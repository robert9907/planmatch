// Real monthly drug prices (Rob, 2026-10-21 — Cynthia Kline). Plan Match's
// stored Medicare.gov price table covers ~73 NDCs; everything else was priced
// at a flat $200/mo "Tier 3" guess, which pushed every plan to the Part D cap
// and made totals identical. These helpers turn a client's prescription into
// a monthly quantity and read Medicare.gov's gross (full_cost) price per drug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyQuantity, grossMonthlyFromResponse } from '../../src/lib/drugGrossPrice';

test('monthly quantity from the sig (doses per day × 30)', () => {
  assert.equal(monthlyQuantity({ quantity: '60', frequency: 'Take 1 tablet by mouth 3 times daily', form: 'Oral Tablet' }), 90);
  assert.equal(monthlyQuantity({ quantity: '180', frequency: 'Take 1 tablet by mouth twice a day' }), 60);
  assert.equal(monthlyQuantity({ quantity: '180', frequency: 'TAKE 1 TO 2 TABLETS BY MOUTH AT BEDTIME FOR INSOMNIA' }), 60);
  assert.equal(monthlyQuantity({ quantity: '90', frequency: 'TAKE 1 TABLET BY MOUTH EVERY 8 HOURS AS NEEDED' }), 90);
  assert.equal(monthlyQuantity({ quantity: '90', frequency: 'TAKE 1 TABLET BY MOUTH AT BEDTIME' }), 30);
  assert.equal(monthlyQuantity({ quantity: '100', frequency: 'Take 1 tablet by mouth once daily' }), 30);
});

test('monthly quantity falls back to the fill size and refill days', () => {
  assert.equal(monthlyQuantity({ quantity: '90', refillDays: 90 }), 30);
  assert.equal(monthlyQuantity({ quantity: '30' }), 30);
  assert.equal(monthlyQuantity({}), 30);
});

// Regression (2026-10-21, Cynthia Kline #394): medicare.gov counts creams,
// sprays and pens in packages — quantity 43 priced 43 tubes of estradiol.
test('packaged forms price one package per month', () => {
  assert.equal(monthlyQuantity({ name: 'Estradiol Vaginal Cream', quantity: '42.5', frequency: 'Insert 1 gram vaginally at bedtime 3 times a week' }), 1);
  assert.equal(monthlyQuantity({ name: 'Fluticasone Propionate Nasal Spray, USP', quantity: '16' }), 1);
  assert.equal(monthlyQuantity({ name: 'Zepbound 5 MG/0.5ML Pen', quantity: '2' }), 1);
  assert.equal(monthlyQuantity({ name: 'Albuterol Inhaler', quantity: '' }), 1);
});

test('liquids keep the filed quantity', () => {
  assert.equal(monthlyQuantity({ name: 'Amoxicillin Oral Suspension', quantity: '150' }), 150);
});

test('gross price per rxcui = median full_cost across plans, matched through alternates', () => {
  const resp = {
    costs: [
      { raw: { costs: [{ drug_costs: [{ ndc: 'A2', full_cost: 10 }, { ndc: 'B1', full_cost: 600 }] }] } },
      { raw: { costs: [{ drug_costs: [{ ndc: 'A2', full_cost: 12 }, { ndc: 'B1', full_cost: 620 }] }] } },
      { raw: { costs: [{ drug_costs: [{ ndc: 'A2', full_cost: 11 }] }] } },
    ],
  };
  const ndcsByRxcui = { '310434': ['A1', 'A2', 'A3'], '1364447': ['B1'], '999': ['Z1'] };
  const m = grossMonthlyFromResponse(resp, ndcsByRxcui);
  assert.equal(m.get('310434'), 11);
  assert.equal(m.get('1364447'), 610);
  assert.equal(m.has('999'), false);
});

// Brain: a real Medicare.gov gross price replaces the flat Tier-3 notional
// ($200/mo). Gabapentin 800 at ~$11/mo gross on a 17% Tier 3 plan with a
// $700 deductible must cost far less than the ~$620/yr the notional produced.
import { estimateBundleYearlyCost } from '../../src/lib/plan-brain-utils';

const formulary = new Map([['310434', { tier: 3, copay: null, coinsurance: 0.17 }]]) as never;
const benefits = [{ benefit_category: 'rx_tier_3', copay: null, coinsurance: 17 }] as never;
const gaba = [{ rxcui: '310434', name: 'Gabapentin' }];

test('real gross price is used instead of the $200 notional', () => {
  const [guess] = estimateBundleYearlyCost({ drugs: gaba, formulary, benefits, drugDeductible: 700 });
  const [real] = estimateBundleYearlyCost({
    drugs: gaba, formulary, benefits, drugDeductible: 700,
    grossMonthlyByRxcui: new Map([['310434', 11]]),
  });
  assert.ok(guess.yearlyCost > 500, `notional baseline ${guess.yearlyCost}`);
  assert.ok(real.yearlyCost <= 11 * 12, `real-price cost ${real.yearlyCost} should not exceed the gross`);
});

test('uncovered drug is penalized at its real gross price, not the notional', () => {
  const [z] = estimateBundleYearlyCost({
    drugs: [{ rxcui: '2601746', name: 'ZEPBOUND' }],
    formulary: new Map() as never, benefits, drugDeductible: 0,
    grossMonthlyByRxcui: new Map([['2601746', 1086]]),
  });
  assert.equal(z.covered, false);
  assert.equal(z.yearlyCost, 1086 * 12);
});

// Regression (2026-10-21, live): medicare.gov rejects a non-integer quantity
// ("invalid value for int32 field quantity: 42.5") and fails every drug.
test('monthly quantity is always a whole number', () => {
  assert.equal(monthlyQuantity({ name: 'Amoxicillin Oral Suspension', quantity: '42.5' }), 43);
  assert.ok(Number.isInteger(monthlyQuantity({ quantity: '45', refillDays: 28 })));
});
