// GET /api/plans — plan catalog backed by pm_plans + pm_plan_benefits.
//
// Query params:
//   state?       2-letter state code (NC / GA / TX).
//   county?      free-text county name, normalized and matched against
//                pm_plans.county_name plus "All Counties" (PDPs).
//   planType?    app's PlanType enum ('MA' | 'MAPD' | 'DSNP' | 'PDP' |
//                'MEDSUPP'). Filters by a translation from the
//                landscape plan_type + SNP flags.
//   ids?         comma-separated list of Plan ids (contract-plan-segment)
//                for the Step 6 finalist refetch path. When provided,
//                state/county/planType filters are ignored — the client
//                already committed to these ids upstream.
//   limit?       default 500, max 2000.
//
// Response: { plans: Plan[], source: 'pm_plans' }
// Errors: { error, detail? } on 4xx/5xx.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';
import { supabase } from './_lib/supabase.js';

type AppPlanType = 'MA' | 'MAPD' | 'DSNP' | 'PDP' | 'MEDSUPP';

// Keep aligned with src/types/plans.ts — the API is the single source
// of truth for Plan shape as far as the UI is concerned.
interface Plan {
  id: string;
  contract_id: string;
  plan_number: string;
  segment_id: string;
  carrier: string;
  plan_name: string;
  state: string;
  counties: string[];
  plan_type: AppPlanType;
  premium: number;
  annual_deductible: number | null;
  moop_in_network: number;
  moop_out_of_network: number | null;
  drug_deductible: number | null;
  part_b_giveback: number;
  star_rating: number;
  benefits: PlanBenefits;
  formulary: Record<string, never>; // populated lazily via /api/formulary
  in_network_npis: string[]; // empty — networkCheck.ts stamps its own
}

interface CostShare {
  copay: number | null;
  coinsurance: number | null;
  description: string | null;
}

interface PlanBenefits {
  dental: { preventive: boolean; comprehensive: boolean; annual_max: number; description: string | null };
  vision: { exam: boolean; eyewear_allowance_year: number; description: string | null };
  hearing: { aid_allowance_year: number; exam: boolean; description: string | null };
  transportation: { rides_per_year: number; distance_miles: number; description: string | null };
  otc: { allowance_per_quarter: number; description: string | null };
  food_card: { allowance_per_month: number; restricted_to_medicaid_eligible: boolean; description: string | null };
  diabetic: { covered: boolean; preferred_brands: string[] };
  fitness: { enabled: boolean; program: string | null };
  medical: {
    primary_care: CostShare;
    specialist: CostShare;
    urgent_care: CostShare;
    emergency: CostShare;
    inpatient: CostShare;
    outpatient_surgery_hospital: CostShare;
    outpatient_surgery_asc: CostShare;
    outpatient_observation: CostShare;
    lab_services: CostShare;
    diagnostic_tests: CostShare;
    xray: CostShare;
    diagnostic_radiology: CostShare;
    therapeutic_radiology: CostShare;
    mental_health_individual: CostShare;
    mental_health_group: CostShare;
    physical_therapy: CostShare;
    telehealth: CostShare;
  };
  rx_tiers: {
    tier_1: CostShare;
    tier_2: CostShare;
    tier_3: CostShare;
    tier_4: CostShare;
    tier_5: CostShare;
    tier_6?: CostShare;
    tier_7?: CostShare;
    tier_8?: CostShare;
  };
}

interface PlanRow {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_name: string;
  carrier: string | null;
  parent_organization: string | null;
  plan_type: string | null;
  state: string;
  county_name: string;
  monthly_premium: number | null;
  annual_deductible: number | null;
  moop: number | null;
  drug_deductible: number | null;
  star_rating: number | null;
  snp: boolean;
  snp_type: string | null;
  sanctioned: boolean;
}

interface BenefitRow {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  benefit_category: string;
  benefit_description: string | null;
  coverage_amount: number | null;
  copay: number | null;
  coinsurance: number | null;
  max_coverage: number | null;
}

interface PbpBenefitRow {
  plan_id: string; // already concatenated "H5296-003-0"
  benefit_type: string;
  copay: number | null;
  coinsurance: number | null;
  tier_id: string | null;
}

// pbp_benefits carries categories that the structured importer does
// NOT write into pm_plan_benefits (mental_health_individual,
// mental_health_group, physical_therapy). The Quote table renders
// these as their own rows. Fall back to pbp_benefits when
// pm_plan_benefits has no row for the category.
const PBP_FALLBACK_TYPES = [
  'mental_health_individual',
  'mental_health_group',
  'physical_therapy',
] as const;
type PbpFallbackType = (typeof PBP_FALLBACK_TYPES)[number];

// dental_annual_max is also extracted from medicare.gov (filed at
// ma_benefits.plan_limits_details under limit_type=COVERAGE,
// limit_period=EVERY_YEAR) and stored in pbp_benefits with the dollar
// amount in the `copay` slot. Tracked separately because the value
// feeds Plan.benefits.dental.annual_max — a scalar, not a CostShare.
const PBP_DENTAL_MAX_TYPE = 'dental_annual_max';
// Extras allowance fallbacks. The medicare.gov scraper writes these
// into pbp_benefits with the dollar amount in the `copay` column. We
// fall back to them when pm_plan_benefits is missing the matching
// otc / food_card row — common on plans that filed extras only via
// the SoB scrape, which is what the Quote table is supposed to show
// regardless of pbp_federal completeness.
const PBP_OTC_TYPE = 'otc_quarter';
const PBP_FOOD_CARD_TYPE = 'food_card_month';

interface PbpFallback {
  costShares: Partial<Record<PbpFallbackType, CostShare>>;
  dentalAnnualMax?: number;
  otcQuarterly?: number;
  foodCardMonthly?: number;
}

type PbpFallbackMap = Map<string, PbpFallback>;

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

function normalizeCounty(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+co\.?$/i, '')
    .replace(/\s+county$/i, '')
    .replace(/\s+parish$/i, '')
    .trim();
}

function mapPlanType(raw: string | null, snp: boolean, snpType: string | null): AppPlanType {
  const t = (raw ?? '').toUpperCase().trim();
  // SNP takes priority — D-SNP + C-SNP plans ride HMO/PPO structures
  // in the source file but the app treats them as their own bucket.
  // The Intake planType filter (MAPD) must never surface SNP plans
  // since eligibility rules differ (Medicaid for D-SNP, chronic
  // condition attestation for C-SNP).
  if (snp) {
    const s = (snpType ?? '').toUpperCase();
    if (s.includes('D-SNP') || s.includes('DSNP')) return 'DSNP';
    // C-SNP and I-SNP aren't in the app's PlanType enum yet; tag them
    // as DSNP so the MAPD filter excludes them. A downstream follow-up
    // can split C-SNP/I-SNP into their own buckets.
    return 'DSNP';
  }
  if (t === 'PDP') return 'PDP';
  // Everything else in the source (HMO, Local PPO, Regional PPO,
  // HMOPOS, PFFS, MSA, Cost) ships with Part D → MAPD in our enum.
  return 'MAPD';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');

  const state =
    typeof req.query.state === 'string' && /^[A-Za-z]{2}$/.test(req.query.state)
      ? req.query.state.toUpperCase()
      : null;
  const county =
    typeof req.query.county === 'string' ? req.query.county.trim() : '';
  const planType = (typeof req.query.planType === 'string'
    ? req.query.planType
    : null) as AppPlanType | null;
  const idsParam = typeof req.query.ids === 'string' ? req.query.ids : '';
  const limit = Math.min(
    Math.max(
      Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : DEFAULT_LIMIT,
      1,
    ),
    MAX_LIMIT,
  );

  const wantedCounty = normalizeCounty(county);

  try {
    const sb = supabase();

    // ─── Step 1: fetch matching pm_plans rows ───────────────────────
    // When ids are passed we ignore the geo filters and just load those
    // triples (finalist refetch path). Otherwise filter by state +
    // (county OR "All Counties" for PDPs).
    let plansQuery = sb
      .from('pm_plans')
      .select(
        'contract_id, plan_id, segment_id, plan_name, carrier, parent_organization, plan_type, state, county_name, monthly_premium, annual_deductible, moop, drug_deductible, star_rating, snp, snp_type, sanctioned',
      )
      .eq('sanctioned', false)
      .limit(limit);

    if (idsParam) {
      const ids = idsParam
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length === 0) return sendJson(res, 200, { plans: [], source: 'pm_plans' });
      // Parse ids: "H1234-005-000" → { contract_id: 'H1234', plan_id: '005', segment_id: '000' }
      const triples = ids
        .map((id) => {
          const parts = id.split('-');
          if (parts.length < 2) return null;
          return {
            contract_id: parts[0],
            plan_id: parts[1],
            segment_id: parts[2] ?? '000',
          };
        })
        .filter((t): t is { contract_id: string; plan_id: string; segment_id: string } => !!t);
      if (triples.length === 0) return sendJson(res, 200, { plans: [], source: 'pm_plans' });
      // Postgrest doesn't do composite IN() — union on the three cols.
      const contractIds = [...new Set(triples.map((t) => t.contract_id))];
      const planIds = [...new Set(triples.map((t) => t.plan_id))];
      plansQuery = plansQuery.in('contract_id', contractIds).in('plan_id', planIds);
    } else {
      if (state) plansQuery = plansQuery.eq('state', state);
      if (wantedCounty) {
        // Push the county match into PostgREST. Without this we fetch up
        // to `limit` rows from a state with thousands of plan-county
        // rows (NC alone has 6,220) and then filter to ~80 in JS — most
        // of the wanted county's rows fall outside the row window and
        // get silently dropped (this was the Durham 11-vs-74 bug).
        // 'All Counties' is the PDP state-wide wildcard. ilike is
        // case-insensitive; we strip PostgREST-significant chars first.
        const safe = wantedCounty.replace(/[,()*%]/g, '').trim();
        plansQuery = plansQuery.or(
          `county_name.ilike.${safe},county_name.eq.All Counties`,
        );
      }
    }

    const { data: rawRows, error: planErr } = await plansQuery;
    if (planErr) throw planErr;

    let rows = (rawRows ?? []) as PlanRow[];

    // Defensive county re-filter — handles the ids-path (which skips the
    // PostgREST county filter above) and any DB rows whose county_name
    // normalizes differently than the input string.
    if (wantedCounty) {
      rows = rows.filter((r) => {
        const c = normalizeCounty(r.county_name);
        return c === wantedCounty || c === 'all counties';
      });
    }

    if (idsParam) {
      // Restrict to the exact triples (in-DB `in()` is a superset).
      const idSet = new Set(
        idsParam.split(',').map((s) => s.trim()).filter(Boolean),
      );
      rows = rows.filter((r) => {
        const id = `${r.contract_id}-${r.plan_id}-${r.segment_id || '000'}`;
        return idSet.has(id);
      });
    }

    if (planType) {
      rows = rows.filter((r) => mapPlanType(r.plan_type, r.snp, r.snp_type) === planType);
    }

    // ─── Step 2: aggregate by (contract_id, plan_id, segment_id) ────
    // Landscape rows are one-per-county; the app wants one plan per
    // triple with an array of counties.
    const byTriple = new Map<string, { row: PlanRow; counties: Set<string> }>();
    for (const r of rows) {
      const key = `${r.contract_id}-${r.plan_id}-${r.segment_id || '000'}`;
      const hit = byTriple.get(key);
      if (hit) {
        hit.counties.add(r.county_name);
      } else {
        byTriple.set(key, { row: r, counties: new Set([r.county_name]) });
      }
    }

    if (byTriple.size === 0) {
      return sendJson(res, 200, { plans: [], source: 'pm_plans' });
    }

    // ─── Step 3: fetch pm_plan_benefits for these triples ───────────
    const contractIds = [...new Set([...byTriple.values()].map((v) => v.row.contract_id))];
    const planIds = [...new Set([...byTriple.values()].map((v) => v.row.plan_id))];
    const { data: benefitRows, error: benefitErr } = await sb
      .from('pm_plan_benefits')
      .select(
        'contract_id, plan_id, segment_id, benefit_category, benefit_description, coverage_amount, copay, coinsurance, max_coverage',
      )
      .in('contract_id', contractIds)
      .in('plan_id', planIds);
    if (benefitErr) throw benefitErr;

    const benefitsByTriple = new Map<string, BenefitRow[]>();
    for (const b of (benefitRows ?? []) as BenefitRow[]) {
      const key = `${b.contract_id}-${b.plan_id}-${b.segment_id || '000'}`;
      const list = benefitsByTriple.get(key) ?? [];
      list.push(b);
      benefitsByTriple.set(key, list);
    }

    // ─── Step 3b: fetch pbp_benefits fallback for MH/PT ─────────────
    // pm_plan_benefits is empty for mental_health_individual,
    // mental_health_group, and physical_therapy across the catalog. The
    // Medicare.gov detail scraper writes these into pbp_benefits with
    // plan_id already in "H5296-003-0" format. Pull only the categories
    // we actually need so the row count stays small.
    const tripleKeys = [...byTriple.keys()];
    const pbpTypes = [...PBP_FALLBACK_TYPES, PBP_DENTAL_MAX_TYPE, PBP_OTC_TYPE, PBP_FOOD_CARD_TYPE];
    const { data: pbpRows, error: pbpErr } = await sb
      .from('pbp_benefits')
      .select('plan_id, benefit_type, copay, coinsurance, tier_id')
      .in('plan_id', tripleKeys)
      .in('benefit_type', pbpTypes);
    if (pbpErr) throw pbpErr;
    const pbpFallback = buildPbpFallback((pbpRows ?? []) as PbpBenefitRow[]);

    // ─── Step 4: shape into Plan[] ──────────────────────────────────
    const plans: Plan[] = [];
    for (const [key, { row, counties }] of byTriple) {
      const benefits = buildBenefits(
        benefitsByTriple.get(key) ?? [],
        pbpFallback.get(key),
      );
      const partBGiveback = pickBenefitNumber(
        benefitsByTriple.get(key) ?? [],
        'partb_giveback',
        'coverage_amount',
      );
      plans.push({
        id: key,
        contract_id: row.contract_id,
        plan_number: row.plan_id,
        segment_id: row.segment_id || '000',
        carrier: row.carrier ?? row.parent_organization ?? '—',
        plan_name: row.plan_name,
        state: row.state,
        counties: [...counties].sort(),
        plan_type: mapPlanType(row.plan_type, row.snp, row.snp_type),
        premium: row.monthly_premium ?? 0,
        annual_deductible: row.annual_deductible,
        moop_in_network: row.moop ?? 0,
        // pm_plans only carries in-network MOOP; OON isn't in the
        // landscape extract, so we leave it null and let the UI render
        // "—" rather than fake a value.
        moop_out_of_network: null,
        drug_deductible: row.drug_deductible,
        part_b_giveback: partBGiveback ?? 0,
        star_rating: row.star_rating ?? 0,
        benefits,
        formulary: {},
        in_network_npis: [],
      });
    }

    // Stable-ish ordering: star desc, then premium asc.
    plans.sort((a, b) => {
      if (a.star_rating !== b.star_rating) return b.star_rating - a.star_rating;
      return a.premium - b.premium;
    });

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    return sendJson(res, 200, { plans, source: 'pm_plans' });
  } catch (err) {
    return serverError(res, err);
  }
}

function pickBenefitNumber(
  rows: BenefitRow[],
  category: string,
  field: 'coverage_amount' | 'copay' | 'coinsurance' | 'max_coverage',
): number | null {
  const hit = rows.find((r) => r.benefit_category === category);
  if (!hit) return null;
  const v = hit[field];
  return typeof v === 'number' ? v : v != null ? Number(v) : null;
}

// Several Plan-type field names diverge from the canonical
// pm_plan_benefits.benefit_category strings. Probed against the live
// table on plan-match-prod, the DB uses these short keys — every
// alias here was historically failing to find its row, leaving copay
// and coinsurance as null and the agent quote screen rendering '—'
// for Labs / Imaging / Outpatient Surgery.
//
//   Plan field                    →  pm_plan_benefits.benefit_category
//   --------------------------------------------------------------
//   lab_services                  →  lab            (712 rows)
//   diagnostic_radiology          →  imaging        (748 rows)
//   outpatient_surgery_hospital   →  outpatient_surgery (748 rows)
//
// physical_therapy and mental_health_individual have NO rows in
// pm_plan_benefits at all — those categories fall back to
// pbp_benefits via the PBP_FALLBACK_TYPES path in buildBenefits.
const CATEGORY_ALIAS: Record<string, string> = {
  lab_services: 'lab',
  diagnostic_radiology: 'imaging',
  outpatient_surgery_hospital: 'outpatient_surgery',
};

function costShareFor(
  rows: BenefitRow[],
  category: string,
  pbpFallback?: PbpFallback,
): CostShare {
  const aliasedCategory = CATEGORY_ALIAS[category] ?? category;
  const hit =
    rows.find((r) => r.benefit_category === aliasedCategory) ??
    rows.find((r) => r.benefit_category === category);
  if (hit) {
    return {
      copay: toNum(hit.copay),
      coinsurance: toNum(hit.coinsurance),
      description: hit.benefit_description ?? null,
    };
  }
  // pbp_benefits fallback for the categories the structured importer
  // never populates (mental_health_*, physical_therapy). Treated as a
  // last resort so a future pm_plan_benefits row would still win.
  if (pbpFallback && (PBP_FALLBACK_TYPES as readonly string[]).includes(category)) {
    const cs = pbpFallback.costShares[category as PbpFallbackType];
    if (cs) return cs;
  }
  return { copay: null, coinsurance: null, description: null };
}

// pbp_benefits files mental_health_individual at tier_id "min"/"max"
// for plans that report a copay range; non-tiered plans use "". We
// quote the lower end (the broker's "as low as" number) and tag the
// description with the range so the UI can surface it.
function buildPbpFallback(rows: PbpBenefitRow[]): PbpFallbackMap {
  // Group cost-share fallback rows (mental_health_*, physical_therapy)
  // by plan + benefit_type so we can resolve min/max tier ranges.
  const csGrouped = new Map<string, Map<PbpFallbackType, PbpBenefitRow[]>>();
  // Single-value-per-plan extras — collected separately. The scraper
  // writes the dollar amount in the `copay` column.
  const dentalMaxByPlan = new Map<string, number>();
  const otcQuarterlyByPlan = new Map<string, number>();
  const foodCardMonthlyByPlan = new Map<string, number>();

  for (const r of rows) {
    if ((PBP_FALLBACK_TYPES as readonly string[]).includes(r.benefit_type)) {
      const byType = csGrouped.get(r.plan_id) ?? new Map<PbpFallbackType, PbpBenefitRow[]>();
      const list = byType.get(r.benefit_type as PbpFallbackType) ?? [];
      list.push(r);
      byType.set(r.benefit_type as PbpFallbackType, list);
      csGrouped.set(r.plan_id, byType);
    } else if (r.benefit_type === PBP_DENTAL_MAX_TYPE) {
      const v = toNum(r.copay);
      if (v != null && v > 0) dentalMaxByPlan.set(r.plan_id, v);
    } else if (r.benefit_type === PBP_OTC_TYPE) {
      const v = toNum(r.copay);
      if (v != null && v > 0) otcQuarterlyByPlan.set(r.plan_id, v);
    } else if (r.benefit_type === PBP_FOOD_CARD_TYPE) {
      const v = toNum(r.copay);
      if (v != null && v > 0) foodCardMonthlyByPlan.set(r.plan_id, v);
    }
  }

  const out: PbpFallbackMap = new Map();
  const planIds = new Set([
    ...csGrouped.keys(),
    ...dentalMaxByPlan.keys(),
    ...otcQuarterlyByPlan.keys(),
    ...foodCardMonthlyByPlan.keys(),
  ]);
  for (const planId of planIds) {
    const costShares: Partial<Record<PbpFallbackType, CostShare>> = {};
    const byType = csGrouped.get(planId);
    if (byType) {
      for (const [bt, list] of byType) {
        const min = list.find((r) => r.tier_id === 'min') ?? list[0];
        const max = list.find((r) => r.tier_id === 'max');
        const minCopay = toNum(min.copay);
        const minCoins = toNum(min.coinsurance);
        const maxCopay = toNum(max?.copay);
        const description =
          max && minCopay != null && maxCopay != null && minCopay !== maxCopay
            ? `$${minCopay}–$${maxCopay} copay`
            : null;
        costShares[bt] = { copay: minCopay, coinsurance: minCoins, description };
      }
    }
    out.set(planId, {
      costShares,
      dentalAnnualMax: dentalMaxByPlan.get(planId),
      otcQuarterly: otcQuarterlyByPlan.get(planId),
      foodCardMonthly: foodCardMonthlyByPlan.get(planId),
    });
  }
  return out;
}

function buildBenefits(
  rows: BenefitRow[],
  pbpFallback?: PbpFallback,
): PlanBenefits {
  // Dental, vision, hearing — single-row categories from b16/b17/b18.
  // max_coverage = annual benefit maximum; coverage_amount usually
  // duplicates it. Preventive vs comprehensive isn't split out in the
  // PBP extract, so we treat presence of a row with max_coverage > 0
  // as comprehensive. When pm_plan_benefits has no annual cap (the
  // structured importer doesn't populate it), fall back to the
  // medicare.gov scraper's dental_annual_max value in pbp_benefits.
  const dental = rows.find((r) => r.benefit_category === 'dental');
  const pmDentalMax = toNum(dental?.max_coverage ?? dental?.coverage_amount) ?? 0;
  const dentalMax = pmDentalMax > 0 ? pmDentalMax : (pbpFallback?.dentalAnnualMax ?? 0);

  const vision = rows.find((r) => r.benefit_category === 'vision');
  const visionEyewear = toNum(vision?.max_coverage ?? vision?.coverage_amount) ?? 0;

  const hearing = rows.find((r) => r.benefit_category === 'hearing');
  const hearingAllowance = toNum(hearing?.max_coverage ?? hearing?.coverage_amount) ?? 0;

  // b13b → otc. Importer writes coverage_amount as the QUARTERLY
  // equivalent ($/qtr), max_coverage as the ANNUAL max. Benefit
  // Filters' "≥ $150 / qtr" tier reads allowance_per_quarter, so we
  // feed coverage_amount directly. When pm_plan_benefits has no row
  // (common — only ~30% of plans file OTC structurally), fall back
  // to the medicare.gov scraper's value in pbp_benefits otc_quarter.
  const otc = rows.find((r) => r.benefit_category === 'otc');
  const pmOtcQuarterly = toNum(otc?.coverage_amount) ?? 0;
  const otcQuarterly = pmOtcQuarterly > 0
    ? pmOtcQuarterly
    : (pbpFallback?.otcQuarterly ?? 0);

  // b13c → food_card. coverage_amount = MONTHLY equivalent so the
  // filter's "≥ $100 / mo" tier maps cleanly. A row with
  // coverage_amount === 1 and no dollar signal is the importer's
  // "offered but no dollar cap" marker (common for post-discharge
  // meals benefits); surface it as > 0 so the filter's Any tier
  // passes, but the specific dollar tiers won't. Same scraper-fallback
  // logic as OTC for plans missing structured rows.
  const foodCard = rows.find((r) => r.benefit_category === 'food_card');
  const pmFoodCardMonthly = toNum(foodCard?.coverage_amount) ?? 0;
  const foodCardMonthly = pmFoodCardMonthly > 0
    ? pmFoodCardMonthly
    : (pbpFallback?.foodCardMonthly ?? 0);

  // b10b → transportation. coverage_amount is either a dollar cap OR
  // the presence marker (1). The schema's transportation.rides_per_year
  // doesn't fit a dollar cap cleanly, so we surface rides_per_year as
  // a proxy: 12 rides if plan offers transportation at all (satisfies
  // the "Any" tier), scaled up when a dollar cap hints at more. The
  // real per-ride count isn't in b10b — plans file that in the SoB.
  const transport = rows.find((r) => r.benefit_category === 'transportation');
  const transportOffered = Boolean(transport);
  const transportDollarCap = toNum(transport?.max_coverage);
  const ridesProxy = transportOffered
    ? transportDollarCap && transportDollarCap > 500
      ? 48
      : transportDollarCap && transportDollarCap > 200
        ? 36
        : 24
    : 0;

  // Fitness — PBP doesn't carry the program name in the structured
  // extract (see comment in scripts/import-pbp-benefits.ts). When no
  // row exists we DEFAULT enabled=true because MA plans on the CMS
  // landscape almost universally include a fitness benefit
  // (SilverSneakers / Renew Active / Active&Fit); defaulting to false
  // would cause the fitness filter tier to wrongly eliminate every
  // plan. Program stays null until the importer starts extracting
  // name, at which point the row's benefit_description carries it.
  const fitness = rows.find((r) => r.benefit_category === 'fitness');
  const fitnessProgramMatch = fitness?.benefit_description?.match(/Fitness · ([^·]+)/);
  const fitnessProgram = fitnessProgramMatch ? fitnessProgramMatch[1].trim() : null;

  // Diabetic supplies — Part B benefit covered universally by every
  // MA plan (test strips, monitors, lancets). Default covered=true so
  // the Diabetic filter doesn't zero out the funnel; the preferred-
  // brand subToggles (OneTouch / Accu-Chek) still cut plans because
  // we don't have brand data yet. Old behaviour was covered=false for
  // every plan, which combined with the AND intersection in the Extras
  // funnel produced 0 finalists whenever Diabetic was enabled.
  return {
    dental: {
      preventive: Boolean(dental),
      comprehensive: dentalMax > 0,
      annual_max: dentalMax,
      description:
        dental?.benefit_description ??
        (pbpFallback?.dentalAnnualMax
          ? `$${pbpFallback.dentalAnnualMax}/yr dental allowance`
          : null),
    },
    vision: {
      exam: Boolean(vision),
      eyewear_allowance_year: visionEyewear,
      description: vision?.benefit_description ?? null,
    },
    hearing: {
      aid_allowance_year: hearingAllowance,
      exam: Boolean(hearing),
      description: hearing?.benefit_description ?? null,
    },
    transportation: {
      rides_per_year: ridesProxy,
      distance_miles: 0,
      description: transport?.benefit_description ?? null,
    },
    otc: {
      allowance_per_quarter: otcQuarterly,
      description:
        otc?.benefit_description ??
        (pbpFallback?.otcQuarterly && pbpFallback.otcQuarterly > 0
          ? `$${pbpFallback.otcQuarterly}/qtr OTC allowance`
          : null),
    },
    food_card: {
      allowance_per_month: foodCardMonthly,
      restricted_to_medicaid_eligible: false,
      description:
        foodCard?.benefit_description ??
        (pbpFallback?.foodCardMonthly && pbpFallback.foodCardMonthly > 0
          ? `$${pbpFallback.foodCardMonthly}/mo food card`
          : null),
    },
    diabetic: { covered: true, preferred_brands: [] },
    // PBP-as-source caveat: enabled stays true whether or not we
    // extracted a fitness row — fitness is nearly ubiquitous on MA
    // plans and PBP doesn't expose it in structured form. See the
    // block comment above.
    fitness: {
      enabled: true,
      program: fitnessProgram,
    },
    medical: {
      primary_care: costShareFor(rows, 'primary_care'),
      specialist: costShareFor(rows, 'specialist'),
      urgent_care: costShareFor(rows, 'urgent_care'),
      emergency: costShareFor(rows, 'emergency'),
      inpatient: costShareFor(rows, 'inpatient'),
      outpatient_surgery_hospital: costShareFor(rows, 'outpatient_surgery_hospital'),
      outpatient_surgery_asc: costShareFor(rows, 'outpatient_surgery_asc'),
      outpatient_observation: costShareFor(rows, 'outpatient_observation'),
      lab_services: costShareFor(rows, 'lab_services'),
      diagnostic_tests: costShareFor(rows, 'diagnostic_tests'),
      xray: costShareFor(rows, 'xray'),
      diagnostic_radiology: costShareFor(rows, 'diagnostic_radiology'),
      therapeutic_radiology: costShareFor(rows, 'therapeutic_radiology'),
      mental_health_individual: costShareFor(rows, 'mental_health_individual', pbpFallback),
      mental_health_group: costShareFor(rows, 'mental_health_group', pbpFallback),
      physical_therapy: costShareFor(rows, 'physical_therapy', pbpFallback),
      telehealth: costShareFor(rows, 'telehealth'),
    },
    rx_tiers: {
      tier_1: costShareFor(rows, 'rx_tier_1'),
      tier_2: costShareFor(rows, 'rx_tier_2'),
      tier_3: costShareFor(rows, 'rx_tier_3'),
      tier_4: costShareFor(rows, 'rx_tier_4'),
      tier_5: costShareFor(rows, 'rx_tier_5'),
      tier_6: costShareFor(rows, 'rx_tier_6'),
      tier_7: costShareFor(rows, 'rx_tier_7'),
      tier_8: costShareFor(rows, 'rx_tier_8'),
    },
  };
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
