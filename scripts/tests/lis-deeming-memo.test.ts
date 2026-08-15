// scripts/tests/lis-deeming-memo.test.ts
//
// Pins AUTO_DEEM_LIS_TIER and LIS_COPAYS_2026 against the PUBLISHED CMS
// table rather than against either brain's comments.
//
// Source: "Calendar Year (CY) 2026 Resource and Cost-Sharing Limits for
// Low-Income Subsidy (LIS)", Table 2.
// https://www.cms.gov/files/document/cy2026-lis-resource-limits-memo.pdf
//
//   row 1  Full-benefit dual, institutionalized or receiving HCBS
//                                                       $0    / $0
//   row 2  Full-benefit dual, income <= 100% FPL        $1.60 / $4.90
//   row 3  Full-benefit dual, income 100-150% FPL       $5.10 / $12.65
//   row 4  "Non-Full Benefit Dual Eligible Beneficiaries Applied or are
//          eligible for Medicare Savings Program (QMB-only, SLMB-only,
//          or QI); or Supplemental Security Income"     $5.10 / $12.65
//   row 5  Non-full-benefit dual, <=150% FPL + resources
//                                                       $5.10 / $12.65
//
// Full-benefit duals are FBDE, QMB+ and SLMB+ (rows 1-3). QMB-only,
// SLMB and QI are PARTIAL duals and take row 4 regardless of living
// setting — the institutional $0/$0 row is written for full-benefit
// duals only. QDWI is not deemed for Extra Help at all: SSA POMS
// HI 03001.005, "Qualified Disabled Working Individuals (QDWI) are not
// deemed eligible for Extra Help."
//
// WHY THIS FILE EXISTS: between 2026-07-23 and 2026-08-15 this repo
// deemed FBDE-community, QMB+-community and standalone QMB to a
// `qmb_uniform` tier of $4.90 flat for generic AND brand, citing a
// "QMB + Full Medicaid" row. No such row exists. $4.90 is the BRAND
// figure of row 2, whose generic is $1.60. The effect on a QMB-only
// client was a understated brand copay of $4.90 against a real $12.65.
// Do not reintroduce a tier that files the same amount for generic and
// brand without a row of the memo to point at.
//
//   npx tsx --test scripts/tests/lis-deeming-memo.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_DEEM_LIS_TIER,
  LIS_COPAYS_2026,
  deemLisTier,
  getLisCopays,
  normalizeLisTier,
  type LisTier,
  type LivingSetting,
  type MedicaidLevel,
} from '../../src/lib/dual-eligible.js';

const MEMO: Record<Exclude<LisTier, 'none'>, { generic: number; brand: number }> = {
  full_institutional: { generic: 0, brand: 0 },
  full_low: { generic: 1.6, brand: 4.9 },
  full_high: { generic: 5.1, brand: 12.65 },
};

test('copay tiers match the memo table exactly', () => {
  assert.deepEqual(LIS_COPAYS_2026, MEMO);
});

test('no tier files the same non-zero amount for generic and brand', () => {
  // The $4.90/$4.90 regression is the specific shape being guarded.
  for (const [tier, c] of Object.entries(LIS_COPAYS_2026)) {
    if (c.generic === 0 && c.brand === 0) continue;
    assert.notEqual(
      c.generic,
      c.brand,
      `${tier} files ${c.generic} for both generic and brand — no memo row does that`,
    );
  }
});

const CASES: ReadonlyArray<[MedicaidLevel, LivingSetting, LisTier, string]> = [
  ['fbde', 'institutional_or_hcbs', 'full_institutional', 'full-benefit dual, row 1'],
  ['fbde', 'community', 'full_low', 'full-benefit dual, row 2'],
  ['qmb_plus', 'institutional_or_hcbs', 'full_institutional', 'QMB+ is a full-benefit dual'],
  ['qmb_plus', 'community', 'full_low', 'QMB+ is a full-benefit dual'],
  ['slmb_plus', 'institutional_or_hcbs', 'full_institutional', 'SLMB+ is a full-benefit dual'],
  ['slmb_plus', 'community', 'full_low', 'SLMB+ is a full-benefit dual'],
  ['qmb', 'community', 'full_high', 'QMB-only is named in row 4'],
  ['qmb', 'institutional_or_hcbs', 'full_high', 'row 1 is full-benefit duals only'],
  ['slmb', 'community', 'full_high', 'SLMB-only is named in row 4'],
  ['slmb', 'institutional_or_hcbs', 'full_high', 'partial dual — setting does not move it'],
  ['qi', 'community', 'full_high', 'QI is named in row 4'],
  ['qi', 'institutional_or_hcbs', 'full_high', 'partial dual — setting does not move it'],
  ['qdwi', 'community', 'none', 'not deemed — SSA POMS HI 03001.005'],
  ['qdwi', 'institutional_or_hcbs', 'none', 'not deemed — SSA POMS HI 03001.005'],
  ['none', 'community', 'none', 'not dual'],
];

for (const [level, setting, expected, why] of CASES) {
  test(`deemLisTier(${level}, ${setting}) === ${expected} — ${why}`, () => {
    assert.equal(deemLisTier(level, setting), expected);
    const copays = getLisCopays(deemLisTier(level, setting));
    assert.deepEqual(copays, expected === 'none' ? null : MEMO[expected]);
  });
}

test('the deeming table covers every MedicaidLevel and LivingSetting', () => {
  const levels: MedicaidLevel[] = [
    'none', 'qi', 'slmb', 'slmb_plus', 'qmb', 'qmb_plus', 'fbde', 'qdwi',
  ];
  for (const l of levels) {
    assert.ok(AUTO_DEEM_LIS_TIER[l], `${l} missing from AUTO_DEEM_LIS_TIER`);
    for (const s of ['community', 'institutional_or_hcbs'] as LivingSetting[]) {
      const tier = AUTO_DEEM_LIS_TIER[l][s];
      assert.ok(
        tier === 'none' || tier in MEMO,
        `${l}/${s} deems to ${tier}, which is not a memo row`,
      );
    }
  }
});

test('a session carrying the retired qmb_uniform is re-derived, not guessed', () => {
  // Derived from medicaidLevel, because qmb_uniform was written for both
  // full-benefit duals in the community and standalone QMB. Mapping the
  // stale tier straight to full_low would understate a QMB-only client.
  assert.equal(normalizeLisTier('qmb_uniform', 'qmb', 'community'), 'full_high');
  assert.equal(normalizeLisTier('qmb_uniform', 'fbde', 'community'), 'full_low');
  assert.equal(
    normalizeLisTier('qmb_uniform', 'fbde', 'institutional_or_hcbs'),
    'full_institutional',
  );
  // Valid tiers and nullish input pass through unchanged.
  assert.equal(normalizeLisTier('full_high', 'fbde', 'community'), 'full_high');
  assert.equal(normalizeLisTier(null, 'none', 'community'), 'none');
  assert.equal(normalizeLisTier(undefined, 'none', 'community'), 'none');
});
