// scripts/tests/food-card-tier.test.ts
//
// The agent bench's "Has Food Card" chip used to be
// `foodCardMonthly > 0`, which silently hid every plan whose card has
// no filed dollar amount. It now reads the pm_plan_benefits
// .food_category classifier — the same taxonomy the consumer brain
// gates healthy_foods on — and falls back to the allowance rule only
// when the classifier has not reached the plan-segment.
//
// Measured 2026-09-13 against pm_plan_benefits: 296 plan-segments carry
// a passing tier vs 202 with allowance > 0. All 94 newly-passing plans
// are food_card_unverified. Zero move the other way.
//
// The failure this pins is a SILENT one. The tier arrives via an
// untyped cast (`as FoodTier | undefined`), so if api/plans.ts ever
// stops selecting or emitting food_category the predicate keeps
// compiling, foodTier goes permanently null, and the chip quietly
// reverts to the old allowance rule with nobody the wiser. The
// "tier wins over allowance" cases below are what catch that.
//
//   npm run test:food-tier
//   tsx --test scripts/tests/food-card-tier.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planHasFoodCard, FOOD_TIERS_PASSING } from '../../src/agent-v3/food-tier.js';

const hasFoodCard = () => (plan: { foodTier: string | null; foodCardMonthly: number }) =>
  planHasFoodCard(plan.foodTier, plan.foodCardMonthly);

function p(foodTier: string | null, foodCardMonthly: number) {
  return { foodTier, foodCardMonthly };
}

test('verified food_card passes', () => {
  assert.equal(hasFoodCard()(p('food_card', 75)), true);
});

test('flex_card_food passes — food pooled with OTC/utilities is still a food card', () => {
  assert.equal(hasFoodCard()(p('flex_card_food', 50)), true);
});

test('food_card_unverified passes even with NO filed dollar', () => {
  // The whole point of the change: 94 plans sit here, and the old
  // allowance > 0 rule hid every one of them.
  assert.equal(hasFoodCard()(p('food_card_unverified', 0)), true);
});

test("tier 'none' fails even when an allowance is present", () => {
  // Tier must WIN over the allowance, not merely supplement it. If this
  // flips, the predicate has fallen back to the old rule.
  assert.equal(hasFoodCard()(p('none', 120)), false);
});

test('meals_post_discharge never satisfies the food-card chip', () => {
  // Defence in depth. api/plans.ts reads food_category off the 'meals'
  // row only, so this value should never reach foodTier at all — but a
  // hospital meal delivery must not read as a grocery card even if it
  // does.
  assert.equal(hasFoodCard()(p('meals_post_discharge', 0)), false);
  assert.equal(hasFoodCard()(p('meals_post_discharge', 200)), false);
});

test('classifier absent → falls back to the old allowance rule', () => {
  assert.equal(hasFoodCard()(p(null, 90)), true, 'allowance > 0 still passes');
  assert.equal(hasFoodCard()(p(null, 0)), false, 'no allowance, no tier → fail');
});

test('an unknown tier string does not pass', () => {
  // Guards against a new classifier category being added upstream and
  // quietly counting as a food card here.
  assert.equal(hasFoodCard()(p('flex_allowance', 0)), false);
  assert.equal(hasFoodCard()(p('otc', 0)), false);
});

test('the passing set is exactly the three card tiers', () => {
  assert.deepEqual(
    [...FOOD_TIERS_PASSING].sort(),
    ['flex_card_food', 'food_card', 'food_card_unverified'],
    'changing this set changes which plans a broker sees — do it deliberately',
  );
});
