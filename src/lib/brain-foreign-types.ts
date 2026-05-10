// Shimmed from consumer Plan Match (~/Code/plan-match) to make the shared
// brain compile in this repo. Source-of-truth lives in the consumer; keep
// these in sync if the consumer adds new exports the brain depends on.
//
// Originals:
//   CsnpCondition, DsnpEligibility, TieredPriorityKey, TIER_THRESHOLDS,
//   PriorityTier
//     ← packages/shared/src/types.ts
//   PmPlanRow      ← apps/web/src/hooks/usePlansForCounty.ts
//   PlanBenefitRow ← apps/web/src/hooks/usePlanBenefits.ts
//   FormularyCoverage ← apps/web/src/hooks/useFormulary.ts

// ---------------------------------------------------------------------------
// from @plan-match/shared (packages/shared/src/types.ts)
// ---------------------------------------------------------------------------

/**
 * Per-tier dollar thresholds for the four tier-picker priorities. The
 * Priorities screen ("What matters most?") lets the user pick a tier
 * (basic / good / best); the threshold here is the floor that a plan
 * must meet for the brain to credit a +15 "meets threshold" bonus on
 * the extras axis.
 */
export type PriorityTier = 'basic' | 'good' | 'best';
export const TIER_THRESHOLDS: Readonly<
  Record<'dental' | 'vision' | 'otc' | 'partb_giveback', Record<PriorityTier, number>>
> = {
  dental:         { basic: 0, good: 1000, best: 2000 },
  vision:         { basic: 0, good: 200,  best: 400  },
  otc:            { basic: 0, good: 50,   best: 150  },
  partb_giveback: { basic: 0, good: 50,   best: 100  },
};
/** Priorities that carry a tier picker. */
export type TieredPriorityKey = keyof typeof TIER_THRESHOLDS;

/**
 * D-SNP eligibility derived from the About-You medicaid/extra-help chip.
 *   true    → user has Medicaid (full dual) — show D-SNP-ranked plans
 *   false   → user picked "No"              — standard MAPD path
 *   'unsure'→ user picked "Not sure"        — include D-SNP with verification flag
 *   null    → not yet answered
 */
export type DsnpEligibility = boolean | 'unsure' | null;

/**
 * Chronic-condition keys used by C-SNP filtering + condition profiles.
 *  diabetes      — Type 1/2/managed-pre-diabetes
 *  cardio        — CHF / CAD / prior MI / AFib (general cardiovascular)
 *  copd          — COPD / chronic lung disease
 *  cancer        — active cancer treatment (chemo, radiation, surgery)
 *  hypertension  — high blood pressure without other cardiovascular Dx
 *  esrd          — End-stage renal disease (Stage 4+, dialysis, transplant)
 */
export type CsnpCondition =
  | 'diabetes'
  | 'cardio'
  | 'copd'
  | 'cancer'
  | 'hypertension'
  | 'esrd';

// ---------------------------------------------------------------------------
// from ../hooks/usePlansForCounty
// ---------------------------------------------------------------------------

export interface PmPlanRow {
  id: number;
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_name: string;
  carrier: string | null;
  parent_organization: string | null;
  plan_type: string | null;
  state: string;
  county_name: string;
  county_fips: string | null;
  monthly_premium: number | null;
  annual_deductible: number | null;
  moop: number | null;
  drug_deductible: number | null;
  star_rating: number | null;
  snp: boolean;
  snp_type: string | null;
  sanctioned: boolean;
  enrollment_count: number | null;
  enrollment_as_of: string | null;
}

// ---------------------------------------------------------------------------
// from ../hooks/usePlanBenefits
// ---------------------------------------------------------------------------

export interface PlanBenefitRow {
  // Real pm_plan_benefits rows have a numeric id; synthetic rows
  // generated from pbp_benefits use a string key like
  // `pbp:H5253-189:rx_tier_3` so React still gets a stable key.
  id: number | string;
  contract_id: string;
  plan_id: string;
  segment_id: string;
  benefit_category: string;
  benefit_description: string | null;
  coverage_amount: number | null;
  copay: number | null;
  coinsurance: number | null;
  max_coverage: number | null;
  /**
   * Provenance — lets the UI distinguish value-bearing SB-OCR
   * descriptions ("$150 allowance every 2 years…") from short federal
   * labels ("Eyewear allowance") so formatBenefitValue can render the
   * sb_ocr string verbatim instead of synthesizing "$X/yr".
   *   'landscape' — pm_plan_benefits (original Landscape import)
   *   'pbp'       — pbp_benefits row with federal source
   *   'sb_ocr'    — pbp_benefits row from scripts/sb-pipeline.ts
   *   'manual'    — pbp_benefits row edited by hand
   */
  source?: 'landscape' | 'pbp' | 'sb_ocr' | 'manual';
}

// ---------------------------------------------------------------------------
// from ../hooks/useFormulary
// ---------------------------------------------------------------------------

export interface FormularyCoverage {
  rxcui: string;
  drug_name: string | null;
  tier: number | null;
  copay: number | null;
  coinsurance: number | null;
  prior_auth: boolean;
  step_therapy: boolean;
  quantity_limit: boolean;
  quantity_limit_amount: number | null;
  quantity_limit_days: number | null;
  // 'rxcui'      → exact rxcui hit (most reliable)
  // 'ingredient' → widened ingredient-stem match; the matched plan
  //                strength may differ from the user's strength. UI
  //                surfaces a "confirm with your doctor" disclaimer.
  // Undefined when the row predates the field (older API responses).
  match_type?: 'rxcui' | 'ingredient';
}
