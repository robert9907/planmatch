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

// Regression (2026-10-28, Debra O'Connell): AgentBase/formulary labels use
// pharmacy abbreviations ("REPATHA SURECLICK SOLN AUTO-INJ"). They missed the
// non-solid check, fell through to the 30-tablet default and priced 30
// syringes (~$8,250/mo) — every plan pegged at the $2,400 cap ($200/mo).
test('abbreviated injectable labels price the filed quantity, never 30', () => {
  assert.equal(monthlyQuantity({ name: 'REPATHA SURECLICK SOLN AUTO-INJ' }), 1);
  assert.equal(monthlyQuantity({ name: 'REPATHA SURECLICK SOLN AUTO-INJ', quantity: '1' }), 1);
  assert.equal(monthlyQuantity({ name: 'REPATHA SURECLICK SOLN AUTO-INJ', quantity: '2' }), 2);
  assert.equal(monthlyQuantity({ name: 'ENOXAPARIN SOD INJ PFS 40MG/0.4ML', quantity: '' }), 1);
  assert.equal(monthlyQuantity({ name: 'HUMALOG KWIKPEN INJ 100U/ML' }), 1);
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

// Regression (2026-10-27, Rob): creams, ointments and nasal sprays whose
// NAME doesn't say "cream"/"spray" were priced off the sig as if they were
// pills ("apply twice daily" → 60 tubes). The form or the sig marks them
// as packaged — one package a month.
test('topicals and sprays are packages even when the name does not say so', () => {
  assert.equal(monthlyQuantity({ name: 'Fluticasone Propionate 50 MCG/ACT', quantity: '16', frequency: 'Use 2 sprays in each nostril once daily' }), 1);
  assert.equal(monthlyQuantity({ name: 'Mupirocin 2%', quantity: '22 g', frequency: 'Apply to affected area 3 times a day' }), 1);
  assert.equal(monthlyQuantity({ name: 'Triamcinolone Acetonide 0.1%', form: 'ointment', quantity: '80 g', frequency: 'Apply twice daily' }), 1);
  assert.equal(monthlyQuantity({ name: 'Azelastine 137 MCG', form: 'nasal spray', quantity: '30 mL' }), 1);
  assert.equal(monthlyQuantity({ name: 'Budesonide-Formoterol 160-4.5', quantity: '1', frequency: 'Inhale 2 puffs twice daily' }), 1);
  // Pills are unchanged.
  assert.equal(monthlyQuantity({ name: 'Lisinopril 10 MG', quantity: '90', frequency: 'Take 1 tablet by mouth twice daily' }), 60);
});

// Regression (2026-10-28, Debra O'Connell): with no pharmacy chosen,
// medicare.gov prices the mail lane as a 90-day fill (quantity ×3) even when
// asked for 30 days. The 90-day full_cost must be scaled to one 30-day fill.
test('a 90-day mail row is scaled back to a 30-day gross price', () => {
  const resp = {
    costs: [
      { raw: { costs: [{ drug_costs: [{ ndc: 'R1', full_cost: 1619.31, frequency: 'FREQUENCY_90_DAYS' }] }] } },
      { raw: { costs: [{ drug_costs: [{ ndc: 'R1', full_cost: 539.77, frequency: 'FREQUENCY_30_DAYS' }] }] } },
    ],
  };
  const m = grossMonthlyFromResponse(resp, { '1665900': ['R1'] });
  assert.equal(m.get('1665900'), 539.77);
});
