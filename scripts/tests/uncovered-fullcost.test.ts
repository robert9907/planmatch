// Fix #3 (agent, narrow) — an uncovered drug prices off the REAL
// pm_drug_cost_cache.full_cost (× 12 fills/yr) when a cache row exists, instead
// of the flat NOTIONAL_TIER_FULL_COST[3]×12 ≈ $4,200. The notional stays ONLY
// as the no-cache fallback, preserving the Gate-4 missing-drug cost penalty.
//
//   tsx --test scripts/tests/uncovered-fullcost.test.ts
//
// Ground truth: C08 folic acid (Fulton GA, H5302-012) is off-formulary; Plan
// Finder prices it $29.16/yr (~$2.43/mo). Cache uncovered full_cost = $2.43.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateBundleYearlyCost } from '../../src/lib/plan-brain-utils.js';

const benefits = [] as unknown as Parameters<typeof estimateBundleYearlyCost>[0]['benefits'];
const emptyFormulary = new Map() as Parameters<typeof estimateBundleYearlyCost>[0]['formulary'];

function run(hasCache: boolean) {
  const cache = new Map<string, unknown>(
    hasCache ? [['NDC_FOLIC', { ndc: 'NDC_FOLIC', tier: null, full_cost: 2.43, initial_cost: 2.43, estimated_yearly_total: 14.58, covered: false }]] : [],
  ) as Parameters<typeof estimateBundleYearlyCost>[0]['cache'];
  const rxcuiToNdc = new Map(hasCache ? [['315966', 'NDC_FOLIC']] : []);
  return estimateBundleYearlyCost({
    drugs: [{ rxcui: '315966', name: 'folic acid 1 MG Oral Tablet', isBrand: false }],
    formulary: emptyFormulary, benefits, drugDeductible: 0, planYear: 2027, cache, rxcuiToNdc,
  })[0];
}

test('uncovered drug with a cache full_cost → full_cost × 12 (folic acid $2.43 → $29.16)', () => {
  const est = run(true);
  assert.equal(est.covered, false);
  assert.equal(est.confirmedUncovered, true);
  assert.ok(Math.abs(est.yearlyCost - 29.16) <= 1, `expected ~$29.16, got ${est.yearlyCost}`);
});

test('no cache row → keeps the full-retail notional penalty (Gate-4 missing-drug signal)', () => {
  const est = run(false);
  assert.equal(est.covered, false);
  assert.ok(est.yearlyCost > 1000, `expected the notional penalty, got ${est.yearlyCost}`);
});
