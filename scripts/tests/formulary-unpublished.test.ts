// Governing rule (Rob, Oct 2026): when the formulary for a plan year isn't
// published, every surface says so. It does NOT fall back to full retail, does
// NOT show $0, does NOT show the prior year's tier, and does NOT quietly omit
// the drug from a total that still presents itself as a total.
//
// pm_plans is dual-year (PY2026 + PY2027) well before the Part D drug file is.
// Until CMS posts the year's SPUF (~Oct 31, mid-AEP), a year-filtered formulary
// read returns ZERO rows for every plan in the new year. These tests pin the
// two behaviors that keep that empty read from becoming a fabricated price:
//
//   1. unavailableDrugEstimates — the brain's substitute for
//      estimateBundleYearlyCost when formularyPublished === false. Every drug
//      comes back cost-unavailable: $0 yearly, null tier, NOT a full-retail
//      guess, flagged so the UI renders "formulary not yet published".
//
//   2. estimateBundleYearlyCost's "unknown coverage" path is UNCHANGED. A drug
//      genuinely absent from a PUBLISHED formulary still draws the retail
//      penalty (covered:false, yearlyCost > 0). This is a different state from
//      "not published" and must stay distinct — otherwise turning off the
//      penalty for unpublished years would also stop penalizing real gaps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  unavailableDrugEstimates,
  estimateBundleYearlyCost,
} from '../../src/lib/plan-brain-utils.js';
import type { FormularyCoverage } from '../../src/lib/brain-foreign-types.js';

test('unavailableDrugEstimates: never fabricates a cost, flags every drug', () => {
  const drugs = [
    { rxcui: '1364430', name: 'Eliquis', isBrand: true }, // a Tier-4 brand
    { name: 'Vitamin D' }, // no rxcui, OTC-ish — still unavailable, not $0
  ];
  const out = unavailableDrugEstimates(drugs);

  assert.equal(out.length, 2, 'one estimate per input drug');
  assert.equal(out[0].name, 'Eliquis', 'preserves input order');
  assert.equal(out[1].name, 'Vitamin D');

  for (const est of out) {
    assert.equal(est.yearlyCost, 0, 'no $0-as-real and no full-retail guess');
    assert.equal(est.tier, null, 'no prior-year tier leaks through');
    assert.equal(est.covered, false, 'not asserted covered');
    assert.equal(
      est.confirmedUncovered,
      false,
      'not asserted uncovered either — we simply do not know',
    );
    assert.equal(est.costUnavailable, true, 'flagged so the UI says "not yet published"');
  }

  const total = out.reduce((s, x) => s + x.yearlyCost, 0);
  assert.equal(total, 0, 'a drug-inclusive total built from these is $0, to be labeled incomplete');

  // isBrand is threaded through unchanged (dual-eligible LIS override reads it).
  assert.equal(out[0].isBrand, true);
  assert.equal(out[1].isBrand, false, 'defaults false when the input omitted it');
});

test('estimateBundleYearlyCost: a drug absent from a PUBLISHED formulary still draws the retail penalty (distinct state, unchanged)', () => {
  const formulary = new Map<string, FormularyCoverage>(); // published, but this drug is not listed
  const out = estimateBundleYearlyCost({
    drugs: [{ rxcui: '999999', name: 'SomeUnlistedBrand' }],
    formulary,
    benefits: [],
    drugDeductible: 0,
  });

  assert.equal(out.length, 1);
  assert.equal(out[0].covered, false, 'genuinely not on this plan');
  assert.equal(out[0].confirmedUncovered, false, 'no cache row → coverage unknown, surfaces via drugCoverageUnknown');
  assert.ok(out[0].yearlyCost > 0, 'retail penalty so cost-rank disfavors the gap — NOT the unpublished-year behavior');
  assert.notEqual(out[0].costUnavailable, true, 'this is "unlisted on a real formulary", not "formulary not published"');
});
