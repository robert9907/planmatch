// scripts/tests/csnp-current-plan.test.ts
//
// A client already enrolled in a C-SNP qualifies for C-SNPs: the current
// plan's CMS condition list ticks the Intake chips so the bench shows
// C-SNPs. Regression: James Daniel (Plainville GA, UHC Complete Care
// GA-3 PPO C-SNP H1889-020) saw "0 C-SNP" — Nov 3 2026.
//
//   npx tsx --test scripts/tests/csnp-current-plan.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csnpConditionsFromPlan } from '../../src/lib/condition-detector.js';
import { qualifiesForBench } from '../../src/lib/benchEligibility.js';

test('UHC Complete Care GA-3 (diabetes/CVD/CHF) → diabetes + cardio', () => {
  const got = csnpConditionsFromPlan(
    'C-SNP',
    'CardiovascularDisorders,ChronicHeartFailure,DiabetesMellitus',
  );
  assert.deepEqual([...got].sort(), ['cardio', 'diabetes']);
});

test('lung and kidney C-SNPs map to copd / esrd', () => {
  assert.deepEqual(csnpConditionsFromPlan('C-SNP', 'ChronicLungDisorders'), ['copd']);
  assert.deepEqual(csnpConditionsFromPlan('C-SNP', 'ChronicKidneyDisease'), ['esrd']);
});

test('non-C-SNP current plans tick nothing', () => {
  assert.deepEqual(csnpConditionsFromPlan(null, null), []);
  assert.deepEqual(csnpConditionsFromPlan('D-SNP', 'DiabetesMellitus'), []);
  assert.deepEqual(csnpConditionsFromPlan('C-SNP', null), []);
});

test('ticked conditions open the bench to the Humana Diabetes & Heart C-SNP', () => {
  const humanaCsnp = { plan_type: 'CSNP' as const, snp_type: 'C-SNP' };
  const codes = csnpConditionsFromPlan('C-SNP', 'CardiovascularDisorders,ChronicHeartFailure,DiabetesMellitus');
  assert.equal(qualifiesForBench(humanaCsnp, { csnpConditions: codes as never }), true);
  assert.equal(qualifiesForBench(humanaCsnp, { csnpConditions: [] }), false);
});
