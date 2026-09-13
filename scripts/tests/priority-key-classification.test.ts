// scripts/tests/priority-key-classification.test.ts
//
// The Gate 3 classification invariant:
//
//   every key the Priorities picker offers is EITHER gated by Gate 3
//   (EXTRAS_GATE_KEYS) OR explicitly excused (NON_GATE_PRIORITY_KEYS)
//
// WHY THIS TEST EXISTS
//
// Before 2026-09-13, PRIORITY_OPTIONS offered nine toggles and
// EXTRAS_GATE_KEYS listed six. The other three were passed into
// applyExtrasGate, matched nothing, and were dropped with no trace —
// while plan-brain-explanations.ts evaluated all nine and rendered
// "<label> not offered" per plan. So a broker could tick "Healthy
// foods", see the ranking not move, and then read "Healthy foods /
// grocery not offered" on the plan the brain had just recommended.
// A comment above EXTRAS_GATE_KEYS asserted the opposite was
// impossible ("Every current PriorityKey maps to a Gate-3 benefit
// category").
//
// AgentV3App carries a compile-time version of this check, but that
// only fires when someone runs tsc. This is the runtime half, and it
// asserts against PRIORITY_OPTIONS — the list a broker actually sees —
// rather than against the PriorityKey union.
//
//   npm run test:priority-keys
//   tsx --test scripts/tests/priority-key-classification.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PRIORITY_OPTIONS } from '../../src/agent-v3/priority-keys.js';
import {
  EXTRAS_GATE_KEYS,
  NON_GATE_PRIORITY_KEYS,
} from '../../src/lib/plan-brain.js';

const gated: ReadonlySet<string> = new Set<string>(EXTRAS_GATE_KEYS);
const excused: ReadonlySet<string> = new Set<string>(
  Object.keys(NON_GATE_PRIORITY_KEYS),
);

test('every picker option is either gated or explicitly excused', () => {
  const unclassified = PRIORITY_OPTIONS.map((o) => o.key).filter(
    (k) => !gated.has(k) && !excused.has(k),
  );
  assert.deepEqual(
    unclassified,
    [],
    `these picker options reach Gate 3 and do nothing: ${unclassified.join(', ')}. ` +
      'Add each to EXTRAS_GATE_KEYS (it eliminates) or to ' +
      'NON_GATE_PRIORITY_KEYS with the reason it does not.',
  );
});

test('the two classifications are disjoint — no key is both gated and excused', () => {
  const both = [...gated].filter((k) => excused.has(k));
  assert.deepEqual(
    both,
    [],
    `classified twice, so the excuse is a lie: ${both.join(', ')}`,
  );
});

test('every excused key carries a non-trivial reason', () => {
  for (const [key, reason] of Object.entries(NON_GATE_PRIORITY_KEYS)) {
    assert.equal(typeof reason, 'string', `${key} reason must be a string`);
    assert.ok(
      reason.trim().length >= 40,
      `${key} is excused from Gate 3 with a ${reason.trim().length}-char reason. ` +
        'Say why it is not gated and where it does take effect, or gate it.',
    );
  }
});

test('every excused key is still a real picker option', () => {
  const offered = new Set(PRIORITY_OPTIONS.map((o) => o.key));
  const orphans = [...excused].filter((k) => !offered.has(k));
  assert.deepEqual(
    orphans,
    [],
    `excused from Gate 3 but no longer offered by the picker: ${orphans.join(', ')}. ` +
      'Drop the entry — a standing excuse for a key nobody can select is dead weight ' +
      'that makes the next reader think the key is live.',
  );
});

// Guards the specific regression the August task was aimed at: the gate
// list silently shrinking back below what the picker offers.
test('telehealth is gated, not silently dropped', () => {
  assert.ok(
    gated.has('telehealth'),
    'telehealth was moved out of EXTRAS_GATE_KEYS without being excused — ' +
      'that is the exact silent no-op this invariant exists to prevent.',
  );
});

test('healthy_foods and partb_giveback are excused on purpose, not gated', () => {
  // These two are filed by 2.9% and 1.9% of plan segments respectively
  // (pbp_benefits_v2 PY2026, measured 2026-09-13). Gating either would
  // empty the pool in most counties, so they narrow the CompareScreen
  // bench instead. If someone gates them, that is a deliberate product
  // decision and this assertion is the place it gets noticed.
  for (const key of ['healthy_foods', 'partb_giveback']) {
    assert.ok(excused.has(key), `${key} should be excused`);
    assert.ok(
      !gated.has(key),
      `${key} is now a hard Gate 3 eliminator. It is filed by under 3% of ` +
        'plan segments, so this empties the Top 4 in most counties. ' +
        'Confirm that is intended before changing this test.',
    );
  }
});
