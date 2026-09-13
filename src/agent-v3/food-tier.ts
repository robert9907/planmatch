// food-tier — what counts as "has a food card", as one pure rule.
//
// Split out of useBenchFilters (a React hook module, so not loadable
// under `tsx --test`) because this is the part worth pinning: the
// answer decides which plans a broker sees on the bench, and its
// failure mode is silent.
//
// The tier comes from pm_plan_benefits.food_category, written by
// runFoodClassifierPass in the consumer's
// scripts/merge-pbp-into-pm-plan-benefits.ts and surfaced by
// api/plans.ts on Plan.benefits.food_card.food_category. It arrives
// through an untyped cast, so if the API ever stops emitting it the
// value goes null and the rule quietly reverts to the pre-2026-09-13
// allowance test. scripts/tests/food-card-tier.test.ts is what notices.

/** Tiers the classifier can put on a benefit_category 'meals' row. */
export const FOOD_TIERS = [
  'food_card',
  'flex_card_food',
  'food_card_unverified',
  'none',
] as const;
export type FoodTier = (typeof FOOD_TIERS)[number];

/**
 * Tiers that count as having a food card.
 *
 *   food_card            verified grocery card, dollar amount known
 *   flex_card_food       food pooled with OTC / utilities, dollar known
 *   food_card_unverified real card, no filed dollar — chronic-condition
 *                        eligibility may apply
 *
 * 'none' fails, and so does anything not in this set — notably
 * 'meals_post_discharge', which is hospital-discharge meal delivery
 * rather than a grocery card. api/plans.ts reads the tier off the
 * 'meals' row only, so that value should never arrive here at all;
 * excluding it explicitly means it cannot pass even if it does.
 */
export const FOOD_TIERS_PASSING: ReadonlySet<string> = new Set<string>([
  'food_card',
  'flex_card_food',
  'food_card_unverified',
]);

/**
 * True when the plan has a healthy-food card.
 *
 * Prefers the classifier. Falls back to "a monthly allowance was filed"
 * only when the classifier has not reached this plan-segment, because
 * that rule is what the tier replaced: measured 2026-09-13, the tier
 * passes 296 plan-segments against the allowance rule's 202, and all 94
 * of the difference are food_card_unverified — real cards the allowance
 * rule hid because no dollar figure was filed. No plan passes the old
 * rule and fails this one.
 */
export function planHasFoodCard(
  foodTier: string | null | undefined,
  foodCardMonthly: number,
): boolean {
  if (foodTier) return FOOD_TIERS_PASSING.has(foodTier);
  return foodCardMonthly > 0;
}
