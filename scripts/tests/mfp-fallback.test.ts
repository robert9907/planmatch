// MFP fallback — IRA-negotiated drug with no cache row is priced at the CMS
// Maximum Fair Price with the plan's IRA cost-share. Agent-side mirror of the
// consumer test. Ground truth: C09 Gerald Banks, PF Eliquis+metoprolol on
// H5302-022 (ded $500) = $930.97.
//
//   tsx --test scripts/tests/mfp-fallback.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateBundleYearlyCost } from '../../src/lib/plan-brain-utils.js';
import { mfpForDrug } from '../../src/lib/mfp-prices.js';

test('mfpForDrug matches brand / ingredient and gates Round 2 to 2027', () => {
  assert.equal(mfpForDrug('apixaban 5 MG Oral Tablet [Eliquis]', 2027), 231);
  assert.equal(mfpForDrug('rivaroxaban 20 MG Oral Tablet', 2027), 197);
  assert.equal(mfpForDrug('semaglutide 1 MG/DOSE Pen [Ozempic]', 2026), null);
  assert.equal(mfpForDrug('semaglutide 1 MG/DOSE Pen [Ozempic]', 2027), 274);
  assert.equal(mfpForDrug('metoprolol tartrate 25 MG Oral Tablet', 2027), null);
  // Combo vs single-ingredient brand (Janumet ≠ Januvia).
  assert.equal(mfpForDrug('sitagliptin 50 MG / metformin 1000 MG Oral Tablet [Janumet]', 2027), 80);
});

test('MFP fallback prices Eliquis within ~5% of Plan Finder (cache disabled)', () => {
  const benefits = [
    { id: 'b3', contract_id: 'H5302', plan_id: '022', segment_id: '0', benefit_category: 'rx_tier_3', benefit_description: null, coverage_amount: null, copay: null, coinsurance: 24, max_coverage: null },
  ] as unknown as Parameters<typeof estimateBundleYearlyCost>[0]['benefits'];
  const formulary = new Map<string, unknown>([
    ['1364447', { rxcui: '1364447', drug_name: 'apixaban 5 MG Oral Tablet [Eliquis]', tier: 3, copay: null, coinsurance: 24, prior_auth: false, step_therapy: false, quantity_limit: false, quantity_limit_amount: null, quantity_limit_days: null }],
  ]) as Parameters<typeof estimateBundleYearlyCost>[0]['formulary'];
  const ira = new Map([[3, { type: 'coinsurance' as const, amount: 0.17 }]]);
  const v = estimateBundleYearlyCost({
    drugs: [{ rxcui: '1364447', name: 'apixaban 5 MG Oral Tablet [Eliquis]', isBrand: true }],
    formulary, benefits, drugDeductible: 500,
    iraCostShareByTier: ira,
  })[0].yearlyCost;
  assert.ok(Math.abs(v - 930.97) / 930.97 <= 0.05, `got ${v}`);
});
