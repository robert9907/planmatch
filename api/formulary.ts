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
// Clinical-drug tty set: SCD = semantic clinical drug, SBD = semantic
// branded drug, GPCK/BPCK = generic/branded pack. Covers every tty
// level that appears in the CMS landscape formulary file.
const CLINICAL_TTY = 'SCD+SBD+GPCK+BPCK';
// Ingredient tty set used by the tier-3 walk-up so one /related.json
// call returns both the clinical-drug siblings and the ingredient
// anchors we'd need for tier 3.
const RELATED_TTY = 'SCD+SBD+GPCK+BPCK+IN+MIN+PIN';
const RELATED_TIMEOUT_MS = 4_000;

// Fluid Compute re-uses function instances across requests, so this
// module-level cache amortizes RxNorm calls across the whole session
// (and often across sessions). Maps original rxcui → the full set of
// candidate rxcuis to query pm_formulary against, including itself.
const expansionCache = new Map<string, string[]>();

// Fetch helper wrapping the 4-second abort and JSON parse. Returns the
// set of rxcuis found under the requested tty filter (the input rxcui
// is never added here — the caller decides whether to include it).
async function relatedRxcuis(
  rxcui: string,
  tty: string,
): Promise<{ ok: boolean; byTty: Map<string, string[]> }> {
  const byTty = new Map<string, string[]>();
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), RELATED_TIMEOUT_MS);
  try {
    const url = `${RXNAV}/rxcui/${encodeURIComponent(rxcui)}/related.json?tty=${tty}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!res.ok) {
      console.log('[formulary] related.json failed', { rxcui, tty, status: res.status });
      return { ok: false, byTty };
    }
    const body = (await res.json()) as {
      relatedGroup?: {
        conceptGroup?: { tty?: string; conceptProperties?: { rxcui?: string }[] }[];
      };
    };
    for (const g of body.relatedGroup?.conceptGroup ?? []) {
      const bucket = g.tty ?? 'UNKNOWN';
      const list = byTty.get(bucket) ?? [];
      for (const c of g.conceptProperties ?? []) {
        if (c?.rxcui) list.push(String(c.rxcui));
      }
      if (list.length > 0) byTty.set(bucket, list);
    }
    return { ok: true, byTty };
  } catch (err) {
    console.log('[formulary] related.json error', {
      rxcui,
      tty,
      err: (err as Error).message,
    });
    return { ok: false, byTty };
  } finally {
    clearTimeout(timeout);
  }
}

// Three-tier rxcui expansion driving the pm_formulary candidate set.
//
// Tier 1: self. `pm_formulary` is keyed on strength-level rxcuis, so if
//   the user's rxcui is already a SCD/SBD/GPCK/BPCK row, this hits.
// Tier 2: direct /related.json expansion with tty=SCD+SBD+GPCK+BPCK+
//   IN+MIN+PIN. Adds sibling clinical drugs (e.g. SBD Jardiance 25 MG
//   → SCD generic empagliflozin 25 MG) plus captures the ingredient
//   rxcuis we need for tier 3.
// Tier 3: for each ingredient found in tier 2, re-run /related.json
//   with tty=SCD+SBD+GPCK+BPCK to pick up EVERY clinical drug under
//   that ingredient. This catches non-strength starting points (BN
//   "Jardiance", IN "empagliflozin", SBDF "empagliflozin Oral Tablet
//   [Jardiance]"), which the previous expansion missed because
//   related.json on a BN doesn't always surface every SBD.
//
// pickBestRow still prefers the exact user rxcui when rows exist for it
// — the broader tier-3 set is only consulted when nothing tighter
// matches, so the "covered / not covered" badge stays honest.
async function expandRxcui(rxcui: string): Promise<string[]> {
  const cached = expansionCache.get(rxcui);
  if (cached) return cached;

  const candidates = new Set<string>([rxcui]);
  const ingredients = new Set<string>();

  // Tier 2.
  const tier2 = await relatedRxcuis(rxcui, RELATED_TTY);
  if (tier2.ok) {
    for (const [tty, list] of tier2.byTty) {
      if (tty === 'IN' || tty === 'MIN' || tty === 'PIN') {
        for (const r of list) ingredients.add(r);
      } else {
        for (const r of list) candidates.add(r);
      }
    }
  }

  // Tier 3 — walk each ingredient back down to every clinical drug.
  // Runs in parallel because each call is independent. Kept behind the
  // tier-2 succeeded check so a transient RxNav failure can be retried
  // on the next request rather than cached as a narrow expansion.
  let tier3Ok = true;
  if (tier2.ok && ingredients.size > 0) {
    const tier3Results = await Promise.all(
      [...ingredients].map((ing) => relatedRxcuis(ing, CLINICAL_TTY)),
    );
    for (const r of tier3Results) {
      if (!r.ok) {
        tier3Ok = false;
        continue;
      }
      for (const list of r.byTty.values()) {
        for (const rx of list) candidates.add(rx);
      }
    }
  }

  const list = [...candidates];
  // Memoize only when every RxNav call succeeded. A partial expansion
  // (one tier-3 ingredient failed, or tier 2 itself failed) would
  // permanently narrow the candidate set for this Fluid Compute
  // instance; leaving it uncached lets the next request retry.
  if (tier2.ok && tier3Ok) expansionCache.set(rxcui, list);
  return list;
}

// Rows get a score triple we compare lexically: (isExact, isCombo,
// tier). Lower wins on every axis. Exact-match always beats any
// sibling — the caller asked about rxcui X, so if pm_formulary has a
// row with rxcui X for this plan, that row is the answer regardless of
// tier. Within non-exact rows we exclude combinations (HCTZ/lisinopril
// and amlodipine/atorvastatin combos share an ingredient with the
// query but are different drugs) by giving them the highest isCombo
// penalty, then fall back to lowest tier.
interface ScoredRow {
  row: FormularyRow;
  isExact: boolean;
  isCombo: boolean;
}

function isComboName(name: string | null): boolean {
  return typeof name === 'string' && / \/ /.test(name);
}

function pickBestScored(
  current: ScoredRow | undefined,
  candidate: ScoredRow,
): ScoredRow {
  if (!current) return candidate;

  if (current.isExact !== candidate.isExact) {
    return current.isExact ? current : candidate;
  }
  if (current.isCombo !== candidate.isCombo) {
    return current.isCombo ? candidate : current;
  }
  const ct = current.row.tier;
  const nt = candidate.row.tier;
  if (ct == null && nt == null) return current;
  if (ct == null) return candidate;
  if (nt == null) return current;
  return nt < ct ? candidate : current;
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
      const best = new Map<string, ScoredRow>();
      for (const r of (data ?? []) as FormularyRow[]) {
        const originalsForRow = candidateToOriginals.get(r.rxcui);
        if (!originalsForRow) continue;
        const combo = isComboName(r.drug_name);
        for (const original of originalsForRow) {
          const key = `${r.contract_id}_${r.plan_id}::${original}`;
          const scored: ScoredRow = {
            row: { ...r, rxcui: original },
            isExact: r.rxcui === original,
            isCombo: combo,
          };
          best.set(key, pickBestScored(best.get(key), scored));
        }
      }
      const rows = [...best.values()]
        // A (plan, rxcui) pair that only matched combination siblings
        // isn't really covering this drug — suppress it so the client
        // renders "not on formulary" instead of misattributing a combo's
        // tier/copay to the user's standalone query.
        .filter((s) => s.isExact || !s.isCombo)
        .map(({ row: r }) => ({
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

    let best: ScoredRow | undefined;
    for (const r of data as FormularyRow[]) {
      const scored: ScoredRow = {
        row: r,
        isExact: r.rxcui === rxcui,
        isCombo: isComboName(r.drug_name),
      };
      best = pickBestScored(best, scored);
    }

    // If the only match we found was a combination sibling, treat the
    // drug as not covered — telling the user their lisinopril 10 MG is
    // "covered tier 4" based on an HCTZ/lisinopril combo row would be
    // wrong. Exact hits always pass this filter.
    if (!best || (!best.isExact && best.isCombo)) {
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
      return sendJson(res, 200, { tier: 'not_covered' });
    }

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    return sendJson(res, 200, {
      tier: best.row.tier ?? 'not_covered',
      copay: best.row.copay ?? null,
      coinsurance: best.row.coinsurance ?? null,
      drug_name: best.row.drug_name ?? null,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
