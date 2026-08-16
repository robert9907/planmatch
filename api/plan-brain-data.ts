// GET /api/plan-brain-data
//
// Aggregator for the agent-side Plan Brain — one round trip pulls every
// table the engine needs to score the user's candidate plans:
//
//   pbp_benefits                 — medical copays + extras per plan
//   pm_drug_cost_cache           — pre-computed per-plan per-drug totals
//   pm_formulary                 — tier + cost-share fallback
//   pm_drug_ndc                  — rxcui → NDC bridge
//   pm_provider_network_cache    — provider in-network status per plan
//
// Query string:
//   ids=H5253-189-000,H1036-335-2,...   (comma-separated triple ids)
//   rxcuis=861740,1551300,...           (optional)
//   npis=1619976297,...                 (optional)
//
// Response keyed so the client can do constant-time lookups during
// scoring; see PlanBrainData in src/lib/plan-brain-types.ts.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';
import { supabase } from './_lib/supabase.js';
import { expandRxcui } from './formulary.js';

// PostgREST on this project caps every query at 1000 rows
// (db-max-rows). The formulary fetch can easily exceed that — Durham
// alone returns 681 Ozempic-family rows across 72 plans, and a real
// drug list (Ozempic + Metformin + Lisinopril + Atorvastatin) pushes
// well past the cap. Truncation silently drops per-(plan, rxcui) tier
// rows; downstream brain logic falls back to "not covered" or grabs
// the wrong tier. Paginated fetch defuses the trap.
async function paginatedFetch<T>(
  pageFn: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<{ data: T[]; error: unknown }> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let pageNum = 0; pageNum < 20; pageNum += 1) {
    const from = pageNum * PAGE;
    const to = from + PAGE - 1;
    const { data, error } = await pageFn(from, to);
    if (error) return { data: [], error };
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return { data: out, error: null };
}

interface BenefitRow {
  plan_id: string;
  benefit_type: string;
  tier_id: string | null;
  copay: number | null;
  coinsurance: number | null;
  description: string | null;
  source: string;
  // Highest-ranked LOSER of the source-priority dedup — populated only
  // when a lower-priority source disagreed with the winner. Downstream
  // consumers (usePlanBrain → PlanBenefitRow → selectCostShare in
  // src/lib/dual-eligible.ts) use these to pick the population-
  // appropriate value for MSP-protected beneficiaries. Null when every
  // source agreed. Mirror of the alt_ projection in /api/plans.ts.
  alt_copay?: number | null;
  alt_coinsurance?: number | null;
  alt_source?: string | null;
}

interface PbpBenefitRawRow {
  plan_id: string;
  benefit_type: string;
  tier_id: string | null;
  copay: number | null;
  coinsurance: number | null;
  description: string | null;
  source: string;
}

// Source priority — MUST stay in lockstep with the definitions in
// api/plans.ts (SOURCE_PRIORITY, CARRIER_AUTHORITATIVE_TYPES,
// SOURCE_PRIORITY_CARRIER, sourceRank at lines ~487-513). Copied
// rather than imported because api/plans.ts does not export these
// today and the task closing this endpoint's gap explicitly rules
// api/plans.ts out of the change set. If the priority table ever
// shifts in one place, update BOTH — a divergence silently changes
// which source's value wins the dedup, which quietly flips filed
// cost-share for every downstream reader.
const SOURCE_PRIORITY: Readonly<Record<string, number>> = {
  medicare_gov: 5,
  sb_ocr: 4,
  cms_pbp: 3,
  manual: 2,
  pbp_federal: 1,
};
const CARRIER_AUTHORITATIVE_TYPES: ReadonlySet<string> = new Set([
  'otc_allowance',
  'food_card',
]);
const SOURCE_PRIORITY_CARRIER: Readonly<Record<string, number>> = {
  manual: 4,
  sb_ocr: 3,
  medicare_gov: 2,
  pbp_federal: 1,
};
function sourceRank(source: string | null | undefined, benefitType: string): number {
  if (!source) return 0;
  const table = CARRIER_AUTHORITATIVE_TYPES.has(benefitType)
    ? SOURCE_PRIORITY_CARRIER
    : SOURCE_PRIORITY;
  return table[source] ?? 0;
}

interface DrugCacheRow {
  plan_id: string;
  segment_id: string;
  ndc: string;
  tier: number | null;
  full_cost: number | null;
  covered: boolean | null;
  estimated_yearly_total: number | null;
}

interface FormularyRow {
  contract_id: string;
  plan_id: string;
  rxcui: string;
  tier: number | null;
  copay: number | null;
  coinsurance: number | null;
  prior_auth: boolean | null;
  step_therapy: boolean | null;
}

interface NdcRow {
  rxcui: string;
  ndc: string;
  default_quantity_30: number | null;
  default_quantity_90: number | null;
}

interface NetworkRow {
  plan_id: string;
  segment_id: string;
  npi: string;
  covered: boolean | null;
}

function splitTriple(id: string): { contract: string; plan: string; segment: string } | null {
  const parts = id.split('-');
  if (parts.length < 2) return null;
  return { contract: parts[0], plan: parts[1], segment: (parts[2] ?? '0').replace(/^0+/, '') || '0' };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');

  const idsParam = typeof req.query.ids === 'string' ? req.query.ids : '';
  const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return badRequest(res, 'ids required (triple ids comma-separated)');

  const rxcuis = (typeof req.query.rxcuis === 'string' ? req.query.rxcuis : '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const npis = (typeof req.query.npis === 'string' ? req.query.npis : '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  const triples = ids.map(splitTriple).filter(
    (t): t is { contract: string; plan: string; segment: string } => !!t,
  );
  if (triples.length === 0) return badRequest(res, 'no valid triple ids');

  const tripleIds = triples.map((t) => `${t.contract}-${t.plan}-${(t.segment === '0' ? '000' : t.segment.padStart(3, '0'))}`);
  const contractPlans = [...new Set(triples.map((t) => `${t.contract}-${t.plan}`))];
  const contracts = [...new Set(triples.map((t) => t.contract))];
  const planNumbers = [...new Set(triples.map((t) => t.plan))];

  try {
    const sb = supabase();

    // ─── rxcui expansion (compliance-critical) ───────────────────────
    // pm_formulary keys on the EXACT clinical-drug rxcui CMS files.
    // The Plan Match search picks one rxcui per medication (often the
    // top-ranked SCD/SBD), but H1914 may file the SAME atorvastatin
    // 80 MG tablet under rxcui 617310 while the search returned 617318.
    // Without expansion the lookup misses, the cell renders "Not
    // covered" for a Tier 1 generic, and the broker sees noise.
    //
    // expandRxcui (in api/formulary.ts) walks RxNav's /related.json
    // endpoint to build the candidate set: self → all sibling
    // SCD/SBD/GPCK/BPCK rxcuis → for each ingredient found, every
    // clinical drug under it. Memoized at the function-instance level
    // so popular drugs (atorvastatin, lisinopril, metformin) only pay
    // the RxNav cost on first request.
    //
    // We build:
    //   • expandedSet  — the union of all candidate rxcuis to query
    //   • expansionMap — rxcui → all_candidates so result rows can be
    //                    indexed back to the ORIGINAL input rxcui that
    //                    QuoteDeliveryV4 looks up by.
    const expansionMap = new Map<string, string[]>();
    const expandedSet = new Set<string>();
    if (rxcuis.length > 0) {
      const expansions = await Promise.all(rxcuis.map(expandRxcui));
      for (let i = 0; i < rxcuis.length; i++) {
        const rx = rxcuis[i];
        const candidates = expansions[i].length > 0 ? expansions[i] : [rx];
        expansionMap.set(rx, candidates);
        for (const c of candidates) expandedSet.add(c);
      }
    }
    const expandedRxcuiList = [...expandedSet];

    // Run the five queries in parallel — none of them depend on each
    // other's results.
    const [benefitsRes, drugCacheRes, formularyRes, ndcRes, networkRes] = await Promise.all([
      // Paginated + filtered to the four real sources so the alt_
      // dedup below sees every candidate (a source-restricted query
      // truncated at PostgREST's 1000-row cap would silently drop the
      // losing filing on high-density D-SNP / MAPD county pools). The
      // source list matches api/plans.ts's pbp_benefits pull exactly.
      paginatedFetch<PbpBenefitRawRow>((from, to) =>
        sb
          .from('pbp_benefits')
          .select('plan_id, benefit_type, tier_id, copay, coinsurance, description, source')
          .in('plan_id', uniqueAcceptableIds(ids, tripleIds))
          .in('source', ['medicare_gov', 'sb_ocr', 'cms_pbp', 'manual'])
          .order('plan_id', { ascending: true })
          .order('benefit_type', { ascending: true })
          .order('tier_id', { ascending: true, nullsFirst: true })
          .range(from, to),
      ),
      // pm_drug_cost_cache uses (plan_id="<contract>-<plan>", segment_id, ndc).
      rxcuis.length > 0
        ? sb
            .from('pm_drug_cost_cache')
            .select('plan_id, segment_id, ndc, tier, full_cost, covered, estimated_yearly_total')
            .in('plan_id', contractPlans)
        : Promise.resolve({ data: [], error: null }),
      // Query the EXPANDED rxcui set, not just the originals. The
      // index step below maps each returned row back to whichever
      // original rxcui claims it. Paginated because (plans × rxcuis)
      // for a typical Durham-sized county + multi-drug user exceeds
      // PostgREST's 1000-row cap — un-paginated, plans whose formulary
      // rows sort past the boundary silently lose tier info and the
      // MedsScreen badge picks the wrong tier.
      expandedRxcuiList.length > 0
        ? paginatedFetch<FormularyRow>((from, to) =>
            sb
              .from('pm_formulary')
              .select(
                'contract_id, plan_id, rxcui, tier, copay, coinsurance, prior_auth, step_therapy',
              )
              .in('contract_id', contracts)
              .in('plan_id', planNumbers)
              .in('rxcui', expandedRxcuiList)
              .range(from, to),
          )
        : Promise.resolve({ data: [], error: null }),
      rxcuis.length > 0
        ? sb
            .from('pm_drug_ndc')
            .select('rxcui, ndc, default_quantity_30, default_quantity_90')
            .in('rxcui', rxcuis)
        : Promise.resolve({ data: [], error: null }),
      npis.length > 0
        ? sb
            .from('pm_provider_network_cache')
            .select('plan_id, segment_id, npi, covered')
            .in('plan_id', contractPlans)
            .in('npi', npis)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (benefitsRes.error) throw benefitsRes.error;
    if (drugCacheRes.error) throw drugCacheRes.error;
    if (formularyRes.error) throw formularyRes.error;
    if (ndcRes.error) throw ndcRes.error;
    if (networkRes.error) throw networkRes.error;

    // ─── Source-priority dedup + alt_ projection ─────────────────
    // Mirror of the winner/alt logic in api/plans.ts (bestByKey +
    // altByKey around lines 1020-1059). For each (plan_id,
    // benefit_type, tier_id) triple: pick the highest-source-rank row
    // as the winner and track the highest-rank LOSER whose cost-share
    // actually disagrees as the alt. Without this pass, a medicare_gov
    // 20% row would silently displace a cms_pbp 0% row for the 8 UHC
    // D-SNPs on primary_care, and the brain — which now has no visibility
    // into the losing filing — would score every MSP population against
    // 20% even though QMB/QMB+/SLMB+/FBDE members owe 0% (Medicaid
    // covers the difference). See selectCostShare in
    // src/lib/dual-eligible.ts for the population-aware pick.
    const rawPbpRows = (benefitsRes.data ?? []) as PbpBenefitRawRow[];
    const bestByKey = new Map<string, PbpBenefitRawRow>();
    for (const row of rawPbpRows) {
      const key = `${row.plan_id}|${row.benefit_type}|${row.tier_id ?? 0}`;
      const prior = bestByKey.get(key);
      if (
        !prior ||
        sourceRank(row.source, row.benefit_type) > sourceRank(prior.source, prior.benefit_type)
      ) {
        bestByKey.set(key, row);
      }
    }
    // Second pass — keep the highest-ranked LOSER whose (copay,
    // coinsurance) actually disagrees with the winner's. Rows that
    // merely restate the winner do NOT become alts (only real
    // disagreements matter). Rows that file (null, null) are excluded
    // — a shell row carries no cost-share signal to preserve.
    const altByKey = new Map<
      string,
      { copay: number | null; coinsurance: number | null; source: string }
    >();
    for (const row of rawPbpRows) {
      const key = `${row.plan_id}|${row.benefit_type}|${row.tier_id ?? 0}`;
      const winner = bestByKey.get(key);
      if (!winner || winner === row) continue;
      if (row.copay === winner.copay && row.coinsurance === winner.coinsurance) continue;
      if (row.copay == null && row.coinsurance == null) continue;
      const prior = altByKey.get(key);
      if (
        prior &&
        sourceRank(prior.source, row.benefit_type) >= sourceRank(row.source, row.benefit_type)
      ) {
        continue;
      }
      altByKey.set(key, {
        copay: row.copay,
        coinsurance: row.coinsurance,
        source: row.source,
      });
    }

    // ─── Index by triple id ────────────────────────────────────────
    const benefitsByPlan: Record<string, BenefitRow[]> = {};
    for (const [key, winner] of bestByKey) {
      const alt = altByKey.get(key) ?? null;
      const benefitRow: BenefitRow = {
        plan_id: winner.plan_id,
        benefit_type: winner.benefit_type,
        tier_id: winner.tier_id,
        copay: winner.copay,
        coinsurance: winner.coinsurance,
        description: winner.description,
        source: winner.source,
        alt_copay: alt ? alt.copay : null,
        alt_coinsurance: alt ? alt.coinsurance : null,
        alt_source: alt ? alt.source : null,
      };
      const triple = normalizeTripleId(winner.plan_id, ids);
      (benefitsByPlan[triple] ||= []).push(benefitRow);
    }

    const drugCostCache: Record<string, Record<string, DrugCacheRow>> = {};
    for (const r of (drugCacheRes.data ?? []) as DrugCacheRow[]) {
      const segNorm = (r.segment_id ?? '0').replace(/^0+/, '') || '0';
      const triple = `${r.plan_id}-${segNorm === '0' ? '000' : segNorm.padStart(3, '0')}`;
      const matched = matchToRequestedTriple(triple, ids) ?? triple;
      (drugCostCache[matched] ||= {})[r.ndc] = r;
    }

    // Index formulary rows back to the ORIGINAL input rxcuis. Each
    // returned row may satisfy multiple inputs (e.g. atorvastatin
    // 80 MG SCD 617318 expansion includes 617310, and a different med
    // search hit might have started with 617310 directly — both
    // inputs claim the result).
    //
    // For each original rxcui, prefer the row that matches it
    // exactly; otherwise take the first expansion-match. This keeps
    // tier accuracy highest when CMS files multiple strengths and
    // we want the user's specific dose to win when present.
    const formularyByContractPlan: Record<string, Record<string, FormularyRow>> = {};
    const reverseMap = new Map<string, string[]>(); // candidate rxcui → originals that claim it
    for (const [orig, candidates] of expansionMap) {
      for (const cand of candidates) {
        const list = reverseMap.get(cand) ?? [];
        list.push(orig);
        reverseMap.set(cand, list);
      }
    }
    for (const r of (formularyRes.data ?? []) as FormularyRow[]) {
      const key = `${r.contract_id}-${r.plan_id}`;
      const originals = reverseMap.get(r.rxcui) ?? [r.rxcui];
      const slot = (formularyByContractPlan[key] ||= {});
      for (const orig of originals) {
        const existing = slot[orig];
        // Prefer exact-match rows (orig === returned rxcui) over
        // expansion siblings. Without this, an arbitrary expansion
        // sibling could overwrite a real exact hit.
        if (!existing || (orig === r.rxcui && existing.rxcui !== orig)) {
          slot[orig] = r;
        }
      }
    }

    const ndcByRxcui: Record<string, NdcRow> = {};
    for (const r of (ndcRes.data ?? []) as NdcRow[]) {
      // Take the first row per rxcui — pm_drug_ndc has one canonical
      // bridge per rxcui today; if there's ever multiple, the first
      // arbitrary winner is fine for cache lookup.
      if (!ndcByRxcui[r.rxcui]) ndcByRxcui[r.rxcui] = r;
    }

    const networkByPlan: Record<string, Record<string, NetworkRow>> = {};
    for (const r of (networkRes.data ?? []) as NetworkRow[]) {
      const segNorm = (r.segment_id ?? '0').replace(/^0+/, '') || '0';
      const triple = `${r.plan_id}-${segNorm === '0' ? '000' : segNorm.padStart(3, '0')}`;
      const matched = matchToRequestedTriple(triple, ids) ?? triple;
      (networkByPlan[matched] ||= {})[r.npi] = r;
    }

    res.setHeader('Cache-Control', 'no-store');
    return sendJson(res, 200, {
      benefitsByPlan,
      drugCostCache,
      formularyByContractPlan,
      ndcByRxcui,
      networkByPlan,
      stats: {
        benefits: (benefitsRes.data ?? []).length,
        drugCache: (drugCacheRes.data ?? []).length,
        formulary: (formularyRes.data ?? []).length,
        ndcs: (ndcRes.data ?? []).length,
        network: (networkRes.data ?? []).length,
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
}

// pbp_benefits stores triple ids inconsistently across sources —
// medicare_gov rows use the segment as-typed ("H1036-335-2"), federal
// rows zero-pad to 3 ("H1036-335-002"). We accept both and return the
// caller-supplied form so the client doesn't have to renormalize.
function uniqueAcceptableIds(requested: string[], normalized: string[]): string[] {
  return [...new Set([...requested, ...normalized])];
}

function normalizeTripleId(planId: string, requested: string[]): string {
  const matched = matchToRequestedTriple(planId, requested);
  return matched ?? planId;
}

function matchToRequestedTriple(planId: string, requested: string[]): string | null {
  if (requested.includes(planId)) return planId;
  // Try permuting the segment between '0' / '00' / '000' to match.
  const parts = planId.split('-');
  if (parts.length < 3) return null;
  const [c, p, s] = parts;
  const segNorm = (s ?? '0').replace(/^0+/, '') || '0';
  for (const candidateSeg of [segNorm, segNorm.padStart(3, '0'), '0']) {
    const cand = `${c}-${p}-${candidateSeg}`;
    if (requested.includes(cand)) return cand;
  }
  return null;
}
