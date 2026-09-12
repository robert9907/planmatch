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

test('outpatient_surgery_asc alias → asc: copay=0, max=325 → numeric 0, range 0–325', () => {
  const rows = [row({ benefit_category: 'asc', copay: 0, max_coverage: 325 })];
  const cs = costShareFor(rows, 'outpatient_surgery_asc');
  assert.equal(cs.copay, 0);
  assert.equal(cs.copay_high, 325);
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
