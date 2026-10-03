// scripts/tests/medical-deductible-known.test.ts
//
// "Missing stays missing." A medical deductible that is NULL because its
// source isn't loaded for the plan_year (e.g. the PY2027 shelf — no
// medicare_gov medical_deductible scrape yet) must NOT silently become a
// $0 in the Gate 4 cost model. If it did, a plan with an UNKNOWN deductible
// would rank/display as if it had NONE — a correctness trap the moment that
// field is surfaced or weighted.
//
// Contrast a null whose source IS loaded (e.g. a 2026 plan that simply
// files no medical deductible): that is a genuine, quotable $0 and must
// stay $0 (the 2026 Medicare.gov parity fix, planCatalog.ts).
//
// resolveMedicalDeductible(value, known) is the single gate:
//   • a filed value always wins (known or not)
//   • null + source NOT loaded (known === false) → null (unknown)
//   • null + source loaded (known true/undefined) → 0 (genuine $0; the
//     undefined case preserves legacy behavior for callers/responses that
//     predate the signal)
//
//   npm run test:medical-deductible

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMedicalDeductible } from '../../src/lib/plan-brain-utils.js';

test('null + source NOT loaded → null (unknown, never $0)', () => {
  assert.equal(resolveMedicalDeductible(null, false), null);
});

test('null + source loaded → 0 (genuine $0)', () => {
  assert.equal(resolveMedicalDeductible(null, true), 0);
});

test('null + signal absent → 0 (legacy back-compat)', () => {
  assert.equal(resolveMedicalDeductible(null, undefined), 0);
});

test('a filed $0 stays $0', () => {
  assert.equal(resolveMedicalDeductible(0, true), 0);
  assert.equal(resolveMedicalDeductible(0, false), 0);
});

test('a filed dollar value always wins, regardless of the signal', () => {
  assert.equal(resolveMedicalDeductible(250, true), 250);
  assert.equal(resolveMedicalDeductible(250, false), 250);
});
