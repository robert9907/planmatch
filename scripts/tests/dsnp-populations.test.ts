// scripts/tests/dsnp-populations.test.ts
//
// The Partial-Dual mapping and the inversion detector.
//
// The July 2026 bug was a single boolean read backwards, and it survived
// a month because nothing checked it. These cases pin the direction
// explicitly — "No" is the PERMISSIVE answer and yields the LARGER set —
// so a future edit that flips it fails here rather than in production.
//
//   npm run test:dsnp-populations
//   tsx --test scripts/tests/dsnp-populations.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  POPS_ALL_DUALS,
  POPS_PARTIAL_ONLY,
  parsePartialDual,
  expectedPopulations,
  sameSet,
  checkPlan,
  summarise,
} from '../_lib/dsnp-populations.js';

test('Partial Dual "No" means NOT restricted — all seven populations', () => {
  const got = expectedPopulations('No');
  assert.equal(got.length, 7);
  assert.ok(got.includes('FBDE'), 'full-benefit duals must be accepted');
  assert.ok(got.includes('QMB'), 'QMB must be accepted');
});

test('Partial Dual "Yes" means partial duals ONLY — three populations', () => {
  const got = expectedPopulations('Yes');
  assert.deepEqual([...got].sort(), ['QDWI', 'QI', 'SLMB']);
  assert.ok(!got.includes('FBDE'), 'FBDE must NOT be in the partial-only set');
  assert.ok(!got.includes('QMB'), 'QMB must NOT be in the partial-only set');
});

test('the two sets are not the same size — the inversion is detectable', () => {
  assert.notEqual(POPS_ALL_DUALS.length, POPS_PARTIAL_ONLY.length);
});

test('the flag is parsed case-insensitively and never guessed', () => {
  assert.equal(parsePartialDual('Yes'), 'Yes');
  assert.equal(parsePartialDual(' no '), 'No');
  assert.equal(parsePartialDual('YES'), 'Yes');
  for (const bad of ['', 'maybe', null, undefined, 'Y']) {
    assert.equal(parsePartialDual(bad), null, `${JSON.stringify(bad)} must not be guessed`);
  }
});

test('set comparison ignores order', () => {
  assert.ok(sameSet(['QI', 'SLMB', 'QDWI'], POPS_PARTIAL_ONLY));
  assert.ok(!sameSet(['QI', 'SLMB'], POPS_PARTIAL_ONLY));
});

test('a correct plan passes and is not flagged inverted', () => {
  const c = checkPlan('H4073-003-0', 'Yes', ['SLMB', 'QDWI', 'QI']);
  assert.equal(c.ok, true);
  assert.equal(c.inverted, false);
});

test('a plan holding the opposite set is flagged INVERTED, not merely wrong', () => {
  // This is the exact July failure: Partial Dual=No written with the
  // restrictive set.
  const c = checkPlan('H0174-023-0', 'No', ['SLMB', 'QDWI', 'QI']);
  assert.equal(c.ok, false);
  assert.equal(c.inverted, true);
});

test('a plan wrong in some other way is NOT called an inversion', () => {
  const c = checkPlan('H9999-001-0', 'No', ['FBDE', 'QMB']);
  assert.equal(c.ok, false);
  assert.equal(c.inverted, false, 'only a clean swap counts as inversion');
});

test('a whole-run swap is reported as a wholesale inversion', () => {
  const checks = [
    checkPlan('a', 'No', ['SLMB', 'QDWI', 'QI']),
    checkPlan('b', 'No', ['SLMB', 'QDWI', 'QI']),
    checkPlan('c', 'Yes', [...POPS_ALL_DUALS]),
  ];
  const s = summarise(checks);
  assert.equal(s.failed, 3);
  assert.equal(s.inverted, 3);
  assert.equal(s.wholesaleInversion, true);
});

test('one-sided damage is NOT a wholesale inversion', () => {
  // Only "No" plans broken. Real inversions hit both directions; calling
  // this an inversion would send the next reader to the wrong line.
  const checks = [
    checkPlan('a', 'No', ['SLMB', 'QDWI', 'QI']),
    checkPlan('b', 'Yes', [...POPS_PARTIAL_ONLY]),
  ];
  const s = summarise(checks);
  assert.equal(s.failed, 1);
  assert.equal(s.wholesaleInversion, false);
});

test('a clean run reports no inversion', () => {
  const s = summarise([
    checkPlan('a', 'No', [...POPS_ALL_DUALS]),
    checkPlan('b', 'Yes', [...POPS_PARTIAL_ONLY]),
  ]);
  assert.equal(s.failed, 0);
  assert.equal(s.wholesaleInversion, false);
});
