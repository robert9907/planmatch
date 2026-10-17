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

test('ageFromDob handles both date formats and the birthday boundary', () => {
  const today = new Date(2026, 9, 17); // Oct 17 2026
  assert.equal(ageFromDob('1960-01-01', today), 66);
  assert.equal(ageFromDob('01/01/1960', today), 66);
  assert.equal(ageFromDob('1960-10-18', today), 65);
  assert.equal(ageFromDob('1960-10-17', today), 66);
  assert.equal(ageFromDob('', today), null);
  assert.equal(ageFromDob('not a date', today), null);
});
