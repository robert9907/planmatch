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
import { resolvePlanCatalogYear } from './library/planCatalogYear.js';
import { isFormularyPublished } from './_lib/formulary-published.js';
import { getSellabilitySets, resolveSellability } from './_lib/sellability.js';
import { getSellableRules, getSellableFlags } from './_lib/sellable-rules.js';
import { outranks, isTrustedSource } from './_lib/network-row-precedence.js';

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
  source?: string | null;
  checked_at?: string | null;
  plan_year?: number | null;
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
  // Scope the pbp_benefits overlay to the resolved catalog year (view now
  // exposes plan_year) so a 2027 plan never shows 2026 cost-shares.
  const catalogYear = resolvePlanCatalogYear({
    explicit: req.query.plan_year,
    effectiveDate: req.query.effective_date,
  });
  // Prior-year carry-over for provider networks (mirrors the consumer's
  // /api/library/provider-network): CMS contract-plan IDs persist between
  // years with networks that rarely change, so when the requested year has
  // no row for a (plan, doctor) we fall back to the prior year's answer —
  // the requested year always wins when both exist (year-aware winner below).
  const networkFallbackYear = catalogYear >= 2027 ? catalogYear - 1 : null;
  const networkReadYears = networkFallbackYear != null ? [catalogYear, networkFallbackYear] : [catalogYear];

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

    // Run the queries in parallel — none of them depend on each other's
    // results. formularyPublished gates whether the client is allowed to
    // treat an empty/partial formulary read as real cost data (it is not
    // until CMS posts the year's SPUF drug file ~Oct 31).
    const [benefitsRes, drugCacheRes, formularyRes, ndcRes, networkRes, formularyPublished] = await Promise.all([
      // Paginated + filtered to the four real sources so the alt_
      // dedup below sees every candidate (a source-restricted query
      // truncated at PostgREST's 1000-row cap would silently drop the
      // losing filing on high-density D-SNP / MAPD county pools). The
      // source list matches api/plans.ts's pbp_benefits pull exactly.
      paginatedFetch<PbpBenefitRawRow>((from, to) =>
        sb
          .from('pbp_benefits')
          .select('plan_id, benefit_type, tier_id, copay, coinsurance, description, source')
          .eq('plan_year', catalogYear)
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
              // Year-scope: pm_formulary is year-aware. Without this a 2027 plan
              // gets its 2026 twin's tiers/copays — a real-looking drug price for
              // a year CMS hasn't published.
              .eq('plan_year', catalogYear)
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
            .select('plan_id, segment_id, npi, covered, source, checked_at, plan_year')
            // Requested year + (for 2027+) the prior year, so a plan with no
            // requested-year row can carry over. The year-aware winner below
            // only uses the prior-year row when the requested year is silent.
            .in('plan_year', networkReadYears)
            .in('plan_id', contractPlans)
            .in('npi', npis)
        : Promise.resolve({ data: [], error: null }),
      isFormularyPublished(sb, catalogYear),
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
      // One row of record per (plan, doctor). The requested year always beats
      // a prior-year carry-over; within the same year class, broker-verified >
      // carrier directory (fhir_*/healthteam/insurelytix/alignment/healthspring)
      // > Plan Finder > other, freshest wins (network-row-precedence). Mirrors
      // the consumer's /api/library/provider-network winner.
      const slot = (networkByPlan[matched] ||= {});
      const cur = slot[r.npi];
      const rReq = r.plan_year == null || r.plan_year === catalogYear;
      const curReq = cur ? cur.plan_year == null || cur.plan_year === catalogYear : false;
      const take = !cur || (rReq !== curReq ? rReq : outranks(r, cur));
      if (take) slot[r.npi] = r;
    }
    // A medicare_gov (or any non-trusted) "not covered" is UNKNOWN, not out
    // of network — Plan Finder under-reports in-network doctors, and the
    // brain's Gate 1 eliminates a covered=false row (plan-brain.ts
    // applyProviderGate) but passes an ABSENT one as unverified. Drop any
    // winning row that says "not covered" from a non-trusted source so the
    // doctor reads as unknown, never a false out-of-network. covered=true,
    // and trusted covered=false, stay. Matches the consumer's status
    // endpoints (isTrustedSource).
    for (const npiMap of Object.values(networkByPlan)) {
      for (const [npi, row] of Object.entries(npiMap)) {
        if (row.covered !== true && !isTrustedSource(row.source)) delete npiMap[npi];
      }
    }

    // ─── Sellability — appointment/certification flags + rules + flags ──
    // Attached so the LOCAL brain (usePlanBrain → runPlanBrain) can bench
    // non-sellable plans the same way the consumer does. appointment flags
    // (pm_plan_sellability) are per-plan; the exclude rules + carrier flags
    // are per-plan-year. Fails CLOSED on cold-start error (same posture as
    // the consumer plan endpoints) — a 500 beats routing a plan Rob can't
    // sell into the top four. pays_commission is carried for the record only;
    // the brain must NEVER consult it for ranking. sellableRows is keyed by
    // the caller-supplied triple id so the hook can line it up with its
    // PmPlanRow triples.
    const sbUrl = process.env.SUPABASE_URL ?? '';
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    const [sellabilitySets, sellableRules] = await Promise.all([
      getSellabilitySets(sbUrl, sbKey),
      getSellableRules(sbUrl, sbKey, catalogYear),
    ]);

    // ─── MA-only (no-Part-D) exclusion set ─────────────────────────────
    // pm_mapd_plan_set is the authoritative projection of distinct
    // (plan_year, contract_id, plan_id) that have a Part D formulary — i.e.
    // the TRUE MAPD set. The brain drops any eligible plan NOT in this set
    // for a non-VA, drug-having user, because pm_plans.plan_type doesn't carry
    // the MA-only distinction (an HMO-POS medical-only plan like Blue Medicare
    // Medical Only H3449-012 looks like a normal MAPD otherwise). Scoped to the
    // ranked year + this request's contracts (same as the consumer's
    // plans-with-extras). Returned as `${contract_id}-${plan_id}` strings.
    // Fails SAFE: on error we return an EMPTY array and the brain suspends the
    // MA-only filter (gated on size > 0) so a failed load never empties the
    // county. pm_mapd_plan_set CY2027 rows exist only once the shelf is
    // promoted — before promotion the empty set correctly suspends the filter.
    const mapdContractPlanIds: string[] = [];
    {
      const { data: mapdData, error: mapdErr } = await sb
        .from('pm_mapd_plan_set')
        .select('contract_id, plan_id')
        .eq('plan_year', catalogYear)
        .in('contract_id', contracts);
      if (mapdErr) {
        console.warn(
          `[plan-brain-data] pm_mapd_plan_set load failed (${mapdErr.message}) — ` +
            'returning empty set; brain suspends the MA-only filter (fail-safe).',
        );
      } else {
        for (const r of (mapdData ?? []) as Array<{ contract_id: string; plan_id: string }>) {
          mapdContractPlanIds.push(`${r.contract_id}-${r.plan_id}`);
        }
      }
    }
    const sellableFlags = getSellableFlags();
    const sellableByPlan: Record<
      string,
      { is_appointed: boolean; is_certified: boolean; pays_commission: boolean }
    > = {};
    for (const t of triples) {
      const flags = resolveSellability(sellabilitySets, t.contract, t.plan);
      // Key back to the caller's supplied triple form (matchToRequestedTriple
      // handles the medicare_gov vs zero-padded segment mismatch).
      const segNorm = t.segment === '0' ? '000' : t.segment.padStart(3, '0');
      const triple = `${t.contract}-${t.plan}-${segNorm}`;
      const matched = matchToRequestedTriple(triple, ids) ?? triple;
      sellableByPlan[matched] = {
        is_appointed: flags.is_appointed,
        is_certified: flags.is_certified,
        pays_commission: flags.pays_commission,
      };
    }

    res.setHeader('Cache-Control', 'no-store');
    return sendJson(res, 200, {
      planYear: catalogYear,
      // When false, an empty formularyByContractPlan means "CMS hasn't posted
      // this year's drug file yet" — NOT $0, not full retail, not the prior
      // year's tier. The brain must surface drug tiers/costs as unavailable and
      // label any total that would include drugs as incomplete.
      formularyPublished,
      benefitsByPlan,
      drugCostCache,
      formularyByContractPlan,
      ndcByRxcui,
      networkByPlan,
      // Sellability — per-plan appointment flags + the ranked year's exclude
      // rules + carrier kill-switch flags. The local brain benches any plan
      // that isn't sellable (not appointed/certified, UHC/Devoted, exclude
      // rule, or Wellcare non-allowlist) so its top four match the consumer.
      sellableByPlan,
      sellableRules,
      sellableFlags,
      // Authoritative MAPD (has-Part-D) set for the ranked year. The brain
      // drops any eligible plan NOT in this set for a non-VA drug-having user
      // so a medical-only plan never ranks for someone who needs drug coverage.
      // Empty ⇒ MA-only filter suspended (fail-safe / pre-promotion).
      mapdContractPlanIds,
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
