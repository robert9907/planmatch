// scripts/tests/lis-cap-agent-v3.test.ts
//
// Verifies the LIS (Extra Help) cap math the agent-v3 CompareScreen
// relies on for correct beneficiary out-of-pocket display. Every case
// pins a known plan-copay scenario against the 2026 LIS caps
// (src/lib/dual-eligible.ts:49):
//
//   full_institutional  $0 generic  / $0 brand
//   full_low            $1.60       / $4.90
//   full_high           $5.10       / $12.65
//
// Plus the TrOOP backstop ($2,100 for 2026) that zeros Part D cost
// above the annual threshold for everyone (IRA §11201).
//
//   npm run test:lis
//   tsx --test scripts/tests/lis-cap-agent-v3.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLisCapsToLibraryPlan } from '../../src/lib/lis-cap-agent-v3.js';
import { PART_D_OOP_CAP_2026 } from '../../src/lib/plan-brain-utils.js';

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

test('lisTier=full_low → $1.60 generic / $4.90 brand caps per fill × 12', () => {
  // Plan-copay generic $10/fill ($120/yr) → capped at $1.60/fill = $19.20/yr
  // Plan-copay brand   $200/fill ($2400/yr) → capped at $4.90/fill = $58.80/yr
  const r = applyLisCapsToLibraryPlan(
    [generic(120), brand(2400)],
    'full_low',
  );
  assert.equal(r.adjustedTotal, Math.round(1.60 * 12) + Math.round(4.90 * 12));
  assert.deepEqual(r.lisCopaysApplied, { generic: 1.60, brand: 4.90 });
});

test('lisTier=full_high → $5.10 generic / $12.65 brand caps per fill × 12', () => {
  const r = applyLisCapsToLibraryPlan(
    [generic(120), brand(2400)],
    'full_high',
  );
  assert.equal(r.adjustedTotal, Math.round(5.10 * 12) + Math.round(12.65 * 12));
  assert.deepEqual(r.lisCopaysApplied, { generic: 5.10, brand: 12.65 });
});

test('plan copay below LIS cap → plan wins (min semantics)', () => {
  // Plan-copay generic $0.50/fill ($6/yr) — already below full_low $1.60.
  // LIS cap must NOT raise the cost.
  const r = applyLisCapsToLibraryPlan([generic(6)], 'full_low');
  assert.equal(r.adjustedTotal, 6);
});

test('uncovered drug pass-through — LIS does not help off-formulary', () => {
  // Uncovered kept small ($500) so total stays under PART_D_OOP_CAP_2026
  // — this test isolates the pass-through, TrOOP is exercised separately.
  const r = applyLisCapsToLibraryPlan(
    [generic(120), uncovered(500)],
    'full_low',
  );
  // Generic: capped at $1.60/fill × 12 = $19
  // Uncovered: full $500 stays
  assert.equal(r.adjustedTotal, Math.round(1.60 * 12) + 500);
});

test('specialty tier (5) is treated as brand for LIS cap', () => {
  const r = applyLisCapsToLibraryPlan([specialty(12000)], 'full_low');
  assert.equal(r.adjustedTotal, Math.round(4.90 * 12));
});

test('TrOOP backstop caps total at PART_D_OOP_CAP_2026', () => {
  // Ten brand-tier drugs at $500/fill each ($60k/yr each) all pre-cap.
  // Even without LIS, TrOOP zeros above $2,100. With full_high LIS
  // caps, each contributes ~$152/yr → 10 × $152 = $1,520 which is
  // below the cap — bad test. Use lisTier=none to force TrOOP path.
  //
  // Actually applyLisCapsToLibraryPlan only applies TrOOP when
  // lisCopays are active — matches dual-eligible.ts semantics. Test
  // with full_low so caps push total below $2,100 anyway; separately
  // verify the OOP constant is imported and finite.
  assert.equal(Number.isFinite(PART_D_OOP_CAP_2026), true);
  assert.equal(PART_D_OOP_CAP_2026 > 0, true);

  // Verify Math.min(runningTotal, PART_D_OOP_CAP_2026) fires: build a
  // scenario whose LIS-adjusted total exceeds the cap. With full_high
  // $12.65 brand cap × 12 = $151.80/yr per drug, need ~14 brand drugs
  // to breach $2,100. Cheaper: use 20 brands to guarantee the ceiling.
  const many = Array.from({ length: 20 }, () => brand(2400));
  const r = applyLisCapsToLibraryPlan(many, 'full_high');
  assert.equal(r.adjustedTotal, PART_D_OOP_CAP_2026);
});

test('empty medications list → zero, correct caps struct', () => {
  const r = applyLisCapsToLibraryPlan([], 'full_low');
  assert.equal(r.adjustedTotal, 0);
  assert.deepEqual(r.lisCopaysApplied, { generic: 1.60, brand: 4.90 });
});

test('tier heuristic — tier 2 counts as generic, tier 3 as brand', () => {
  const t2 = { covered: true, tier: 2, annualCost: 240 };
  const t3 = { covered: true, tier: 3, annualCost: 240 };
  const rLow = applyLisCapsToLibraryPlan([t2, t3], 'full_low');
  // t2 → generic cap $1.60 × 12 = ~$19
  // t3 → brand cap   $4.90 × 12 = ~$59
  assert.equal(rLow.adjustedTotal, Math.round(1.60 * 12) + Math.round(4.90 * 12));
});
