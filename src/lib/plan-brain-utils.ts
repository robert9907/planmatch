// Plan Brain — shared utilities for normalization, utilization
// derivation, and the dollarized extras-value table.

import type { PlanBenefitRow } from './brain-foreign-types';
import type { FormularyCoverage } from './brain-foreign-types';
import type { Utilization, UtilizationProfile, UserProfile, DrugCostCacheEntry } from './plan-brain-types';
import { dominantConditionProfile, type ConditionProfile, type ConditionSupply } from './condition-profiles';

// ─── Utilization profiles (CMS-typical visit counts) ──────────────────

export const UTIL_LOW: Utilization = {
  pcp_visits: 2, specialist_visits: 1, lab_visits: 1, imaging_visits: 0,
  er_visits: 0, inpatient_days: 0,
};
export const UTIL_MODERATE: Utilization = {
  pcp_visits: 4, specialist_visits: 3, lab_visits: 2, imaging_visits: 1,
  er_visits: 0.5, inpatient_days: 0,
};
export const UTIL_HIGH: Utilization = {
  pcp_visits: 6, specialist_visits: 5, lab_visits: 3, imaging_visits: 2,
  er_visits: 1, inpatient_days: 0.3,
};

// Derive profile from condition signal first, then fall back to the
// drug-count heuristic. Order:
//   1. condition-aware profile (diabetes/CHF/COPD/cancer/hypertension)
//      from condition-profiles.ts — exact visit counts per actuarial
//      averages for that population
//   2. drug-count heuristic (legacy):
//        <3 meds  → low (healthy)
//        3-6 meds → moderate (typical)
//        7+ meds  → high (complex)
//      Any chronic condition without a per-condition profile (esrd
//      currently) bumps low → moderate.
//
// Returns the picked condition profile alongside so the caller can
// build a condition-aware cost-breakdown string.
export function deriveUtilization(profile: UserProfile): {
  profile: UtilizationProfile | 'condition';
  utilization: Utilization;
  conditionProfile: ConditionProfile | null;
} {
  const cp = dominantConditionProfile(profile.csnpConditions);
  if (cp) {
    return { profile: 'condition', utilization: cp.utilization, conditionProfile: cp };
  }
  const n = profile.drugs.length;
  const hasChronic = (profile.csnpConditions ?? []).length > 0;
  let p: UtilizationProfile;
  if (n >= 7) p = 'high';
  else if (n >= 3 || hasChronic) p = 'moderate';
  else p = 'low';
  const u = p === 'high' ? UTIL_HIGH : p === 'moderate' ? UTIL_MODERATE : UTIL_LOW;
  return { profile: p, utilization: u, conditionProfile: null };
}

// ─── Benefit lookup helpers ───────────────────────────────────────────

export function benefitByCategory(
  benefits: PlanBenefitRow[],
  category: string,
): PlanBenefitRow | undefined {
  return benefits.find((b) => b.benefit_category === category);
}

// Cost a single service slot — flat copay > coinsurance × notional
// service price > 0. Notional prices are CMS-published averages used
// when the plan only files a coinsurance percentage (rare for primary/
// specialist; common for inpatient and outpatient surgery).
const NOTIONAL_SERVICE_PRICE: Record<string, number> = {
  primary_care: 150,
  specialist: 250,
  urgent_care: 200,
  emergency: 1500,
  inpatient: 2500, // per day
  outpatient_surgery: 3000,
  lab: 80,
  imaging: 800,
  ambulance: 1200,
};

export function copayForCategory(benefits: PlanBenefitRow[], category: string): number {
  const b = benefitByCategory(benefits, category);
  if (!b) return 0;
  if (b.copay != null) return b.copay;
  if (b.coinsurance != null) {
    const notional = NOTIONAL_SERVICE_PRICE[category] ?? 200;
    return Math.round(notional * (b.coinsurance / 100));
  }
  return 0;
}

// Compute estimated annual medical cost from utilization × per-service
// copay (capped at MOOP). Premium NOT included here — caller adds it
// after the MOOP cap so the cap doesn't swallow the premium too.
//
// Defensive fallback: when pbp_benefits doesn't carry the load-bearing
// cost-share rows (PCP / specialist / lab / imaging) for a plan, the
// raw sum collapses to $0. This isn't "free care" — it's a data gap
// (some carriers under-file pbp_benefits, especially BCBS NC). Without
// a fallback the Compare screen renders a $0 estimated total, which
// is misleading. Use a CMS-typical floor instead: half the in-network
// MOOP, capped at $1,500. Conservative; still rewards low-MOOP plans.
export function annualMedicalCostFromUtilization(
  benefits: PlanBenefitRow[],
  util: Utilization,
  moopInNetwork: number | null,
): number {
  const pcpCopay = copayForCategory(benefits, 'primary_care');
  const specCopay = copayForCategory(benefits, 'specialist');
  const labCopay = copayForCategory(benefits, 'lab');
  // pm_plan_benefits canonical key is 'advanced_imaging'. The legacy
  // PBP synth key 'imaging' only appears on medicare_gov-derived rows
  // (PBP_TYPE_TO_CATEGORY.imaging → 'imaging'). Landscape-only plans
  // would silently return $0 here pre-fix.
  const imgCopay = copayForCategory(benefits, 'advanced_imaging');
  const erCopay = copayForCategory(benefits, 'emergency');
  const ipCopay = copayForCategory(benefits, 'inpatient');
  const raw =
    util.pcp_visits * pcpCopay +
    util.specialist_visits * specCopay +
    util.lab_visits * labCopay +
    util.imaging_visits * imgCopay +
    util.er_visits * erCopay +
    util.inpatient_days * ipCopay;

  // None of the load-bearing categories filed → assume data gap, not
  // free. ER and inpatient are checked too because a plan with ONLY
  // ER/inpatient filed (no outpatient) is also under-filed.
  const hasOutpatientCostShare =
    benefitByCategory(benefits, 'primary_care') != null ||
    benefitByCategory(benefits, 'specialist') != null;
  const hasAnyCostShare =
    hasOutpatientCostShare ||
    benefitByCategory(benefits, 'lab') != null ||
    benefitByCategory(benefits, 'advanced_imaging') != null;
  if (!hasAnyCostShare && moopInNetwork != null && moopInNetwork > 0) {
    return Math.min(1500, Math.round(moopInNetwork / 2));
  }

  const capped = moopInNetwork != null && moopInNetwork > 0
    ? Math.min(raw, moopInNetwork)
    : raw;
  return Math.round(capped);
}

// ─── Drug cost estimation ─────────────────────────────────────────────

// Common Part D insulin names (subset of the PlanDetail INSULIN_NAME_RE)
// — the IRA $35/mo cap applies regardless of the plan's nominal rate.
const INSULIN_NAME_RE =
  /\b(insulin|lantus|basaglar|toujeo|levemir|tresiba|humalog|novolog|fiasp|admelog|apidra|lyumjev|humulin|novolin|afrezza|semglee|rezvoglar)\b/i;
const INSULIN_MONTHLY_CAP_2026 = 35;

// Notional retail price per tier — used when the per-NDC drug cost
// cache hasn't been populated yet for this plan. Empirically sane for
// Medicare-age generics + brand baskets.
const NOTIONAL_TIER_FULL_COST: Record<number, number> = {
  1: 8,
  2: 30,
  3: 200,
  4: 500,
  5: 1500,
};

// CMS national-average monthly cost-share by tier. Fallback when a
// plan's rx_tier_N row exists in pm_plan_benefits but carries null
// for both copay AND coinsurance (data gap — cost-share filed only
// in the description text). Without this, a Tier 3+ brand like
// Ozempic returns $0/mo and poisons the funnel's drug-cost ranking.
export const CMS_TYPICAL_MONTHLY_BY_TIER: Readonly<Record<number, number>> = {
  1: 2,
  2: 15,
  3: 47,
  4: 100,
  5: 300,
};

interface EstimateDrugInput {
  rxcui?: string;
  name: string;
  formulary: Map<string, FormularyCoverage>;
  benefits: PlanBenefitRow[];
  cache?: Map<string, DrugCostCacheEntry>;
  rxcuiToNdc?: Map<string, string>;
}

export interface DrugYearlyEstimate {
  rxcui: string | undefined;
  name: string;
  tier: number | null;
  yearlyCost: number;
  covered: boolean;
}

// Single-drug yearly cost estimate. Cache hit → use it. Cache miss →
// fall back to formulary tier × notional retail × tier rate.
export function estimateDrugYearlyCost(d: EstimateDrugInput): DrugYearlyEstimate {
  const cov = d.rxcui ? d.formulary.get(d.rxcui) : undefined;
  const tier = cov?.tier ?? null;

  // Cache path
  if (d.rxcui && d.cache && d.rxcuiToNdc) {
    const ndc = d.rxcuiToNdc.get(d.rxcui);
    const hit = ndc ? d.cache.get(ndc) : undefined;
    if (hit) {
      const yearly = hit.estimated_yearly_total ?? estimateFromTier(hit.tier ?? tier, hit.full_cost ?? null, d.benefits);
      const capped = INSULIN_NAME_RE.test(d.name)
        ? Math.min(yearly, INSULIN_MONTHLY_CAP_2026 * 12)
        : yearly;
      return {
        rxcui: d.rxcui,
        name: d.name,
        tier: hit.tier ?? tier,
        yearlyCost: Math.max(0, Math.round(capped)),
        covered: hit.covered,
      };
    }
  }

  // Formulary fallback — use plan's tier copay/coinsurance
  if (cov) {
    const yearly = estimateFromTier(tier, NOTIONAL_TIER_FULL_COST[tier ?? 3] ?? 200, d.benefits);
    const capped = INSULIN_NAME_RE.test(d.name)
      ? Math.min(yearly, INSULIN_MONTHLY_CAP_2026 * 12)
      : yearly;
    return { rxcui: d.rxcui, name: d.name, tier, yearlyCost: Math.max(0, Math.round(capped)), covered: true };
  }

  // Not in formulary — heavy penalty per spec: assume full retail.
  const fullCost = NOTIONAL_TIER_FULL_COST[3] * 12; // ~$2,400 if uncovered brand-tier guess
  return { rxcui: d.rxcui, name: d.name, tier: null, yearlyCost: fullCost, covered: false };
}

// ─── Bundle drug cost — Part D deductible-aware ──────────────────────
//
// Per-drug estimateDrugYearlyCost can't model the Part D drug deductible
// because the deductible is shared across the bundle: every Tier 3-5
// brand/specialty drug the user fills burns the same pot down. This
// bundle function reads the plan's drug_deductible once, computes how
// many months of full retail it takes to clear it, then mixes
// post-deductible copay/coinsurance for the remaining months.
//
//   - Tier 1-2 generics       → deductible-exempt; pay copay × 12.
//   - Tier 3-5 brand/specialty → share the deductible pot pro-rata by
//                                each drug's monthly retail. After the
//                                pot is empty, switch to copay /
//                                coinsurance × remaining_months.
//   - Insulin (IRA cap)        → flat $35/mo Part B-side cap supersedes
//                                the deductible (regulatory floor).
//
// Per-drug attribution: the deductible_paid bundle dollar is split
// across Tier 3-5 drugs by relative retail contribution, so the sum
// of per-drug yearlyCost equals the bundle total (drug_deductible +
// sum of copay × remaining_months + tier 1-2 copay × 12).
//
// Returns one DrugYearlyEstimate per input drug, in input order.

interface EstimateBundleInput {
  drugs: ReadonlyArray<{ rxcui?: string; name: string }>;
  formulary: Map<string, FormularyCoverage>;
  benefits: PlanBenefitRow[];
  drugDeductible: number | null;
  cache?: Map<string, DrugCostCacheEntry>;
  rxcuiToNdc?: Map<string, string>;
}

interface DrugInfo {
  input: { rxcui?: string; name: string };
  tier: number | null;
  retailMonthly: number;
  postDeductibleMonthly: number;
  covered: boolean;
  isInsulin: boolean;
  cacheOverride: number | null;
}

export function estimateBundleYearlyCost(args: EstimateBundleInput): DrugYearlyEstimate[] {
  const infos: DrugInfo[] = args.drugs.map((d) => {
    const cov = d.rxcui ? args.formulary.get(d.rxcui) : undefined;
    const tier = cov?.tier ?? null;
    const isInsulin = INSULIN_NAME_RE.test(d.name);

    let cacheOverride: number | null = null;
    let cachedFullCost: number | null = null;
    let cachedTier: number | null = null;
    let cachedCovered: boolean | null = null;
    if (d.rxcui && args.cache && args.rxcuiToNdc) {
      const ndc = args.rxcuiToNdc.get(d.rxcui);
      const hit = ndc ? args.cache.get(ndc) : undefined;
      if (hit) {
        cachedTier = hit.tier;
        cachedCovered = hit.covered;
        cachedFullCost = hit.full_cost;
        if (hit.estimated_yearly_total != null) {
          const yearly = isInsulin
            ? Math.min(hit.estimated_yearly_total, INSULIN_MONTHLY_CAP_2026 * 12)
            : hit.estimated_yearly_total;
          cacheOverride = Math.max(0, Math.round(yearly));
        }
      }
    }

    if (cacheOverride != null) {
      return {
        input: d,
        tier: cachedTier ?? tier,
        retailMonthly: 0,
        postDeductibleMonthly: 0,
        covered: cachedCovered ?? true,
        isInsulin,
        cacheOverride,
      };
    }

    const effectiveTier = cachedTier ?? tier;
    if (effectiveTier == null && !cov && cachedCovered !== true) {
      const retailMonthly = NOTIONAL_TIER_FULL_COST[3];
      return {
        input: d,
        tier: null,
        retailMonthly,
        postDeductibleMonthly: retailMonthly,
        covered: false,
        isInsulin,
        cacheOverride: null,
      };
    }

    const retailMonthly =
      cachedFullCost && cachedFullCost > 0
        ? cachedFullCost
        : NOTIONAL_TIER_FULL_COST[effectiveTier ?? 3] ?? NOTIONAL_TIER_FULL_COST[3];
    const tierBenefit = benefitByCategory(args.benefits, `rx_tier_${effectiveTier}`);
    let postDeductibleMonthly = 0;
    if (tierBenefit?.copay != null) postDeductibleMonthly = tierBenefit.copay;
    else if (tierBenefit?.coinsurance != null) {
      postDeductibleMonthly = Math.round(retailMonthly * (tierBenefit.coinsurance / 100));
    } else if (effectiveTier != null && !isInsulin) {
      const typical = CMS_TYPICAL_MONTHLY_BY_TIER[effectiveTier];
      postDeductibleMonthly = typical ?? 0;
    }
    return {
      input: d,
      tier: effectiveTier,
      retailMonthly,
      postDeductibleMonthly,
      covered: true,
      isInsulin,
      cacheOverride: null,
    };
  });

  const drugDeductible = Math.max(0, args.drugDeductible ?? 0);
  const tier3plus = infos.filter(
    (i) =>
      i.cacheOverride == null &&
      i.tier != null &&
      i.tier >= 3 &&
      !i.isInsulin &&
      i.covered,
  );
  const tier3plusRetailMonthly = tier3plus.reduce((s, i) => s + i.retailMonthly, 0);
  let monthsToDeductible = 0;
  let deductiblePaid = 0;
  if (drugDeductible > 0 && tier3plusRetailMonthly > 0) {
    monthsToDeductible = Math.min(12, Math.ceil(drugDeductible / tier3plusRetailMonthly));
    deductiblePaid = Math.min(drugDeductible, tier3plusRetailMonthly * 12);
  }
  const remainingMonths = 12 - monthsToDeductible;

  return infos.map((info) => {
    if (info.cacheOverride != null) {
      return {
        rxcui: info.input.rxcui,
        name: info.input.name,
        tier: info.tier,
        yearlyCost: info.cacheOverride,
        covered: info.covered,
      };
    }
    if (!info.covered) {
      const yearly = info.isInsulin
        ? INSULIN_MONTHLY_CAP_2026 * 12
        : info.retailMonthly * 12;
      return {
        rxcui: info.input.rxcui,
        name: info.input.name,
        tier: null,
        yearlyCost: Math.max(0, Math.round(yearly)),
        covered: false,
      };
    }
    if (info.isInsulin) {
      const yearly = Math.min(info.postDeductibleMonthly * 12, INSULIN_MONTHLY_CAP_2026 * 12);
      return {
        rxcui: info.input.rxcui,
        name: info.input.name,
        tier: info.tier,
        yearlyCost: Math.max(0, Math.round(yearly)),
        covered: true,
      };
    }
    if (info.tier != null && info.tier <= 2) {
      return {
        rxcui: info.input.rxcui,
        name: info.input.name,
        tier: info.tier,
        yearlyCost: Math.max(0, Math.round(info.postDeductibleMonthly * 12)),
        covered: true,
      };
    }
    let yearly: number;
    if (tier3plusRetailMonthly > 0 && deductiblePaid > 0) {
      const share = (info.retailMonthly / tier3plusRetailMonthly) * deductiblePaid;
      const postDeductible = info.postDeductibleMonthly * remainingMonths;
      yearly = share + postDeductible;
    } else {
      yearly = info.postDeductibleMonthly * 12;
    }
    return {
      rxcui: info.input.rxcui,
      name: info.input.name,
      tier: info.tier,
      yearlyCost: Math.max(0, Math.round(yearly)),
      covered: true,
    };
  });
}

// Compute monthly cost from a tier and a full retail price. Uses the
// plan's filed rx_tier_N copay/coinsurance from pbp_benefits.
function estimateFromTier(
  tier: number | null,
  fullCost30: number | null,
  benefits: PlanBenefitRow[],
): number {
  if (tier == null || fullCost30 == null) return 0;
  const tierBenefit = benefitByCategory(benefits, `rx_tier_${tier}`);
  if (tierBenefit?.copay != null) return tierBenefit.copay * 12;
  if (tierBenefit?.coinsurance != null) return Math.round(fullCost30 * (tierBenefit.coinsurance / 100) * 12);
  return 0;
}

// ─── Extras dollarization ─────────────────────────────────────────────

// Per-category default annual values. When the plan files an actual
// dollar amount we use that; these are the floor values for "the
// benefit is included" without a published amount.
const EXTRAS_DEFAULT_VALUE: Record<string, number> = {
  dental_preventive: 200,
  dental: 500,            // comprehensive — counted only if covered, not rider-only
  vision_exam: 100,
  vision: 75,             // $150 every 2 years → $75/yr
  hearing_exam: 50,
  hearing: 300,
  otc: 0,                 // dollarized from coverage_amount
  meals: 0,               // food card — dollarized
  meal_benefit: 150,      // post-discharge meals
  fitness: 300,
  transportation: 200,
  insulin: 400,           // diabetic supplies category key
  telehealth: 100,
  partb_giveback: 0,      // tracked separately, NOT in extras score
};

// Categories the user could prioritize (set in About-You priorities).
// Matches the priority key vocabulary; categories not in this map are
// scored at default value without doubling.
const PRIORITY_TO_CATEGORIES: Record<string, ReadonlyArray<string>> = {
  dental: ['dental_preventive', 'dental'],
  vision: ['vision_exam', 'vision'],
  hearing: ['hearing_exam', 'hearing'],
  otc: ['otc'],
  food_card: ['meals'],
  fitness: ['fitness'],
  transportation: ['transportation'],
  meal_benefit: ['meal_benefit'],
  diabetic_supplies: ['insulin'],
  telehealth: ['telehealth'],
};

/**
 * R7 — extra-benefits dollar-value bonus. Returns the annual dollar
 * value of the extras subset Rob calls out for explicit emphasis:
 *
 *   - OTC          coverage_amount × period (parsed from description;
 *                  defaults to QUARTERLY when ambiguous — matches the
 *                  CMS PBP filing convention)
 *   - Food card    coverage_amount × period (DEFAULTS TO MONTHLY).
 *                  Returns $0 on non-SNP plan types — food cards are
 *                  D-SNP / C-SNP-only by CMS rule and the upstream
 *                  importer occasionally lifts a food row onto a
 *                  standard MAPD; R7 ignores those filings.
 *   - Part B giveback   coverage_amount × 12 (always monthly per CMS).
 *                  DELIBERATE double-emphasis with the OOP axis (which
 *                  also subtracts giveback) — broker spec: giveback is
 *                  the highest-leverage extras lever for healthy
 *                  clients, the rank-normalized OOP axis dilutes it
 *                  too much in the typical pool.
 *   - Transportation  flat +$200 when ANY transportation row exists
 *                     (matches EXTRAS_DEFAULT_VALUE.transportation).
 *   - Fitness        flat +$300 when ANY fitness row exists
 *                    (matches EXTRAS_DEFAULT_VALUE.fitness).
 *
 * Doesn't touch dental / vision / hearing — those are already first-
 * class via the extras axis (rank-normalized) and dentalProportionalBonus.
 * This is the *additive absolute-dollar* layer, the one that survives
 * pool normalization so a $1,200/yr extras bundle reliably differentiates
 * from a $300/yr bundle in composite points.
 *
 * Period detection reads benefit_description for "monthly", "quarterly",
 * "annual" keywords. When the description is silent, falls back to
 * category-specific defaults (OTC=quarterly, food=monthly) since CMS
 * PBP filing conventions for these categories are well-established.
 */
export function r7ExtrasAnnualValue(
  benefits: PlanBenefitRow[],
  planType: string | null | undefined,
): number {
  const isSnp = /\b[CDI]-?SNP\b/i.test(planType ?? '');
  const detectPeriod = (
    desc: string | null | undefined,
    fallback: 'month' | 'quarter' | 'year',
  ): 'month' | 'quarter' | 'year' => {
    const s = (desc ?? '').toLowerCase();
    if (s.includes('monthly') || s.includes('/mo') || s.includes('per month')) return 'month';
    if (s.includes('quarter') || s.includes('/qtr')) return 'quarter';
    if (s.includes('yearly') || s.includes('annual') || s.includes('/yr') || s.includes('per year')) return 'year';
    return fallback;
  };
  const annualize = (amount: number, period: 'month' | 'quarter' | 'year'): number => {
    if (period === 'month') return amount * 12;
    if (period === 'quarter') return amount * 4;
    return amount;
  };
  // pm_plan_benefits occasionally contains duplicate rows for the same
  // (plan, category) pair — most often partb_giveback and hearing,
  // where the SB/PBP merge appended without de-duping. Iterating the
  // raw list would double-count: a $175/mo giveback filed twice would
  // add $4,200 instead of $2,100. Pick the row with the highest filed
  // amount per category as the canonical entry — that matches the
  // "most favorable filing" convention used elsewhere in the brain
  // (and is also what `benefitByCategory(...).find(...)` would pick
  // when row order happens to put the higher one first).
  const canonicalByCategory = new Map<string, PlanBenefitRow>();
  for (const b of benefits) {
    const cat = b.benefit_category;
    const filed = (b.coverage_amount ?? b.max_coverage ?? 0) || 0;
    const existing = canonicalByCategory.get(cat);
    if (!existing) {
      canonicalByCategory.set(cat, b);
    } else {
      const existingFiled = (existing.coverage_amount ?? existing.max_coverage ?? 0) || 0;
      if (filed > existingFiled) canonicalByCategory.set(cat, b);
    }
  }

  let total = 0;
  let hasTransportation = false;
  let hasFitness = false;

  for (const b of canonicalByCategory.values()) {
    const cat = b.benefit_category;
    if (cat === 'otc') {
      const filed = b.coverage_amount ?? b.max_coverage ?? null;
      if (filed != null && filed > 0) {
        total += annualize(filed, detectPeriod(b.benefit_description, 'quarter'));
      }
    } else if (cat === 'meals') {
      // CMS-restricted to D-SNP / C-SNP plan filings. Skip on standard
      // MAPD even when an importer mistakenly lifted a row onto one —
      // those filings are non-deliverable and shouldn't earn composite
      // points.
      if (!isSnp) continue;
      const filed = b.coverage_amount ?? b.max_coverage ?? null;
      if (filed != null && filed > 0) {
        total += annualize(filed, detectPeriod(b.benefit_description, 'month'));
      }
    } else if (cat === 'partb_giveback') {
      // Always monthly — Part B giveback is filed as a monthly Part B
      // premium credit per CMS. Note: also reduces totalOOPEstimate
      // upstream; this R7 line is the deliberate double-count.
      const filed = b.coverage_amount ?? null;
      if (filed != null && filed > 0) total += filed * 12;
    } else if (cat === 'transportation') {
      hasTransportation = true;
    } else if (cat === 'fitness') {
      hasFitness = true;
    }
  }

  if (hasTransportation) total += 200;
  if (hasFitness) total += 300;

  return Math.round(total);
}

export function annualExtrasValue(
  benefits: PlanBenefitRow[],
  priorities: ReadonlySet<string>,
  conditionBoostCategories: ReadonlyArray<string> = [],
): number {
  // Two multiplier layers:
  //   priorities → user explicitly checked the category → 2×
  //   condition-key extras → not user-picked but materially relevant
  //     to their reported chronic condition (food card for diabetes,
  //     transport for COPD) → 1.5×
  // When both apply, multiplied together (3×). Caps at 3× since
  // doubling priority on top of condition is the most a user can
  // signal to lean on extras.
  const doubledCategories = new Set<string>();
  for (const pri of priorities) {
    const cats = PRIORITY_TO_CATEGORIES[pri];
    if (cats) for (const c of cats) doubledCategories.add(c);
  }
  const boostedCategories = new Set(conditionBoostCategories);

  let total = 0;
  // OTC is annualized once across the whole row set via extractOtcQuarterly
  // (it picks the canonical OTC row), then ×4 to annualize. Skip per-row
  // OTC handling below to avoid double-counting.
  const otcAnnual = extractOtcQuarterly(benefits).quarterly * 4;
  let otcAdded = false;
  for (const b of benefits) {
    const cat = b.benefit_category;
    if (!(cat in EXTRAS_DEFAULT_VALUE)) continue;
    if (cat === 'partb_giveback') continue; // handled by OOP axis
    const filed = b.coverage_amount ?? b.max_coverage ?? null;
    let value = 0;
    if (cat === 'otc') {
      if (otcAdded) continue;
      otcAdded = true;
      value = otcAnnual;
    } else if (cat === 'meals') {
      if (filed != null) value = filed < 100 ? filed * 12 : filed;
    } else if (cat === 'vision') {
      // Vision coverage_amount arrives ANNUAL — the API
      // (transformPbpRow) halves biennial values from medicare_gov so
      // every consumer (brain, dropdown, pills) sees the same dollar.
      // Trust the filed annual; fall back to the default annual value.
      if (filed != null) value = filed;
      else value = EXTRAS_DEFAULT_VALUE.vision;
    } else if (cat === 'hearing') {
      if (filed != null) value = filed;
      else value = EXTRAS_DEFAULT_VALUE.hearing;
    } else if (filed != null) {
      // Falls into a covered category with a filed dollar — trust it.
      value = filed;
    } else {
      // Covered without an explicit dollar — use the floor default.
      value = EXTRAS_DEFAULT_VALUE[cat] ?? 0;
    }
    if (doubledCategories.has(cat)) value *= 2;
    if (boostedCategories.has(cat)) value *= 1.5;
    total += value;
  }
  return Math.round(total);
}

// ─── Supply coverage ──────────────────────────────────────────────────
//
// For each ConditionSupply the user picked, decide whether the plan
// covers it. Three outcomes:
//   - covered          → supply.annualValue contributes to extras
//   - brand_mismatch   → benefit exists but description names a
//                         brand outside supply.brands (e.g., plan
//                         covers Contour/Accu-Chek only, user has CGM)
//   - not_covered      → no benefit row at all → 0 value, gap flagged
//
// Brand-restriction matching is case-insensitive substring search
// against benefit_description. When a supply has no brands list,
// any benefit row counts as covered.

export type SupplyCoverage =
  | { status: 'covered'; supply: ConditionSupply; valueAnnual: number }
  | { status: 'brand_mismatch'; supply: ConditionSupply; valueAnnual: 0 }
  | { status: 'not_covered'; supply: ConditionSupply; valueAnnual: 0 };

export function computeSupplyCoverage(
  benefits: PlanBenefitRow[],
  selectedSupplies: ReadonlyArray<string>,
  conditionProfile: ConditionProfile | null,
): SupplyCoverage[] {
  if (!conditionProfile || selectedSupplies.length === 0) return [];
  const out: SupplyCoverage[] = [];
  for (const key of selectedSupplies) {
    const supply = conditionProfile.supplies.find((s) => s.key === key);
    if (!supply) continue;
    const benefit = benefitByCategory(benefits, supply.benefitCategory);
    if (!benefit) {
      out.push({ status: 'not_covered', supply, valueAnnual: 0 });
      continue;
    }
    if (supply.brands && supply.brands.length > 0) {
      const desc = (benefit.benefit_description ?? '').toLowerCase();
      // When the benefit description names ANY brand, only listed
      // brands count. If the description doesn't mention brands at
      // all, assume default brand selection covers the user.
      const namesAnyBrand = supply.brands.some((b) =>
        desc.includes(b.toLowerCase()),
      );
      // A benefit that mentions "diabetic supplies" without naming
      // a brand is treated as covering all supply types — only flag
      // brand_mismatch when the benefit description specifically
      // restricts brands (heuristic: contains "only" or "limited").
      const looksRestricted = /only|limited|preferred|exclusive/i.test(
        benefit.benefit_description ?? '',
      );
      if (looksRestricted && !namesAnyBrand) {
        out.push({ status: 'brand_mismatch', supply, valueAnnual: 0 });
        continue;
      }
    }
    out.push({ status: 'covered', supply, valueAnnual: supply.annualValue });
  }
  return out;
}

// Sum the dollarized supply value for the extras axis. Capped at the
// per-supply value — no double-counting if the brain already added
// the category's standard EXTRAS_DEFAULT_VALUE (since selected
// supplies override the floor).
export function suppliesValueAnnual(coverage: SupplyCoverage[]): number {
  return coverage.reduce((sum, c) => sum + c.valueAnnual, 0);
}

// Part B giveback as an annual cost reduction. Subtracted from the
// totalOOPEstimate per spec. Negative number flips into a savings
// pile.
/**
 * Annual dollar value of a single extras category from a plan's
 * benefit rows. Reads coverage_amount first, falls back to
 * max_coverage. Category-specific normalization:
 *   vision           — coverage_amount is already annual (see
 *                      api/plans-with-extras.ts transformPbpRow which
 *                      halves biennial medicare_gov rows).
 *   otc              — quarterly per CMS PBP convention; period parsed
 *                      from description (extractOtcQuarterly), then ×4.
 *   partb_giveback   — filed monthly → ×12.
 *   everything else  — filed value used as-is (already annual).
 */
export function extractCategoryAnnualValue(
  benefits: ReadonlyArray<{ benefit_category: string; coverage_amount: number | null; max_coverage: number | null; benefit_description?: string | null }>,
  category: 'dental' | 'vision' | 'otc' | 'partb_giveback' | 'hearing' | 'fitness' | 'transportation' | 'telehealth' | 'meals',
): number {
  if (category === 'otc') {
    const { quarterly } = extractOtcQuarterly(benefits);
    return quarterly * 4;
  }
  const row = benefits.find((b) => b.benefit_category === category);
  if (!row) return 0;
  const filed = row.coverage_amount ?? row.max_coverage ?? null;
  if (filed == null) return 0;
  if (category === 'vision') return filed;
  if (category === 'partb_giveback') return filed * 12;
  return filed;
}

export function partBGivebackAnnual(benefits: PlanBenefitRow[]): number {
  const b = benefitByCategory(benefits, 'partb_giveback');
  if (!b) return 0;
  const monthly = b.coverage_amount ?? b.copay ?? 0;
  return Math.round(monthly * 12);
}

/**
 * Quarterly OTC allowance for a plan. ~95% of MA plans file OTC as a
 * quarterly benefit per CMS PBP convention; a few file monthly. Returns
 * a normalized quarterly dollar value plus the period the row was filed
 * under so callers (UI) can label appropriately ("$90/qtr" vs "$30/mo").
 */
export function extractOtcQuarterly(
  benefits: ReadonlyArray<{ benefit_category: string; coverage_amount: number | null; max_coverage: number | null; benefit_description?: string | null }>,
): { quarterly: number; period: 'month' | 'quarter' } {
  const row = benefits.find((b) => b.benefit_category === 'otc');
  if (!row) return { quarterly: 0, period: 'quarter' };
  const filed = row.coverage_amount ?? row.max_coverage ?? null;
  if (filed == null || filed <= 0) return { quarterly: 0, period: 'quarter' };
  const desc = (row.benefit_description ?? '').toLowerCase();
  const isMonthly =
    desc.includes('monthly') || desc.includes('/mo') || desc.includes('per month');
  if (isMonthly) return { quarterly: filed * 3, period: 'month' };
  // Annual filings (rare): /yr → /qtr is /4. Fall through to quarterly default.
  if (desc.includes('yearly') || desc.includes('annual') || desc.includes('/yr') || desc.includes('per year')) {
    return { quarterly: Math.round(filed / 4), period: 'quarter' };
  }
  return { quarterly: filed, period: 'quarter' };
}

// ─── Score normalization ──────────────────────────────────────────────

// Linear-interp inversion: lowest input → 100, highest → 0. Identical
// inputs all return 100 (treat ties as "everyone is best on this axis"
// rather than 0 which would zero out a whole axis).
export function normalizeInverse(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return values.map(() => 100);
  return values.map((v) => Math.round(100 * (max - v) / (max - min)));
}

// Direct (high = good). Used for extras axis.
export function normalizeDirect(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return values.map(() => 100);
  return values.map((v) => Math.round(100 * (v - min) / (max - min)));
}

// ─── Dental tier classification ───────────────────────────────────────
//
// Every MAPD plan advertises "dental." ~80% of them are preventive-only
// (cleanings + exams + x-rays — ~$50–100/yr retail value). A user who
// says "I want good dental" means crowns, dentures, root canals,
// implants — comprehensive coverage with a real annual allowance.
//
// The dollar threshold gate (priorityThresholds.dental) catches the
// crude case but misses semantic gaps: a "$1,500 preventive-only annual
// max" passes a $1,000 threshold even though it doesn't cover crowns.
// This classifier reads the description text alongside the allowance to
// surface the real distinction.
//
//   preventive   — cleanings/exams/x-rays only. The CMS baseline; every
//                  MAPD has it. Value to an extras-shopping consumer ≈ $0.
//   basic        — adds fillings/extractions. Allowance under $1,000 OR
//                  description names major work but no real cap.
//   comprehensive — major work (crowns/dentures/implants/endodontics/
//                  prosthodontics) with a meaningful annual allowance
//                  (≥$1,000). What "good dental" actually means.
//
// Tier 1 carries a -10 composite penalty when the user picked dental
// as a priority (see plan-brain.ts), and the Report Card surfaces the
// tier label so the consumer sees "Comprehensive — $2,000/yr" instead
// of an undifferentiated "Dental ✓".

export type DentalTier = 'preventive' | 'basic' | 'comprehensive';

const COMPREHENSIVE_RE =
  /\b(comprehensive|crown|denture|implant|endodont|prosthodont|root\s*canal|major\s+(?:service|restorative|dental))\b/i;
const BASIC_RE = /\b(filling|extraction|restorative|simple\s+oral|basic\s+dental)\b/i;
const PREVENTIVE_ONLY_RE = /\b(preventive|cleaning|exam|x-?ray|fluoride)\b/i;

/**
 * Classify a plan's dental benefit into preventive / basic /
 * comprehensive. `description` is the merged benefit_description from
 * /api/plan-benefits (medicare_gov > sb_ocr > pbp_federal > landscape);
 * `allowance` is the filed annual max (coverage_amount ?? max_coverage).
 *
 * Lives next to the rest of the benefit utils so both the brain (for
 * scoring) and the Report Card (for the row label) can call the same
 * function and stay in sync.
 */
export function classifyDentalTier(
  description: string | null | undefined,
  allowance: number | null | undefined,
): DentalTier {
  const desc = (description ?? '').toLowerCase();
  const dollar = typeof allowance === 'number' && Number.isFinite(allowance) ? allowance : null;

  const hasComprehensive = COMPREHENSIVE_RE.test(desc);
  const hasBasic = BASIC_RE.test(desc);
  const hasPreventiveOnly = PREVENTIVE_ONLY_RE.test(desc) && !hasComprehensive && !hasBasic;

  // Comprehensive label + a real annual allowance is the only path to
  // tier 3. A "Preventive + comprehensive dental · 20% coinsurance" row
  // (no annual max filed) drops to basic — coinsurance plans without a
  // cap don't behave like the $2,000-allowance plans consumers picture.
  if (hasComprehensive && dollar != null && dollar >= 1000) return 'comprehensive';
  if (hasComprehensive) return 'basic';
  if (hasBasic) return 'basic';
  if (dollar != null && dollar >= 500) return 'basic';
  // Empty descriptions (or anything that isn't comprehensive/basic) —
  // including the bulk of pbp_federal `dental_preventive` rows — fall
  // through to preventive. Honest signal even when the row is sparse.
  void hasPreventiveOnly;
  return 'preventive';
}

/**
 * Find the dental row a plan ships and classify it. Called by both the
 * brain (scoring path) and PlanBenefitDetail (UI label) so the
 * displayed tier always matches the tier the brain scored on.
 */
export function classifyPlanDentalTier(benefits: PlanBenefitRow[]): DentalTier {
  // Walk the dental family in priority order — comprehensive label
  // wins over preventive-only when both are present. dental_preventive
  // is the bulk of pbp_federal data (preventive baseline); 'dental' is
  // the consumer-facing merged row that may carry "comprehensive" copy
  // and an allowance.
  const order: ReadonlyArray<string> = ['dental', 'dental_comprehensive', 'dental_preventive'];
  for (const cat of order) {
    const row = benefitByCategory(benefits, cat);
    if (!row) continue;
    const allowance = row.coverage_amount ?? row.max_coverage ?? null;
    return classifyDentalTier(row.benefit_description, allowance);
  }
  return 'preventive';
}
