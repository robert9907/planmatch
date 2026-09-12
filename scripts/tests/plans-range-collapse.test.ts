// scripts/tests/plans-range-collapse.test.ts
//
// Contract for how costShareFor surfaces a ranged medical benefit.
//
// HISTORY: commit d4c7d9a promoted copay_max (max_coverage) into the
// returned `copay` when the raw copay was 0/null ("range-collapse"), so
// specialist/urgent_care/outpatient_surgery showed the HIGH headline.
// Per ROB'S DECISION (2026-09), that collapse is REVERTED: when a benefit
// is a range, Plan Match shows the full range "$low–$high" (display-only),
// and the numeric `copay`/`coinsurance` stay the raw filed LOW value — the
// number the brain reads and the CMS ground-truth validator grades (the
// July 228/228 behavior). The high end rides along on `copay_high`
// (from copay_max/max_coverage). Ranges are NEVER built from
// alt_copay/alt_coinsurance (a losing source's value, not a range).
//
//   npm run api:test
//   tsx --test scripts/tests/plans-range-collapse.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costShareFor, type BenefitRow } from '../../api/plans.js';

function row(overrides: Partial<BenefitRow>): BenefitRow {
  return {
    contract_id: 'H5253',
    plan_id: '117',
    segment_id: '0',
    benefit_category: 'specialist',
    benefit_description: null,
    coverage_amount: null,
    copay: null,
    coinsurance: null,
    max_coverage: null,
    ...overrides,
  };
}

// ─── Numeric copay stays the filed LOW value; range on copay_low/high ──

test('copay=0 + max_coverage=35 (specialist) → numeric 0, range 0–35', () => {
  const rows = [row({ benefit_category: 'specialist', copay: 0, max_coverage: 35 })];
  const cs = costShareFor(rows, 'specialist');
  assert.equal(cs.copay, 0, 'numeric copay is the filed low value, not the promoted max');
  assert.equal(cs.copay_low, 0);
  assert.equal(cs.copay_high, 35);
});

test('copay=25 + max_coverage=35 → numeric 25, range 25–35', () => {
  const rows = [row({ benefit_category: 'specialist', copay: 25, max_coverage: 35 })];
  const cs = costShareFor(rows, 'specialist');
  assert.equal(cs.copay, 25);
  assert.equal(cs.copay_low, 25);
  assert.equal(cs.copay_high, 35);
});

test('copay=0 + max_coverage=0 → numeric 0, no range (high === low)', () => {
  const rows = [row({ benefit_category: 'specialist', copay: 0, max_coverage: 0 })];
  const cs = costShareFor(rows, 'specialist');
  assert.equal(cs.copay, 0);
  assert.equal(cs.copay_high, 0, 'no distinct max → single value');
});

test('copay=0 + max_coverage=null → numeric 0, no range', () => {
  const rows = [row({ benefit_category: 'specialist', copay: 0, max_coverage: null })];
  const cs = costShareFor(rows, 'specialist');
  assert.equal(cs.copay, 0);
  assert.equal(cs.copay_high, 0);
});

// ─── Guard: allowance categories keep max_coverage as annual cap ──────
// max_coverage is an annual $ cap here, NOT a copay ceiling — so it must
// not become a copay range.

test('dental copay=0 + max_coverage=2000 → copay 0, no copay range', () => {
  const rows = [row({ benefit_category: 'dental', copay: 0, coinsurance: 20, max_coverage: 2000 })];
  const cs = costShareFor(rows, 'dental');
  assert.equal(cs.copay, 0);
  assert.equal(cs.copay_high, 0, 'annual max is not a copay ceiling → no range');
  assert.equal(cs.coinsurance, 20);
});

test('vision copay=null + max_coverage=300 → copay null (allowance)', () => {
  const rows = [row({ benefit_category: 'vision', copay: null, max_coverage: 300 })];
  const cs = costShareFor(rows, 'vision');
  assert.equal(cs.copay, null);
});

test('otc copay=null + max_coverage=180 → copay null (allowance)', () => {
  const rows = [row({ benefit_category: 'otc', copay: null, max_coverage: 180 })];
  const cs = costShareFor(rows, 'otc');
  assert.equal(cs.copay, null);
});

// ─── Category alias still resolves; numeric stays low, range on high ──

test('lab_services alias → lab: copay=0, max=20 → numeric 0, range 0–20', () => {
  const rows = [row({ benefit_category: 'lab', copay: 0, max_coverage: 20 })];
  const cs = costShareFor(rows, 'lab_services');
  assert.equal(cs.copay, 0);
  assert.equal(cs.copay_high, 20);
});

test('outpatient_surgery_asc alias → asc: copay=0, max=325, no cms range → numeric 0, range 0–325', () => {
  const rows = [row({ benefit_category: 'asc', copay: 0, max_coverage: 325 })];
  const cs = costShareFor(rows, 'outpatient_surgery_asc');
  assert.equal(cs.copay, 0);
  assert.equal(cs.copay_high, 325);
});

// HIGH_END rule: ASC is graded on the cms_pbp copay_max (Plan Finder
// headlines the high). With the cms range stamped, the numeric is the
// high, and the range still spans low→high.
test('asc with cms range 0–375 → numeric 375 (high), range $0–$375', () => {
  const rows = [row({ benefit_category: 'asc', copay: 35, cms_copay_low: 0, cms_copay_high: 375 })];
  const cs = costShareFor(rows, 'outpatient_surgery_asc');
  assert.equal(cs.copay, 375, 'ASC grades on cms_pbp copay_max, not the filed flat copay');
  assert.equal(cs.copay_low, 0);
  assert.equal(cs.copay_high, 375);
});

test('asc with flat cms value 150 → numeric 150, single value', () => {
  const rows = [row({ benefit_category: 'asc', copay: 25, cms_copay_low: 150, cms_copay_high: 150 })];
  const cs = costShareFor(rows, 'outpatient_surgery_asc');
  assert.equal(cs.copay, 150);
  assert.equal(cs.copay_high, 150);
});

// Specialist keeps the real filed copay even with a cms range: the copay
// stays the filed value (here 0), and the range high rides along display-only.
test('specialist with cms range 0–55 → numeric stays the filed 0, range shown', () => {
  const rows = [row({ benefit_category: 'specialist', copay: 0, cms_copay_low: 0, cms_copay_high: 55 })];
  const cs = costShareFor(rows, 'specialist');
  assert.equal(cs.copay, 0, 'the filed copay is 0 here — the range floor is not what wins');
  assert.equal(cs.copay_high, 55);
});

// ROB'S DECISION: specialist/urgent_care copay is the REAL filed value on
// the winning row, NOT the cms_pbp low (that low is a published range floor,
// not the visit price). The $0–$high range is still shown display-only.
test('specialist: winning row 45, cms low 0 → numeric 45 (real filed), range $0–$45', () => {
  const rows = [row({ benefit_category: 'specialist', copay: 45, cms_copay_low: 0, cms_copay_high: 45 })];
  const cs = costShareFor(rows, 'specialist');
  assert.equal(cs.copay, 45, 'real filed copay wins, not the cms_pbp range floor');
  assert.equal(cs.copay_low, 0, 'range floor is display-only');
  assert.equal(cs.copay_high, 45);
});

test('urgent_care: winning row 65, cms low 0 → numeric 65 (real filed), range $0–$65', () => {
  const rows = [row({ benefit_category: 'urgent_care', copay: 65, cms_copay_low: 0, cms_copay_high: 65 })];
  const cs = costShareFor(rows, 'urgent_care');
  assert.equal(cs.copay, 65, 'real filed copay wins, not the cms_pbp range floor');
  assert.equal(cs.copay_low, 0);
  assert.equal(cs.copay_high, 65);
});

// asc coinsurance is DROPPED from LOW_END too (step-1 finding): cms_pbp
// files asc as a BARE 0% (no copay, no coinsurance_max) on the plans where
// the landscape row files the real 20%/30% (H5253-041 20%, H5453-016 30%).
// That 0% is not backed by any copay, so it is not a real cost-share —
// keep the real filed coinsurance; show the cms span display-only.
test('asc coinsurance: winning row 20%, cms bare low 0 → numeric 20% (real filed), range low 0', () => {
  const rows = [row({ benefit_category: 'asc', coinsurance: 20, cms_coins_low: 0, cms_coins_high: 0 })];
  const cs = costShareFor(rows, 'outpatient_surgery_asc');
  assert.equal(cs.coinsurance, 20, 'real filed coinsurance wins, not the bare cms 0%');
  assert.equal(cs.coinsurance_low, 0, 'cms low is display-only');
});

// ambulance coinsurance is DROPPED from LOW_END: cms_pbp DOES file a
// coinsurance_max and ground/air split with different cost-shares, so the
// aggregate low is a range floor. Keep the real filed coinsurance; show range.
test('ambulance coinsurance: winning row 45%, cms low 0 → numeric 45% (real filed), range 0–45%', () => {
  const rows = [row({ benefit_category: 'ambulance', coinsurance: 45, cms_coins_low: 0, cms_coins_high: 45 })];
  const cs = costShareFor(rows, 'ambulance');
  assert.equal(cs.coinsurance, 45, 'real filed coinsurance wins, not the aggregate 0% floor');
  assert.equal(cs.coinsurance_low, 0, 'range floor is display-only');
  assert.equal(cs.coinsurance_high, 45);
});

// urgent_care coinsurance is DROPPED from LOW_END: cms_pbp files a
// coinsurance_max (0–20/30% range on some plans), so 0 is a range floor.
test('urgent_care coinsurance: winning row 20%, cms low 0 → numeric 20% (real filed), range 0–20%', () => {
  const rows = [row({ benefit_category: 'urgent_care', coinsurance: 20, cms_coins_low: 0, cms_coins_high: 20 })];
  const cs = costShareFor(rows, 'urgent_care');
  assert.equal(cs.coinsurance, 20, 'real filed coinsurance wins, not the range floor');
  assert.equal(cs.coinsurance_low, 0);
  assert.equal(cs.coinsurance_high, 20);
});

// A category with no cms filing keeps the winning row's value.
test('urgent_care with no cms range → numeric stays the filed value', () => {
  const rows = [row({ benefit_category: 'urgent_care', copay: 30 })];
  const cs = costShareFor(rows, 'urgent_care');
  assert.equal(cs.copay, 30);
});

// ─── H5253-117 canonical rows: numeric is the low, range carries high ─

test('H5253-117 specialist: numeric 0, range high 35', () => {
  const rows = [row({ benefit_category: 'specialist', copay: 0, max_coverage: 35 })];
  const cs = costShareFor(rows, 'specialist');
  assert.equal(cs.copay, 0);
  assert.equal(cs.copay_high, 35);
});

test('H5253-117 urgent_care: numeric 0, range high 65', () => {
  const rows = [row({ benefit_category: 'urgent_care', copay: 0, max_coverage: 65 })];
  const cs = costShareFor(rows, 'urgent_care');
  assert.equal(cs.copay, 0);
  assert.equal(cs.copay_high, 65);
});

test('H5253-117 outpatient_surgery_hospital: numeric 0, range high 455', () => {
  const rows = [row({ benefit_category: 'outpatient_surgery', copay: 0, max_coverage: 455 })];
  const cs = costShareFor(rows, 'outpatient_surgery_hospital');
  assert.equal(cs.copay, 0);
  assert.equal(cs.copay_high, 455);
});
