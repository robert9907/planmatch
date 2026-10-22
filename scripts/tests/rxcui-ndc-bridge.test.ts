// Fix #2 — rxcui→NDC bridge via the matched formulary rxcui.
//
// drug-search hands the user ONE albuterol-HFA sibling (e.g. 801092 / 2123111);
// the medicare.gov scrape cached a DIFFERENT sibling's NDC (2123076 →
// 50090413700). pm_drug_ndc only bridges the scraped rxcui, so the user's own
// rxcui has no NDC → the drug-cost cache never hits → a COVERED $0 drug fell to
// the full-retail fallback. The cost path now falls back to the matched
// formulary rxcui (cov.rxcui = the on-formulary sibling this plan files, same
// ingredient+strength+form) for the bridge.
//
//   tsx --test scripts/tests/rxcui-ndc-bridge.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateBundleYearlyCost } from '../../src/lib/plan-brain-utils.js';

const USER_RXCUI = '801092'; // what drug-search resolved "albuterol HFA" to
const MATCHED_RXCUI = '2123076'; // the on-formulary sibling the scrape cached
const NAME = 'NDA020983 200 ACTUAT albuterol 0.09 MG/ACTUAT Metered Dose Inhaler';

// pickBestFormularyRow keyed the match under the user's input rxcui, and the
// row it picked is the on-formulary sibling 2123076 (tier 2, covered).
const formulary = new Map<string, unknown>([
  [USER_RXCUI, { rxcui: MATCHED_RXCUI, drug_name: NAME, tier: 2, copay: 0, coinsurance: null, prior_auth: false, step_therapy: false, quantity_limit: true, quantity_limit_amount: null, quantity_limit_days: null }],
]) as Parameters<typeof estimateBundleYearlyCost>[0]['formulary'];

const benefits = [
  { id: 'b2', contract_id: 'H5302', plan_id: '012', segment_id: '0', benefit_category: 'rx_tier_2', benefit_description: null, coverage_amount: null, copay: 0, coinsurance: null, max_coverage: null },
] as unknown as Parameters<typeof estimateBundleYearlyCost>[0]['benefits'];

// Cache keyed by the SCRAPED NDC; pm_drug_ndc bridges ONLY the matched rxcui,
// NOT the user's input rxcui (the real-world gap).
const cache = new Map<string, unknown>([
  ['50090413700', { ndc: '50090413700', tier: 2, full_cost: 4.42, initial_cost: 0, gap_cost: 4.42, estimated_yearly_total: 0, covered: true }],
]) as Parameters<typeof estimateBundleYearlyCost>[0]['cache'];

const drug = { rxcui: USER_RXCUI, name: 'albuterol HFA', isBrand: false };

test('user rxcui with no pm_drug_ndc row bridges via matched formulary rxcui → cache hit, covered', () => {
  const rxcuiToNdc = new Map([[MATCHED_RXCUI, '50090413700']]); // user 801092 absent
  const [est] = estimateBundleYearlyCost({
    drugs: [drug], formulary, benefits, drugDeductible: 0, planYear: 2027, cache, rxcuiToNdc,
  });
  assert.equal(est.covered, true, 'albuterol HFA must resolve COVERED off the cache');
  assert.ok(est.yearlyCost <= 60, `covered tier-2 HFA should be ~$0, got ${est.yearlyCost}`);
});

test('control: no bridge for either rxcui → cache misses (not the covered cache row)', () => {
  const rxcuiToNdc = new Map<string, string>(); // neither bridges
  const [est] = estimateBundleYearlyCost({
    drugs: [drug], formulary, benefits, drugDeductible: 0, planYear: 2027, cache, rxcuiToNdc,
  });
  // Falls to formulary tier-2 pricing (still "covered" via formulary), but NOT
  // off the cache — proves the first test's hit came through the bridge.
  assert.equal(est.confirmedUncovered, false);
});

test('direct user-rxcui bridge still works when pm_drug_ndc has it', () => {
  const rxcuiToNdc = new Map([[USER_RXCUI, '50090413700'], [MATCHED_RXCUI, '50090413700']]);
  const [est] = estimateBundleYearlyCost({
    drugs: [drug], formulary, benefits, drugDeductible: 0, planYear: 2027, cache, rxcuiToNdc,
  });
  assert.equal(est.covered, true);
});
