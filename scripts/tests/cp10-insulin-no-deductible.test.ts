// CP10 — covered insulin is EXEMPT from the Part D deductible (IRA §11406).
// Agent-side mirror of the consumer test
// (robert9907/plan-match: packages/brain/src/__tests__/cp10-insulin-no-deductible.test.ts).
//
//   tsx --test scripts/tests/cp10-insulin-no-deductible.test.ts
//
// Ground truth: C06 Marcus Reyes, Lantus SoloStar on Aetna H4523-024 (drug
// deductible $500). Live Plan Finder prices it at ~$148/yr — the real per-fill
// member cost ($12.35) × 12, with NO deductible. Routing insulin through the
// deductible (first ~6 fills capped at $35) overstated it to ~$256.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateBundleYearlyCost } from '../../src/lib/plan-brain-utils.js';

const LANTUS = { rxcui: '847232', name: 'insulin glargine 100 UNIT/ML Pen Injector [Lantus SoloStar]' };

const benefits = [
  { id: 'b3', contract_id: 'H4523', plan_id: '024', segment_id: '0', benefit_category: 'rx_tier_3', benefit_description: null, coverage_amount: null, copay: null, coinsurance: 25, max_coverage: null },
] as unknown as Parameters<typeof estimateBundleYearlyCost>[0]['benefits'];

const formulary = new Map<string, unknown>([
  ['847232', { rxcui: '847232', drug_name: LANTUS.name, tier: 3, copay: null, coinsurance: 25, prior_auth: false, step_therapy: false, quantity_limit: false, quantity_limit_amount: null, quantity_limit_days: null }],
]) as Parameters<typeof estimateBundleYearlyCost>[0]['formulary'];

const rxcuiToNdc = new Map([['847232', 'NDC_LANTUS']]);
const cache = new Map<string, unknown>([
  ['NDC_LANTUS', { ndc: 'NDC_LANTUS', tier: 3, full_cost: 94.98, initial_cost: 12.35, estimated_yearly_total: 37.05, covered: true }],
]) as Parameters<typeof estimateBundleYearlyCost>[0]['cache'];

function run(): number {
  const est = estimateBundleYearlyCost({
    drugs: [{ rxcui: LANTUS.rxcui, name: LANTUS.name, isBrand: true }],
    formulary, benefits, drugDeductible: 500, planYear: 2027, cache, rxcuiToNdc,
  });
  return est.reduce((s, e) => s + e.yearlyCost, 0);
}

test('reproduces Plan Finder (~$148) within ±2% / ±$25 (C06 Lantus)', () => {
  assert.ok(Math.abs(run() - 148.2) <= 25, `got ${run()}`);
});

test('does NOT apply the deductible to insulin (would push toward ~$256)', () => {
  assert.ok(run() < 200, `got ${run()}`);
});
