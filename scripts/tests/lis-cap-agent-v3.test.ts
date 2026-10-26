// scripts/tests/lis-cap-agent-v3.test.ts
//
// Verifies the LIS (Extra Help) cap math the agent-v3 CompareScreen
// relies on for correct beneficiary out-of-pocket display. The per-fill
// caps are read year-aware from getLisCopays (which defaults to the
// active plan catalog year), so these assertions track whatever year the
// code resolves — not a hardcoded one. Post-2026-10-15 cutover that is
// 2027 Table V-2: full_institutional $0/$0, full_low $1.65/$5.00,
// full_high $5.80/$14.40.
//
// Plus the TrOOP backstop (PART_D_OOP_CAP — $2,400 for 2027, year-resolved)
// that zeros Part D cost above the annual threshold (IRA §11201).
//
//   npm run test:lis
//   tsx --test scripts/tests/lis-cap-agent-v3.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLisCapsToLibraryPlan } from '../../src/lib/lis-cap-agent-v3.js';
import { getLisCopays } from '../../src/lib/dual-eligible.js';
import { PART_D_OOP_CAP } from '../../src/lib/plan-brain-utils.js';

// Expected caps come from the SAME year-aware source the code uses, so the
// test stays correct across the annual catalog-year cutover rather than
// pinning a year that goes stale (the prior hardcoded 2026 $1.60/$4.90 +
// a never-exported PART_D_OOP_CAP_2026 import broke the suite on main).
const LOW = getLisCopays('full_low')!;
const HIGH = getLisCopays('full_high')!;

// Helpers — small fixture builders keep the assertions close to the
// numbers they check.

const generic = (annualCost: number) => ({ covered: true, tier: 1, annualCost });
const brand = (annualCost: number) => ({ covered: true, tier: 3, annualCost });
const specialty = (annualCost: number) => ({ covered: true, tier: 5, annualCost });
const uncovered = (annualCost: number) => ({ covered: false, tier: null, annualCost });

test('lisTier=none → sum passes through, no caps applied', () => {
  const r = applyLisCapsToLibraryPlan(
    [generic(120), brand(2400), uncovered(500)],
    'none',
  );
  assert.equal(r.adjustedTotal, 120 + 2400 + 500);
  assert.equal(r.lisCopaysApplied, null);
});

test('lisTier=full_institutional → all covered fills cap at $0', () => {
  const r = applyLisCapsToLibraryPlan(
    [generic(120), brand(2400)],
    'full_institutional',
  );
  assert.equal(r.adjustedTotal, 0);
  assert.deepEqual(r.lisCopaysApplied, { generic: 0, brand: 0 });
});

test('lisTier=full_low → generic/brand caps per fill × 12', () => {
  // Plan-copay generic $10/fill ($120/yr) → capped at the full_low generic cap
  // Plan-copay brand   $200/fill ($2400/yr) → capped at the full_low brand cap
  const r = applyLisCapsToLibraryPlan(
    [generic(120), brand(2400)],
    'full_low',
  );
  assert.equal(r.adjustedTotal, Math.round(LOW.generic * 12) + Math.round(LOW.brand * 12));
  assert.deepEqual(r.lisCopaysApplied, LOW);
});

test('lisTier=full_high → generic/brand caps per fill × 12', () => {
  const r = applyLisCapsToLibraryPlan(
    [generic(120), brand(2400)],
    'full_high',
  );
  assert.equal(r.adjustedTotal, Math.round(HIGH.generic * 12) + Math.round(HIGH.brand * 12));
  assert.deepEqual(r.lisCopaysApplied, HIGH);
});

test('plan copay below LIS cap → plan wins (min semantics)', () => {
  // Plan-copay generic $0.50/fill ($6/yr) — already below the full_low generic
  // cap. LIS cap must NOT raise the cost.
  const r = applyLisCapsToLibraryPlan([generic(6)], 'full_low');
  assert.equal(r.adjustedTotal, 6);
});

test('uncovered drug pass-through — LIS does not help off-formulary', () => {
  // Uncovered kept small ($500) so total stays under PART_D_OOP_CAP
  // — this test isolates the pass-through, TrOOP is exercised separately.
  const r = applyLisCapsToLibraryPlan(
    [generic(120), uncovered(500)],
    'full_low',
  );
  // Generic: capped at the full_low generic cap × 12; Uncovered: full $500 stays
  assert.equal(r.adjustedTotal, Math.round(LOW.generic * 12) + 500);
});

test('specialty tier (5) is treated as brand for LIS cap', () => {
  const r = applyLisCapsToLibraryPlan([specialty(12000)], 'full_low');
  assert.equal(r.adjustedTotal, Math.round(LOW.brand * 12));
});

test('TrOOP backstop caps total at PART_D_OOP_CAP', () => {
  // Verify the OOP constant is imported and finite (year-resolved, $2,400 for 2027).
  assert.equal(Number.isFinite(PART_D_OOP_CAP), true);
  assert.equal(PART_D_OOP_CAP > 0, true);

  // Verify Math.min(runningTotal, PART_D_OOP_CAP) fires: 20 brand drugs each
  // capped at the full_high brand cap × 12 breaches the ceiling at either
  // year's cap, so the adjusted total pins to PART_D_OOP_CAP.
  const many = Array.from({ length: 20 }, () => brand(2400));
  const r = applyLisCapsToLibraryPlan(many, 'full_high');
  assert.equal(r.adjustedTotal, PART_D_OOP_CAP);
});

test('empty medications list → zero, correct caps struct', () => {
  const r = applyLisCapsToLibraryPlan([], 'full_low');
  assert.equal(r.adjustedTotal, 0);
  assert.deepEqual(r.lisCopaysApplied, LOW);
});

test('tier heuristic — tier 2 counts as generic, tier 3 as brand', () => {
  const t2 = { covered: true, tier: 2, annualCost: 240 };
  const t3 = { covered: true, tier: 3, annualCost: 240 };
  const rLow = applyLisCapsToLibraryPlan([t2, t3], 'full_low');
  // t2 → generic cap × 12; t3 → brand cap × 12
  assert.equal(rLow.adjustedTotal, Math.round(LOW.generic * 12) + Math.round(LOW.brand * 12));
});
