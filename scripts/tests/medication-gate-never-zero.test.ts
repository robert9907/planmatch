// Gate 2 (agent brain) — never return zero plans. Mirror of consumer
// plan-match#159. When no single plan covers the full regimen but each drug
// is covered by SOME plan, the all-or-nothing rule empties the pool; we must
// keep the best-coverage plans instead (C03 Tamara Wilkes, 9-drug MS regimen).
//
//   tsx --test scripts/tests/medication-gate-never-zero.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMedicationGate } from '../../src/lib/plan-brain.js';

function plan(covered: boolean[], key = 'H0001-001'): any {
  return {
    row: { contract_id: key.split('-')[0], plan_id: key.split('-')[1] },
    score: { drugBreakdown: covered.map((c, i) => ({ rxcui: String(i), covered: c, partB: false })) },
  };
}

test('all drugs covered on a plan → that plan survives', () => {
  const pool = [plan([true, true]), plan([true, false], 'H0002-001')];
  const s = applyMedicationGate(pool, true, new Set());
  assert.equal(s.length, 1);
});

test('never returns zero — no single plan covers the full regimen, keep best coverage', () => {
  const pool = [plan([true, false], 'H0001-001'), plan([false, true], 'H0002-001')];
  const s = applyMedicationGate(pool, true, new Set());
  assert.ok(s.length > 0, 'must not be empty');
  assert.equal(s.length, 2); // both cover exactly 1 (tie) → keep both
});

test('when relaxing, keeps the plan covering the MOST drugs', () => {
  const pool = [plan([true, true, false], 'H0001-001'), plan([true, false, false], 'H0002-001')];
  // No plan covers all 3 (drug 3 covered nowhere → but it's NOT in otcIndices here,
  // so both fall short). H0001 covers 2, H0002 covers 1 → keep H0001.
  const s = applyMedicationGate(pool, true, new Set());
  assert.equal(s.length, 1);
  assert.equal(s[0].row.plan_id, '001');
});
