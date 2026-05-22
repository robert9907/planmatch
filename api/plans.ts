// GET /api/plans — plan catalog backed by pm_plans + pm_plan_benefits.
//
// Query params:
//   state?       2-letter state code (NC / GA / TX).
//   county?      free-text county name, normalized and matched against
//                pm_plans.county_name plus "All Counties" (PDPs).
//   planType?    app's PlanType enum ('MA' | 'MAPD' | 'DSNP' | 'CSNP' |
//                'ISNP' | 'PDP' | 'MEDSUPP'). Filters by a translation
//                from the landscape plan_type + SNP flags.
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
import {
  filterPlanLevelExclusions,
  getNonCommissionableSets,
} from './_lib/non-commissionable.js';
import { supabase } from './_lib/supabase.js';

type AppPlanType = 'MA' | 'MAPD' | 'DSNP' | 'CSNP' | 'ISNP' | 'PDP' | 'MEDSUPP';

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
  // Live data uses both 2-part ("H1036-335") and 3-part-with-1ch-segment
  // ("H5253-187-0") plan_id formats. Never the API's 3-part-with-3ch
  // form, so we always normalize to 2-part for fallback lookups.
  plan_id: string;
  benefit_type: string;
  copay: number | null;
  coinsurance: number | null;
  tier_id: string | null;
  description: string | null;
}

// Rich pbp row with the columns the merge needs — `copay_max` for
// dollar-cap categories, `source` for priority dedup. Used by the
// broad medicare_gov / sb_ocr / manual fetch that mirrors the
// consumer's plans-with-extras endpoint.
interface PbpRichRow extends PbpBenefitRow {
  copay_max: number | null;
  source: string | null;
}

// pbp_benefits.plan_id is either 2-part ("H1036-335") or 3-part-with-
// 1ch-segment ("H5253-187-0"); pm_plans.id is always 3-part-with-3ch
// ("H1036-335-000"). Strip everything after the second hyphen so both
// the query and the lookup use the same canonical key — pbp data is
// uniform per (contract, plan) regardless of segment, so collapsing
// the segment is safe.
function normalizePbpKey(planId: string): string {
  const parts = planId.split('-');
  if (parts.length < 2) return planId;
  return `${parts[0]}-${parts[1]}`;
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
// Extras allowance fallbacks. The pbp_federal + medicare.gov scrapers
// write these into pbp_benefits with the dollar amount in the `copay`
// column. We fall back when pm_plan_benefits is missing the matching
// otc / food_card row — common on plans that filed extras only via
// the SoB scrape, which is what the Quote table needs to show
// regardless of pbp_federal completeness.
//
// Verified against the live database 2026-04-30:
//   • benefit_type = 'otc_allowance'   (3,937 rows; description tells
//                                       period: "OTC quarterly" /
//                                       "OTC monthly" / "OTC yearly")
//   • benefit_type = 'food_card'       (3,178 rows; description like
//                                       "Healthy food/grocery")
const PBP_OTC_TYPE = 'otc_allowance';
const PBP_FOOD_CARD_TYPE = 'food_card';

interface PbpFallback {
  costShares: Partial<Record<PbpFallbackType, CostShare>>;
  dentalAnnualMax?: number;
  otcQuarterly?: number;
  otcDescription?: string;
  foodCardMonthly?: number;
  foodCardDescription?: string;
}

type PbpFallbackMap = Map<string, PbpFallback>;

// ─── Broad pbp_benefits merge — mirrors consumer plans-with-extras ─
//
// Earlier versions of this endpoint only fetched a tiny benefit_type
// subset of pbp_benefits (mental_health_*, physical_therapy,
// dental_annual_max, otc_allowance, food_card) and treated everything
// else as missing. The consumer's /api/plans-with-extras has always
// taken the opposite approach: fetch ALL pbp_benefits with source IN
// (medicare_gov, sb_ocr, manual), transform to pm_plan_benefits row
// shape, and merge with PBP winning on conflict. That path produces
// real numbers for vision_allowance, dental_comprehensive desc-dollar
// parses ($1,600 annual allowance), authoritative imaging copays,
// etc. — none of which the agent saw before.
//
// Verified parity test (Aetna H3146-004, NC):
//   Consumer broad fetch returned 26 rows across 3 sources → agent
//   narrow fetch returned 1 row. The 25 missed rows are exactly the
//   data the broker QA flagged as missing on the agent side.

// pbp_benefits.benefit_type → pm_plan_benefits.benefit_category. The
// shape buildBenefits already consumes, so the transformed rows feed
// straight through the existing flatten path.
//
// Two intentional divergences from the consumer's mapping:
//   • food_card → 'food_card'  (consumer uses 'meals'; we keep the
//     pm_plan_benefits-native key so PBP rows merge with landscape
//     food_card rows on conflict instead of duplicating them)
//   • dental_preventive omitted (agent's Plan.benefits.dental is a
//     single shape — only the comprehensive row matters here)
const PBP_TYPE_TO_CATEGORY: Record<string, string> = {
  primary_care_visit: 'primary_care',
  inpatient_hospital: 'inpatient',
  emergency_room: 'emergency',
  urgent_care: 'urgent_care',
  specialist_visit: 'specialist',
  lab_diagnostic: 'lab',
  imaging: 'imaging',
  outpatient_surgery: 'outpatient_surgery',
  ambulance: 'ambulance',
  dental_comprehensive: 'dental',
  vision_exam: 'vision_exam',
  vision_allowance: 'vision',
  hearing_exam: 'hearing_exam',
  hearing_aid_allowance: 'hearing',
  otc_allowance: 'otc',
  food_card: 'food_card',
  transportation: 'transportation',
  fitness: 'fitness',
  diabetic_supplies: 'insulin',
  telehealth: 'telehealth',
  rx_deductible: 'rx_deductible',
  rx_tier_1: 'rx_tier_1',
  rx_tier_2: 'rx_tier_2',
  rx_tier_3: 'rx_tier_3',
  rx_tier_4: 'rx_tier_4',
  rx_tier_5: 'rx_tier_5',
  rx_tier_6: 'rx_tier_6',
};

// pbp.copay holds different meanings per benefit_type. For these
// allowance / deductible types the dollar amount lives in `copay` but
// pm_plan_benefits stores it in `coverage_amount`; the transform
// remaps so buildBenefits' coverage_amount lookup wins.
const PBP_ALLOWANCE_TYPES = new Set([
  'vision_allowance',
  'hearing_aid_allowance',
  'otc_allowance',
  'food_card',
  'rx_deductible',
  'transportation',
]);

// Source priority — keep in sync with consumer plans-with-extras.
const SOURCE_PRIORITY: Readonly<Record<string, number>> = {
  medicare_gov: 4,
  sb_ocr: 3,
  manual: 2,
  pbp_federal: 1,
};
// OTC + food_card are the carrier-authoritative categories (Medicare.gov
// Plan Finder doesn't carry the dollar amount for C-SNP healthy-food
// allowances, so manual / sb_ocr overrides win for these specifically).
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

function transformPbpRow(
  row: PbpRichRow,
  contract_id: string,
  plan_id: string,
  segment_id: string,
): BenefitRow | null {
  const category = PBP_TYPE_TO_CATEGORY[row.benefit_type];
  if (!category) return null;

  const isAllowance = PBP_ALLOWANCE_TYPES.has(row.benefit_type);
  let coverage_amount = isAllowance ? row.copay : null;
  const copay = isAllowance ? null : row.copay;
  let max_coverage = row.copay_max;

  // OTC normalization: pbp_benefits.copay arrives in mixed units
  // (sb_ocr files quarterly, medicare_gov files monthly, manual
  // sometimes annual). Beneficiaries get a quarterly disbursement on
  // the OTC card, so quarterly is the canonical display unit.
  if (row.benefit_type === 'otc_allowance' && typeof row.copay === 'number' && row.copay > 0) {
    const desc = (row.description ?? '').toLowerCase();
    const src = (row.source ?? '').toLowerCase();
    const perMonth = /per month|\/mo\b|monthly/.test(desc);
    const perQuarter = /per quarter|every quarter|\/qtr\b|\bqtr\b|quarterly/.test(desc);
    const perYear = /per year|\/yr\b|annual|yearly/.test(desc);
    let monthly: number;
    if (perQuarter) monthly = row.copay / 3;
    else if (perYear) monthly = row.copay / 12;
    else if (perMonth) monthly = row.copay;
    else if (src === 'sb_ocr') monthly = row.copay / 3;
    else monthly = row.copay;
    coverage_amount = Math.round(monthly * 3);
    max_coverage = Math.round(monthly * 12);
  }

  // food_card normalization → monthly (matches Plan.benefits
  // .food_card.allowance_per_month contract).
  if (row.benefit_type === 'food_card' && typeof row.copay === 'number' && row.copay > 0) {
    const desc = (row.description ?? '').toLowerCase();
    const perQuarter = /per quarter|every quarter|\/qtr\b|\bqtr\b|quarterly/.test(desc);
    const perYear = /per year|\/yr\b|annual|yearly/.test(desc);
    let monthly: number;
    if (perQuarter) monthly = row.copay / 3;
    else if (perYear) monthly = row.copay / 12;
    else monthly = row.copay;
    coverage_amount = Math.round(monthly);
    if (max_coverage == null) max_coverage = Math.round(monthly * 12);
  }

  // Vision normalization → annual. Some plans file biennial; halve so
  // the dropdown's "/yr" label matches the value.
  if (row.benefit_type === 'vision_allowance' && typeof row.copay === 'number' && row.copay > 0) {
    const desc = (row.description ?? '').toLowerCase();
    const biennial = /every 2 years|every 24 months|every two years|biennial/.test(desc);
    const annual = biennial ? Math.round(row.copay / 2) : row.copay;
    coverage_amount = annual;
    if (max_coverage == null) max_coverage = annual;
  }

  return {
    contract_id,
    plan_id,
    segment_id,
    benefit_category: category,
    benefit_description: row.description,
    coverage_amount,
    copay,
    coinsurance: row.coinsurance,
    max_coverage,
  };
}

// Dollar-from-description parse. Some sb_ocr / medicare_gov rows file
// the dollar value only in the description string ("$1,600 annual
// allowance for covered dental services") with copay/coverage_amount
// null. Pull the LARGEST $-amount in the text — supplemental copy
// commonly leads with a per-visit copay before the meaningful annual
// number.
const DESC_DOLLAR_CATEGORIES: ReadonlySet<string> = new Set([
  'dental',
  'hearing',
  'vision',
  'otc',
  'transportation',
  'food_card',
]);
const DESC_DOLLAR_RE = /\$(\d[\d,]*)/g;
function dollarFromDesc(desc: string | null | undefined): number | null {
  if (typeof desc !== 'string' || !desc) return null;
  let max = 0;
  for (const m of desc.matchAll(DESC_DOLLAR_RE)) {
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max > 0 ? max : null;
}

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
    if (s.includes('D-SNP') || s.includes('DSNP') || s.includes('DUAL')) return 'DSNP';
    if (s.includes('C-SNP') || s.includes('CSNP') || s.includes('CHRONIC')) return 'CSNP';
    if (s.includes('I-SNP') || s.includes('ISNP') || s.includes('INSTITUTIONAL')) return 'ISNP';
    // snp=true but snp_type missing or unrecognized — treat as DSNP so
    // MAPD/CSNP filters exclude it. The brain still sees plan_type
    // contains "SNP" via the raw passthrough.
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

    // ─── Non-commissionable exclusions ──────────────────────────────
    // Mirror the consumer flow: fetch the (contracts, plans) Rob can't
    // sell, push the contract-level set into the pm_plans query as a
    // PostgREST `contract_id=not.in.(…)` filter, and apply the plan-
    // level set in JS after the rows return. Fails closed on cold-
    // start lookup error so Rob never sees plans he can't write.
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return serverError(
        res,
        new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing'),
      );
    }
    const nonComm = await getNonCommissionableSets(supabaseUrl, supabaseKey);

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

    if (nonComm.contracts.size > 0) {
      plansQuery = plansQuery.not(
        'contract_id',
        'in',
        `(${[...nonComm.contracts].join(',')})`,
      );
    }

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

    // Plan-level non-commissionable exclusion. PostgREST already
    // dropped the contract-level blocks above; this strips the
    // remaining (contract_id, plan_id) pairs Rob can't sell — UHC
    // convention where only specific plans within a contract are
    // blocked, not the whole contract.
    rows = filterPlanLevelExclusions(rows, nonComm.plans);

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

    // ─── Step 3b: fetch pbp_benefits fallback for extras + MH/PT ────
    // pm_plan_benefits is empty for mental_health_individual,
    // mental_health_group, physical_therapy, and frequently for OTC /
    // food card too. The pbp_federal extract + medicare.gov scrape
    // both land in pbp_benefits, but they store plan_id in 2-part
    // form ("H1036-335") or 3-part-with-1ch-segment ("H5253-187-0"),
    // never the API's 3-part-with-3ch form. We probe both shapes and
    // index everything under the canonical 2-part key so the lookup
    // in buildBenefits doesn't have to know which scraper wrote each
    // row.
    const tripleKeys = [...byTriple.keys()];
    const pbpKeyVariants = new Set<string>();
    for (const k of tripleKeys) {
      pbpKeyVariants.add(k);                    // H1036-335-000 (rare)
      pbpKeyVariants.add(normalizePbpKey(k));   // H1036-335 (most rows)
      const parts = k.split('-');
      if (parts.length >= 3) {
        // Strip leading zeros from segment so '000' → '0' (174 rows
        // use this single-digit form).
        const seg1 = parts[2].replace(/^0+/, '') || '0';
        pbpKeyVariants.add(`${parts[0]}-${parts[1]}-${seg1}`);
      }
    }
    const pbpTypes = [...PBP_FALLBACK_TYPES, PBP_DENTAL_MAX_TYPE, PBP_OTC_TYPE, PBP_FOOD_CARD_TYPE];
    const { data: pbpRows, error: pbpErr } = await sb
      .from('pbp_benefits')
      .select('plan_id, benefit_type, copay, coinsurance, tier_id, description')
      .in('plan_id', [...pbpKeyVariants])
      .in('benefit_type', pbpTypes);
    if (pbpErr) throw pbpErr;
    const pbpFallback = buildPbpFallback((pbpRows ?? []) as PbpBenefitRow[]);

    // ─── Step 3c: broad pbp_benefits merge (parity with consumer) ────
    // The narrow Step 3b above only feeds mental_health / PT /
    // dental_max into a side-channel fallback. The consumer's
    // /api/plans-with-extras has always pulled ALL pbp rows with
    // source IN (medicare_gov, sb_ocr, manual) and merged them as
    // first-class benefit rows — that's how vision_allowance copays,
    // dental_comprehensive desc-dollar parses, and authoritative
    // imaging copays land in the consumer Results page.
    //
    // Shape parity: transform each pbp row to the pm_plan_benefits
    // row shape via PBP_TYPE_TO_CATEGORY, dedupe by source priority,
    // backfill from landscape + description-dollar parse, then merge
    // with PBP winning on (triple, category). buildBenefits below
    // operates on the merged set.
    const { data: broadPbpRaw, error: broadPbpErr } = await sb
      .from('pbp_benefits')
      .select('plan_id, benefit_type, copay, copay_max, coinsurance, tier_id, description, source')
      .in('plan_id', [...pbpKeyVariants])
      .in('source', ['medicare_gov', 'sb_ocr', 'manual']);
    if (broadPbpErr) throw broadPbpErr;
    const broadPbpRows = (broadPbpRaw ?? []) as PbpRichRow[];

    // Source-priority dedup: when multiple sources file the same
    // (plan_id, benefit_type, tier_id), keep the highest-rank row.
    // medicare_gov wins by default, manual wins for OTC/food_card.
    const bestByKey = new Map<string, PbpRichRow>();
    for (const row of broadPbpRows) {
      const key = `${row.plan_id}|${row.benefit_type}|${row.tier_id ?? 0}`;
      const prior = bestByKey.get(key);
      if (
        !prior ||
        sourceRank(row.source, row.benefit_type) > sourceRank(prior.source, prior.benefit_type)
      ) {
        bestByKey.set(key, row);
      }
    }

    // Map canonical 2-part pbp keys back to each finalist's full triple
    // so the synthesized rows carry the same contract/plan/segment the
    // landscape rows do — required for the merge keying below.
    const planByCanonical = new Map<string, { contract_id: string; plan_id: string; segment_id: string }>();
    for (const k of byTriple.keys()) {
      const parts = k.split('-');
      planByCanonical.set(`${parts[0]}-${parts[1]}`, {
        contract_id: parts[0],
        plan_id: parts[1],
        segment_id: parts[2] || '000',
      });
    }

    const synthBenefits: BenefitRow[] = [];
    for (const row of bestByKey.values()) {
      const canonical = normalizePbpKey(row.plan_id);
      const plan = planByCanonical.get(canonical);
      if (!plan) continue;
      const t = transformPbpRow(row, plan.contract_id, plan.plan_id, plan.segment_id);
      if (t) synthBenefits.push(t);
    }

    // Backfill coverage_amount + max_coverage on the synthetic rows
    // from the matching landscape row when the supplemental source
    // didn't carry a numeric dollar (sb_ocr commonly files only the
    // marketing description for non-allowance categories like
    // dental_comprehensive — see plans-with-extras for the full
    // rationale).
    const landscapeRows = (benefitRows ?? []) as BenefitRow[];
    const landscapeByKey = new Map<string, BenefitRow>();
    for (const b of landscapeRows) {
      const triple = `${b.contract_id}-${b.plan_id}-${b.segment_id || '000'}`;
      landscapeByKey.set(`${triple}|${b.benefit_category}`, b);
    }
    for (const b of synthBenefits) {
      if (b.coverage_amount != null && b.max_coverage != null) continue;
      const triple = `${b.contract_id}-${b.plan_id}-${b.segment_id || '000'}`;
      const land = landscapeByKey.get(`${triple}|${b.benefit_category}`);
      if (!land) continue;
      if (b.coverage_amount == null && land.coverage_amount != null) {
        b.coverage_amount = land.coverage_amount;
      }
      if (b.max_coverage == null && land.max_coverage != null) {
        b.max_coverage = land.max_coverage;
      }
    }

    // Description-dollar parse: when both structured fields and the
    // landscape backfill leave coverage_amount null but the marketing
    // description carries the value ("$1,600 annual allowance for
    // covered dental services"), pull the largest dollar amount and
    // use it. Mirrors consumer behavior — Aetna H3146-004's $1,600
    // dental cap only lives in the description.
    for (const b of synthBenefits) {
      if (b.coverage_amount != null) continue;
      if (!DESC_DOLLAR_CATEGORIES.has(b.benefit_category)) continue;
      const parsed = dollarFromDesc(b.benefit_description);
      if (parsed == null) continue;
      if (b.benefit_category === 'otc') {
        const desc = (b.benefit_description ?? '').toLowerCase();
        const perMonth = /per month|\/mo\b|monthly/.test(desc);
        const perQuarter = /per quarter|every quarter|\/qtr\b|\bqtr\b|quarterly/.test(desc);
        const perYear = /per year|\/yr\b|annual|yearly/.test(desc);
        let monthly = parsed;
        if (perQuarter) monthly = parsed / 3;
        else if (perYear) monthly = parsed / 12;
        else if (perMonth) monthly = parsed;
        b.coverage_amount = Math.round(monthly * 3);
        if (b.max_coverage == null) b.max_coverage = Math.round(monthly * 12);
      } else {
        b.coverage_amount = parsed;
      }
    }
    // Same desc-dollar parse for the landscape rows that survive the
    // merge, so plans whose pm_plan_benefits dental row carries only a
    // description ("Preventive + comprehensive dental · $45 copay")
    // also pick up a dollar value when one is parseable.
    for (const b of landscapeRows) {
      if (b.coverage_amount != null) continue;
      if (!DESC_DOLLAR_CATEGORIES.has(b.benefit_category)) continue;
      const parsed = dollarFromDesc(b.benefit_description);
      if (parsed != null) b.coverage_amount = parsed;
    }

    // Merge: PBP wins on (triple, category). Drop the matching
    // landscape row so the buildBenefits flatten path sees one
    // authoritative entry per category.
    const pbpKeyset = new Set(
      synthBenefits.map(
        (b) => `${b.contract_id}-${b.plan_id}-${b.segment_id || '000'}|${b.benefit_category}`,
      ),
    );
    const mergedRows: BenefitRow[] = [
      ...landscapeRows.filter(
        (b) => !pbpKeyset.has(
          `${b.contract_id}-${b.plan_id}-${b.segment_id || '000'}|${b.benefit_category}`,
        ),
      ),
      ...synthBenefits,
    ];

    // Re-index merged rows by triple so buildBenefits below picks them
    // up via the existing per-plan lookup.
    const mergedBenefitsByTriple = new Map<string, BenefitRow[]>();
    for (const b of mergedRows) {
      const triple = `${b.contract_id}-${b.plan_id}-${b.segment_id || '000'}`;
      const list = mergedBenefitsByTriple.get(triple) ?? [];
      list.push(b);
      mergedBenefitsByTriple.set(triple, list);
    }

    // ─── Step 4: shape into Plan[] ──────────────────────────────────
    const plans: Plan[] = [];
    for (const [key, { row, counties }] of byTriple) {
      // Use the merged benefits set (landscape + transformed pbp)
      // instead of the raw landscape rows — that's the parity fix
      // with the consumer's plans-with-extras endpoint.
      const benefits = buildBenefits(
        mergedBenefitsByTriple.get(key) ?? [],
        pbpFallback.get(normalizePbpKey(key)),
      );
      const partBGiveback = pickBenefitNumber(
        mergedBenefitsByTriple.get(key) ?? [],
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
// OTC period detection — pbp_benefits.description carries strings like
// "OTC quarterly", "OTC monthly", "OTC yearly" or "$25 allowance" /
// "OTC allowance". Returns the multiplier to convert the copay value
// into a quarterly equivalent. Defaults to 1 (already quarterly) when
// the description is silent — that matches the most common pbp shape.
function otcQuarterlyMultiplier(description: string | null): number {
  if (!description) return 1;
  const d = description.toLowerCase();
  if (d.includes('monthly') || d.includes('per month') || d.includes('/mo')) return 3;
  if (d.includes('yearly') || d.includes('annual') || d.includes('/yr')) return 1 / 4;
  if (d.includes('quarterly') || d.includes('/qtr')) return 1;
  return 1;
}

// food_card period detection — most rows are monthly per the spec
// (pm_plan_benefits.coverage_amount is already monthly when filed). The
// pbp scraper sometimes writes quarterly. We normalize to monthly here
// to match the Plan.benefits.food_card.allowance_per_month contract.
function foodCardMonthlyMultiplier(description: string | null): number {
  if (!description) return 1;
  const d = description.toLowerCase();
  if (d.includes('quarterly') || d.includes('/qtr')) return 1 / 3;
  if (d.includes('yearly') || d.includes('annual') || d.includes('/yr')) return 1 / 12;
  return 1;
}

function buildPbpFallback(rows: PbpBenefitRow[]): PbpFallbackMap {
  // All groupings keyed by the canonical 2-part form ("H1036-335") so
  // the lookup in buildBenefits doesn't have to care which form a
  // particular scraper wrote.
  const csGrouped = new Map<string, Map<PbpFallbackType, PbpBenefitRow[]>>();
  const dentalMaxByPlan = new Map<string, number>();
  const otcQuarterlyByPlan = new Map<string, number>();
  const otcDescByPlan = new Map<string, string>();
  const foodCardMonthlyByPlan = new Map<string, number>();
  const foodCardDescByPlan = new Map<string, string>();

  for (const r of rows) {
    const key = normalizePbpKey(r.plan_id);
    if ((PBP_FALLBACK_TYPES as readonly string[]).includes(r.benefit_type)) {
      const byType = csGrouped.get(key) ?? new Map<PbpFallbackType, PbpBenefitRow[]>();
      const list = byType.get(r.benefit_type as PbpFallbackType) ?? [];
      list.push(r);
      byType.set(r.benefit_type as PbpFallbackType, list);
      csGrouped.set(key, byType);
    } else if (r.benefit_type === PBP_DENTAL_MAX_TYPE) {
      const v = toNum(r.copay);
      if (v != null && v > 0) dentalMaxByPlan.set(key, v);
    } else if (r.benefit_type === PBP_OTC_TYPE) {
      const v = toNum(r.copay);
      if (v != null && v > 0) {
        const qtr = Math.round(v * otcQuarterlyMultiplier(r.description));
        if (qtr > 0) otcQuarterlyByPlan.set(key, qtr);
      }
      if (r.description) otcDescByPlan.set(key, r.description);
    } else if (r.benefit_type === PBP_FOOD_CARD_TYPE) {
      const v = toNum(r.copay);
      if (v != null && v > 0) {
        const mo = Math.round(v * foodCardMonthlyMultiplier(r.description));
        if (mo > 0) foodCardMonthlyByPlan.set(key, mo);
      }
      if (r.description) foodCardDescByPlan.set(key, r.description);
    }
  }

  const out: PbpFallbackMap = new Map();
  const planIds = new Set([
    ...csGrouped.keys(),
    ...dentalMaxByPlan.keys(),
    ...otcQuarterlyByPlan.keys(),
    ...otcDescByPlan.keys(),
    ...foodCardMonthlyByPlan.keys(),
    ...foodCardDescByPlan.keys(),
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
      otcDescription: otcDescByPlan.get(planId),
      foodCardMonthly: foodCardMonthlyByPlan.get(planId),
      foodCardDescription: foodCardDescByPlan.get(planId),
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
          : pbpFallback?.otcDescription
            ? pbpFallback.otcDescription
            : null),
    },
    food_card: {
      allowance_per_month: foodCardMonthly,
      restricted_to_medicaid_eligible: false,
      description:
        foodCard?.benefit_description ??
        (pbpFallback?.foodCardMonthly && pbpFallback.foodCardMonthly > 0
          ? `$${pbpFallback.foodCardMonthly}/mo food card`
          : pbpFallback?.foodCardDescription
            ? pbpFallback.foodCardDescription
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
