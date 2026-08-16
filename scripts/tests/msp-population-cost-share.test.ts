// scripts/tests/msp-population-cost-share.test.ts
//
// Pins selectCostShare against the CMS COST_SHARING_PROTECTION table.
// Guards the population-aware cost-share pick that closes the alt_
// projection gap opened in commit c4548fc:
//
//   "Both filed cost-share values now reach the brain via alt_copay /
//    alt_coinsurance / alt_source instead of the > 0 gate silently
//    letting a medicare_gov 20% displace a cms_pbp 0%. Nothing consumes
//    the alternates yet — the brain's benefit array comes from
//    /api/plan-brain-data, which still projects the collapsed scalar."
//
// The scenario under test mirrors the 8 UHC D-SNPs on primary_care in
// production where medicare_gov files 20% coinsurance and cms_pbp
// files 0%. Under the source-priority dedup (medicare_gov=5,
// cms_pbp=3) medicare_gov wins, so the winner row carries 20% and the
// alt row carries the losing cms_pbp 0%. The correct value for a
// beneficiary depends on their MSP population:
//
//   Protected (Medicaid pays their Medicare cost sharing):
//     QMB / QMB+ / SLMB+ / FBDE  → owes 0%  (cms_pbp filing)
//   Exposed (Medicaid does NOT pay their Medicare cost sharing):
//     none / SLMB / QI / QDWI    → owes 20% (winning filing)
//
// The exposed vs. protected split is COST_SHARING_PROTECTION in
// src/lib/dual-eligible.ts; see also isCostSharingProtected. If a
// population moves between exposed and protected, this test AND that
// table must move together.
//
// Run:
//   npx tsx --test scripts/tests/msp-population-cost-share.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectCostShare,
  isCostSharingProtected,
  type MedicaidLevel,
} from '../../src/lib/dual-eligible.js';

// UHC D-SNP primary_care shape — medicare_gov 20% won the source
// dedup, cms_pbp 0% lost. This is the exact configuration observed on
// 8 production D-SNPs pre-fix.
const uhcPrimaryCare = {
  copay: null,
  coinsurance: 20,
  alt_copay: null,
  alt_coinsurance: 0,
  alt_source: 'cms_pbp' as const,
};

// Every CMS-defined MedicaidLevel plus 'none'.
const ALL_POPULATIONS: readonly MedicaidLevel[] = [
  'none',
  'qmb',
  'qmb_plus',
  'slmb_plus',
  'fbde',
  'slmb',
  'qi',
  'qdwi',
];

const EXPOSED: readonly MedicaidLevel[] = ['none', 'slmb', 'qi', 'qdwi'];
const PROTECTED: readonly MedicaidLevel[] = ['qmb', 'qmb_plus', 'slmb_plus', 'fbde'];

test('COST_SHARING_PROTECTION classifies the four protected and four exposed populations', () => {
  for (const p of PROTECTED) {
    assert.equal(
      isCostSharingProtected(p),
      true,
      `${p} must be classified as cost-sharing protected`,
    );
  }
  for (const p of EXPOSED) {
    assert.equal(
      isCostSharingProtected(p),
      false,
      `${p} must be classified as cost-sharing exposed`,
    );
  }
});

test('exhaustive coverage: every population has a case in this suite', () => {
  const union = new Set<MedicaidLevel>([...EXPOSED, ...PROTECTED]);
  for (const p of ALL_POPULATIONS) {
    assert.ok(union.has(p), `${p} missing from EXPOSED ∪ PROTECTED`);
  }
  assert.equal(union.size, ALL_POPULATIONS.length);
});

for (const pop of EXPOSED) {
  test(`${pop} sees the filed 20% (winning medicare_gov filing) on UHC D-SNP primary_care`, () => {
    const picked = selectCostShare(uhcPrimaryCare, pop);
    assert.equal(picked.coinsurance, 20, `${pop} should owe the filed 20%`);
    assert.equal(picked.copay, null, `${pop} copay should mirror the filed null`);
  });
}

for (const pop of PROTECTED) {
  test(`${pop} sees 0% (cms_pbp filing) on UHC D-SNP primary_care — Medicaid covers the rest`, () => {
    const picked = selectCostShare(uhcPrimaryCare, pop);
    assert.equal(picked.coinsurance, 0, `${pop} should owe the cms_pbp-filed 0%`);
    assert.equal(picked.copay, null, `${pop} copay should mirror the cms_pbp-filed null`);
  });
}

test('when cms_pbp wins the dedup (medicare_gov is the alt), protected populations still see the filed 0%', () => {
  // Reversed shape — cms_pbp 0% won, medicare_gov 20% lost. Only
  // cms_pbp-alt should trigger the swap; when cms_pbp is already the
  // winning source, selectCostShare must pass through the filed value.
  const reversed = {
    copay: null,
    coinsurance: 0,
    alt_copay: null,
    alt_coinsurance: 20,
    alt_source: 'medicare_gov' as const,
  };
  for (const pop of ALL_POPULATIONS) {
    const picked = selectCostShare(reversed, pop);
    assert.equal(
      picked.coinsurance,
      0,
      `${pop} should see the filed 0% when cms_pbp already won (no swap)`,
    );
  }
});

test('rows without alt_ collapse to the filed value for every population', () => {
  // Every source agreed → no alt captured → filed value stands
  // regardless of population.
  const agreed = {
    copay: 45,
    coinsurance: null,
    alt_copay: null,
    alt_coinsurance: null,
    alt_source: null,
  };
  for (const pop of ALL_POPULATIONS) {
    const picked = selectCostShare(agreed, pop);
    assert.equal(picked.copay, 45, `${pop} should see the filed $45 copay`);
    assert.equal(picked.coinsurance, null);
  }
});

test('medicaidLevel === "none" short-circuits before consulting alt_', () => {
  // Even with a cms_pbp alt in play, "none" always sees the filed
  // winner — no Medicaid means no cost-share protection.
  const picked = selectCostShare(uhcPrimaryCare, 'none');
  assert.equal(picked.coinsurance, 20);
  assert.equal(picked.copay, null);
});

test('non-cms_pbp alt sources are ignored (sb_ocr and manual alts do not trigger the swap)', () => {
  // Only cms_pbp is trusted as the population-aware alternate — it's
  // the extract of what the plan actually filed with CMS. sb_ocr and
  // manual alts (which encode carrier / broker overrides for extras)
  // must not swap under a QMB member's feet.
  const sbOcrAlt = {
    copay: null,
    coinsurance: 20,
    alt_copay: null,
    alt_coinsurance: 0,
    alt_source: 'sb_ocr' as const,
  };
  for (const pop of PROTECTED) {
    const picked = selectCostShare(sbOcrAlt, pop);
    assert.equal(
      picked.coinsurance,
      20,
      `${pop} must not swap on non-cms_pbp alt (source was sb_ocr)`,
    );
  }
});
