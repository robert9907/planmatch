// Healthy-food classifier — the one definition of "does this plan have
// a food benefit", shared by the API handler and the agent UI.
//
// Lives in api/library/ because that is this repo's established home
// for pure, dependency-free modules that BOTH api/ and src/ import
// (see partDTimeline.ts and planYearParams.ts). Importing api/plans.ts
// from the UI instead would drag the Supabase server client into the
// browser bundle.
//
// Mirrors FoodCategoryTier / readFoodCategoryFromBenefits /
// foodTierPasses in the consumer monorepo at
// packages/brain/src/plan-brain.ts:589-607. This repo cannot import
// @plan-match/shared, so the rule is duplicated — keep the passing set
// identical to the brain's.
//
// Source column: pm_plan_benefits.food_category, present only on the
// benefit_category='meals' row (migration
// 202608011200_add_pm_plan_benefits_food_category).

export type FoodTier =
  | 'food_card'            // verified: healthy-food-only card, $ known
  | 'flex_card_food'       // verified: food + OTC/utility combined pool
  | 'food_card_unverified' // chronic-condition eligibility may apply
  | 'none'                 // no verified healthy-food benefit
  | 'unknown';             // no meals row, or an unrecognized value

/**
 * Tiers that count as "this plan has a healthy-food benefit".
 *
 * The brain's wording, which this must not drift from: "Verified +
 * unverified pass; 'none' / 'unknown' do not." Unverified passes the
 * gate and is scored lower only in the Gate 4 tiebreak — it is NOT
 * excluded from the bench.
 */
export function foodTierPasses(t: FoodTier): boolean {
  return t === 'food_card' || t === 'flex_card_food' || t === 'food_card_unverified';
}

/** Verified vs unverified — mirrors isFoodTierVerified in the brain. */
export function isFoodTierVerified(t: FoodTier): boolean {
  return t === 'food_card' || t === 'flex_card_food';
}

/** Normalize a raw pm_plan_benefits.food_category value to a tier. */
export function normalizeFoodTier(raw: string | null | undefined): FoodTier {
  if (
    raw === 'food_card' ||
    raw === 'flex_card_food' ||
    raw === 'food_card_unverified' ||
    raw === 'none'
  ) {
    return raw;
  }
  return 'unknown';
}
