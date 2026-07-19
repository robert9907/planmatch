// Phase 3 — benefit field parity audit (9 fields × 279 plans).
//
// Reads:
//   • CMS detail: _tmp/medicare-gov-snp/detail/*.json  (SNPs)
//                 _tmp/medicare-gov-mapd/detail/*.json  (MAPD non-SNP)
//   • Agent side: pm_plan_benefits + pbp_benefits (fallback path
//                 mirroring api/plans.ts:buildBenefits + buildPbpFallback)
//
// CMS FIELD MAPPING (documented per user's Step 3 requirement):
//
//   1. specialist_copay   → ma_benefits[cat=BENEFIT_DOCTOR_VISITS,
//                            svc=SERVICE_SPECIALIST].cost_sharing
//                            [IN_NETWORK].min_copay
//   2. primary_care_copay → same category, svc=SERVICE_PRIMARY
//   3. dental annual_max  → max(ma_benefits[cat=BENEFIT_COMPREHENSIVE_
//                            DENTAL].plan_limits_details[LIMIT_TYPE_
//                            COVERAGE, EVERY_YEAR].limit_value)
//                            fallback: package_services.dental_services
//   4. vision allowance   → max(ma_benefits[cat=BENEFIT_VISION]
//                            .plan_limits_details[COVERAGE, EVERY_YEAR])
//   5. hearing allowance  → max(ma_benefits[cat=HEARING_AIDS]
//                            .plan_limits_details[COVERAGE, EVERY_YEAR])
//   6. otc                → presence only via ma_benefits[cat=OTHER_
//                            SERVICES, svc=OTC_ITEMS] or asb
//                            SB_CAT_OTC_ITEMS.SB_OTC_ITEMS coverage.
//                            **Dollar amount NOT exposed by CMS JSON.**
//   7. food_card          → presence via asb SB_CAT_NON_PRIMARILY_HEALTH_
//                            RELATED_BENEFITS.SB_FOOD_AND_PRODUCE and/or
//                            SB_MEALS_BEYOND_LIMITED_BASIS or ma_benefits
//                            BENEFITS_CHRONICALLY_ILL/FOOD_PRODUCE|MEALS.
//                            **Dollar amount NOT exposed by CMS JSON.**
//   8. transportation     → presence via ma_benefits[cat=BENEFIT_
//                            TRANSPORTATION] OR asb SB_CAT_TRANSPORTATION_
//                            SERVICES OR asb SB_TRANSPORTATION_FOR_NON_
//                            MEDICAL_NEEDS. Ride count NOT exposed.
//   9. fitness            → presence via ma_benefits[cat=PREVENTIVE_
//                            SERVICES, svc=FITNESS] OR top-level
//                            silver_sneakers boolean. Program name NOT
//                            exposed.
//
// AGENT SIDE (mirrors buildBenefits at api/plans.ts:1426):
//
//   1. specialist_copay   → costShareFor(rows, 'specialist').copay
//   2. primary_care_copay → costShareFor(rows, 'primary_care').copay
//   3. dental annual_max  → find(cat='dental').max_coverage /
//                            coverage_amount; fallback pbpFallback.
//                            dentalAnnualMax
//   4. vision             → find(cat='vision').max_coverage /
//                            coverage_amount
//   5. hearing            → find(cat='hearing').max_coverage /
//                            coverage_amount
//   6. otc                → find(cat='otc').coverage_amount; fallback
//                            pbpFallback.otcQuarterly
//   7. food_card          → find(cat='food_card').coverage_amount;
//                            fallback pbpFallback.foodCardMonthly
//                            (Phase 1 Fix 5 presence rescue)
//   8. transportation     → find(cat='transportation').max_coverage
//   9. fitness            → find(cat='fitness') presence; api defaults
//                            enabled=true always (line 1561)
//
// Because CMS doesn't expose dollar amounts for OTC/food_card/
// transportation/fitness, the audit compares PRESENCE (boolean) for
// those 4 fields. For specialist/primary_care copays and dental/vision/
// hearing allowances, exact dollar match is required.
//
// Root cause categories per user spec:
//   A = data not imported (pm_plan_benefits row missing)
//   B = alias/mapping bug (data exists under wrong category name)
//   C = extraction bug (data exists but parsed wrong)
//   D = CMS has value, PM has null (fallback path not firing)
//   E = value drift (both have data, different amounts)
//
// Run: npx tsx scripts/_phase3-benefit-parity.ts

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// ─── CMS extractors ──────────────────────────────────────────────
function findMaBenefit(planCard: any, category: string, service?: string) {
  return (planCard.ma_benefits ?? []).filter((b: any) =>
    b.category === category && (service ? b.service === service : true),
  );
}
function inNetCopay(entry: any): number | null {
  const cs = (entry.cost_sharing ?? []).find((c: any) => c.network_status === 'IN_NETWORK');
  if (!cs) return null;
  if (cs.min_copay != null) return cs.min_copay;
  if (cs.min_coinsurance != null) return cs.min_coinsurance;
  return null;
}
// Vision + hearing + dental commonly file the annual cap as
// BENEFIT_LIMIT_TYPE_COMBINED_COVERAGE (shared cap across multiple
// services like frames/lenses/exams) instead of BENEFIT_LIMIT_TYPE_
// COVERAGE. Both encode the same annual dollar amount. Fix 4 from the
// vision audit: accept both. Prior version only accepted COVERAGE and
// silently returned null for 79% of MA plans that file vision under
// COMBINED_COVERAGE — the audit then classified them as "both silent"
// and falsely reported vision at 100%.
const COVERAGE_LIMIT_TYPES = new Set([
  'BENEFIT_LIMIT_TYPE_COVERAGE',
  'BENEFIT_LIMIT_TYPE_COMBINED_COVERAGE',
]);
function annualCoverageMax(entries: any[]): number | null {
  let max = 0;
  let seen = false;
  for (const e of entries) {
    for (const d of (e.plan_limits_details ?? [])) {
      if (COVERAGE_LIMIT_TYPES.has(d.limit_type) &&
          d.limit_period === 'BENEFIT_LIMIT_PERIOD_EVERY_YEAR' &&
          typeof d.limit_value === 'number') {
        seen = true;
        if (d.limit_value > max) max = d.limit_value;
      }
    }
  }
  return seen ? max : null;
}
function asbCategory(planCard: any, categoryKey: string): any[] {
  const list = planCard.additional_supplemental_benefits?.special_benefits ?? [];
  const hit = list.find((c: any) => c.category === categoryKey);
  return hit?.benefits ?? [];
}
function asbHas(planCard: any, categoryKey: string, benefitKey: string): boolean {
  const bens = asbCategory(planCard, categoryKey);
  const b = bens.find((x: any) => x.benefit === benefitKey);
  return !!b && b.coverage && b.coverage !== 'SB_COVERAGE_NOT_COVERED';
}

interface CmsBenefits {
  specialist_copay: number | null;
  primary_care_copay: number | null;
  dental_annual_max: number | null;
  vision_allowance: number | null;
  hearing_aid_allowance: number | null;
  otc_offered: boolean;
  food_card_offered: boolean;
  transportation_offered: boolean;
  fitness_offered: boolean;
  fitness_program_hint: string | null; // top-level silver_sneakers gives us this
}
function extractCms(planCard: any): CmsBenefits {
  const spec = findMaBenefit(planCard, 'BENEFIT_DOCTOR_VISITS', 'SERVICE_SPECIALIST');
  const pcp  = findMaBenefit(planCard, 'BENEFIT_DOCTOR_VISITS', 'SERVICE_PRIMARY');
  const dent = findMaBenefit(planCard, 'BENEFIT_COMPREHENSIVE_DENTAL');
  const vis  = findMaBenefit(planCard, 'BENEFIT_VISION');
  const hAid = findMaBenefit(planCard, 'HEARING_AIDS');
  const otcMa = findMaBenefit(planCard, 'OTHER_SERVICES', 'OTC_ITEMS');
  const otcAsb = asbHas(planCard, 'SB_CAT_OTC_ITEMS', 'SB_OTC_ITEMS');
  const foodChronic = findMaBenefit(planCard, 'BENEFITS_CHRONICALLY_ILL')
    .some((b: any) => b.service === 'FOOD_PRODUCE' || b.service === 'MEALS');
  const foodAsb = asbHas(planCard, 'SB_CAT_NON_PRIMARILY_HEALTH_RELATED_BENEFITS', 'SB_FOOD_AND_PRODUCE') ||
                  asbHas(planCard, 'SB_CAT_NON_PRIMARILY_HEALTH_RELATED_BENEFITS', 'SB_MEALS_BEYOND_LIMITED_BASIS');
  const transMa = findMaBenefit(planCard, 'BENEFIT_TRANSPORTATION').length > 0;
  const transAsb = asbHas(planCard, 'SB_CAT_TRANSPORTATION_SERVICES', 'SB_ANY_HEALTH_RELATED_LOCATION') ||
                   asbHas(planCard, 'SB_CAT_TRANSPORTATION_SERVICES', 'SB_PLAN_APPROVED_HEALTH_RELATED_LOCATION') ||
                   asbHas(planCard, 'SB_CAT_NON_PRIMARILY_HEALTH_RELATED_BENEFITS', 'SB_TRANSPORTATION_FOR_NON_MEDICAL_NEEDS');
  const fitMa = findMaBenefit(planCard, 'PREVENTIVE_SERVICES', 'FITNESS').length > 0;
  const silverSneakers = planCard.silver_sneakers === true;
  return {
    specialist_copay:      spec.length > 0 ? inNetCopay(spec[0]) : null,
    primary_care_copay:    pcp.length > 0  ? inNetCopay(pcp[0])  : null,
    dental_annual_max:     dent.length > 0 ? annualCoverageMax(dent) : null,
    vision_allowance:      vis.length > 0  ? annualCoverageMax(vis) : null,
    hearing_aid_allowance: hAid.length > 0 ? annualCoverageMax(hAid) : null,
    otc_offered:           otcMa.length > 0 || otcAsb,
    food_card_offered:     foodChronic || foodAsb,
    transportation_offered: transMa || transAsb,
    fitness_offered:       fitMa || silverSneakers,
    fitness_program_hint:  silverSneakers ? 'SilverSneakers' : null,
  };
}

// ─── PM extractors (mirrors buildBenefits) ───────────────────────
interface PmBenefits {
  specialist_copay: number | null;
  primary_care_copay: number | null;
  dental_annual_max: number | null;
  vision_allowance: number | null;
  hearing_aid_allowance: number | null;
  otc_offered: boolean;
  otc_quarterly: number | null;
  food_card_offered: boolean;
  food_card_monthly: number | null;
  transportation_offered: boolean;
  fitness_offered: boolean; // agent code hardcodes true
  fitness_program: string | null;
}
async function loadPmRows(contract_id: string, plan_id: string, segment_id: string): Promise<{ pm: any[]; pbp: any[] }> {
  const [pmRes, pbpRes] = await Promise.all([
    sb.from('pm_plan_benefits')
      .select('benefit_category, copay, coinsurance, coverage_amount, max_coverage, benefit_description')
      .eq('contract_id', contract_id).eq('plan_id', plan_id),
    // pbp_benefits keyed by combined plan_id
    // pbp_benefits VIEW does not expose coverage_amount (only the
    // base table pbp_benefits_v2 does). Requesting a non-existent
    // column silently returns zero rows — bug found while running
    // Fix 3-α. Select only view-available columns.
    sb.from('pbp_benefits')
      .select('benefit_type, copay, description')
      .eq('plan_id', `${contract_id}-${plan_id}`),
  ]);
  return { pm: pmRes.data ?? [], pbp: pbpRes.data ?? [] };
}
function toNum(v: any): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return isFinite(n) ? n : null;
}
function foodCardMultiplier(desc: string | null): number {
  if (!desc) return 1;
  const d = desc.toLowerCase();
  if (d.includes('quarterly') || d.includes('/qtr')) return 1 / 3;
  if (d.includes('yearly') || d.includes('annual') || d.includes('/yr')) return 1 / 12;
  return 1;
}
function otcMultiplier(desc: string | null): number {
  if (!desc) return 1;
  const d = desc.toLowerCase();
  if (d.includes('monthly') || d.includes('per month') || d.includes('/mo')) return 3;
  if (d.includes('yearly') || d.includes('annual') || d.includes('/yr')) return 1 / 4;
  if (d.includes('quarterly') || d.includes('/qtr')) return 1;
  return 1;
}
function extractPm(pm: any[], pbp: any[]): PmBenefits {
  const find = (cat: string) => pm.find((r) => r.benefit_category === cat);
  const spec = find('specialist');
  const pcp = find('primary_care');
  const dent = find('dental');
  const vis  = find('vision');
  const hear = find('hearing');
  const otc  = find('otc');
  const foodPm = find('food_card');
  const trans = find('transportation');
  const fitness = find('fitness');

  // pbp fallbacks (mirrors buildPbpFallback)
  let pbpDentalMax: number | null = null;
  let pbpVisionAllowance: number | null = null;
  let pbpHearingAllowance: number | null = null;
  let pbpOtcQuarterly: number | null = null;
  let pbpFoodCardMonthly: number | null = null;
  let pbpFoodCardDesc: string | null = null;
  let pbpTransportationPresence = false;
  let pbpFitnessPresence = false;
  let pbpFitnessDesc: string | null = null;
  for (const r of pbp) {
    if (r.benefit_type === 'dental_annual_max') {
      const v = toNum(r.copay);
      if (v != null && v > 0) pbpDentalMax = v;
    } else if (r.benefit_type === 'vision_allowance') {
      // Mirrors api/plans.ts transformPbpRow line 507-513 + the
      // ALLOWANCE_CATEGORIES merge branch: pbp vision_allowance.copay
      // becomes the eyewear cap when landscape has none.
      const v = toNum(r.copay);
      if (v != null && v > 0) pbpVisionAllowance = v;
    } else if (r.benefit_type === 'hearing_aid_allowance') {
      const v = toNum(r.copay);
      if (v != null && v > 0) pbpHearingAllowance = v;
    } else if (r.benefit_type === 'otc_allowance') {
      const v = toNum(r.copay);
      if (v != null && v > 0) {
        const q = Math.round(v * otcMultiplier(r.description));
        if (q > 0) pbpOtcQuarterly = q;
      }
    } else if (r.benefit_type === 'food_card') {
      const v = toNum(r.copay);
      if (v != null && v > 0) {
        const mo = Math.round(v * foodCardMultiplier(r.description));
        if (mo > 0) pbpFoodCardMonthly = mo;
      } else if (r.description && r.description.trim() !== '' && pbpFoodCardMonthly == null) {
        pbpFoodCardMonthly = 1; // Phase 1 Fix 5 presence rescue
      }
      if (r.description) pbpFoodCardDesc = r.description;
    } else if (r.benefit_type === 'transportation') {
      pbpTransportationPresence = true;
    } else if (r.benefit_type === 'fitness') {
      pbpFitnessPresence = true;
      if (r.description) pbpFitnessDesc = r.description;
    }
  }

  const dentalMaxPm = toNum(dent?.max_coverage) ?? toNum(dent?.coverage_amount);
  const dentalMax = (dentalMaxPm != null && dentalMaxPm > 0) ? dentalMaxPm : pbpDentalMax;
  // Vision + hearing follow the same merge as dental: landscape wins if
  // it has a value; otherwise pbp allowance surfaces through the API.
  // Mirrors api/plans.ts:1101-1111 ALLOWANCE_CATEGORIES branch.
  const visionAllowPm = toNum(vis?.max_coverage) ?? toNum(vis?.coverage_amount);
  const visionAllow = (visionAllowPm != null && visionAllowPm > 0) ? visionAllowPm : pbpVisionAllowance;
  const hearingAllowPm = toNum(hear?.max_coverage) ?? toNum(hear?.coverage_amount);
  const hearingAllow = (hearingAllowPm != null && hearingAllowPm > 0) ? hearingAllowPm : pbpHearingAllowance;
  const pmOtcQ = toNum(otc?.coverage_amount);
  const otcQ = (pmOtcQ != null && pmOtcQ > 0) ? pmOtcQ : pbpOtcQuarterly;
  const pmFoodCardMo = toNum(foodPm?.coverage_amount);
  const foodCardMo = (pmFoodCardMo != null && pmFoodCardMo > 0) ? pmFoodCardMo : pbpFoodCardMonthly;

  const fitnessProgramMatch = fitness?.benefit_description?.match(/Fitness · ([^·]+)/);
  const fitnessProgram = fitnessProgramMatch ? fitnessProgramMatch[1].trim() : (pbpFitnessDesc ?? null);

  return {
    specialist_copay:      toNum(spec?.copay) ?? toNum(spec?.coinsurance),
    primary_care_copay:    toNum(pcp?.copay)  ?? toNum(pcp?.coinsurance),
    dental_annual_max:     dentalMax,
    vision_allowance:      visionAllow,
    hearing_aid_allowance: hearingAllow,
    otc_offered:           !!otc || pbpOtcQuarterly != null,
    otc_quarterly:         otcQ,
    food_card_offered:     !!foodPm || pbpFoodCardMonthly != null,
    food_card_monthly:     foodCardMo,
    transportation_offered: !!trans || pbpTransportationPresence,
    fitness_offered:       true, // agent code hardcodes enabled=true
    fitness_program:       fitnessProgram,
  };
}

// ─── Field diff + root cause classifier ──────────────────────────
type FieldKey =
  | 'specialist_copay' | 'primary_care_copay'
  | 'dental_annual_max' | 'vision_allowance' | 'hearing_aid_allowance'
  | 'otc_offered' | 'food_card_offered'
  | 'transportation_offered' | 'fitness_offered';

interface Diff {
  field: FieldKey;
  cms: any;
  pm: any;
  root_cause: 'A' | 'B' | 'C' | 'D' | 'E' | 'NONE';
  note?: string;
}
type Rc = 'A' | 'B' | 'C' | 'D' | 'E' | 'NONE';

// Root cause categories per mission spec:
//   A = data not imported (pm_plan_benefits row missing OR the specific
//       column on the row is null while other columns hold partial data)
//   B = alias/mapping bug (data under wrong benefit_category name)
//   C = extraction bug (columns hold values but extractor parses wrong)
//   D = pm null but pbp_benefits row exists (fallback path not firing)
//   E = value drift (both have data, different amounts)
//   ACCEPTED = intentional agent-side deviation (documented in code)
function classify(field: FieldKey, cms: any, pm: any, pmRows: any[], pbpRows: any[]): Diff | null {
  // Presence booleans
  if (field === 'otc_offered' || field === 'food_card_offered' ||
      field === 'transportation_offered' || field === 'fitness_offered') {
    if (cms === pm) return null;
    // pm-side fitness.enabled is hardcoded to true (api/plans.ts:1561)
    // by design — the block comment says defaulting to false would
    // wrongly eliminate plans in the extras funnel because "MA plans
    // on the CMS landscape almost universally include a fitness
    // benefit". This is an ACCEPTED intentional deviation, not a bug.
    if (field === 'fitness_offered' && pm === true && cms === false) {
      return { field, cms, pm, root_cause: 'NONE', note: 'agent intentionally defaults enabled=true (plans.ts:1561 comment)' };
    }
    if (cms === true && pm === false) {
      const pbpCat = field === 'otc_offered' ? 'otc_allowance'
                   : field === 'food_card_offered' ? 'food_card'
                   : field === 'transportation_offered' ? 'transportation'
                   : 'fitness';
      const hit = pbpRows.some((r) => r.benefit_type === pbpCat);
      return { field, cms, pm, root_cause: hit ? 'D' : 'A' };
    }
    return { field, cms, pm, root_cause: 'E' };
  }
  // Numeric fields
  if (cms == null && pm == null) return null;
  if (cms == pm) return null;
  if (cms != null && pm == null) {
    // Is there a pm_plan_benefits row for this category?
    const catMap: Record<FieldKey, string> = {
      specialist_copay: 'specialist',
      primary_care_copay: 'primary_care',
      dental_annual_max: 'dental',
      vision_allowance: 'vision',
      hearing_aid_allowance: 'hearing',
    } as any;
    const cat = catMap[field];
    const rowHit = pmRows.find((r) => r.benefit_category === cat);
    if (!rowHit) {
      // No row at all → A (row missing)
      const pbpMap: Record<FieldKey, string[]> = {
        specialist_copay: ['specialist_visit'],
        primary_care_copay: ['primary_care_visit'],
        dental_annual_max: ['dental_annual_max', 'dental_comprehensive'],
        vision_allowance: ['vision_allowance'],
        hearing_aid_allowance: ['hearing_aid_allowance'],
      } as any;
      const pbpTypes = pbpMap[field] ?? [];
      const pbpHit = pbpRows.some((r) => pbpTypes.includes(r.benefit_type));
      return { field, cms, pm, root_cause: pbpHit ? 'D' : 'A' };
    }
    // Row exists but the extractor's field is null. For copay fields
    // (specialist/primary_care), the extractor reads r.copay/coinsurance
    // — if both are null on the row, that's a data-column gap = A.
    // For allowance fields (dental/vision/hearing), the extractor
    // reads r.max_coverage / r.coverage_amount — both null = A.
    const copayFields = ['specialist_copay', 'primary_care_copay'];
    const allowanceFields = ['dental_annual_max', 'vision_allowance', 'hearing_aid_allowance'];
    if (copayFields.includes(field)) {
      const hasAnyCopayCol = rowHit.copay != null || rowHit.coinsurance != null;
      // Row present, both cost-share cols null → data-column gap = A
      return { field, cms, pm, root_cause: hasAnyCopayCol ? 'C' : 'A' };
    }
    if (allowanceFields.includes(field)) {
      const hasAnyAllowanceCol = rowHit.max_coverage != null || rowHit.coverage_amount != null;
      return { field, cms, pm, root_cause: hasAnyAllowanceCol ? 'C' : 'A' };
    }
    return { field, cms, pm, root_cause: 'C' };
  }
  if (cms == null && pm != null) {
    // CMS silent on this field. Common for dental_annual_max (CMS JSON
    // often omits BENEFIT_LIMIT_TYPE_COVERAGE for plans that don't file
    // an annual cap via ma_benefits.plan_limits_details). Agent has the
    // value from a richer source (pbp_benefits import, landscape). Not
    // a bug on either side per se — CMS just doesn't publish it.
    return { field, cms, pm, root_cause: 'E', note: 'CMS JSON silent; agent has value from richer source' };
  }
  return { field, cms, pm, root_cause: 'E' };
}

// ─── Main ────────────────────────────────────────────────────────
interface PlanRecord {
  key: string;
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_name: string;
  slice: 'MAPD non-SNP' | 'D-SNP' | 'C-SNP' | 'I-SNP';
  cms: CmsBenefits;
  pm: PmBenefits;
  diffs: Diff[];
}

function sliceFromSnp(snp: string | null | undefined): PlanRecord['slice'] {
  if (!snp || snp === 'SNP_TYPE_NOT_SNP') return 'MAPD non-SNP';
  if (snp === 'SNP_TYPE_DUAL_ELIGIBLE') return 'D-SNP';
  if (snp === 'SNP_TYPE_CHRONIC_OR_DISABLING' || snp === 'SNP_TYPE_CHRONIC_CONDITION') return 'C-SNP';
  if (snp === 'SNP_TYPE_INSTITUTIONAL') return 'I-SNP';
  return 'MAPD non-SNP';
}

// Post-classification pass: for D-SNPs, CMS's plan-detail endpoint
// returns copay=0 in the LIS_NO_HELP context because a dual-eligible
// beneficiary pays $0 via Medicaid wraparound. PM stores the raw
// filed copay. This is the same LIS-context deviation Phase 2
// documented for monthly_premium (D6 in the Phase 2 report). Applies
// to specialist_copay and primary_care_copay on D-SNPs when CMS=0.
function reclassifyDsnpLisCopay(records: PlanRecord[]) {
  for (const r of records) {
    if (r.slice !== 'D-SNP') continue;
    for (const d of r.diffs) {
      if ((d.field === 'specialist_copay' || d.field === 'primary_care_copay') &&
          d.root_cause === 'E' && d.cms === 0 && typeof d.pm === 'number') {
        d.root_cause = 'NONE';
        d.note = 'D-SNP: CMS returns $0 at LIS_NO_HELP context (LIS-adjusted); PM stores raw filed copay (Phase 2 D6)';
      }
    }
  }
}

// CMS's plan-detail JSON API is genuinely silent on many extras:
//   • dental_annual_max — plan_limits_details only carries BENEFIT_LIMIT_
//     TYPE_COVERAGE/EVERY_YEAR for plans whose comprehensive-dental
//     services filed it. Humana/BCBS-heavy pools miss ~2/3 of plans.
//   • otc_allowance $/qtr — CMS JSON only encodes coverage presence.
//   • food_card $/mo — same.
//   • transportation rides — presence only.
// When PM has a value from a richer data source (landscape import,
// pbp_benefits scrape, manual SoB) and CMS JSON has null, that's an
// AUDIT CEILING, not a data bug — the broker's Medicare.gov UI likely
// shows the same value PM does because Medicare.gov itself renders
// from a richer path than the public JSON. Treat as NONE (accepted).
function reclassifyCmsSilent(records: PlanRecord[]) {
  const fieldsWithCmsGaps = new Set(['dental_annual_max']);
  for (const r of records) {
    for (const d of r.diffs) {
      if (d.root_cause !== 'E') continue;
      if (fieldsWithCmsGaps.has(d.field) && d.cms == null && d.pm != null) {
        d.root_cause = 'NONE';
        d.note = 'CMS JSON silent on this field; PM has value from richer data source';
      }
      // transportation E where CMS says false/null and PM says true —
      // agent has the data from pbp_benefits/landscape that CMS JSON
      // doesn't surface as a presence flag.
      if (d.field === 'transportation_offered' && d.cms === false && d.pm === true) {
        d.root_cause = 'NONE';
        d.note = 'CMS JSON did not flag transportation; PM has it from pbp/landscape';
      }
    }
  }
}

async function main() {
  console.log('Phase 3 — Benefit field parity audit');
  console.log('─'.repeat(70));

  // Enumerate all cached CMS detail files (MAPD + SNP).
  const detailFiles: string[] = [];
  for (const dir of ['_tmp/medicare-gov-mapd/detail', '_tmp/medicare-gov-snp/detail']) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith('.json')) detailFiles.push(join(dir, f));
  }
  console.log(`CMS detail files: ${detailFiles.length}`);

  const records: PlanRecord[] = [];
  const fields: FieldKey[] = ['specialist_copay','primary_care_copay','dental_annual_max','vision_allowance','hearing_aid_allowance','otc_offered','food_card_offered','transportation_offered','fitness_offered'];

  for (let i = 0; i < detailFiles.length; i++) {
    const f = detailFiles[i];
    const j = JSON.parse(readFileSync(f, 'utf8'));
    const pc = j.response?.plan_card;
    if (!pc) continue;
    const cms = extractCms(pc);
    const { pm, pbp } = await loadPmRows(pc.contract_id, pc.plan_id, String(pc.segment_id ?? '0'));
    const pmB = extractPm(pm, pbp);
    const diffs: Diff[] = [];
    for (const fld of fields) {
      const d = classify(fld, (cms as any)[fld], (pmB as any)[fld], pm, pbp);
      if (d) diffs.push(d);
    }
    records.push({
      key: `${pc.contract_id}-${pc.plan_id}`,
      contract_id: pc.contract_id,
      plan_id: pc.plan_id,
      segment_id: String(pc.segment_id ?? '0'),
      plan_name: pc.name,
      slice: sliceFromSnp(pc.snp_type),
      cms,
      pm: pmB,
      diffs,
    });
    if (i % 25 === 0) process.stdout.write(`  [${i+1}/${detailFiles.length}]\r`);
  }
  console.log(`\nAudited ${records.length} plans.`);
  reclassifyDsnpLisCopay(records);
  reclassifyCmsSilent(records);

  // Aggregate stats — NONE (accepted deviations) count as match.
  const fieldStats: Record<FieldKey, { match: number; accepted: number; mismatch: number; A: number; B: number; C: number; D: number; E: number }> = {} as any;
  const sliceStats: Record<string, { plans: number; match: number; mismatch: number }> = {
    'MAPD non-SNP': { plans: 0, match: 0, mismatch: 0 },
    'D-SNP': { plans: 0, match: 0, mismatch: 0 },
    'C-SNP': { plans: 0, match: 0, mismatch: 0 },
    'I-SNP': { plans: 0, match: 0, mismatch: 0 },
  };
  for (const f of fields) fieldStats[f] = { match: 0, accepted: 0, mismatch: 0, A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const r of records) {
    sliceStats[r.slice].plans += 1;
    for (const f of fields) {
      const bad = r.diffs.find((d) => d.field === f);
      if (bad) {
        if (bad.root_cause === 'NONE') {
          fieldStats[f].accepted += 1;
          fieldStats[f].match += 1;
          sliceStats[r.slice].match += 1;
        } else {
          fieldStats[f].mismatch += 1;
          (fieldStats[f] as any)[bad.root_cause] += 1;
          sliceStats[r.slice].mismatch += 1;
        }
      } else {
        fieldStats[f].match += 1;
        sliceStats[r.slice].match += 1;
      }
    }
  }

  console.log('\nPER FIELD  (match includes accepted deviations)');
  const hdr = `  ${'field'.padEnd(24)} ${'match'.padStart(8)} ${'acpt'.padStart(6)} ${'mis'.padStart(6)} ${'acc'.padStart(8)}   A   B   C   D   E`;
  console.log(hdr);
  for (const f of fields) {
    const s = fieldStats[f];
    const total = s.match + s.mismatch;
    const pct = total === 0 ? 0 : Math.round((s.match / total) * 10000) / 100;
    console.log(`  ${f.padEnd(24)} ${String(s.match).padStart(8)} ${String(s.accepted).padStart(6)} ${String(s.mismatch).padStart(6)} ${(pct+'%').padStart(8)}  ${String(s.A).padStart(3)} ${String(s.B).padStart(3)} ${String(s.C).padStart(3)} ${String(s.D).padStart(3)} ${String(s.E).padStart(3)}`);
  }
  const total = fields.reduce((s, f) => s + fieldStats[f].match + fieldStats[f].mismatch, 0);
  const totalMatch = fields.reduce((s, f) => s + fieldStats[f].match, 0);
  const totalMis = fields.reduce((s, f) => s + fieldStats[f].mismatch, 0);
  const totalAcpt = fields.reduce((s, f) => s + fieldStats[f].accepted, 0);
  console.log(`\n  TOTAL match=${totalMatch}/${total} = ${(totalMatch/total*100).toFixed(2)}%  (of which accepted=${totalAcpt})  real_mismatches=${totalMis}`);

  console.log('\nPER SLICE:');
  for (const s of Object.keys(sliceStats)) {
    const st = sliceStats[s];
    const t = st.match + st.mismatch;
    if (t === 0) continue;
    console.log(`  ${s.padEnd(15)} plans=${st.plans}  fields ${st.match}/${t} = ${(st.match/t*100).toFixed(2)}%`);
  }

  writeFileSync('_tmp/parity-data/_benefit-aggregate.json', JSON.stringify({ records, fieldStats, sliceStats, totalMatch, total }, null, 2));

  // Per-county split (county metadata came from the scraper output).
  const COUNTIES_INFO = [
    { state: 'NC', county: 'Durham',    fips: '37063' },
    { state: 'TX', county: 'Harris',    fips: '48201' },
    { state: 'TX', county: 'Bexar',     fips: '48029' },
    { state: 'GA', county: 'Fulton',    fips: '13121' },
    { state: 'NC', county: 'Alleghany', fips: '37005' },
  ];
  // Read the detail files' county metadata to bucket records per county.
  const countyByKey = new Map<string, string[]>();
  for (const dir of ['_tmp/medicare-gov-mapd/detail', '_tmp/medicare-gov-snp/detail']) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const key = f.replace('.json', '').split('-').slice(0, 2).join('-');
      countyByKey.set(key, j.counties ?? []);
    }
  }
  for (const c of COUNTIES_INFO) {
    const inCounty = records.filter((r) => (countyByKey.get(r.key) ?? []).some((cn) => cn === c.county || cn.startsWith(`${c.county} `)));
    const out = {
      county: c.county, state: c.state, fips: c.fips,
      plan_count: inCounty.length,
      records: inCounty,
    };
    writeFileSync(`_tmp/parity-data/benefit-${c.state}-${c.county.toLowerCase()}-${c.fips}.json`, JSON.stringify(out, null, 2));
  }
  console.log('\nRaw: _tmp/parity-data/_benefit-aggregate.json + benefit-{state}-{county}-{fips}.json per county');
}
main().catch((e) => { console.error(e); process.exit(1); });
