// scripts/tests/dental-pricing.test.ts
//
// Contract for src/lib/dentalPricing.ts — how the agent-v3 Dental screen
// turns stored rate rows into a monthly price. Fixtures mirror the real
// shapes loaded into pm_dental_rate on 2026-10-17.
//
// Run: npx tsx --test scripts/tests/dental-pricing.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageFromDob, priceDentalPlan, type DentalRate } from '../../src/lib/dentalPricing';

const rate = (r: Partial<DentalRate> & { monthly_premium: number }): DentalRate => ({
  zip: null, zip_prefixes: null, age_min: null, age_max: null, tier: 'individual', is_starting_at: false, ...r,
});

// Delta NC Enhanced: statewide, two age bands.
const deltaEnhanced = { rates: [rate({ age_min: 0, age_max: 64, monthly_premium: 45.23 }), rate({ age_min: 65, monthly_premium: 55.78 })] };

// Delta NC Plan A Enhanced (EHB): ZIP-area rated, three tiers.
const AREA_A = ['270', '271', '272', '273', '274', '280', '281', '282'];
const AREA_B = ['275', '276', '277', '279'];
const deltaEhb = {
  rates: [
    rate({ zip_prefixes: AREA_A, monthly_premium: 49.67 }),
    rate({ zip_prefixes: AREA_B, monthly_premium: 52.65 }),
    rate({ monthly_premium: 46.7 }),
    rate({ zip_prefixes: AREA_B, tier: 'family', monthly_premium: 171.12 }),
    rate({ tier: 'family', monthly_premium: 151.77 }),
  ],
};

// Guardian: one quote run at age 66, ZIP 27713.
const guardianQuote = { rates: [rate({ zip: '27713', age_min: 66, age_max: 66, monthly_premium: 52.87 })] };

// Guardian Select: 50+ only.
const guardianSelect = { rates: [rate({ age_min: 50, monthly_premium: 36.17 })] };

// Humana Loyalty Plus: 18–50 and 52+ confirmed; 51 never confirmed.
const humanaLoyalty = { rates: [rate({ age_min: 18, age_max: 50, monthly_premium: 41.99 }), rate({ age_min: 52, monthly_premium: 45.99 })] };

test('age band picks the 65+ rate', () => {
  const r = priceDentalPlan(deltaEnhanced, { age: 66, zip: '27713', tier: 'individual' });
  assert.deepEqual(r, { kind: 'price', monthly: 55.78, flags: [], quotedAge: null, quotedZip: null });
});

test('age band picks the under-65 rate', () => {
  const r = priceDentalPlan(deltaEnhanced, { age: 64, zip: '27713', tier: 'individual' });
  assert.equal(r.kind === 'price' && r.monthly, 45.23);
});

test('ZIP area: Durham (277) gets the 275-279 area price, not the cheaper statewide row', () => {
  const r = priceDentalPlan(deltaEhb, { age: 66, zip: '27713', tier: 'individual' });
  assert.equal(r.kind === 'price' && r.monthly, 52.65);
});

test('ZIP area: Asheville (288) falls to "all other NC ZIPs"', () => {
  const r = priceDentalPlan(deltaEhb, { age: 66, zip: '28801', tier: 'individual' });
  assert.equal(r.kind === 'price' && r.monthly, 46.7);
});

test('household "2 or more" matches a carrier\'s "family" tier', () => {
  const r = priceDentalPlan(deltaEhb, { age: 66, zip: '27713', tier: 'self_plus_2_or_more' });
  assert.equal(r.kind === 'price' && r.monthly, 171.12);
});

test('missing household tier is reported, not priced', () => {
  const r = priceDentalPlan(deltaEnhanced, { age: 66, zip: '27713', tier: 'self_plus_1' });
  assert.deepEqual(r, { kind: 'no_tier' });
});

test('single-age quote matching the client is clean', () => {
  const r = priceDentalPlan(guardianQuote, { age: 66, zip: '27713', tier: 'individual' });
  assert.deepEqual(r, { kind: 'price', monthly: 52.87, flags: [], quotedAge: 66, quotedZip: '27713' });
});

test('single-age quote for a different client is shown but flagged for re-quote', () => {
  const r = priceDentalPlan(guardianQuote, { age: 72, zip: '28801', tier: 'individual' });
  assert.equal(r.kind, 'price');
  if (r.kind === 'price') {
    assert.equal(r.monthly, 52.87);
    assert.deepEqual(r.flags, ['quoted_other_age', 'quoted_other_zip']);
  }
});

test('under the plan minimum age is ineligible', () => {
  const r = priceDentalPlan(guardianSelect, { age: 45, zip: '27713', tier: 'individual' });
  assert.deepEqual(r, { kind: 'ineligible', minAge: 50 });
});

test('an unconfirmed age gap is never guessed', () => {
  const r = priceDentalPlan(humanaLoyalty, { age: 51, zip: '27713', tier: 'individual' });
  assert.deepEqual(r, { kind: 'no_rate' });
});

test('plan with no rates', () => {
  assert.deepEqual(priceDentalPlan({ rates: [] }, { age: 66, zip: '27713', tier: 'individual' }), { kind: 'no_rate' });
});

// ─── Households ──────────────────────────────────────────────────────
// Fixtures are real 2026-10-17 quotes (Durham 27713 unless noted).
// household.spouseAge: undefined = no spouse, null = spouse with age not entered.

// Cigna Dental 1000, Durham area: 25–59 $33, 60+ $39. Spouse 15% off.
const cigna1000 = {
  household_pricing: 'sum_by_age' as const,
  spouse_discount_pct: 15,
  rates: [rate({ age_min: 18, age_max: 24, monthly_premium: 31 }), rate({ age_min: 25, age_max: 59, monthly_premium: 33 }), rate({ age_min: 60, monthly_premium: 39 })],
};
// Cigna DVH 3500 — checks spouse-discount rounding to the cent.
const cignaDvh = { ...cigna1000, rates: [rate({ age_min: 25, age_max: 59, monthly_premium: 60.54 }), rate({ age_min: 60, monthly_premium: 70.16 })] };
// Guardian Premier 2.0: exact sum, no discount.
const guardianPremier = {
  household_pricing: 'sum_by_age' as const,
  spouse_discount_pct: null,
  rates: [rate({ age_min: 18, age_max: 18, monthly_premium: 100.35 }), rate({ age_min: 19, age_max: 49, monthly_premium: 94.33 }), rate({ age_min: 50, age_max: 64, monthly_premium: 103.75 }), rate({ age_min: 65, monthly_premium: 114.13 })],
};
// Ameritas Care Lite, flat household tiers by area.
const ameritasLite = {
  household_pricing: 'tier' as const,
  rates: [rate({ zip_prefixes: ['277'], monthly_premium: 31.79 }), rate({ zip_prefixes: ['277'], tier: 'self_plus_1', monthly_premium: 63.58 }), rate({ zip_prefixes: ['277'], tier: 'self_plus_2_or_more', monthly_premium: 101.73 })],
};

test('Cigna couple: primary full rate + spouse 15% off (quoted 66+40 = $67.05)', () => {
  const r = priceDentalPlan(cigna1000, { age: 66, zip: '27713', household: { spouseAge: 40, children: 0 } });
  assert.equal(r.kind === 'price' && r.monthly, 67.05);
});

test('Cigna couple order matters (quoted 40+66 = $66.15)', () => {
  const r = priceDentalPlan(cigna1000, { age: 40, zip: '27713', household: { spouseAge: 66, children: 0 } });
  assert.equal(r.kind === 'price' && r.monthly, 66.15);
});

test('Cigna spouse discount rounds to the cent (quoted DVH 66+40 = $121.62)', () => {
  const r = priceDentalPlan(cignaDvh, { age: 66, zip: '27713', household: { spouseAge: 40, children: 0 } });
  assert.equal(r.kind === 'price' && r.monthly, 121.62);
});

test('Guardian couple is the exact sum (quoted 66+40 = $208.46)', () => {
  const r = priceDentalPlan(guardianPremier, { age: 66, zip: '27713', household: { spouseAge: 40, children: 0 } });
  assert.equal(r.kind === 'price' && r.monthly, 208.46);
});

test('per-person plan with children is not guessed', () => {
  const r = priceDentalPlan(guardianPremier, { age: 66, zip: '27713', household: { spouseAge: 64, children: 1 } });
  assert.deepEqual(r, { kind: 'needs_quote', reason: 'children' });
});

test('per-person plan needs the spouse age', () => {
  const r = priceDentalPlan(guardianPremier, { age: 66, zip: '27713', household: { spouseAge: null, children: 0 } });
  assert.deepEqual(r, { kind: 'needs_quote', reason: 'spouse_age' });
});

test('tier plan: couple and family use the household tiers', () => {
  const one = priceDentalPlan(ameritasLite, { age: 66, zip: '27713', household: { children: 0 } });
  assert.equal(one.kind === 'price' && one.monthly, 31.79);
  const couple = priceDentalPlan(ameritasLite, { age: 66, zip: '27713', household: { spouseAge: 40, children: 0 } });
  assert.equal(couple.kind === 'price' && couple.monthly, 63.58);
  const fam = priceDentalPlan(ameritasLite, { age: 40, zip: '27713', household: { spouseAge: 38, children: 2 } });
  assert.equal(fam.kind === 'price' && fam.monthly, 101.73);
});

test('single person on a per-person plan is just their own rate', () => {
  const r = priceDentalPlan(guardianPremier, { age: 66, zip: '27713', household: { children: 0 } });
  assert.equal(r.kind === 'price' && r.monthly, 114.13);
});

test('ageFromDob handles both date formats and the birthday boundary', () => {
  const today = new Date(2026, 9, 17); // Oct 17 2026
  assert.equal(ageFromDob('1960-01-01', today), 66);
  assert.equal(ageFromDob('01/01/1960', today), 66);
  assert.equal(ageFromDob('1960-10-18', today), 65);
  assert.equal(ageFromDob('1960-10-17', today), 66);
  assert.equal(ageFromDob('', today), null);
  assert.equal(ageFromDob('not a date', today), null);
});
