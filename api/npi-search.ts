// DEPRECATED — agent useProviderSearch now calls
// planmatch.generationhealth.me/api/library/npi-search (POST). This
// route stays in place as a fallback until a 30-day Vercel access-log
// review shows zero hits, after which it can be deleted. Do not add
// new callers.
//
// GET /api/npi-search — server-side proxy for the CMS NPPES NPI Registry.
//
// NPPES doesn't send Access-Control-Allow-Origin, so direct browser
// fetches fail with opaque "Failed to fetch". Proxying server-side
// sidesteps that and lets us surface real error bodies to the UI.
//
// Query params:
//   name  required · free-text provider name; single or multi-token.
//   state optional · 2-letter state code.
//   limit optional · default 50, clamped to [1, 50].
//
// Response:
//   { results: NppesRecord[], fallback?: 'last_name_only', query?: {...} }
//
// Two parallel calls back every search: individuals (NPI-1) by name
// and organizations (NPI-2) by organization_name. Results are merged
// and deduped by NPI so a query like "Duke Primary Care" or "WakeMed"
// surfaces practices alongside named clinicians on the same dropdown.
// Server-side ranking tiers exact last/org-name match ahead of prefix
// match — NPPES sorts wildcarded results alphabetically, so without
// the rank step a "klein" query buries the Kleins behind Kleinbecks
// and Kleinmans.
//
// Fallback behavior: a multi-token search with a state filter that
// returns 0 results retries with last_name only, still state-scoped.
// This rescues agent searches where the first name is misspelled
// (e.g. "Kambiz Klein" — the doctor is actually "Kombiz Klein" in
// NPPES). The UI uses the `fallback` marker to explain the widened
// search.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';

const NPPES_URL = 'https://npiregistry.cms.hhs.gov/api/';
const NPPES_VERSION = '2.1';
const DEFAULT_TIMEOUT_MS = 12_000;
// Default candidate pool — bumped from 20 so common surnames have
// headroom before NPPES's alphabetical cut-off. Still fits in a single
// NPPES response and keeps the round-trip well under the 500ms target.
const DEFAULT_LIMIT = 50;

interface NppesAddress {
  address_purpose?: string;
  city?: string;
  state?: string;
  postal_code?: string;
}
interface NppesBasic {
  first_name?: string;
  last_name?: string;
  organization_name?: string;
}
interface NppesRecord {
  number?: string | number;
  enumeration_type?: string;
  basic?: NppesBasic;
  addresses?: NppesAddress[];
  [k: string]: unknown;
}
interface NppesResponse {
  result_count?: number;
  results?: NppesRecord[];
  Errors?: unknown[];
}

// Always carries `status` regardless of the success branch so callers
// can log it uniformly without having to narrow the discriminated
// union. Previously the `ok: true` variant omitted `status`, which
// made TS 5.9 fail to narrow inside `primaryRes.ok ? 200 :
// primaryRes.status` ternaries during the Vercel build.
async function fetchNppes(
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<
  | { ok: true; status: number; body: NppesResponse; text: string; url: string }
  | { ok: false; status: number; body?: undefined; text: string; url: string }
> {
  const url = `${NPPES_URL}?${params.toString()}`;
  const upstream = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  const text = await upstream.text();
  if (!upstream.ok) return { ok: false, status: upstream.status, text, url };
  let body: NppesResponse = {};
  try {
    body = JSON.parse(text) as NppesResponse;
  } catch {
    return { ok: false, status: 502, text: 'non-JSON NPPES body', url };
  }
  return { ok: true, status: upstream.status, body, text, url };
}

function rankRecords(records: NppesRecord[], qLower: string, state: string | null): NppesRecord[] {
  // Tier exact last/org-name == query first, then startsWith, then
  // mid-string. Within each tier, prefer state matches (the practice
  // address state). Ties break alphabetically by surname/org name.
  return records
    .map((r) => {
      const basic = r.basic ?? {};
      const isOrg = r.enumeration_type === 'NPI-2';
      const name = (isOrg ? basic.organization_name : basic.last_name) ?? '';
      const lower = name.toLowerCase();
      const nameBucket = lower === qLower ? 0 : lower.startsWith(qLower) ? 1 : 3;
      const stateBucket = !state
        ? 0
        : (r.addresses ?? []).some(
              (a) => (a.state ?? '').toUpperCase() === state,
            )
          ? 0
          : 2;
      return { r, rank: nameBucket + stateBucket, sortName: lower };
    })
    .sort((a, b) => a.rank - b.rank || a.sortName.localeCompare(b.sortName))
    .map((x) => x.r);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');

  const nameRaw = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  if (nameRaw.length < 2) {
    return badRequest(res, 'name query param must be at least 2 characters');
  }

  const state =
    typeof req.query.state === 'string' && /^[A-Za-z]{2}$/.test(req.query.state)
      ? req.query.state.toUpperCase()
      : null;

  const limitRaw =
    typeof req.query.limit === 'string' ? Number(req.query.limit) : DEFAULT_LIMIT;
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.floor(limitRaw), 1), DEFAULT_LIMIT)
    : DEFAULT_LIMIT;

  const tokens = nameRaw.split(/\s+/);
  const baseParams = () =>
    new URLSearchParams({ version: NPPES_VERSION, limit: String(limit) });

  // ─── Individual search (NPI-1) ───────────────────────────────────────
  const individualParams = baseParams();
  individualParams.set('enumeration_type', 'NPI-1');
  if (tokens.length >= 2) {
    individualParams.set('first_name', tokens[0]);
    individualParams.set('last_name', tokens.slice(1).join(' '));
    individualParams.set('use_first_name_alias', 'true');
  } else {
    const t = tokens[0];
    // Wildcard the last_name when ≥3 chars so partial typing ("smi")
    // still returns hits. NPPES needs 3+ chars before `*` to actually
    // prefix-match — shorter wildcards return alphabetical noise.
    individualParams.set('last_name', t.length >= 3 ? t + '*' : t);
  }
  if (state) individualParams.set('state', state);

  // ─── Org search (NPI-2) — only fires for queries plausibly naming a
  // practice. Multi-token queries like "jane smith" are almost never an
  // org name, so we skip the parallel call there and avoid pollution.
  const orgParams = tokens.length === 1 ? baseParams() : null;
  if (orgParams) {
    orgParams.set('enumeration_type', 'NPI-2');
    const t = tokens[0];
    orgParams.set('organization_name', t.length >= 3 ? t + '*' : t);
    if (state) orgParams.set('state', state);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const [individualRes, orgRes] = await Promise.all([
      fetchNppes(individualParams, controller.signal),
      orgParams
        ? fetchNppes(orgParams, controller.signal).catch((err) => {
            // Org call failures shouldn't take down the dominant
            // individual-search path. Log and move on.
            console.warn(
              '[npi-search] org call failed:',
              err instanceof Error ? err.message : err,
            );
            return {
              ok: true,
              status: 200,
              body: { results: [] } as NppesResponse,
              text: '',
              url: '',
            } as Awaited<ReturnType<typeof fetchNppes>>;
          })
        : Promise.resolve({
            ok: true,
            status: 200,
            body: { results: [] } as NppesResponse,
            text: '',
            url: '',
          } as Awaited<ReturnType<typeof fetchNppes>>),
    ]);

    console.log('[npi-search] primary', {
      url: individualRes.url,
      state,
      tokens: tokens.length,
      ok: individualRes.ok,
      indivCount: individualRes.ok ? (individualRes.body.result_count ?? 0) : null,
      orgCount: orgRes.ok ? (orgRes.body?.result_count ?? 0) : null,
      status: individualRes.status,
    });

    if (!individualRes.ok) {
      return sendJson(res, 502, {
        error: `NPPES ${individualRes.status}`,
        status: individualRes.status,
        detail: individualRes.text.slice(0, 400),
      });
    }

    const indivRecords = individualRes.body.results ?? [];
    const orgRecords = orgRes.ok ? (orgRes.body.results ?? []) : [];

    // Dedupe by NPI in case the same number shows up twice. Org first
    // would be wrong — individual results are the dominant path.
    const seen = new Set<string>();
    const merged: NppesRecord[] = [];
    for (const r of [...indivRecords, ...orgRecords]) {
      const npi = String(r.number ?? '');
      if (!npi || seen.has(npi)) continue;
      seen.add(npi);
      merged.push(r);
    }

    const qLower = (tokens.length === 1 ? tokens[0] : tokens.slice(1).join(' '))
      .toLowerCase();
    const ranked = rankRecords(merged, qLower, state);
    const primaryCount = ranked.length;

    // Fallback: multi-token + state + zero hits → retry with last_name
    // only. Rescues first-name typos (Kambiz vs Kombiz) and alias gaps.
    if (primaryCount === 0 && tokens.length >= 2) {
      const fallback = baseParams();
      fallback.set('enumeration_type', 'NPI-1');
      const last = tokens.slice(1).join(' ');
      if (last.length >= 3) fallback.set('last_name', last + '*');
      else fallback.set('last_name', last);
      if (state) fallback.set('state', state);

      const fbRes = await fetchNppes(fallback, controller.signal);
      console.log('[npi-search] fallback', {
        url: fbRes.url,
        reason: 'primary-zero-results',
        ok: fbRes.ok,
        count: fbRes.ok ? fbRes.body.result_count ?? 0 : null,
      });

      if (fbRes.ok && (fbRes.body.result_count ?? 0) > 0) {
        const fbRanked = rankRecords(
          fbRes.body.results ?? [],
          last.toLowerCase(),
          state,
        );
        res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60');
        return sendJson(res, 200, {
          result_count: fbRanked.length,
          results: fbRanked,
          fallback: 'last_name_only',
          query: { tried: { first: tokens[0], last }, fell_back_to: { last } },
        });
      }

      // Second fallback: last-name-only WITH state also returned zero,
      // and a state filter was in play → drop the state and try once
      // more. NPPES files providers under their mailing-address state,
      // not their practice state — a NC border-county client looking
      // for an SC/GA/VA-mailed clinician would otherwise see an empty
      // search. Only fires when state was set; without a state filter
      // there is nothing left to drop.
      if (state) {
        const stateDropped = baseParams();
        stateDropped.set('enumeration_type', 'NPI-1');
        if (last.length >= 3) stateDropped.set('last_name', last + '*');
        else stateDropped.set('last_name', last);
        // state intentionally omitted

        const sdRes = await fetchNppes(stateDropped, controller.signal);
        console.log('[npi-search] fallback', {
          url: sdRes.url,
          reason: 'last-only-zero-in-state',
          dropped_state: state,
          ok: sdRes.ok,
          count: sdRes.ok ? sdRes.body.result_count ?? 0 : null,
        });

        if (sdRes.ok && (sdRes.body.result_count ?? 0) > 0) {
          // Pass null for the state argument so rankRecords doesn't
          // penalize the out-of-state matches we deliberately surfaced.
          const sdRanked = rankRecords(
            sdRes.body.results ?? [],
            last.toLowerCase(),
            null,
          );
          res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60');
          return sendJson(res, 200, {
            result_count: sdRanked.length,
            results: sdRanked,
            fallback: 'state_dropped',
            query: {
              tried: { first: tokens[0], last, state },
              fell_back_to: { last, state: null },
            },
          });
        }
      }
    }

    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60');
    return sendJson(res, 200, {
      result_count: ranked.length,
      results: ranked,
    });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      return sendJson(res, 504, {
        error: 'NPPES upstream timed out',
        detail: `Exceeded ${DEFAULT_TIMEOUT_MS} ms — try again or narrow the search.`,
      });
    }
    return serverError(res, err);
  } finally {
    clearTimeout(timeout);
  }
}
