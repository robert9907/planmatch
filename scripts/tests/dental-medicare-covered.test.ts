// CP20 — agent dental == consumer dental. The consumer (#95) rebuilt dental
// from CMS PBP B16 into the SHARED pm_plan_benefits table as two categories:
//   • 'dental'                  — routine preventive + comprehensive allowance
//   • 'dental_medicare_covered' — medically-necessary, non-routine (B16a)
// The agent already reads the routine row (same shared max/description as the
// consumer); this test pins the newly-surfaced medicare-covered parity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBenefits, type BenefitRow } from '../../api/plans.js';

function row(cat: string, over: Partial<BenefitRow> = {}): BenefitRow {
  return {
    contract_id: 'H1', plan_id: '001', segment_id: '0',
    benefit_category: cat, benefit_description: null,
    coverage_amount: null, copay: null, coinsurance: null, max_coverage: null,
    ...over,
  } as BenefitRow;
}

test('routine dental max flows from the shared "dental" row (consumer parity)', () => {
  const b = buildBenefits([
    row('dental', { max_coverage: 2500, coverage_amount: 2500, benefit_description: 'Preventive + comprehensive dental · $2,500 yearly max' }),
  ]);
  assert.equal(b.dental.annual_max, 2500);
  assert.equal(b.dental.comprehensive, true);
  assert.equal(b.dental.description, 'Preventive + comprehensive dental · $2,500 yearly max');
});

test('dental_medicare_covered is surfaced with its own copay/coinsurance, no max', () => {
  const b = buildBenefits([
    row('dental', { max_coverage: 1000, coverage_amount: 1000 }),
    row('dental_medicare_covered', { copay: 45, benefit_description: 'Medicare-covered dental (medically necessary, not routine) · $45 copay' }),
  ]);
  assert.ok(b.dental.medicare_covered, 'medicare_covered present');
  assert.equal(b.dental.medicare_covered?.copay, 45);
  assert.equal(b.dental.medicare_covered?.coinsurance, null);
  assert.equal(b.dental.medicare_covered?.description, 'Medicare-covered dental (medically necessary, not routine) · $45 copay');
  // Routine allowance unaffected.
  assert.equal(b.dental.annual_max, 1000);
});

test('medicare_covered is null when the plan files no B16a row', () => {
  const b = buildBenefits([row('dental', { max_coverage: 1500, coverage_amount: 1500 })]);
  assert.equal(b.dental.medicare_covered, null);
});

test('a plan with ONLY medicare-covered dental (no routine allowance) still surfaces it', () => {
  const b = buildBenefits([
    row('dental_medicare_covered', { coinsurance: 20, benefit_description: 'Medicare-covered dental · 20% coinsurance' }),
  ]);
  assert.equal(b.dental.annual_max, 0);
  assert.ok(b.dental.medicare_covered);
  assert.equal(b.dental.medicare_covered?.coinsurance, 20);
});
