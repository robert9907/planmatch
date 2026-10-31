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

test('per-service copay RANGES are costs, not an allowance (Kaiser GA H1170, Verda TX H5163)', () => {
  // Range low-ends ("$44" in "$44–$528 copay") previously leaked as a bogus
  // "$44/yr dental maximum" on plans that file per-service copay ranges but no
  // annual cap. The whole range is a member cost — nothing is an allowance.
  assert.equal(dollarFromDesc('crowns & bridges $44–$528 copay'), null);
  assert.equal(dollarFromDesc('fillings $0–$464 copay · dentures $25–$738 copay'), null);
  assert.equal(
    dollarFromDesc(
      'Preventive + comprehensive dental · no yearly max filed · exams, cleanings $0 copay · ' +
      'fillings $0–$464 copay · root canals $22–$625 copay · gum treatment $0–$643 copay · ' +
      'dentures $25–$738 copay · crowns & bridges $44–$528 copay · other general services $0–$151 copay',
    ),
    null,
  );
  // A real annual max alongside copay ranges still wins.
  assert.equal(dollarFromDesc('Comprehensive dental · $2,500 yearly max · crowns $44–$528 copay'), 2500);
});

test('plain allowance amounts still parse', () => {
  assert.equal(dollarFromDesc('$150/yr eyewear allowance'), 150);
  assert.equal(dollarFromDesc('OTC allowance · $50 per quarter'), 50);
  assert.equal(dollarFromDesc(null), null);
  assert.equal(dollarFromDesc(''), null);
});
