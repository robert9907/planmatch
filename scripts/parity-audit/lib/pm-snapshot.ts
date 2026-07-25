// PM snapshot builder — produces a typed PlanSnapshot from the Plan
// Match Supabase DB for a given BeneficiaryProfile. Consumed by the
// parity-audit diff engine alongside an MPF-scraped counterpart.
//
// Query surface mirrors api/plans.ts:
//   • pm_plans                → identification + premium/MOOP/deductible
//   • pm_plan_benefits        → medical + supplemental copays
//   • pbp_benefits_v2         → fallback for categories pm_plan_benefits
//                                doesn't file (mental_health_*, PT, etc.)
//   • pm_formulary_v2         → per-drug tier + PA/QL/ST flags
//                                (copay_default $, coinsurance_default 0..1
//                                fraction; NOT percent — writes go to base
//                                pm_formulary_v2, reads via pm_formulary view)
//
// Env pattern is intentionally identical to scripts/_template-probe.ts.
// paginate() helper is copied inline per parity-audit style.

import { createClient, type PostgrestSingleResponse } from '@supabase/supabase-js';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  BeneficiaryProfile,
  Drug,
  DrugCoverage,
  InpatientCostSharing,
  LISLevel,
  MedicaidStatus,
  OtherMedical,
  OutpatientCostSharing,
  PlanIdentification,
  PlanSnapshot,
  PremiumAndDeductible,
  RxPhases,
  RxStructure,
  RxTierCostSharing,
  SupplementalBenefits,
  TherapyAndDme,
  Tier,
  DentalBenefits,
  VisionBenefits,
  HearingBenefits,
} from '../types.js';

// ─── .env.local loader (no dotenv dep — matches _template-probe.ts) ──
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const supabaseUrl = process.env.SUPABASE_URL ?? '';
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  '';

// Deferred client — module import must not throw when env is absent
// (types.ts import chain runs during `tsc --noEmit`). The functions
// below construct on first call and fail loudly if env is missing.
let _sb: ReturnType<typeof createClient> | null = null;
function sb() {
  if (_sb) return _sb;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      'pm-snapshot: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing (expected .env.local at cwd)',
    );
  }
  _sb = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _sb;
}

// ─── Paginated fetch helper (defeats PostgREST's 1000-row cap) ────
// Note: pm_formulary can return 3–5K rows per (contract, plan) — the
// Wellcare PDPs (S4802-*) alone contribute ~3200 each. For a 7-plan set
// the cross-contract query can exceed 20K rows, silently truncating the
// tail of the contract sort (S* comes after H*) and dropping all Wellcare
// formulary rows. MAX_PAGES=50 covers up to 50K rows to accommodate the
// full 7-plan Margaret run plus headroom for larger regimens.
async function paginate<T>(
  pageFn: (from: number, to: number) => PromiseLike<PostgrestSingleResponse<T[]>>,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  const MAX_PAGES = 50;
  for (let pageNum = 0; pageNum < MAX_PAGES; pageNum += 1) {
    const from = pageNum * PAGE;
    const to = from + PAGE - 1;
    const { data, error } = await pageFn(from, to);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

// ─── Types matching the DB row shapes we consume ─────────────────────

interface PmPlanRow {
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
  dsnp_accepted_populations: string[] | null;
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
  source?: string | null;         // preserved from pbp_benefits_v2 for source-rank preference
}

interface PbpV2Row {
  contract_id: string;
  plan_id: string;
  segment_id: string | null;
  benefit_type: string;
  copay: number | null;
  copay_max: number | null;
  coinsurance: number | null;
  tier_id: string | null;
  description: string | null;
  source: string | null;
}

interface FormularyRow {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  rxcui: string;
  tier: number;
  copay_default: number | null;
  coinsurance_default: number | null;
  prior_auth: boolean;
  step_therapy: boolean;
  quantity_limit: boolean;
  quantity_limit_amount: number | null;
  quantity_limit_days: number | null;
  drug_type: string | null; // 'generic' | 'brand' | 'specialty' | null (mig 017)
  drug_name: string | null; // joined from pm_rxcui_meta via pm_formulary view
}

// ─── LIS schedule (CY2026) ───────────────────────────────────────────
//
// Post-IRA §11404 (effective 2024) there is no partial-LIS tier. Everyone
// previously on partial LIS is now on full LIS at one of two income bands:
//   full_low  ≤100% FPL              → $1.60 generic / $4.90 brand
//   full_high >100%–150% FPL         → $5.10 generic / $12.65 brand
// See src/lib/dual-eligible.ts and CMS Oct 2025 LIS Memo.
//
// Advisory only: when profile.medicaid resolves to fbde/qmb/etc we prefer
// the deemed tier; profile.lis wins when medicaid=none.
type PmLisTier = 'none' | 'full_institutional' | 'qmb_uniform' | 'full_low' | 'full_high';

const LIS_COPAYS_2026: Record<Exclude<PmLisTier, 'none'>, { generic: number; brand: number }> = {
  full_institutional: { generic: 0, brand: 0 },
  qmb_uniform: { generic: 4.90, brand: 4.90 },
  full_low: { generic: 1.60, brand: 4.90 },
  full_high: { generic: 5.10, brand: 12.65 },
};

function deriveLisTier(profile: BeneficiaryProfile): PmLisTier {
  // Medicaid auto-deem overrides profile.lis (matches AUTO_DEEM_LIS_TIER
  // in src/lib/dual-eligible.ts). We assume community setting.
  const medicaid: MedicaidStatus = profile.medicaid;
  // QMB + full Medicaid (fbde) and standalone QMB both get the $4.90 flat
  // uniform copay per CY2026 CMS LIS memo Table 2.
  if (medicaid === 'full-dual' || medicaid === 'qmb') return 'qmb_uniform';
  // SLMB and QI auto-qualify for full LIS but not the QMB uniform rate.
  if (medicaid === 'slmb' || medicaid === 'qi') return 'full_high';
  // qdwi does not auto-deem LIS — fall through to profile.lis.
  const lis: LISLevel = profile.lis;
  if (lis === 'none') return 'none';
  // Non-QMB full LIS: assume ≤100% FPL band without a profile.lisIncomeBand
  // field. Add that field if diff scoring needs to distinguish >100-150% FPL.
  return 'full_low';
}

function qmbLikeZerosMedicare(medicaid: MedicaidStatus): boolean {
  return medicaid === 'qmb' || medicaid === 'full-dual';
}

// ─── PART B drug detection via profile ───────────────────────────────
function isPartBOnly(drug: Drug): boolean {
  return drug.part === 'part-b';
}

// ─── Small helpers ───────────────────────────────────────────────────

function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeSeg(seg: string | null | undefined): string {
  const s = String(seg ?? '0').replace(/^0+/, '');
  return s || '0';
}

function padSeg(seg: string): string {
  return seg.padStart(3, '0');
}

function tripleKey(contract: string, plan: string, seg: string): string {
  return `${contract}-${plan}-${padSeg(seg)}`;
}

// ─── Category resolution — mirror api/plans.ts CATEGORY_ALIAS ────────

const CATEGORY_ALIAS: Record<string, string> = {
  lab_services: 'lab',
  outpatient_surgery_hospital: 'outpatient_surgery',
  outpatient_surgery_asc: 'asc',
  mental_health_individual: 'mental_health_outpatient_individual',
  mental_health_group: 'mental_health_outpatient_group',
};

// pbp_benefits_v2.benefit_type → pm_plan_benefits.benefit_category —
// same map api/plans.ts uses for fallback synth rows.
const PBP_TYPE_TO_CATEGORY: Record<string, string> = {
  primary_care_visit: 'primary_care',
  inpatient_hospital: 'inpatient',
  emergency_room: 'emergency',
  urgent_care: 'urgent_care',
  specialist_visit: 'specialist',
  lab_diagnostic: 'lab',
  imaging: 'advanced_imaging',
  outpatient_surgery: 'outpatient_surgery',
  outpatient_surgery_asc: 'asc',
  outpatient_surgery_hospital: 'outpatient_surgery',
  ambulance: 'ambulance',
  // Phase 2e: keep dental subcategories DISTINCT so buildDental can pick
  // the specific row MPF displays (typically dental_cleaning or
  // dental_oral_exam for the preventive copay MPF shows on plan detail).
  dental_comprehensive: 'dental_comprehensive',
  dental_preventive: 'dental_preventive',
  dental_cleaning: 'dental_cleaning',
  dental_oral_exam: 'dental_oral_exam',
  dental_xray: 'dental_xray',
  benefit_preventive_dental__other_diagnostic_services: 'dental_preventive_other',
  benefit_preventive_dental__service_fluoride_treatment: 'dental_fluoride',
  benefit_comprehensive_dental__implant_services: 'dental_implants',
  benefit_comprehensive_dental__orthodontics: 'dental_orthodontics',
  benefit_comprehensive_dental__maxillofacial_prosthetics: 'dental_maxillofacial',
  dental_adjunctive: 'dental_adjunctive',
  hearing_aid: 'hearing_aid',
  // Vision granularity
  benefit_vision__vision_eyeglasses_frames: 'vision_frames',
  benefit_vision__vision_eyeglasses_lenses: 'vision_lenses',
  benefit_vision__vision_upgrades: 'vision_upgrades',
  vision_exam: 'vision_exam',
  vision_allowance: 'vision_allowance',
  hearing_exam: 'hearing_exam',
  hearing_aid_allowance: 'hearing',
  otc_allowance: 'otc',
  food_card: 'food_card',
  transportation: 'transportation',
  fitness: 'fitness',
  telehealth: 'telehealth',
  mental_health_individual: 'mental_health_outpatient_individual',
  mental_health_group: 'mental_health_outpatient_group',
  physical_therapy: 'physical_speech_therapy',
  inpatient_psych: 'mental_health_inpatient',
  chiropractic: 'chiropractic',
  // Phase 1 additions (verified via _probe-phase1.ts):
  home_health: 'home_health',
  dialysis: 'dialysis',
  // Worldwide emergency lives in benefit_type='worldwide_emergency_coverage'
  // etc — probe shows 14K rows ilike '%worldwide%' in pbp; hitting the exact
  // benefit_type names for the SPEC field 93 mapping.
  worldwide_emergency: 'worldwide_emergency',
  worldwide_emergency_coverage: 'worldwide_emergency',
  // Phase 1b (2026-07-24): pbp has vision_contacts as a distinct benefit_type
  // — was previously bundled into vision_eyewear on PM side. MPF returns
  // eyewear + contacts separately (spec §3.11 field 79).
  vision_contacts: 'vision_contacts',
  vision_eyewear: 'vision',
  occupational_therapy: 'occupational_therapy',
  podiatry: 'podiatry',
};

// Score-based row selection for benefit categories that have multiple
// rows (pm_plan_benefits + pbp_benefits_v2 merge appends fallback rows;
// pbp itself often has duplicates per benefit_type). Empirically-verified
// heuristic from _probe-margaret-copays.ts:
//   • Rows with description text are curated (from sb-pipeline or landscape
//     enrichment); no-description rows are typically bare CMS-import stubs.
//     Prefer description +2.
//   • Rows with a non-zero copay or coinsurance are real values; $0/null
//     duplicates are usually import placeholders. Prefer real +1.
// Highest score wins; ties break on first match (arbitrary but stable).
// Category families where source-rank tiebreaker helps parity:
// medicare_gov-scraped rows should beat cms_pbp stubs when both exist for
// the same benefit_category. This matters for dental/vision (multiple
// per-service rows with different copays across sources) but caused
// regressions on SNF/inpatient/supplemental (bare medicare_gov rows won
// over descriptive landscape rows the day-tier parser needs).
const SOURCE_RANK_CATEGORIES = /^(dental|vision|hearing)($|_)/;

function pickBestRow(rows: BenefitRow[], category: string): BenefitRow | null {
  const aliased = CATEGORY_ALIAS[category] ?? category;
  const matches = rows.filter(
    (r) => r.benefit_category === aliased || r.benefit_category === category,
  );
  if (matches.length === 0) return null;
  const useSourceRank = SOURCE_RANK_CATEGORIES.test(aliased);
  const scored = matches.map((r) => {
    const copay = toNum(r.copay);
    const coins = toNum(r.coinsurance);
    const hasReal = (copay ?? 0) > 0 || (coins ?? 0) > 0;
    const hasDesc = !!r.benefit_description && r.benefit_description.trim().length > 0;
    const sourceRankVal = useSourceRank
      ? (r.source ? (SOURCE_PRIORITY[r.source] ?? 0) : 2)
      : 0;
    return {
      r,
      score: (hasDesc ? 2 : 0) + (hasReal ? 1 : 0),
      sourceRank: sourceRankVal,
    };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.sourceRank - a.sourceRank;
  });
  return scored[0].r;
}

// pm_plan_benefits often stores a range: copay=min, max_coverage=max
// (e.g. Lab services $10–$20 → copay:10, max_coverage:20). MPF's
// /plan-compare API returns cost_sharing.max_copay for these ranges, so
// we prefer max_coverage when it exceeds copay to match MPF's display
// convention. Verified via _probe-trace-lab.ts against H9808-009-000.
function extractRangeCopay(row: BenefitRow): number | null {
  const copay = toNum(row.copay);
  const maxCov = toNum(row.max_coverage);
  if (maxCov != null && copay != null && maxCov > copay) return maxCov;
  return copay;
}

function costShareFromRows(
  rows: BenefitRow[],
  category: string,
): { copay: number | null; coinsurance: number | null; description: string | null } {
  const hit = pickBestRow(rows, category);
  if (!hit) return { copay: null, coinsurance: null, description: null };
  return {
    copay: extractRangeCopay(hit),
    coinsurance: toNum(hit.coinsurance),
    description: hit.benefit_description ?? null,
  };
}

function coverageAmountFor(rows: BenefitRow[], category: string): number | null {
  const hit = pickBestRow(rows, category);
  if (!hit) return null;
  return toNum(hit.coverage_amount) ?? toNum(hit.max_coverage);
}

function maxCoverageFor(rows: BenefitRow[], category: string): number | null {
  const hit = pickBestRow(rows, category);
  if (!hit) return null;
  return toNum(hit.max_coverage) ?? toNum(hit.coverage_amount);
}

// ─── Inpatient day-tier parser (subset of src/lib/inpatient-format) ──
interface DayTier { copay: number; dayStart: number; dayEnd: number }
function parseInpatientTiers(description: string | null | undefined): DayTier[] {
  if (!description) return [];
  const tiers: DayTier[] = [];
  const RANGE_FIRST =
    /Days?\s+(\d+)\s*[–-]\s*(\d+)\s*:\s*\$\s*(\d+(?:\.\d+)?)\s*\/\s*day/gi;
  const AMOUNT_FIRST =
    /\$\s*(\d+(?:\.\d+)?)\s*\/\s*day\s*\(\s*days?\s+(\d+)\s*[–-]\s*(\d+)\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = RANGE_FIRST.exec(description)) !== null) {
    tiers.push({ dayStart: Number(m[1]), dayEnd: Number(m[2]), copay: Number(m[3]) });
  }
  while ((m = AMOUNT_FIRST.exec(description)) !== null) {
    tiers.push({ copay: Number(m[1]), dayStart: Number(m[2]), dayEnd: Number(m[3]) });
  }
  tiers.sort((a, b) => a.dayStart - b.dayStart);
  return tiers;
}

// ─── PBP v2 → synthetic BenefitRow (subset of api/plans.ts logic) ────

const PBP_ALLOWANCE_TYPES = new Set([
  'vision_allowance',
  'hearing_aid_allowance',
  'otc_allowance',
  'food_card',
  'transportation',
]);

function transformPbpRow(
  row: PbpV2Row,
  fallbackContract: string,
  fallbackPlan: string,
  fallbackSeg: string,
): BenefitRow | null {
  const category = PBP_TYPE_TO_CATEGORY[row.benefit_type];
  if (!category) return null;
  if (
    row.copay == null &&
    row.copay_max == null &&
    row.coinsurance == null &&
    (row.description == null || row.description.trim() === '')
  ) {
    return null;
  }
  const isAllowance = PBP_ALLOWANCE_TYPES.has(row.benefit_type);
  const coverage_amount = isAllowance ? row.copay : null;
  const collapsedCopay =
    row.copay === 0 && row.copay_max != null && row.copay_max > 0
      ? row.copay_max
      : row.copay;
  const copay = isAllowance ? null : collapsedCopay;
  return {
    contract_id: row.contract_id ?? fallbackContract,
    plan_id: row.plan_id ?? fallbackPlan,
    segment_id: padSeg(normalizeSeg(row.segment_id ?? fallbackSeg)),
    benefit_category: category,
    benefit_description: row.description,
    coverage_amount,
    copay,
    coinsurance: row.coinsurance,
    max_coverage: row.copay_max,
    source: row.source,
  };
}

// Source priority — same table as api/plans.ts. medicare_gov wins by
// default; carrier-authoritative categories flip the ordering.
const SOURCE_PRIORITY: Readonly<Record<string, number>> = {
  medicare_gov: 5,
  sb_ocr: 4,
  cms_pbp: 3,
  manual: 2,
  pbp_federal: 1,
};
const CARRIER_AUTH_TYPES: ReadonlySet<string> = new Set([
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
  const table = CARRIER_AUTH_TYPES.has(benefitType)
    ? SOURCE_PRIORITY_CARRIER
    : SOURCE_PRIORITY;
  return table[source] ?? 0;
}

// ─── Fetch rows for one plan-key set ─────────────────────────────────

async function fetchPlans(
  planKeys: Array<{ contractId: string; planId: string; segmentId: string }>,
): Promise<Map<string, PmPlanRow>> {
  if (planKeys.length === 0) return new Map();
  const contractIds = [...new Set(planKeys.map((k) => k.contractId))];
  const planIds = [...new Set(planKeys.map((k) => k.planId))];
  const rows = await paginate<PmPlanRow>((from, to) =>
    sb()
      .from('pm_plans')
      .select(
        'contract_id, plan_id, segment_id, plan_name, carrier, parent_organization, plan_type, state, county_name, monthly_premium, annual_deductible, moop, drug_deductible, star_rating, snp, snp_type, dsnp_accepted_populations, sanctioned',
      )
      .in('contract_id', contractIds)
      .in('plan_id', planIds)
      .order('contract_id', { ascending: true })
      .order('plan_id', { ascending: true })
      .order('segment_id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<PostgrestSingleResponse<PmPlanRow[]>>,
  );
  const want = new Set(
    planKeys.map((k) => tripleKey(k.contractId, k.planId, k.segmentId)),
  );
  const out = new Map<string, PmPlanRow>();
  for (const r of rows) {
    const key = tripleKey(r.contract_id, r.plan_id, r.segment_id || '000');
    if (!want.has(key)) continue;
    if (!out.has(key)) out.set(key, r);
  }
  return out;
}

async function fetchBenefitsByTriple(
  planKeys: Array<{ contractId: string; planId: string; segmentId: string }>,
): Promise<Map<string, BenefitRow[]>> {
  if (planKeys.length === 0) return new Map();
  const contractIds = [...new Set(planKeys.map((k) => k.contractId))];
  const planIds = [...new Set(planKeys.map((k) => k.planId))];
  const rows = await paginate<BenefitRow>((from, to) =>
    sb()
      .from('pm_plan_benefits')
      .select(
        'contract_id, plan_id, segment_id, benefit_category, benefit_description, coverage_amount, copay, coinsurance, max_coverage',
      )
      .in('contract_id', contractIds)
      .in('plan_id', planIds)
      .order('contract_id', { ascending: true })
      .order('plan_id', { ascending: true })
      .order('segment_id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<PostgrestSingleResponse<BenefitRow[]>>,
  );
  const map = new Map<string, BenefitRow[]>();
  for (const r of rows) {
    const key = tripleKey(r.contract_id, r.plan_id, r.segment_id || '000');
    const list = map.get(key) ?? [];
    list.push(r);
    map.set(key, list);
  }
  return map;
}

async function fetchPbpFallback(
  planKeys: Array<{ contractId: string; planId: string; segmentId: string }>,
): Promise<Map<string, BenefitRow[]>> {
  // pbp_benefits is a compatibility VIEW; the base table pbp_benefits_v2
  // carries the authoritative segment_id column. Read from v2 so we can
  // match segment-tagged medicare_gov rows to the exact plan key.
  if (planKeys.length === 0) return new Map();
  const contractIds = [...new Set(planKeys.map((k) => k.contractId))];
  const planIds = [...new Set(planKeys.map((k) => k.planId))];
  const rows = await paginate<PbpV2Row>((from, to) =>
    sb()
      .from('pbp_benefits_v2')
      .select(
        'contract_id, plan_id, segment_id, benefit_type, copay, copay_max, coinsurance, tier_id, description, source',
      )
      .in('contract_id', contractIds)
      .in('plan_id', planIds)
      .in('source', ['medicare_gov', 'sb_ocr', 'cms_pbp', 'manual'])
      .order('contract_id', { ascending: true })
      .order('plan_id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<PostgrestSingleResponse<PbpV2Row[]>>,
  );
  // Source-priority dedup per (triple, benefit_type, tier_id).
  const best = new Map<string, PbpV2Row>();
  for (const r of rows) {
    const seg = padSeg(normalizeSeg(r.segment_id ?? '0'));
    const key = `${r.contract_id}-${r.plan_id}-${seg}|${r.benefit_type}|${r.tier_id ?? ''}`;
    const prior = best.get(key);
    if (
      !prior ||
      sourceRank(r.source, r.benefit_type) > sourceRank(prior.source, prior.benefit_type)
    ) {
      best.set(key, r);
    }
  }
  const want = new Set(
    planKeys.map((k) => tripleKey(k.contractId, k.planId, k.segmentId)),
  );
  const map = new Map<string, BenefitRow[]>();
  for (const r of best.values()) {
    const seg = padSeg(normalizeSeg(r.segment_id ?? '0'));
    const key = `${r.contract_id}-${r.plan_id}-${seg}`;
    if (!want.has(key)) continue;
    const t = transformPbpRow(r, r.contract_id, r.plan_id, seg);
    if (!t) continue;
    const list = map.get(key) ?? [];
    list.push(t);
    map.set(key, list);
  }
  return map;
}

// Row shape as returned by the pm_formulary view (copay/coinsurance
// columns are the view-level aliases of pm_formulary_v2.copay_default /
// coinsurance_default). We normalize to FormularyRow inline.
interface PmFormularyViewRow {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  rxcui: string;
  tier: number;
  copay: number | null;
  coinsurance: number | null;
  prior_auth: boolean;
  step_therapy: boolean;
  quantity_limit: boolean;
  quantity_limit_amount: number | null;
  quantity_limit_days: number | null;
  drug_type: string | null;
  drug_name: string | null;
}

// Phase 1b (2026-07-24): pm_beneficiary_cost_v2 has the FULL pref/nonpref
// × 30/mail-90 matrix (692K rows). Fetch initial-coverage rows
// (coverage_level=0) and expose per-tier as a canonical 4-way split.
interface RxTierMatrix {
  preferred30: number | null;
  standard30: number | null;
  preferredMail90: number | null;
  standardMail90: number | null;
  isCoinsurance: boolean;
  deductibleApplies: boolean | null;
}

async function fetchBeneficiaryCostByPlan(
  planKeys: Array<{ contractId: string; planId: string; segmentId: string }>,
): Promise<Map<string, Map<number, RxTierMatrix>>> {
  const out = new Map<string, Map<number, RxTierMatrix>>();
  if (planKeys.length === 0) return out;
  const contractIds = [...new Set(planKeys.map((k) => k.contractId))];
  const planIds = [...new Set(planKeys.map((k) => k.planId))];
  // Phase 2d fix: coverage_level varies by plan — H9808-010 (MAPD) uses
  // level=0, S4802-143 (PDP) uses level=1. Fetch both non-catastrophic
  // levels and prefer level=1 when both exist (initial coverage phase
  // post-deductible in CMS SPUF spec). level=3 is catastrophic — skip.
  const rows = await paginate<{
    contract_id: string;
    plan_id: string;
    tier: number;
    days_supply_code: number;
    pharmacy_type: string;
    cost_type: number;
    cost_amount: number | null;
    coverage_level: number;
    deductible_applies: boolean | null;
  }>((from, to) =>
    sb()
      .from('pm_beneficiary_cost_v2')
      .select('contract_id, plan_id, tier, days_supply_code, pharmacy_type, cost_type, cost_amount, coverage_level, deductible_applies')
      .in('contract_id', contractIds)
      .in('plan_id', planIds)
      .in('coverage_level', [0, 1])
      .range(from, to) as unknown as PromiseLike<PostgrestSingleResponse<Array<{
        contract_id: string;
        plan_id: string;
        tier: number;
        days_supply_code: number;
        pharmacy_type: string;
        cost_type: number;
        cost_amount: number | null;
        coverage_level: number;
        deductible_applies: boolean | null;
      }>>>,
  );
  // Group by (plan, tier, level). Then per (plan, tier) pick the row set
  // that has actual coverage — prefer level=1 (post-deductible initial
  // coverage) over level=0 (pre-deductible / not-applied).
  const preferredLevelByPlanTier = new Map<string, number>();
  for (const r of rows) {
    if (r.tier < 1 || r.tier > 6) continue;
    const key = `${r.contract_id}-${r.plan_id}#${r.tier}`;
    const existing = preferredLevelByPlanTier.get(key);
    if (existing === undefined) preferredLevelByPlanTier.set(key, r.coverage_level);
    else if (r.coverage_level > existing) preferredLevelByPlanTier.set(key, r.coverage_level);
  }
  for (const r of rows) {
    if (r.tier < 1 || r.tier > 6) continue;
    const ptKey = `${r.contract_id}-${r.plan_id}#${r.tier}`;
    if (r.coverage_level !== preferredLevelByPlanTier.get(ptKey)) continue;
    const key = `${r.contract_id}-${r.plan_id}`;
    let byTier = out.get(key);
    if (!byTier) { byTier = new Map(); out.set(key, byTier); }
    let m = byTier.get(r.tier);
    if (!m) {
      m = {
        preferred30: null, standard30: null,
        preferredMail90: null, standardMail90: null,
        isCoinsurance: false, deductibleApplies: null,
      };
      byTier.set(r.tier, m);
    }
    // Phase 2d fix (was inverted): CMS SPUF cost_type per spec:
    //   0 = no cost sharing (amt should be 0)
    //   1 = copay (flat $)
    //   2 = coinsurance (fraction 0..1, e.g. 0.4 = 40%)
    // MPF stores coinsurance as PERCENT (40 for 40%) in its rxStructure
    // fields (see mpf-scrape.ts parseRxCell). Convert fractions to
    // percents so PM and MPF sides compare directly.
    const isCoins = r.cost_type === 2 && (r.cost_amount ?? 0) > 0;
    const val = isCoins ? (r.cost_amount ?? 0) * 100 : r.cost_amount;
    if (r.days_supply_code === 1 && r.pharmacy_type === 'pref') m.preferred30 = val;
    else if (r.days_supply_code === 1 && r.pharmacy_type === 'nonpref') m.standard30 = val;
    else if (r.days_supply_code === 2 && r.pharmacy_type === 'mail_pref') m.preferredMail90 = val;
    else if (r.days_supply_code === 2 && r.pharmacy_type === 'mail_nonpref') m.standardMail90 = val;
    if (isCoins) m.isCoinsurance = true;
    if (r.deductible_applies != null && m.deductibleApplies == null) m.deductibleApplies = r.deductible_applies;
  }
  return out;
}

// Phase 1: pull pbp rx_tier rows (benefit_type='rx_tier'), key by
// (contract-plan) → tier → RxTierSlots. Aggregates the tier_id variants:
// 'N'=30-day retail, 'N_90'=90-day retail, 'N_mail'=mail order.
// pm_formulary_v2 files at plan level (segment-agnostic).
async function fetchRxTiersByPlan(
  planKeys: Array<{ contractId: string; planId: string; segmentId: string }>,
): Promise<Map<string, Map<string, RxTierSlots>>> {
  const out = new Map<string, Map<string, RxTierSlots>>();
  if (planKeys.length === 0) return out;
  const contractIds = [...new Set(planKeys.map((k) => k.contractId))];
  const planIds = [...new Set(planKeys.map((k) => k.planId))];
  const rows = await paginate<{
    contract_id: string;
    plan_id: string;
    segment_id: string | null;
    tier_id: string | null;
    copay: number | null;
    coinsurance: number | null;
  }>((from, to) =>
    sb()
      .from('pbp_benefits_v2')
      .select('contract_id, plan_id, segment_id, tier_id, copay, coinsurance')
      .eq('benefit_type', 'rx_tier')
      .in('contract_id', contractIds)
      .in('plan_id', planIds)
      .range(from, to) as unknown as PromiseLike<PostgrestSingleResponse<Array<{
        contract_id: string;
        plan_id: string;
        segment_id: string | null;
        tier_id: string | null;
        copay: number | null;
        coinsurance: number | null;
      }>>>,
  );
  for (const r of rows) {
    if (!r.tier_id) continue;
    const key = `${r.contract_id}-${r.plan_id}`;
    let byTier = out.get(key);
    if (!byTier) { byTier = new Map(); out.set(key, byTier); }
    // Parse tier_id: 'N' | 'N_90' | 'N_mail' → tier + variant
    const m = /^([1-6])(?:_(90|mail))?$/.exec(r.tier_id);
    if (!m) continue;
    const tier = m[1];
    const variant = m[2] ?? '30';
    let slots = byTier.get(tier);
    if (!slots) { slots = emptyRxTierSlots(); byTier.set(tier, slots); }
    if (variant === '30') { slots.copay30 = r.copay; slots.coins30 = r.coinsurance; }
    else if (variant === '90') { slots.copay90 = r.copay; slots.coins90 = r.coinsurance; }
    else if (variant === 'mail') { slots.copayMail = r.copay; slots.coinsMail = r.coinsurance; }
  }
  return out;
}

async function fetchFormularyForDrugs(
  planKeys: Array<{ contractId: string; planId: string; segmentId: string }>,
  drugNames: string[],
): Promise<Map<string, FormularyRow[]>> {
  if (planKeys.length === 0 || drugNames.length === 0) return new Map();
  const contractIds = [...new Set(planKeys.map((k) => k.contractId))];
  const planIds = [...new Set(planKeys.map((k) => k.planId))];
  // Query the pm_formulary compatibility view — it joins pm_rxcui_meta so
  // drug_name is available in the projection. Coinsurance stored 0..1
  // in v2; the view surfaces it as `coinsurance` unchanged.
  const rows = await paginate<PmFormularyViewRow>((from, to) =>
    sb()
      .from('pm_formulary')
      .select(
        'contract_id, plan_id, segment_id, rxcui, tier, copay, coinsurance, prior_auth, step_therapy, quantity_limit, quantity_limit_amount, quantity_limit_days, drug_type, drug_name',
      )
      .in('contract_id', contractIds)
      .in('plan_id', planIds)
      .not('drug_name', 'is', null)
      .order('contract_id', { ascending: true })
      .order('plan_id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<PostgrestSingleResponse<PmFormularyViewRow[]>>,
  );
  // Client-side filter to the drug names on the profile (case-insensitive
  // contains). pm_formulary has ~2M rows; doing this in SQL with .or() +
  // .ilike() on drug_name across N drugs blows through PostgREST's 8kB
  // query limit for large drug lists.
  const wanted = drugNames.map((n) => n.toLowerCase());
  // Segment-agnostic index — pm_formulary_v2 files formulary at
  // (contract, plan) level (typically segment='001' only), but audit plan
  // keys may target other segments (e.g. H1036-335-002). Keying by
  // triple would silently miss the rows. Index by contract-plan; per-plan
  // lookup below strips segment.
  const map = new Map<string, FormularyRow[]>();
  for (const r of rows) {
    if (!r.drug_name) continue;
    const nameLc = r.drug_name.toLowerCase();
    const match = wanted.some((w) => nameLc.includes(w) || w.includes(nameLc));
    if (!match) continue;
    const normalized: FormularyRow = {
      contract_id: r.contract_id,
      plan_id: r.plan_id,
      segment_id: r.segment_id,
      rxcui: r.rxcui,
      tier: r.tier,
      copay_default: r.copay,
      coinsurance_default: r.coinsurance,
      prior_auth: r.prior_auth,
      step_therapy: r.step_therapy,
      quantity_limit: r.quantity_limit,
      quantity_limit_amount: r.quantity_limit_amount,
      quantity_limit_days: r.quantity_limit_days,
      drug_type: r.drug_type,
      drug_name: r.drug_name,
    };
    const key = `${r.contract_id}-${r.plan_id}`;
    const list = map.get(key) ?? [];
    list.push(normalized);
    map.set(key, list);
  }
  return map;
}

// ─── Build helpers ───────────────────────────────────────────────────

function firstBrandKeyword(name: string): string {
  // "Insulin Glargine (Lantus)" → "insulin glargine" (before paren)
  return name.split('(')[0].trim();
}

function findFormularyMatch(
  rows: FormularyRow[],
  drug: Drug,
): FormularyRow | null {
  const target = firstBrandKeyword(drug.name).toLowerCase();
  // Prefer exact word-boundary match, then contains.
  const exact = rows.find((r) => (r.drug_name ?? '').toLowerCase() === target);
  if (exact) return exact;
  const contains = rows.filter((r) => {
    const dn = (r.drug_name ?? '').toLowerCase();
    return dn.includes(target) || target.includes(dn);
  });
  if (contains.length === 0) return null;
  // Tie-break: shortest name (least noise) then lowest tier.
  contains.sort((a, b) => {
    const alen = (a.drug_name ?? '').length;
    const blen = (b.drug_name ?? '').length;
    if (alen !== blen) return alen - blen;
    return a.tier - b.tier;
  });
  return contains[0];
}

function tierNumberToUnion(tier: number): Tier | null {
  if (tier >= 1 && tier <= 6) return tier as Tier;
  return null;
}

function isGenericTier(tier: number | null, drugType: string | null): boolean {
  if (drugType === 'generic') return true;
  if (drugType === 'brand' || drugType === 'specialty') return false;
  // Fall back to tier heuristic (matches lis-cap-agent-v3.ts): 1-2 =
  // generic, 3+ = brand. Preferred-generic tier 2 stays "generic".
  if (tier == null) return false;
  return tier <= 2;
}

function applyLisToDrugCopay(
  planCopay: number | null,
  planCoinsurance: number | null,
  tier: number | null,
  drugType: string | null,
  lisTier: PmLisTier,
): { copay: number | null; isCoinsurance: boolean } {
  if (lisTier === 'none') {
    if (planCopay != null && planCopay > 0) return { copay: planCopay, isCoinsurance: false };
    if (planCoinsurance != null && planCoinsurance > 0) {
      // Surface fraction as 0..1; caller may format.
      return { copay: planCoinsurance, isCoinsurance: true };
    }
    return { copay: planCopay ?? 0, isCoinsurance: false };
  }
  // LIS-override — beneficiary pays MIN(plan copay, LIS cap). No
  // percent-of-cost under LIS; the cap is a dollar figure per fill.
  const caps = LIS_COPAYS_2026[lisTier];
  const cap = isGenericTier(tier, drugType) ? caps.generic : caps.brand;
  const planPerFill = planCopay ?? 0;
  const capped = Math.min(planPerFill > 0 ? planPerFill : cap, cap);
  return { copay: capped, isCoinsurance: false };
}

// Rx tier data pulled from pbp_benefits_v2 (benefit_type='rx_tier'). Each
// plan can have up to 3 rows per tier — tier_id 'N', 'N_90', 'N_mail' —
// representing 30-day retail, 90-day retail, and mail order. Standard-
// pharmacy split is not filed at this granularity (documented import gap
// per _probe-phase1.ts § 1).
interface RxTierSlots {
  copay30: number | null;
  copay90: number | null;
  copayMail: number | null;
  coins30: number | null;
  coins90: number | null;
  coinsMail: number | null;
}

function emptyRxTierSlots(): RxTierSlots {
  return {
    copay30: null,
    copay90: null,
    copayMail: null,
    coins30: null,
    coins90: null,
    coinsMail: null,
  };
}

function buildRxStructure(
  rows: BenefitRow[],
  rxTiers: Map<string, RxTierSlots>,
  matrix: Map<number, RxTierMatrix>,
): RxStructure {
  function tierRow(n: number): RxTierCostSharing {
    // Phase 1b — prefer pm_beneficiary_cost_v2 matrix (full pref/std ×
    // 30/mail-90 split). Falls through to pbp rx_tier if the matrix has no
    // row for this tier, then to legacy pm_plan_benefits as last resort.
    const m = matrix.get(n);
    if (m && (m.preferred30 != null || m.standard30 != null || m.preferredMail90 != null || m.standardMail90 != null)) {
      return {
        preferredPharmacy30: m.preferred30,
        standardPharmacy30: m.standard30,
        preferredMailOrder90: m.preferredMail90,
        standardMailOrder90: m.standardMail90,
        isCoinsurance: m.isCoinsurance,
      };
    }
    const slots = rxTiers.get(String(n));
    if (slots) {
      const isCoins = slots.copay30 == null && slots.coins30 != null;
      const mailCopay = slots.copayMail ?? slots.copay90;
      const mailCoins = slots.coinsMail ?? slots.coins90;
      return {
        preferredPharmacy30: isCoins ? slots.coins30 : slots.copay30,
        standardPharmacy30: isCoins ? slots.coins30 : slots.copay30,
        preferredMailOrder90: isCoins ? mailCoins : mailCopay,
        standardMailOrder90: isCoins ? mailCoins : mailCopay,
        isCoinsurance: isCoins,
      };
    }
    const cs = costShareFromRows(rows, `rx_tier_${n}`);
    const isCoins = cs.copay == null && cs.coinsurance != null;
    return {
      preferredPharmacy30: isCoins ? cs.coinsurance : cs.copay,
      standardPharmacy30: isCoins ? cs.coinsurance : cs.copay,
      preferredMailOrder90: null,
      standardMailOrder90: null,
      isCoinsurance: isCoins,
    };
  }
  const tier6Matrix = matrix.get(6);
  const tier6Slots = rxTiers.get('6');
  const tier6Fallback = costShareFromRows(rows, 'rx_tier_6');
  const tier6Present =
    tier6Matrix != null ||
    tier6Slots != null ||
    tier6Fallback.copay != null ||
    tier6Fallback.coinsurance != null ||
    tier6Fallback.description != null;
  return {
    tier1: tierRow(1),
    tier2: tierRow(2),
    tier3: tierRow(3),
    tier4: tierRow(4),
    tier5: tierRow(5),
    tier6: tier6Present ? tierRow(6) : null,
  };
}

// Phase 1b: derive drug-deductible tier exceptions from
// pm_beneficiary_cost_v2.deductible_applies. Returns tiers where the flag
// is false (i.e., beneficiary pays copay without hitting the deductible
// first). Example: "T1, T2" when generics are exempt from Part D deductible.
function deriveTierExceptions(matrix: Map<number, RxTierMatrix>): string | null {
  const exempt: number[] = [];
  for (const [tier, m] of matrix) {
    if (m.deductibleApplies === false) exempt.push(tier);
  }
  if (exempt.length === 0) return null;
  return exempt.sort().map((t) => `T${t}`).join(', ');
}

function buildRxPhases(): RxPhases {
  return {
    partDOopCap: 2100, // CY2026 IRA §11201 RxMOOP cap ($2,000 in 2025, indexed to $2,100 in 2026); DB doesn't file a per-plan value
    catastrophicCopayGeneric: 0,
    catastrophicCopayBrand: 0,
    partDVaccinesZero: true, // Per IRA §11401 — all plans must comply
  };
}

function buildInpatient(
  rows: BenefitRow[],
  zeroForQmb: boolean,
): InpatientCostSharing {
  const inpatient = costShareFromRows(rows, 'inpatient');
  const psych = costShareFromRows(rows, 'mental_health_inpatient');
  const snf = costShareFromRows(rows, 'snf');
  const tiers = parseInpatientTiers(inpatient.description);
  const snfTiers = parseInpatientTiers(snf.description);
  const day1to20 =
    snfTiers.find((t) => t.dayStart <= 1 && t.dayEnd >= 1)?.copay ??
    (snf.copay != null ? snf.copay : null);
  const day21to100 =
    snfTiers.find((t) => t.dayStart <= 21 && t.dayEnd >= 21)?.copay ?? null;
  const perDayTiered = tiers.length > 0
    ? tiers.map((t) => ({ dayRange: `${t.dayStart}-${t.dayEnd}`, copay: t.copay }))
    : null;

  if (zeroForQmb) {
    return {
      perAdmissionCopay: 0,
      perDayTiered: perDayTiered
        ? perDayTiered.map((t) => ({ dayRange: t.dayRange, copay: 0 }))
        : null,
      coinsurance: 0,
      psychInpatientCopay: 0,
      snfDays1to20: 0,
      snfDays21to100: 0,
    };
  }

  return {
    perAdmissionCopay: inpatient.copay,
    perDayTiered,
    coinsurance: inpatient.coinsurance,
    psychInpatientCopay: psych.copay,
    snfDays1to20: day1to20,
    snfDays21to100: day21to100,
  };
}

function buildOutpatient(
  rows: BenefitRow[],
  zeroForQmb: boolean,
): OutpatientCostSharing {
  const pcp = costShareFromRows(rows, 'primary_care');
  const spec = costShareFromRows(rows, 'specialist');
  const uc = costShareFromRows(rows, 'urgent_care');
  const er = costShareFromRows(rows, 'emergency');
  const amb = costShareFromRows(rows, 'ambulance');
  const air = costShareFromRows(rows, 'air_transportation');
  const surgAsc = costShareFromRows(rows, 'outpatient_surgery_asc');
  const surgHosp = costShareFromRows(rows, 'outpatient_surgery_hospital');
  const lab = costShareFromRows(rows, 'lab_services');
  const xray = costShareFromRows(rows, 'xray');
  const advImg = costShareFromRows(rows, 'advanced_imaging');
  const mhInd = costShareFromRows(rows, 'mental_health_individual');
  const mhGrp = costShareFromRows(rows, 'mental_health_group');
  const sa = costShareFromRows(rows, 'substance_abuse');

  const pick = (v: number | null) => (zeroForQmb ? 0 : v);

  return {
    pcpCopay: pick(pcp.copay),
    specialistCopay: pick(spec.copay),
    preventiveCopay: 0, // ACA §2713 — no cost-share on Medicare preventive
    urgentCareCopay: pick(uc.copay),
    erCopay: pick(er.copay),
    ambulanceGroundCopay: pick(amb.copay),
    ambulanceAirCopay: pick(air.copay),
    outpatientSurgeryAsc: pick(surgAsc.copay),
    outpatientSurgeryHospital: pick(surgHosp.copay),
    diagnosticLabsCopay: pick(lab.copay),
    diagnosticRadiologyCopay: pick(xray.copay),
    advancedImagingCopay: pick(advImg.copay),
    mhOutpatientIndividual: pick(mhInd.copay),
    mhOutpatientGroup: pick(mhGrp.copay),
    substanceAbuseCopay: pick(sa.copay),
  };
}

function buildTherapy(rows: BenefitRow[]): TherapyAndDme {
  const pt = costShareFromRows(rows, 'physical_speech_therapy');
  const ot = costShareFromRows(rows, 'occupational_therapy');
  const dme = costShareFromRows(rows, 'dme_prosthetics');
  return {
    ptCopay: pt.copay,
    otCopay: ot.copay,
    // pm_plan_benefits combines PT + Speech under
    // 'physical_speech_therapy'; ST doesn't have a dedicated column.
    stCopay: pt.copay,
    cardiacRehabCopay: null, // known-missing per spec
    pulmonaryRehabCopay: null,
    dmeCoinsurance: dme.coinsurance,
  };
}

function buildOtherMedical(rows: BenefitRow[]): OtherMedical {
  const telehealth = costShareFromRows(rows, 'telehealth');
  const partb = costShareFromRows(rows, 'partb_drugs');
  const chiro = costShareFromRows(rows, 'chiropractic');
  const podi = costShareFromRows(rows, 'podiatry');
  const homeHealth = costShareFromRows(rows, 'home_health');
  const dialysis = costShareFromRows(rows, 'dialysis');
  // Phase 2d: telehealth rows often have null copay with description
  // "Telehealth included". MPF shows this as $0 (included, no copay).
  // Treat presence of the row as coverage — default null copay to 0.
  const telehealthRow = rows.find((r) => r.benefit_category === 'telehealth');
  const telehealthCopay =
    telehealth.copay ?? (telehealthRow != null ? 0 : null);
  return {
    homeHealthCopay: homeHealth.copay,
    telehealthCopay,
    partBDrugCoinsurance: partb.coinsurance,
    dialysisCopay: dialysis.copay,
    skilledNursingHomeCopay: null,
    chiropracticCopay: chiro.copay,
    podiatryCopay: podi.copay,
  };
}

function buildDental(rows: BenefitRow[]): DentalBenefits {
  // Phase 2e: MPF's dental copay display comes from the per-visit service
  // (dental_cleaning or dental_oral_exam), not the aggregate dental_preventive
  // stub which cms_pbp sometimes files at a different rate. Prefer:
  //   dental_cleaning > dental_oral_exam > dental_xray > dental_preventive
  //   > generic dental
  const dentalGeneric = rows.find((r) => r.benefit_category === 'dental');
  const cleaning = pickBestRow(rows, 'dental_cleaning');
  const oralExam = pickBestRow(rows, 'dental_oral_exam');
  const xray = pickBestRow(rows, 'dental_xray');
  const preventiveGeneric = pickBestRow(rows, 'dental_preventive');
  const comprehensive = pickBestRow(rows, 'dental_comprehensive');
  const annualMax = maxCoverageFor(rows, 'dental');
  const preventiveSourceRow = cleaning ?? oralExam ?? xray ?? preventiveGeneric;
  // Phase 2f: when no per-service rows exist AND the plan has a dental
  // annualMax (evidence of dental coverage), default preventive copay to
  // $0. Many plans file dental as "$X annual max with $0 per-service"
  // and MPF returns $0 accordingly. Prior null caused 26 F2 fails.
  const rawPreventiveCopay = preventiveSourceRow
    ? extractRangeCopay(preventiveSourceRow)
    : toNum(dentalGeneric?.copay ?? null);
  const preventiveCopay =
    rawPreventiveCopay != null
      ? rawPreventiveCopay
      : (annualMax != null && annualMax > 0 ? 0 : null);
  const anyPreventive =
    cleaning != null ||
    oralExam != null ||
    xray != null ||
    preventiveGeneric != null ||
    rows.some((r) =>
      r.benefit_category === 'dental_preventive_other' ||
      r.benefit_category === 'dental_fluoride',
    );
  // Phase 2g attempted a hasRealData restriction here — it eliminated 11
  // F10 false-positives (MPF=false PM=true) but created 33 F2 false-
  // negatives (MPF=true PM=null). Net worse. Revert to looser logic:
  // presence of a dental_comprehensive row OR a specific comprehensive
  // subcategory OR annualMax = covered. MPF-vs-PM disagreements on
  // borderline empty-stub cases are accepted as F10 minor fails.
  const anyComprehensive =
    comprehensive != null ||
    rows.some((r) =>
      r.benefit_category === 'dental_implants' ||
      r.benefit_category === 'dental_orthodontics' ||
      r.benefit_category === 'dental_maxillofacial',
    );
  return {
    preventiveCovered:
      anyPreventive || dentalGeneric != null || preventiveCopay != null
        ? true
        : null,
    comprehensiveCovered:
      anyComprehensive || (annualMax != null && annualMax > 0)
        ? true
        : null,
    annualMax,
    copay: preventiveCopay,
  };
}

function buildVision(rows: BenefitRow[]): VisionBenefits {
  const visionGeneric = rows.find((r) => r.benefit_category === 'vision');
  const visionExamBest = pickBestRow(rows, 'vision_exam');
  const contacts = pickBestRow(rows, 'vision_contacts');
  const frames = pickBestRow(rows, 'vision_frames');
  const lenses = pickBestRow(rows, 'vision_lenses');
  // Phase 2g (2026-07-24): MPF displays the benefit-period total for
  // eyewear ("$250 every 2 years"), which lives on the vision_allowance
  // row's coverage_amount. Prior maxCoverageFor('vision') included
  // vision_eyewear rows that carry per-year amounts (copay_max=$125),
  // causing systematic 2× ratio failures. Prefer vision_allowance first.
  const visionAllowance = pickBestRow(rows, 'vision_allowance');
  const eyewear =
    (visionAllowance ? toNum(visionAllowance.coverage_amount) ?? toNum(visionAllowance.max_coverage) : null) ??
    maxCoverageFor(rows, 'vision') ??
    (frames ? toNum(frames.coverage_amount) ?? toNum(frames.max_coverage) : null) ??
    (lenses ? toNum(lenses.coverage_amount) ?? toNum(lenses.max_coverage) : null);
  const examCopay = visionExamBest
    ? extractRangeCopay(visionExamBest)
    : toNum(visionGeneric?.copay ?? null);
  // Phase 2f: contact lens allowance is usually pooled with eyewear (same
  // dollar cap covers both frames+lenses+contacts). MPF returns the pool
  // amount for both fields; PM previously returned the vision_contacts
  // row's copay (typically $0) which caused 46 F10 fails. Fall back to
  // eyewear allowance when contacts row lacks its own coverage_amount.
  const contactLensAllowance = contacts
    ? toNum(contacts.coverage_amount)
      ?? toNum(contacts.max_coverage)
      ?? eyewear
      ?? (toNum(contacts.copay) ?? null)
    : null;
  return {
    routineExamCovered:
      examCopay != null || visionExamBest != null || visionGeneric != null
        ? true
        : null,
    eyewearAllowance: eyewear,
    contactLensAllowance,
    examCopay,
  };
}

function buildHearing(rows: BenefitRow[]): HearingBenefits {
  // Phase 2d: PBP files hearing_aid as its own benefit_type (mapped to
  // hearing_aid category by PBP_TYPE_TO_CATEGORY). Aid copay is often
  // a per-ear or per-year allowance (coverage_amount / max_coverage).
  const hearing = rows.find((r) => r.benefit_category === 'hearing');
  const hearingExam = pickBestRow(rows, 'hearing_exam');
  const hearingAid = pickBestRow(rows, 'hearing_aid');
  // Prefer the hearing_aid row's coverage/max amount when present; fall
  // through to the generic hearing row's max_coverage.
  const aid =
    hearingAid
      ? toNum(hearingAid.coverage_amount) ?? toNum(hearingAid.max_coverage) ?? toNum(hearingAid.copay)
      : maxCoverageFor(rows, 'hearing');
  const examCopay = hearingExam
    ? extractRangeCopay(hearingExam)
    : toNum(hearing?.copay ?? null);
  return {
    routineExamCovered: examCopay != null || hearingExam != null || hearing != null ? true : null,
    hearingAidBenefit: aid,
    examCopay,
  };
}

function buildSupplemental(rows: BenefitRow[]): SupplementalBenefits {
  const otc = rows.find((r) => r.benefit_category === 'otc');
  const foodCard = rows.find((r) => r.benefit_category === 'food_card');
  const transport = rows.find((r) => r.benefit_category === 'transportation');
  const fitness = rows.find((r) => r.benefit_category === 'fitness');
  const telehealth = rows.find((r) => r.benefit_category === 'telehealth');
  const otcAmt = coverageAmountFor(rows, 'otc');
  const foodAmt = coverageAmountFor(rows, 'food_card');
  // Rides-per-year isn't filed structurally in pm_plan_benefits; leave
  // null so the diff engine surfaces the gap.
  const desc = fitness?.benefit_description ?? null;
  const fitnessMatch = desc?.match(/Fitness · ([^·]+)/);
  const fitnessBenefit = fitnessMatch ? fitnessMatch[1].trim() : desc;
  return {
    otcAllowance: otcAmt,
    // pm_plan_benefits stores quarterly for OTC (per api/plans.ts) and
    // monthly for food_card. Surface those periods verbatim.
    otcAllowancePeriod: otcAmt != null ? 'quarterly' : null,
    transportationTripsPerYear: transport != null ? 24 : null, // proxy; not filed
    mealsPostDischarge: null,
    fitnessBenefit,
    telehealthAccess: telehealth != null ? true : null,
    foodCardMonthly: foodAmt,
    caregiverSupport: null, // known-missing
    inHomeSupportHoursPerMonth: null, // known-missing
    acupunctureVisitsPerYear: null, // known-missing
    // Phase 1 wiring: pbp_benefits_v2 has ~14K worldwide_emergency rows.
    // Presence signals plan offers the benefit; specific coverage terms
    // vary by plan and aren't structurally filed. Boolean surface for now.
    worldwideEmergency: rows.some(
      (r) => r.benefit_category === 'worldwide_emergency',
    ) || null,
    nurseHotline: null, // known-missing (0 rows in pbp/pm_plan_benefits)
  };
}

function buildDrugCoverage(
  profile: BeneficiaryProfile,
  formularyRows: FormularyRow[],
  lisTier: PmLisTier,
): DrugCoverage[] {
  const out: DrugCoverage[] = [];
  for (const drug of profile.drugs) {
    if (isPartBOnly(drug)) {
      // Part-B-only drugs will never appear on the Part D formulary; the
      // diff engine reads Part B coinsurance for these via
      // outpatient.partBDrugCoinsurance instead. Emit a stub so the
      // per-drug array is one-to-one with profile.drugs.
      out.push({
        drug,
        onFormulary: false,
        tier: null,
        priorAuth: false,
        quantityLimit: false,
        quantityLimitAmount: null,
        quantityLimitDays: null,
        stepTherapy: false,
        specialtyPharmacy: false,
        preferredCopay: null,
        standardCopay: null,
        isCoinsurance: false,
      });
      continue;
    }
    const hit = findFormularyMatch(formularyRows, drug);
    if (!hit) {
      out.push({
        drug,
        onFormulary: false,
        tier: null,
        priorAuth: false,
        quantityLimit: false,
        quantityLimitAmount: null,
        quantityLimitDays: null,
        stepTherapy: false,
        specialtyPharmacy: false,
        preferredCopay: null,
        standardCopay: null,
        isCoinsurance: false,
      });
      continue;
    }
    const { copay, isCoinsurance } = applyLisToDrugCopay(
      hit.copay_default,
      hit.coinsurance_default,
      hit.tier,
      hit.drug_type,
      lisTier,
    );
    out.push({
      drug,
      onFormulary: true,
      tier: tierNumberToUnion(hit.tier),
      priorAuth: !!hit.prior_auth,
      quantityLimit: !!hit.quantity_limit,
      quantityLimitAmount: hit.quantity_limit_amount,
      quantityLimitDays: hit.quantity_limit_days,
      stepTherapy: !!hit.step_therapy,
      specialtyPharmacy: false, // known-missing; drug_type='specialty' is a proxy but not the same
      preferredCopay: copay,
      standardCopay: copay,
      isCoinsurance,
    });
  }
  return out;
}

// ─── Cache paths ─────────────────────────────────────────────────────

function cacheDirForProfile(profileId: string): string {
  // Anchor cache at the repo root (this file lives 3 levels deep under
  // scripts/parity-audit/lib/). Uses import.meta.url so cwd doesn't
  // matter — same convention _template-probe.ts assumes for env
  // resolution.
  const here = fileURLToPath(new URL('.', import.meta.url));
  // here = /…/scripts/parity-audit/lib/
  const repoRoot = new URL('../../../', import.meta.url);
  const rootPath = fileURLToPath(repoRoot);
  void here;
  return `${rootPath.replace(/\/$/, '')}/_tmp/parity-audit/pm/${profileId}`;
}

function writeSnapshotCache(snap: PlanSnapshot): void {
  const dir = cacheDirForProfile(snap.profileId);
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${snap.ident.contractId}-${snap.ident.planId}-${snap.ident.segmentId}.json`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(snap, null, 2), 'utf8');
}

// ─── Public: pmSnapshot ──────────────────────────────────────────────

export async function pmSnapshot(
  profile: BeneficiaryProfile,
  planKeys: Array<{ contractId: string; planId: string; segmentId: string }>,
): Promise<PlanSnapshot[]> {
  if (planKeys.length === 0) return [];
  const [planRows, landscapeByTriple, pbpByTriple, formularyByTriple, rxTiersByPlan, benefCostByPlan] = await Promise.all([
    fetchPlans(planKeys),
    fetchBenefitsByTriple(planKeys),
    fetchPbpFallback(planKeys),
    fetchFormularyForDrugs(
      planKeys,
      profile.drugs.filter((d) => !isPartBOnly(d)).map((d) => firstBrandKeyword(d.name)),
    ),
    fetchRxTiersByPlan(planKeys),
    fetchBeneficiaryCostByPlan(planKeys),
  ]);

  const lisTier = deriveLisTier(profile);
  const zeroForQmb = qmbLikeZerosMedicare(profile.medicaid);
  const capturedAt = new Date().toISOString();

  const out: PlanSnapshot[] = [];
  for (const key of planKeys) {
    const triple = tripleKey(key.contractId, key.planId, key.segmentId);
    const planRow = planRows.get(triple);

    const landscape = landscapeByTriple.get(triple) ?? [];
    const pbp = pbpByTriple.get(triple) ?? [];
    // Merge: always include both landscape and pbp rows and let
    // pickBestRow() score-select the most curated row per category. The
    // earlier "landscape wins when it has any real value" gate silently
    // dropped descriptive pbp rows even when landscape only had a bare
    // stub (e.g. H9808 lab landscape=10 no-desc vs pbp=20 desc "$10-$20"
    // — MPF says 20; landscape wins gate kept us at 10). Score-based
    // selection prefers rows with description text and non-zero values.
    const merged: BenefitRow[] = [...landscape, ...pbp];

    // Segment-agnostic formulary lookup — fetchFormularyForDrugs indexes
    // by contract-plan (not triple) since pm_formulary_v2 files at plan
    // level only.
    const formularyRows = formularyByTriple.get(`${key.contractId}-${key.planId}`) ?? [];

    const ident: PlanIdentification = {
      planName: planRow?.plan_name ?? '',
      contractId: key.contractId,
      planId: key.planId,
      segmentId: padSeg(key.segmentId),
      planType: planRow?.snp_type ?? planRow?.plan_type ?? '',
      starRating: toNum(planRow?.star_rating ?? null),
      orgName: planRow?.parent_organization ?? planRow?.carrier ?? '',
    };

    // Phase 1b: PDPs have Part D drug premium == monthlyPremium (the plan
    // IS Part D coverage). MAPD plans bundle it into total premium; not
    // separately filed. Detect PDP by plan_type contains 'PDP'.
    const isPdp = /PDP/i.test(String(planRow?.plan_type ?? ''));
    const monthly = toNum(planRow?.monthly_premium ?? null);
    const tierMatrix = benefCostByPlan.get(`${key.contractId}-${key.planId}`) ?? new Map();
    const premium: PremiumAndDeductible = {
      monthlyPremium: monthly,
      // Part B giveback: default 0 when no giveback row exists. Every plan
      // either has a giveback amount or has zero — MPF reflects this by
      // returning 0 for no-giveback plans, so PM must match.
      partBPremiumReduction: coverageAmountFor(merged, 'partb_giveback') ?? 0,
      // For PDPs the plan IS Part D — partDPremium = monthlyPremium. For
      // MAPD, Part D is bundled into the monthly premium so partDPremium
      // is definitionally $0 (no separate charge). MPF returns 0 for both
      // cases when appropriate; default here so both sides match.
      partDPremium: isPdp ? monthly : 0,
      medicalDeductibleIN: toNum(planRow?.annual_deductible ?? null),
      // Spec §9 Priority 1: OON deductible not in landscape extract. Set
      // to 0 for HMO plans (they structurally have no OON benefits, so
      // OON deductible is not-applicable / effectively $0); leave null
      // for PPO/PFFS where it would be a real value. Diff engine can
      // treat null-vs-MPF-value as N/A per spec.
      medicalDeductibleOON: /HMO/i.test(String(planRow?.plan_type ?? '')) ? 0 : null,
      // MPF returns 0 for plans without a Part D deductible; PM's
      // pm_plans.drug_deductible is null on the same set. Default to
      // 0 so both sides agree (33 F2 fails on the 2026-07-25 audit
      // resolved by this one default).
      partDDrugDeductible: toNum(planRow?.drug_deductible ?? null) ?? 0,
      // Phase 1b: derive from pm_beneficiary_cost_v2.deductible_applies —
      // tiers exempt from the Part D deductible are those with
      // deductible_applies=false in the initial coverage phase.
      drugDeductibleTierExceptions: deriveTierExceptions(tierMatrix),
      annualMoopIN: toNum(planRow?.moop ?? null),
    };

    const snap: PlanSnapshot = {
      source: 'pm',
      capturedAt,
      profileId: profile.id,
      ident,
      premium,
      inpatient: buildInpatient(merged, zeroForQmb),
      outpatient: buildOutpatient(merged, zeroForQmb),
      therapy: buildTherapy(merged),
      otherMedical: buildOtherMedical(merged),
      rxStructure: buildRxStructure(
        merged,
        rxTiersByPlan.get(`${key.contractId}-${key.planId}`) ?? new Map(),
        benefCostByPlan.get(`${key.contractId}-${key.planId}`) ?? new Map(),
      ),
      rxPhases: buildRxPhases(),
      drugCoverage: buildDrugCoverage(profile, formularyRows, lisTier),
      dental: buildDental(merged),
      vision: buildVision(merged),
      hearing: buildHearing(merged),
      supplemental: buildSupplemental(merged),
    };

    try {
      writeSnapshotCache(snap);
    } catch {
      // Caching is best-effort; missing _tmp permissions shouldn't
      // fail the snapshot itself.
    }
    out.push(snap);
  }

  return out;
}

// ─── Public: pmSuggestPlansForProfile ───────────────────────────────

export async function pmSuggestPlansForProfile(
  profile: BeneficiaryProfile,
  opts?: { maxMapdPlans?: number; maxPdpPlans?: number },
): Promise<Array<{ contractId: string; planId: string; segmentId: string }>> {
  const maxMapd = opts?.maxMapdPlans ?? 5;
  const maxPdp = opts?.maxPdpPlans ?? 2;
  const wantSnp = profile.medicaid === 'full-dual' || profile.medicaid === 'qmb' || profile.snpEligibility.length > 0;

  // Fetch candidates in the profile's county. pm_plans.county_fips is
  // 100% NULL in prod, so filter by state + county_name (matches
  // api/plans.ts). PDPs live under 'All Counties'.
  const rows = await paginate<PmPlanRow>((from, to) => {
    let q = sb()
      .from('pm_plans')
      .select(
        'contract_id, plan_id, segment_id, plan_name, carrier, parent_organization, plan_type, state, county_name, monthly_premium, annual_deductible, moop, drug_deductible, star_rating, snp, snp_type, dsnp_accepted_populations, sanctioned',
      )
      .eq('sanctioned', false)
      .eq('state', profile.state);
    // ilike normalizes case; "All Counties" is the PDP wildcard.
    const safeCounty = profile.countyName.replace(/[,()*%]/g, '').trim();
    q = q.or(`county_name.ilike.${safeCounty},county_name.eq.All Counties`);
    return q
      .order('star_rating', { ascending: false, nullsFirst: false })
      .order('monthly_premium', { ascending: true, nullsFirst: false })
      .range(from, to) as unknown as PromiseLike<PostgrestSingleResponse<PmPlanRow[]>>;
  });

  const wanted = new Map<string, PmPlanRow>();
  for (const r of rows) {
    const key = tripleKey(r.contract_id, r.plan_id, r.segment_id || '000');
    if (!wanted.has(key)) wanted.set(key, r);
  }

  const mapd: PmPlanRow[] = [];
  const pdp: PmPlanRow[] = [];
  for (const r of wanted.values()) {
    const isPdp = (r.plan_type ?? '').toUpperCase() === 'PDP';
    if (isPdp) {
      pdp.push(r);
      continue;
    }
    // SNP filter: if profile has D-SNP eligibility, D-SNPs are eligible.
    // Non-eligible profiles must not surface D-SNP / C-SNP / I-SNP.
    if (r.snp) {
      if (!wantSnp) continue;
      const snpTypeUpper = (r.snp_type ?? '').toUpperCase();
      if (snpTypeUpper.includes('D-SNP') || snpTypeUpper.includes('DSNP') || snpTypeUpper.includes('DUAL')) {
        if (profile.medicaid === 'none') continue;
      } else if (snpTypeUpper.includes('C-SNP') || snpTypeUpper.includes('CSNP') || snpTypeUpper.includes('CHRONIC')) {
        if (profile.snpEligibility.filter((s) => s.startsWith('c-snp')).length === 0) continue;
      }
    }
    mapd.push(r);
  }

  // Rank: star desc (already), premium asc (already). Slice.
  const chosenMapd = mapd.slice(0, maxMapd);
  const chosenPdp = pdp.slice(0, maxPdp);

  return [...chosenMapd, ...chosenPdp].map((r) => ({
    contractId: r.contract_id,
    planId: r.plan_id,
    segmentId: padSeg(r.segment_id || '000'),
  }));
}
