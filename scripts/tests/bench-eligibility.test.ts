// scripts/tests/bench-eligibility.test.ts
//
// The Compare bench only lists plans the client qualifies for.
// Regression: Nanette Ford (Durham, not dual, no C-SNP condition) saw
// D-SNPs (Aetna Full Dual, Healthy Blue + Medicare, HealthSpring
// TotalCare) at the top of her bench — Oct 17 2026.
//
//   npx tsx --test scripts/tests/bench-eligibility.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualifiesForBench } from '../../src/lib/benchEligibility.js';

const mapd = { plan_type: 'MAPD' as const, snp_type: null };
const ma = { plan_type: 'MA' as const, snp_type: null };
const pdp = { plan_type: 'PDP' as const, snp_type: null };
const dsnp = { plan_type: 'DSNP' as const, snp_type: 'D-SNP' };
const csnp = { plan_type: 'CSNP' as const, snp_type: 'C-SNP' };
const isnp = { plan_type: 'ISNP' as const, snp_type: 'I-SNP' };

const standard = {};

test('standard client: MAPD with drug coverage only', () => {
  assert.equal(qualifiesForBench(mapd, standard), true);
  assert.equal(qualifiesForBench(ma, standard), false);
  assert.equal(qualifiesForBench(dsnp, standard), false);
  assert.equal(qualifiesForBench(csnp, standard), false);
  assert.equal(qualifiesForBench(isnp, standard), false);
  assert.equal(qualifiesForBench(pdp, standard), false);
});

test('MA-only plans (no drug coverage, even when tagged MAPD) only with VA/TRICARE drug coverage', () => {
  // Durham CY2027: AARP Patriot No Rx, Aetna Eagle, Humana USAA Honor Giveback,
  // HumanaChoice R0110-004 are plan_type MAPD with has_drug_coverage false.
  const noRx = { plan_type: 'MAPD' as const, snp_type: null, has_drug_coverage: false };
  assert.equal(qualifiesForBench(noRx, standard), false);
  assert.equal(qualifiesForBench(noRx, { hasVaDrugCoverage: true }), true);
  assert.equal(qualifiesForBench(ma, { hasVaDrugCoverage: true }), true);
  assert.equal(qualifiesForBench({ ...mapd, has_drug_coverage: true }, standard), true);
});

test('D-SNP for Medicare + Medicaid: dual flag or a Medicaid level on file', () => {
  assert.equal(qualifiesForBench(dsnp, { medicaidLevel: 'qmb' as never }), true);
  assert.equal(qualifiesForBench(dsnp, { medicaidLevel: 'none' as never }), false);
});

test('D-SNP only for a client marked dual (strict true)', () => {
  assert.equal(qualifiesForBench(dsnp, { dsnpEligible: true }), true);
  assert.equal(qualifiesForBench(dsnp, { dsnpEligible: false }), false);
  // A D-SNP whose plan_type came through as MAPD is still a D-SNP.
  assert.equal(qualifiesForBench({ plan_type: 'MAPD', snp_type: 'D-SNP' }, standard), false);
});

test('C-SNP only with a confirmed condition', () => {
  assert.equal(qualifiesForBench(csnp, { csnpConditions: ['diabetes'] as never }), true);
  assert.equal(qualifiesForBench(csnp, { csnpConditions: [] }), false);
});

test('I-SNP only for institutional / HCBS living setting', () => {
  assert.equal(qualifiesForBench(isnp, { livingSetting: 'institutional_or_hcbs' }), true);
  assert.equal(qualifiesForBench(isnp, { livingSetting: 'community' }), false);
});

test('dual client still sees regular MAPD plans', () => {
  assert.equal(qualifiesForBench(mapd, { dsnpEligible: true }), true);
  assert.equal(qualifiesForBench(pdp, { dsnpEligible: true }), false);
});
