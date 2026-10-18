// scripts/tests/plans-desc-dollar.test.ts
//
// Contract for dollarFromDesc — the description-dollar rescue api/plans.ts
// uses when an allowance benefit (dental / vision / hearing / otc /
// transportation / food_card) has no structured coverage_amount.
//
// BUG (2026-10-17, Nanette Ford quote, Durham): the landscape dental row for
// BCBSNC H3449-023 reads "Preventive + comprehensive dental · $40 copay" with
// no annual max filed. The rescue took $40 as the dental ANNUAL MAX, so
// Compare showed "Dental $40" / "$40/yr" on 17 of 74 Durham plans — a per-
// visit copay presented as yearly coverage (and ranked as one). A dollar
// amount labelled as a copay / coinsurance / per-visit cost is never an
// allowance. Missing stays missing ("No annual cap filed").
//
//   npm run api:test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dollarFromDesc } from '../../api/plans.js';

test('a copay-only description yields no allowance', () => {
  assert.equal(dollarFromDesc('Preventive + comprehensive dental · $40 copay'), null);
  assert.equal(dollarFromDesc('Preventive + comprehensive dental · $45 copay'), null);
  assert.equal(dollarFromDesc('$50 co-pay per visit'), null);
  assert.equal(dollarFromDesc('Eye exam $10 copay'), null);
  assert.equal(dollarFromDesc('$20 per visit'), null);
});

test('the real annual max wins over a copay in the same text', () => {
  assert.equal(dollarFromDesc('Preventive + comprehensive dental · $2500 annual max · $25 copay'), 2500);
  assert.equal(dollarFromDesc('$1,600 annual allowance for covered dental services'), 1600);
  assert.equal(dollarFromDesc('$25 copay · $1,500/yr dental allowance'), 1500);
});

test('plain allowance amounts still parse', () => {
  assert.equal(dollarFromDesc('$150/yr eyewear allowance'), 150);
  assert.equal(dollarFromDesc('OTC allowance · $50 per quarter'), 50);
  assert.equal(dollarFromDesc(null), null);
  assert.equal(dollarFromDesc(''), null);
});
