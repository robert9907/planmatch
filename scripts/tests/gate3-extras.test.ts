// scripts/tests/gate3-extras.test.ts
//
// Gate 3 — the extras "must offer" eliminator — had NO test before
// 2026-09-13. That is how three of the nine Priorities toggles
// (telehealth, healthy_foods, partb_giveback) sat outside
// EXTRAS_GATE_KEYS for a month: selecting one changed no ranking, while
// plan-brain-explanations.ts still rendered "<label> not offered" on the
// plans the gate had just kept.
//
// These cases pin the semantics that are easy to regress silently:
//   • a selected gate key eliminates plans that don't file it
//   • a selected NON-gate key eliminates nobody, and says so via
//     ignoredPriorities rather than vanishing
//   • telehealth is evidence-shaped (filed at all), not value-shaped
//
//   npm run test:gate3
//   tsx --test scripts/tests/gate3-extras.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyExtrasGate } from '../../src/lib/plan-brain.js';
import type { BrainScoredPlan } from '../../src/lib/plan-brain-types.js';

/**
 * Minimal BrainScoredPlan. Gate 3 reads `plan` (aggregated benefits)
 * and `benefits` (raw fallback); the cost sort reads a few numeric
 * score fields. Everything else is irrelevant here, so the cast keeps
 * the fixture readable instead of rebuilding the whole brain type.
 */
function plan(
  id: string,
  benefits: Record<string, unknown>,
  premium = 0,
): BrainScoredPlan {
  return {
    row: { contract_id: id, plan_id: '001', segment_id: '000', monthly_premium: premium },
    benefits: [],
    formulary: new Map(),
    score: {
      providersInNetworkCount: 0,
      costSharingExposed: false,
      totalAnnualCost: premium * 12,
      realAnnualCost: premium * 12,
    },
    plan: { benefits, part_b_giveback: 0, monthly_premium: premium },
  } as unknown as BrainScoredPlan;
}

const withDental = plan('H1', { dental: { annual_max: 1500 } });
const noDental = plan('H2', {});
const withTele = plan('H3', { medical: { telehealth: { copay: 0 } } });
const withTeleDescOnly = plan('H8', { medical: { telehealth: { description: 'Virtual visits covered' } } });
const withTeleCoinsOnly = plan('H4', { medical: { telehealth: { coinsurance: 20 } } });
const noTele = plan('H5', { medical: {} });
const withFood = plan('H6', { food_card: { allowance_per_month: 50 } });

const keys = (r: { fullMatch: BrainScoredPlan[] }) =>
  r.fullMatch.map((s) => s.row.contract_id).sort();

test('no priorities selected → nothing is eliminated', () => {
  const r = applyExtrasGate([withDental, noDental], new Set());
  assert.deepEqual(keys(r), ['H1', 'H2']);
  assert.deepEqual(r.eliminated, []);
  assert.deepEqual([...r.ignoredPriorities], []);
});

test('a selected GATE key eliminates plans that do not file it', () => {
  const r = applyExtrasGate([withDental, noDental], new Set(['dental']));
  assert.deepEqual(keys(r), ['H1'], 'the plan with no dental must be pulled');
  assert.equal(r.eliminated.length, 1);
  assert.deepEqual([...r.selectedExtras], ['dental']);
});

test('telehealth is gated and counts a copay-only row as evidence', () => {
  const r = applyExtrasGate([withTele, noTele], new Set(['telehealth']));
  assert.deepEqual(keys(r), ['H3']);
});

test('telehealth counts a description-only row — the medicare_gov shape', () => {
  // 417 of the PY2026 medicare_gov telehealth rows carry a description
  // and no copay. Evidence the benefit is filed is the whole test.
  const r = applyExtrasGate([withTeleDescOnly, noTele], new Set(['telehealth']));
  assert.deepEqual(keys(r), ['H8'], 'description-only telehealth must count as filed');
});

test('telehealth counts a coinsurance-only row — the cms_pbp shape', () => {
  // 1,243 of the 2,127 PY2026 telehealth rows come from cms_pbp with
  // coinsurance set and copay/description null. Checking copay alone
  // would silently eliminate every one of those plans.
  const r = applyExtrasGate([withTeleCoinsOnly, noTele], new Set(['telehealth']));
  assert.deepEqual(keys(r), ['H4'], 'coinsurance-only telehealth must count as filed');
});

test('a selected NON-gate key eliminates nobody and is reported, not swallowed', () => {
  const r = applyExtrasGate([withFood, noDental], new Set(['healthy_foods']));
  assert.deepEqual(keys(r), ['H2', 'H6'], 'healthy_foods must not eliminate');
  assert.deepEqual(r.eliminated, []);
  assert.deepEqual(
    [...r.ignoredPriorities],
    ['healthy_foods'],
    'the gate must say which selected priority it did not act on',
  );
});

test('an unknown priority string is reported as not gated', () => {
  // QuoteDeliveryV4 builds its own priority strings rather than using
  // PriorityKey. If one of them drifts, this is where it becomes visible
  // instead of silently doing nothing.
  const r = applyExtrasGate([withDental], new Set(['worldwide_er']));
  assert.deepEqual(keys(r), ['H1']);
  assert.deepEqual([...r.ignoredPriorities], ['worldwide_er']);
});

test('gate and non-gate keys selected together: only the gate key bites', () => {
  const r = applyExtrasGate(
    [withDental, noDental],
    new Set(['dental', 'partb_giveback']),
  );
  assert.deepEqual(keys(r), ['H1']);
  assert.deepEqual([...r.selectedExtras], ['dental']);
  assert.deepEqual([...r.ignoredPriorities], ['partb_giveback']);
});

test('two gate keys are ANDed, not ORed', () => {
  const both = plan('H7', {
    dental: { annual_max: 1000 },
    medical: { telehealth: { copay: 0 } },
  });
  const r = applyExtrasGate(
    [withDental, withTele, both],
    new Set(['dental', 'telehealth']),
  );
  assert.deepEqual(keys(r), ['H7'], 'only the plan filing BOTH survives');
});
