// POST /api/drug-ndcs
//
// Body: { rxcuis: string[] }
// Resp: { ndcs: Record<rxcui, string[]> }
//
// Persistent rxcui → NDC[] resolver. Checks rxcui_ndcs for each
// requested rxcui; backfills misses from RxNorm /ndcs.json in parallel
// (public NIH endpoint, no auth, ~5 RPS is polite), upserts cache,
// returns a map keyed by rxcui.
//
// Step 3 fires this fire-and-forget on every addMedication so the
// Quote page can skip the round-trip when it needs NDCs for the
// Medicare.gov drug-cost call.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';
import { supabase } from './_lib/supabase.js';

const RXNAV_URL = (rxcui: string) =>
  `https://rxnav.nlm.nih.gov/REST/rxcui/${encodeURIComponent(rxcui)}/ndcs.json`;
const RXNAV_TIMEOUT_MS = 5_000;

interface CachedRow {
  rxcui: string;
  ndcs: string[];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  const body = (req.body ?? {}) as { rxcuis?: unknown };
  const rxcuis = Array.isArray(body.rxcuis)
    ? body.rxcuis.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
  if (rxcuis.length === 0) return badRequest(res, 'rxcuis required (non-empty string array)');

  try {
    const sb = supabase();

    // ─── Cache lookup ──────────────────────────────────────────────
    //
    // One IN query; missing rxcuis fall through to the RxNorm backfill.
    // No TTL on NDC rows — the RxNorm ingredient → NDC mapping rarely
    // changes, and when it does a missing NDC just means one fewer
    // representative ID the cost API can price. Cheaper to let stale
    // rows live than to re-fetch daily.
    const { data: cached, error: cacheErr } = await sb
      .from('rxcui_ndcs')
      .select('rxcui, ndcs')
      .in('rxcui', rxcuis);
    if (cacheErr) {
      const code = (cacheErr as { code?: string }).code;
      // Missing table → fall through to RxNorm for every rxcui. Rob
      // runs scripts/migrations/002_drug_costs.sql once and the cache
      // flips on.
      if (code !== 'PGRST205' && code !== '42P01') throw cacheErr;
    }

    const out: Record<string, string[]> = {};
    const missing: string[] = [];
    const cacheMap = new Map<string, string[]>();
    for (const row of (cached ?? []) as CachedRow[]) {
      cacheMap.set(row.rxcui, row.ndcs ?? []);
    }
    for (const rx of rxcuis) {
      if (cacheMap.has(rx)) out[rx] = cacheMap.get(rx)!;
      else missing.push(rx);
    }

    // ─── RxNorm backfill (parallel, bounded timeout) ───────────────
    if (missing.length > 0) {
      const backfilled = await Promise.all(missing.map((rx) => fetchNdcs(rx)));
      const toUpsert: CachedRow[] = [];
      for (let i = 0; i < missing.length; i++) {
        const rx = missing[i];
        const ndcs = backfilled[i];
        out[rx] = ndcs ?? [];
        // Only cache when we got a definitive answer (empty array is
        // valid — means "RxNav confirmed no NDCs for this rxcui").
        // Transient fetch errors return null and we skip the upsert.
        if (ndcs) toUpsert.push({ rxcui: rx, ndcs });
      }
      if (toUpsert.length > 0) {
        const { error: upsertErr } = await sb
          .from('rxcui_ndcs')
          .upsert(toUpsert, { onConflict: 'rxcui' });
        // Swallow upsert failures — the caller still gets real NDCs
        // via `out`, we just lose the cache benefit. Logged server-side.
        if (upsertErr) console.warn('[drug-ndcs] cache upsert failed:', upsertErr.message);
      }
    }

    return sendJson(res, 200, { ndcs: out, cached: rxcuis.length - missing.length, fetched: missing.length });
  } catch (err) {
    return serverError(res, err);
  }
}

async function fetchNdcs(rxcui: string): Promise<string[] | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), RXNAV_TIMEOUT_MS);
  try {
    const res = await fetch(RXNAV_URL(rxcui), {
      headers: { Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!res.ok) {
      console.log('[drug-ndcs] rxnav non-200', { rxcui, status: res.status });
      return null;
    }
    const body = (await res.json()) as { ndcGroup?: { ndcList?: { ndc?: string[] } } };
    const list = body.ndcGroup?.ndcList?.ndc ?? [];
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [];
  } catch (err) {
    console.log('[drug-ndcs] rxnav fetch error', {
      rxcui, err: (err as Error).message,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
