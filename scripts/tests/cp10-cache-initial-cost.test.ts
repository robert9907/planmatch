// CP10 — pm_drug_cost_cache must price IRA-negotiated drugs off their real
// per-fill cost (full_cost + initial_cost) through partDTimeline, NOT off the
// basket-context estimated_yearly_total and NOT off the plan's filed tier
// coinsurance. Agent-side mirror of the consumer test
// (robert9907/plan-match: packages/brain/src/__tests__/cp10-cache-initial-cost.test.ts).
//
//   tsx --test scripts/tests/cp10-cache-initial-cost.test.ts
//
// Ground truth: C09 Gerald Banks (Chatham GA 31406, no Extra Help), plan
// H5302-022 (drug deductible $500). Live Plan Finder prices Eliquis 5mg
// (60/mo) + metoprolol tartrate 25 (60/mo) at $930.97/yr. The plan FILES
// Tier 3 at 24% coinsurance, but Eliquis bills ~17% off its negotiated
// $255.43/mo price — so the cache's initial_cost ($43.42) must win over the
// tier coinsurance, and estimated_yearly_total ($277, computed inside the
// ~29-drug scrape basket) must be ignored when full_cost is present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateBundleYearlyCost } from '../../src/lib/plan-brain-utils.js';

const ELIQUIS = { rxcui: '1364447', name: 'apixaban 5 MG Oral Tablet [Eliquis]' };
const METOP = { rxcui: '866924', name: 'metoprolol tartrate 25 MG Oral Tablet' };

// Plan FILES Tier 3 at 24% — deliberately wrong for the IRA drug, to prove
// the per-drug initial_cost override beats it.
const benefits = [
  { id: 'b1', contract_id: 'H5302', plan_id: '022', segment_id: '0', benefit_category: 'rx_tier_1', benefit_description: null, coverage_amount: null, copay: 0, coinsurance: null, max_coverage: null },
  { id: 'b3', contract_id: 'H5302', plan_id: '022', segment_id: '0', benefit_category: 'rx_tier_3', benefit_description: null, coverage_amount: null, copay: null, coinsurance: 24, max_coverage: null },
] as unknown as Parameters<typeof estimateBundleYearlyCost>[0]['benefits'];

const formulary = new Map<string, unknown>([
  ['1364447', { rxcui: '1364447', drug_name: ELIQUIS.name, tier: 3, copay: null, coinsurance: 24, prior_auth: false, step_therapy: false, quantity_limit: true, quantity_limit_amount: 60, quantity_limit_days: 30 }],
  ['866924', { rxcui: '866924', drug_name: METOP.name, tier: 1, copay: 0, coinsurance: null, prior_auth: false, step_therapy: false, quantity_limit: false, quantity_limit_amount: null, quantity_limit_days: null }],
]) as Parameters<typeof estimateBundleYearlyCost>[0]['formulary'];

const rxcuiToNdc = new Map([['1364447', 'NDC_ELIQUIS'], ['866924', 'NDC_METOP']]);

function cache(eliquisYearly: number | null) {
  return new Map<string, unknown>([
    ['NDC_ELIQUIS', { ndc: 'NDC_ELIQUIS', tier: 3, full_cost: 255.43, initial_cost: 43.42, estimated_yearly_total: eliquisYearly, covered: true }],
    ['NDC_METOP', { ndc: 'NDC_METOP', tier: 1, full_cost: 3.5, initial_cost: 0, estimated_yearly_total: 10, covered: true }],
  ]) as Parameters<typeof estimateBundleYearlyCost>[0]['cache'];
}

function run(eliquisYearly: number | null): number {
  const est = estimateBundleYearlyCost({
    drugs: [
      { rxcui: ELIQUIS.rxcui, name: ELIQUIS.name, isBrand: true },
      { rxcui: METOP.rxcui, name: METOP.name, isBrand: false },
    ],
    formulary, benefits, drugDeductible: 500, planYear: 2027,
    cache: cache(eliquisYearly), rxcuiToNdc,
  });
  return est.reduce((s, e) => s + e.yearlyCost, 0);
}

test('reproduces Plan Finder ($930.97) within ±2% / ±$25 (C09 Gerald Banks)', () => {
  assert.ok(Math.abs(run(277) - 930.97) <= 25, `got ${run(277)}`);
});

test('ignores estimated_yearly_total when full_cost is present', () => {
  assert.ok(Math.abs(run(277) - run(null)) < 1, `${run(277)} vs ${run(null)}`);
});

test('does NOT collapse to the basket-context yearly (~$287)', () => {
  assert.ok(run(277) > 900, `got ${run(277)}`);
});

test('beats the plan-filed Tier 3 coinsurance (24%): override uses the real ~17%', () => {
  assert.ok(run(277) < 1000, `got ${run(277)}`);
});
