// CP10 — per-plan Part D deductible applicability. Agent-side mirror of the
// consumer test (robert9907/plan-match:
// packages/brain/src/__tests__/deductible-exempt-tiers.test.ts).
//
//   tsx --test scripts/tests/cp10-deductible-exempt-tiers.test.ts
//
// The deductible applies only to tiers NOT in the plan's CMS
// rx_deductible.exempt_tiers. The old hardcoded DEFAULT [3,4,5] wrongly
// charged tier-3 brands the full deductible on plans that exempt tier 3
// (A01 Xarelto on H5296-006, exempt [1,2,3,6]).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateBundleYearlyCost } from '../../src/lib/plan-brain-utils.js';

const DRUG = { rxcui: '1232088', name: 'rivaroxaban 20 MG Oral Tablet [Xarelto]', isBrand: true };

const benefits = [
  { id: 'b3', contract_id: 'H', plan_id: '1', segment_id: '0', benefit_category: 'rx_tier_3', benefit_description: null, coverage_amount: null, copay: null, coinsurance: 25, max_coverage: null },
] as unknown as Parameters<typeof estimateBundleYearlyCost>[0]['benefits'];

const formulary = new Map<string, unknown>([
  ['1232088', { rxcui: '1232088', drug_name: DRUG.name, tier: 3, copay: null, coinsurance: 25, prior_auth: false, step_therapy: false, quantity_limit: false, quantity_limit_amount: null, quantity_limit_days: null }],
]) as Parameters<typeof estimateBundleYearlyCost>[0]['formulary'];

const cache = new Map<string, unknown>([
  // initial_cost ($90) materially below full_cost ($570.97) ⇒ a real plan copay
  // structure (isMeaningfulCopayStructure) → $90/fill post-deductible.
  ['NDC_X', { ndc: 'NDC_X', tier: 3, full_cost: 570.97, initial_cost: 90, estimated_yearly_total: 180, covered: true }],
]) as Parameters<typeof estimateBundleYearlyCost>[0]['cache'];

const rxcuiToNdc = new Map([['1232088', 'NDC_X']]);

function run(exempt: number[] | null): number {
  return estimateBundleYearlyCost({
    drugs: [{ rxcui: DRUG.rxcui, name: DRUG.name, isBrand: true }],
    formulary, benefits, drugDeductible: 700, cache, rxcuiToNdc,
    deductibleExemptTiers: exempt ?? undefined,
  }).reduce((s, e) => s + e.yearlyCost, 0);
}

test('tier-3 EXEMPT ([1,2,3,6]) → no $700 deductible burned (≈ $90/fill × 12)', () => {
  const v = run([1, 2, 3, 6]);
  assert.ok(v > 1000 && v < 1200, `got ${v}`);
});

test('tier-3 SUBJECT ([1,2]) → the $700 deductible IS burned', () => {
  const v = run([1, 2]);
  assert.ok(v > 1500, `got ${v}`);
});

test('exempting tier 3 is strictly cheaper than subjecting it', () => {
  assert.ok(run([1, 2, 3, 6]) < run([1, 2]), `exempt ${run([1, 2, 3, 6])} vs subject ${run([1, 2])}`);
});

test('omitted exempt list falls back to legacy [3,4,5] (tier 3 subject)', () => {
  assert.equal(run(null), run([1, 2])); // default [3,4,5] ⇒ tier 3 subject
});
