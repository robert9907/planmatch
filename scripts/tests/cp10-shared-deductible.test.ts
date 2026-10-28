// The Part D deductible is a shared TOTAL-DRUG-COST threshold: every covered
// drug's gross draws it down, including $0-copay drugs on deductible-exempt
// tiers. So a deductible-SUBJECT drug clears the deductible sooner — and costs
// the member less — when filled alongside exempt drugs. Agent-side mirror of
// the consumer test (robert9907/plan-match:
// packages/brain/src/__tests__/partd-shared-deductible.test.ts).
//
//   tsx --test scripts/tests/cp10-shared-deductible.test.ts
//
// VERIFIED live vs medicare.gov 2026-10-27, A03 Carol Whitfield on H3449-027
// (BCBSNC, $700 deductible, tiers [1,2,6] exempt):
//   Linzess tier 3 alone ............................... $898.50
//   Linzess + losartan (tier 6, $0) .................... $671.16
//   Linzess + losartan + alendronate (tier 6, $0) ...... $562.72  (A03's basket)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partDTimeline, type DrugFill, type PlanInput } from '../../api/library/partDTimeline.js';

const plan: PlanInput = {
  deductible: 700,
  deductibleAppliesToTiers: [3, 4, 5],
  tierCostShares: {
    3: { initial: { type: 'coinsurance', amount: 0.21 } },
    6: { initial: { type: 'copay', amount: 0 } },
  },
};
const linzess: DrugFill = { rxcui: '1869699', name: 'Linzess 72', tier: 3, monthlyGrossCost: 137.26, fillsPerYear: 12 };
const losartan: DrugFill = { rxcui: '979492', name: 'losartan 50', tier: 6, monthlyGrossCost: 95.98, fillsPerYear: 12 };
const alendronate: DrugFill = { rxcui: '904431', name: 'alendronate 70', tier: 6, monthlyGrossCost: 166.16, fillsPerYear: 12 };

function annual(drugs: DrugFill[]): number {
  const rows = partDTimeline({ drugs, plan, planYear: 2027 });
  return Math.round(rows[rows.length - 1].cumulativeMemberCost);
}

test('Linzess alone burns the full $700 deductible (≈ PF $898)', () => {
  assert.ok(annual([linzess]) > 860 && annual([linzess]) < 940, `got ${annual([linzess])}`);
});
test('one $0 exempt companion → cheaper (≈ PF $671)', () => {
  const v = annual([linzess, losartan]);
  assert.ok(v > 640 && v < 700, `got ${v}`);
});
test("A03's full basket → ≈ PF $563 (was $899)", () => {
  const v = annual([linzess, losartan, alendronate]);
  assert.ok(v > 530 && v < 600, `got ${v}`);
  assert.ok(v < annual([linzess]), 'must be strictly cheaper than solo');
});
