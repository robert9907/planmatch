// GET /api/npi-search — server-side proxy for the CMS NPPES NPI Registry.
//
// NPPES doesn't send Access-Control-Allow-Origin, so direct browser
// fetches fail with opaque "Failed to fetch". Proxying server-side
// sidesteps that and lets us surface real error bodies to the UI.
//
// Query params:
//   name  required · free-text provider name; single or multi-token.
//   state optional · 2-letter state code.
//   limit optional · default 20, clamped to [1, 50].
//
// Response:
//   { results: NppesRecord[], fallback?: 'last_name_only', query?: {...} }
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

interface NppesResponse {
  result_count?: number;
  results?: unknown[];
  Errors?: unknown[];
}

async function fetchNppes(
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<{ ok: true; body: NppesResponse; text: string; url: string }
  | { ok: false; status: number; text: string; url: string }> {
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
  return { ok: true, body, text, url };
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

  const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20;
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.floor(limitRaw), 1), 50)
    : 20;

  const tokens = nameRaw.split(/\s+/);
  const baseParams = () =>
    new URLSearchParams({ version: NPPES_VERSION, limit: String(limit) });

  const primary = baseParams();
  if (tokens.length >= 2) {
    primary.set('first_name', tokens[0]);
    primary.set('last_name', tokens.slice(1).join(' '));
    primary.set('use_first_name_alias', 'true');
  } else {
    const t = tokens[0];
    // Single-token: probe both a person last-name match and an
    // organization match. Wildcard the last_name when ≥3 chars so
    // partial typing ("smi") still returns hits.
    if (t.length >= 3) primary.set('last_name', t + '*');
    else primary.set('last_name', t);
    primary.set('organization_name', t);
  }
  if (state) primary.set('state', state);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const primaryRes = await fetchNppes(primary, controller.signal);
    console.log('[npi-search] primary', {
      url: primaryRes.url,
      state,
      tokens: tokens.length,
      ok: primaryRes.ok,
      count: primaryRes.ok ? primaryRes.body.result_count ?? 0 : null,
      status: primaryRes.ok ? 200 : primaryRes.status,
    });

    if (!primaryRes.ok) {
      return sendJson(res, 502, {
        error: `NPPES ${primaryRes.status}`,
        status: primaryRes.status,
        detail: primaryRes.text.slice(0, 400),
      });
    }

    const primaryCount = primaryRes.body.result_count ?? 0;

    // Fallback: multi-token + state + zero hits → retry with last_name
    // only. Rescues first-name typos (Kambiz vs Kombiz) and alias gaps.
    if (primaryCount === 0 && tokens.length >= 2) {
      const fallback = baseParams();
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
        res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60');
        return sendJson(res, 200, {
          ...fbRes.body,
          fallback: 'last_name_only',
          query: { tried: { first: tokens[0], last }, fell_back_to: { last } },
        });
      }
    }

    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(primaryRes.text);
    return;
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
