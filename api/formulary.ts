// GET /api/formulary — per-(plan, rxcui) formulary lookup.
//
// Used by Step 3 Medications to render tier / copay / coinsurance for
// every added drug against every eligible plan, and by Step 5 to cut
// plans whose formulary lacks any of the client's medications.
//
// Query shapes:
//   /api/formulary?contract_plan_id=H1234_005&rxcui=105028
//       → { tier, copay, coinsurance, drug_name } | { tier: 'not_covered' }
//
//   /api/formulary?rxcuis=105028,6809,36567&contract_ids=H1234,H5253
//       → { rows: [{ contract_plan_id, rxcui, tier, copay, coinsurance }] }
//     Bulk lookup for the Step 5 funnel; the server does one query per
//     call instead of N calls from the browser.
//
// RXCUI expansion
//   The CMS landscape formulary file uses SCD/SBD-level rxcuis (specific
//   strength + dose form, e.g. 310431 = "gabapentin 300 MG Oral Capsule").
//   RxNorm search frequently returns the ingredient-level rxcui (IN, e.g.
//   25480 = "gabapentin") for a bare name query, which then misses every
//   row in pm_formulary. Before querying, expand each input rxcui to its
//   related SCD/SBD/GPCK/BPCK rxcuis via RxNorm's /related.json endpoint
//   and match on the union — keyed back to the original rxcui so the
//   client cache stays stable.
//
// Rows are grouped by (contract_id, plan_id, original_rxcui) and the
// best (lowest numeric, non-null) tier wins — if a plan covers any
// related form of the drug, the drug is considered on-formulary.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';
import { supabase } from './_lib/supabase.js';

interface FormularyRow {
  contract_id: string;
  plan_id: string;
  rxcui: string;
  drug_name: string | null;
  tier: number | null;
  copay: number | null;
  coinsurance: number | null;
}

const RXNAV = 'https://rxnav.nlm.nih.gov/REST';
// SCD = semantic clinical drug, SBD = semantic branded drug, GPCK/BPCK
// = generic/branded pack. Covers every tty level we see in CMS
// formulary files; deliberately excludes IN/PIN/MIN (ingredient) since
// pm_formulary never carries those.
const RELATED_TTY = 'SCD+SBD+GPCK+BPCK';
const RELATED_TIMEOUT_MS = 4_000;

// Fluid Compute re-uses function instances across requests, so this
// module-level cache amortizes RxNorm calls across the whole session
// (and often across sessions). Maps original rxcui → the full set of
// candidate rxcuis to query pm_formulary against, including itself.
const expansionCache = new Map<string, string[]>();

async function expandRxcui(rxcui: string): Promise<string[]> {
  const cached = expansionCache.get(rxcui);
  if (cached) return cached;

  const candidates = new Set<string>([rxcui]);
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), RELATED_TIMEOUT_MS);
  try {
    const url = `${RXNAV}/rxcui/${encodeURIComponent(rxcui)}/related.json?tty=${RELATED_TTY}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (res.ok) {
      const body = (await res.json()) as {
        relatedGroup?: {
          conceptGroup?: { tty?: string; conceptProperties?: { rxcui?: string }[] }[];
        };
      };
      const groups = body.relatedGroup?.conceptGroup ?? [];
      for (const g of groups) {
        for (const c of g.conceptProperties ?? []) {
          if (c?.rxcui) candidates.add(String(c.rxcui));
        }
      }
    } else {
      console.log('[formulary] related.json failed', { rxcui, status: res.status });
    }
  } catch (err) {
    console.log('[formulary] related.json error', {
      rxcui,
      err: (err as Error).message,
    });
  } finally {
    clearTimeout(timeout);
  }

  const list = [...candidates];
  expansionCache.set(rxcui, list);
  return list;
}

// Lowest tier wins. null tier never beats a numeric tier. Used to
// collapse multiple matching rows (different strengths of the same drug)
// down to a single "what does this plan offer?" answer.
function pickBestRow(
  a: FormularyRow | undefined,
  b: FormularyRow,
): FormularyRow {
  if (!a) return b;
  if (a.tier == null && b.tier == null) return a;
  if (a.tier == null) return b;
  if (b.tier == null) return a;
  return b.tier < a.tier ? b : a;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');

  const contractPlanId =
    typeof req.query.contract_plan_id === 'string' ? req.query.contract_plan_id.trim() : '';
  const rxcui = typeof req.query.rxcui === 'string' ? req.query.rxcui.trim() : '';

  const rxcuisCsv = typeof req.query.rxcuis === 'string' ? req.query.rxcuis : '';
  const contractIdsCsv = typeof req.query.contract_ids === 'string' ? req.query.contract_ids : '';

  try {
    const sb = supabase();

    // ─── Bulk mode ──────────────────────────────────────────────────
    if (rxcuisCsv) {
      const originals = rxcuisCsv.split(',').map((s) => s.trim()).filter(Boolean);
      if (originals.length === 0) return sendJson(res, 200, { rows: [] });

      // Expand each input rxcui in parallel and build a reverse index
      // from each candidate rxcui back to the original that produced it.
      const expansions = await Promise.all(originals.map(expandRxcui));
      const candidateToOriginals = new Map<string, Set<string>>();
      for (let i = 0; i < originals.length; i++) {
        const original = originals[i];
        for (const candidate of expansions[i]) {
          let set = candidateToOriginals.get(candidate);
          if (!set) {
            set = new Set<string>();
            candidateToOriginals.set(candidate, set);
          }
          set.add(original);
        }
      }
      const allCandidates = [...candidateToOriginals.keys()];

      let q = sb
        .from('pm_formulary')
        .select('contract_id, plan_id, rxcui, drug_name, tier, copay, coinsurance')
        .in('rxcui', allCandidates)
        .limit(50_000);
      if (contractIdsCsv) {
        const contractIds = contractIdsCsv.split(',').map((s) => s.trim()).filter(Boolean);
        if (contractIds.length > 0) q = q.in('contract_id', contractIds);
      }
      const { data, error } = await q;
      if (error) throw error;

      // Collapse (contract_id, plan_id, original_rxcui) → best row.
      const best = new Map<string, FormularyRow>();
      for (const r of (data ?? []) as FormularyRow[]) {
        const originalsForRow = candidateToOriginals.get(r.rxcui);
        if (!originalsForRow) continue;
        for (const original of originalsForRow) {
          const key = `${r.contract_id}_${r.plan_id}::${original}`;
          const synthetic: FormularyRow = { ...r, rxcui: original };
          best.set(key, pickBestRow(best.get(key), synthetic));
        }
      }
      const rows = [...best.values()].map((r) => ({
        contract_plan_id: `${r.contract_id}_${r.plan_id}`,
        rxcui: r.rxcui,
        tier: r.tier,
        copay: r.copay,
        coinsurance: r.coinsurance,
        drug_name: r.drug_name,
      }));
      res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=120');
      return sendJson(res, 200, { rows });
    }

    // ─── Single lookup ──────────────────────────────────────────────
    if (!contractPlanId) return badRequest(res, 'contract_plan_id or rxcuis required');
    if (!rxcui) return badRequest(res, 'rxcui required');

    const [contractId, planId] = contractPlanId.split('_');
    if (!contractId || !planId) {
      return badRequest(res, 'contract_plan_id must be "<contract_id>_<plan_id>"');
    }

    const candidates = await expandRxcui(rxcui);
    const { data, error } = await sb
      .from('pm_formulary')
      .select('drug_name, tier, copay, coinsurance, rxcui')
      .eq('contract_id', contractId)
      .eq('plan_id', planId)
      .in('rxcui', candidates)
      .limit(candidates.length);
    if (error) throw error;

    if (!data || data.length === 0) {
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
      return sendJson(res, 200, { tier: 'not_covered' });
    }

    let best: FormularyRow | undefined;
    for (const r of data as FormularyRow[]) {
      best = pickBestRow(best, r);
    }

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    return sendJson(res, 200, {
      tier: best?.tier ?? 'not_covered',
      copay: best?.copay ?? null,
      coinsurance: best?.coinsurance ?? null,
      drug_name: best?.drug_name ?? null,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
