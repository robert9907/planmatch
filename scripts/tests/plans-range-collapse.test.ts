// scripts/tests/plans-range-collapse.test.ts
//
// Regression coverage for the "specialist $0 on the agent Compare
// screen" bug family. cms_pbp files ranges as (copay=$0, copay_max=$X)
// for benefits that vary by service — specialist $0–$35, urgent_care
// $0–$65, outpatient_surgery $0–$455 — and the landscape importer
// preserved only the $0 floor in pm_plan_benefits.copay. costShareFor
// used to return that $0 verbatim; the fix promotes copay_max
// (max_coverage on the shaped BenefitRow) into the returned copay
// when the raw copay is 0/null and max_coverage carries a real dollar.
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

// ─── Range-collapse for medical copay categories ──────────────────────

test('copay=0 + max_coverage=35 (specialist) → returns 35', () => {
  const rows = [row({ benefit_category: 'specialist', copay: 0, max_coverage: 35 })];
  const cs = costShareFor(rows, 'specialist');
  assert.equal(cs.copay, 35);
});

test('copay=null + max_coverage=65 (urgent_care) → returns 65', () => {
  const rows = [row({ benefit_category: 'urgent_care', copay: null, max_coverage: 65 })];
  const cs = costShareFor(rows, 'urgent_care');
  assert.equal(cs.copay, 65);
});

test('copay=25 + max_coverage=35 → returns 25 (never overrides a real copay)', () => {
  const rows = [row({ benefit_category: 'specialist', copay: 25, max_coverage: 35 })];
  const cs = costShareFor(rows, 'specialist');
  assert.equal(cs.copay, 25);
});

test('copay=0 + max_coverage=0 → returns 0 (no fake headline)', () => {
  const rows = [row({ benefit_category: 'specialist', copay: 0, max_coverage: 0 })];
  const cs = costShareFor(rows, 'specialist');
  assert.equal(cs.copay, 0);
});

test('copay=0 + max_coverage=null → returns 0 (no synthetic value)', () => {
  const rows = [row({ benefit_category: 'specialist', copay: 0, max_coverage: null })];
  const cs = costShareFor(rows, 'specialist');
  assert.equal(cs.copay, 0);
});

// ─── Guard: allowance categories keep max_coverage as annual cap ──────

test('dental copay=0 + max_coverage=2000 → copay stays 0 (annual cap, not range)', () => {
  const rows = [row({ benefit_category: 'dental', copay: 0, coinsurance: 20, max_coverage: 2000 })];
  const cs = costShareFor(rows, 'dental');
  assert.equal(cs.copay, 0, 'dental max_coverage is the annual max, not a copay ceiling');
  assert.equal(cs.coinsurance, 20);
});

test('vision copay=null + max_coverage=300 → copay stays null (allowance)', () => {
  const rows = [row({ benefit_category: 'vision', copay: null, max_coverage: 300 })];
  const cs = costShareFor(rows, 'vision');
  assert.equal(cs.copay, null);
});

test('otc copay=null + max_coverage=180 → copay stays null (allowance)', () => {
  const rows = [row({ benefit_category: 'otc', copay: null, max_coverage: 180 })];
  const cs = costShareFor(rows, 'otc');
  assert.equal(cs.copay, null);
});

// ─── Category alias still resolves after the range-collapse ───────────

test('lab_services alias → lab: copay=0, max_coverage=20 returns 20', () => {
  const rows = [row({ benefit_category: 'lab', copay: 0, max_coverage: 20 })];
  const cs = costShareFor(rows, 'lab_services');
  assert.equal(cs.copay, 20);
});

test('outpatient_surgery_asc alias → asc: copay=0, max_coverage=325 returns 325', () => {
  const rows = [row({ benefit_category: 'asc', copay: 0, max_coverage: 325 })];
  const cs = costShareFor(rows, 'outpatient_surgery_asc');
  assert.equal(cs.copay, 325);
});

// ─── H5253-117 canonical regression rows ──────────────────────────────
// These mirror the exact shapes the merge emits for the plan today.
// Kept in the same file so `npm run api:test` fails loudly if the
// specialist / urgent_care $0 bug returns.

test('H5253-117 specialist: NOT $0', () => {
  const rows = [row({ benefit_category: 'specialist', copay: 0, max_coverage: 35 })];
  const cs = costShareFor(rows, 'specialist');
  assert.notEqual(cs.copay, 0, 'H5253-117 specialist recurring bug — copay must not be $0');
  assert.equal(cs.copay, 35);
});

test('H5253-117 urgent_care: NOT $0', () => {
  const rows = [row({ benefit_category: 'urgent_care', copay: 0, max_coverage: 65 })];
  const cs = costShareFor(rows, 'urgent_care');
  assert.notEqual(cs.copay, 0, 'H5253-117 urgent_care recurring bug — copay must not be $0');
  assert.equal(cs.copay, 65);
});

test('H5253-117 outpatient_surgery_hospital: NOT $0', () => {
  const rows = [row({ benefit_category: 'outpatient_surgery', copay: 0, max_coverage: 455 })];
  const cs = costShareFor(rows, 'outpatient_surgery_hospital');
  assert.notEqual(cs.copay, 0);
  assert.equal(cs.copay, 455);
});
