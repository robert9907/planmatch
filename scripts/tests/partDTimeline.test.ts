// Unit tests for api/library/partDTimeline — the pure Part D phase
// timeline projector.
//
//   tsx --test scripts/tests/partDTimeline.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  partDTimeline,
  type DrugFill,
  type PlanInput,
  type MonthlyRow,
} from '../../api/library/partDTimeline.js';
import { getPlanYearParams } from '../../api/library/planYearParams.js';

const PARAMS_2026 = getPlanYearParams(2026);

// ─── Fixture helpers ─────────────────────────────────────────────────

function plan(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    deductible: 615,
    deductibleAppliesToTiers: [3, 4, 5],
    tierCostShares: {
      1: { initial: { type: 'copay', amount: 0 } },
      2: { initial: { type: 'copay', amount: 10 } },
      3: { initial: { type: 'copay', amount: 47 } },
      4: { initial: { type: 'copay', amount: 100 } },
      5: { initial: { type: 'coinsurance', amount: 0.25 } },
    },
    ...overrides,
  };
}

function drug(overrides: Partial<DrugFill> & { rxcui: string }): DrugFill {
  return {
    rxcui: overrides.rxcui,
    name: overrides.name ?? `Drug ${overrides.rxcui}`,
    tier: 3,
    monthlyGrossCost: 200,
    fillsPerYear: 12,
    ...overrides,
  };
}

function sumMemberCost(rows: MonthlyRow[]): number {
  return rows.reduce((s, r) => s + r.memberCost, 0);
}

// ─── 1. Waived-deductible generics: never leaves initial coverage ───

test('two Tier-1 generics, plan waives deductible → always in initial phase', () => {
  const rows = partDTimeline({
    planYear: 2026,
    plan: plan({
      deductible: 0,
      deductibleAppliesToTiers: [],
      tierCostShares: {
        1: { initial: { type: 'copay', amount: 0 } },
      },
    }),
    drugs: [
      drug({ rxcui: '1000', tier: 1, monthlyGrossCost: 8 }),
      drug({ rxcui: '2000', tier: 1, monthlyGrossCost: 12 }),
    ],
  });

  assert.equal(rows.length, 12);
  for (const r of rows) {
    assert.equal(r.phase, 'initial', `month ${r.month} phase`);
    assert.equal(r.memberCost, 0, `month ${r.month} memberCost`);
    assert.equal(r.phaseChangedMidMonth, false, `month ${r.month} straddle`);
  }
  assert.equal(rows[11].cumulativeMemberCost, 0);
  assert.equal(rows[11].troop, 0);
});

// ─── 2. Eliquis (tier 3, single drug) — verify month it crosses each
//        boundary. Eliquis is real, ~$650/mo AWP; at that rate the
//        deductible fills in month 1 and TrOOP hits catastrophic mid-
//        year.

test('Eliquis alone (tier 3, $650/mo) — deductible clears in Jan, catastrophic reached', () => {
  const rows = partDTimeline({
    planYear: 2026,
    plan: plan(),
    drugs: [drug({ rxcui: 'eliquis', tier: 3, monthlyGrossCost: 650 })],
  });

  // Month 1: deductible piece $615 + initial piece $35 at proportional
  //   copay ($47 × 35/650 = ~$2.53) → member pays ~$617.53.
  //   Straddle: yes.
  assert.equal(rows[0].phaseChangedMidMonth, true, 'Jan straddles ded→initial');
  assert.ok(rows[0].memberCost > 615, 'Jan pays at least the deductible');
  assert.ok(rows[0].memberCost < 618, 'Jan pays deductible + small initial slice');

  // Month 2 onward: pure initial coverage until TrOOP hits $2,100.
  //   Month 2: cumulative ≈ $617.53 + $47 = $664.53. Not yet catastrophic.
  assert.equal(rows[1].phase, 'initial', 'Feb is initial coverage');
  assert.equal(rows[1].memberCost, 47);

  // TrOOP after N months of initial coverage: 617.53 + 47*(N-1). Hits
  // $2,100 when N ≈ 32.5 months. That's beyond the 12-month window, so
  // this basket alone never reaches catastrophic — verify.
  assert.ok(rows[11].troop < PARAMS_2026.troopCap, 'basket does not reach cap in year 1');
  assert.equal(rows[11].phase, 'initial');

  // Sanity: gross drug cost is $650 × 12 across the year.
  const totalGross = rows.reduce((s, r) => s + r.grossDrugCost, 0);
  assert.equal(totalGross, 7800);
});

// ─── 3. High-cost specialty tier 5 (coinsurance) — catastrophic in Q1.

test('specialty tier 5 (25% coinsurance, $8000/mo) → catastrophic within Q1', () => {
  const rows = partDTimeline({
    planYear: 2026,
    plan: plan(),
    drugs: [drug({ rxcui: 'humira', tier: 5, monthlyGrossCost: 8000 })],
  });

  // Month 1: fill $8,000. Deductible piece $615 (100%) + initial piece
  //   $7,385 at 25% coinsurance = $1,846.25. Fill total: $2,461.25.
  //   TrOOP after fill = $2,461.25 > $2,100 → refund overshoot from
  //   initial piece. Final member cost ≤ $2,100.
  assert.ok(rows[0].memberCost <= PARAMS_2026.troopCap + 0.01,
    `Jan member cost ${rows[0].memberCost} must not exceed troopCap`);
  assert.ok(rows[0].troop <= PARAMS_2026.troopCap + 0.01,
    'TrOOP capped at threshold');
  assert.equal(rows[0].phase, 'catastrophic', 'Jan ends in catastrophic');
  assert.equal(rows[0].phaseChangedMidMonth, true, 'Jan straddled ded/initial/cat');

  // Months 2..12: $0 member cost (already catastrophic).
  for (let m = 1; m < 12; m += 1) {
    assert.equal(rows[m].memberCost, 0, `month ${m + 1} in catastrophic → $0`);
    assert.equal(rows[m].phase, 'catastrophic');
    assert.equal(rows[m].phaseChangedMidMonth, false,
      `month ${m + 1} is fully within catastrophic, no straddle`);
  }
});

// ─── 4. Mid-month straddle — split verified, not a whole fill at one rate.

test('mid-month straddle: $200 fill with $50 deductible remaining splits proportionally', () => {
  // Craft a scenario where by month 4 the deductible has $50 left, and
  // the fill straddles. Deductible=$615, drug=$200/mo tier 3 copay $47.
  //   Month 1: $200 → ded remains $415
  //   Month 2: $200 → ded remains $215
  //   Month 3: $200 → ded remains $15
  //   Month 4: $200 fill. Ded piece = $15, initial piece = $185.
  //     Copay $47 scales proportionally: $47 × 185/200 = $43.475.
  //     Total member = $15 + $43.475 = $58.475. Straddle = true.
  //   Months 5..12: $200 → $47 each.
  const rows = partDTimeline({
    planYear: 2026,
    plan: plan(),
    drugs: [drug({ rxcui: 'straddler', tier: 3, monthlyGrossCost: 200 })],
  });

  assert.equal(rows[0].memberCost, 200);
  assert.equal(rows[1].memberCost, 200);
  assert.equal(rows[2].memberCost, 200);
  assert.equal(rows[2].phase, 'deductible');
  assert.equal(rows[2].phaseChangedMidMonth, false);

  // Month 4 (index 3) straddles.
  assert.equal(rows[3].phaseChangedMidMonth, true, 'April straddles');
  assert.ok(
    Math.abs(rows[3].memberCost - 58.48) < 0.02,
    `April member cost ≈ 58.48, got ${rows[3].memberCost}`,
  );
  // Not a whole fill at deductible rate ($200):
  assert.ok(rows[3].memberCost < 200, 'April is NOT charged $200 at deductible rate');
  // Not a whole fill at initial rate ($47) either:
  assert.ok(rows[3].memberCost > 47, 'April is NOT charged the flat $47 copay alone');
  assert.equal(rows[3].phase, 'initial', 'April ends in initial coverage');

  // May onward is flat copay.
  for (let m = 4; m < 12; m += 1) {
    assert.equal(rows[m].memberCost, 47, `month ${m + 1} copay`);
    assert.equal(rows[m].phase, 'initial');
  }

  // Total member cost = 3×200 + 58.475 + 8×47 = 600 + 58.475 + 376 = 1034.475
  const total = sumMemberCost(rows);
  assert.ok(
    Math.abs(total - 1034.48) < 0.02,
    `annual total ≈ 1034.48, got ${total}`,
  );
});

// ─── 5. Insulin cap: $35/mo holds through deductible phase.

test('insulin (tier 3, $650/mo) capped at $35/mo even in deductible phase', () => {
  const rows = partDTimeline({
    planYear: 2026,
    plan: plan(),
    drugs: [
      drug({
        rxcui: 'lantus',
        name: 'Lantus',
        tier: 3,
        monthlyGrossCost: 650,
        isInsulin: true,
      }),
    ],
  });

  for (const r of rows) {
    assert.equal(r.memberCost, 35, `month ${r.month} insulin cap`);
  }
  // Cumulative = $35 × 12 = $420.
  assert.equal(rows[11].cumulativeMemberCost, 420);
  // TrOOP tracks the capped amount, not the notional deductible spend.
  assert.equal(rows[11].troop, 420);
});

// ─── 6. Vaccines: $0 in every phase, gross still counted.

test('Part D vaccine (tier 3, $150 shot) → $0 to member, gross tracked', () => {
  const rows = partDTimeline({
    planYear: 2026,
    plan: plan(),
    drugs: [
      drug({
        rxcui: 'shingrix',
        name: 'Shingrix',
        tier: 3,
        monthlyGrossCost: 150,
        fillsPerYear: 1,
        isVaccine: true,
      }),
    ],
  });

  assert.equal(sumMemberCost(rows), 0);
  const grossTotal = rows.reduce((s, r) => s + r.grossDrugCost, 0);
  assert.equal(grossTotal, 150);
  // Vaccine doesn't burn deductible.
  assert.equal(rows[11].troop, 0);
});

// ─── 7. Cumulative + running-total invariants.

test('cumulativeMemberCost is monotonic and equals sum of memberCost per month', () => {
  const rows = partDTimeline({
    planYear: 2026,
    plan: plan(),
    drugs: [
      drug({ rxcui: 'a', tier: 3, monthlyGrossCost: 200 }),
      drug({ rxcui: 'b', tier: 2, monthlyGrossCost: 30 }),
      drug({ rxcui: 'c', tier: 1, monthlyGrossCost: 8 }),
    ],
  });

  let running = 0;
  for (const r of rows) {
    running += r.memberCost;
    assert.ok(
      Math.abs(r.cumulativeMemberCost - running) < 0.01,
      `month ${r.month} cumulative`,
    );
  }
  assert.ok(rows[11].cumulativeMemberCost >= rows[0].memberCost);
});

// ─── 8. Waived deductible on tiers 1-2, applies to 3-5 (common filing)

test('deductibleAppliesToTiers=[3,4,5]: tier-2 generic pays copay from month 1', () => {
  const rows = partDTimeline({
    planYear: 2026,
    plan: plan(),
    drugs: [
      drug({ rxcui: 't2', tier: 2, monthlyGrossCost: 30 }),
    ],
  });

  for (const r of rows) {
    assert.equal(r.memberCost, 10, `month ${r.month} tier-2 copay`);
    assert.equal(r.phase, 'initial');
    assert.equal(r.phaseChangedMidMonth, false);
  }
});

// ─── 9. 90-day fills — fills spread quarterly, not monthly.

test('90-day fills (fillsPerYear=4) — cost concentrated in fill months', () => {
  const rows = partDTimeline({
    planYear: 2026,
    plan: plan({
      // Waive deductible so we can inspect pure initial-phase spacing.
      deductible: 0,
      deductibleAppliesToTiers: [],
    }),
    drugs: [
      drug({ rxcui: 'mail', tier: 3, monthlyGrossCost: 200, fillsPerYear: 4 }),
    ],
  });

  const fillMonths = rows.filter((r) => r.memberCost > 0).map((r) => r.month);
  assert.deepEqual(fillMonths, [1, 4, 7, 10], 'quarterly fill cadence');
  for (const m of [2, 3, 5, 6, 8, 9, 11, 12]) {
    assert.equal(rows[m - 1].memberCost, 0, `month ${m} no fill`);
  }
});

// ─── 10. Reconciliation with hand-computed annual for a simple basket.

test('annual sum matches hand-computed expected for simple basket (within $1)', () => {
  // Basket: one tier-1 generic ($8/mo, $0 copay) + one tier-3 brand
  //   ($200/mo, $47 copay), plan deductible $615 applying to tier 3+.
  //
  // Expected annual (hand math, matching the mid-month straddle test):
  //   T1 generic: $0 × 12 = $0
  //   T3 brand: 3×$200 (Jan/Feb/Mar burn deductible) + straddle-month
  //     April ($15 ded + $47×185/200 = $58.475) + 8×$47 (May-Dec) =
  //     600 + 58.475 + 376 = $1,034.475
  //   Total: $1,034.475
  const rows = partDTimeline({
    planYear: 2026,
    plan: plan(),
    drugs: [
      drug({ rxcui: 'gen', tier: 1, monthlyGrossCost: 8 }),
      drug({ rxcui: 'brand', tier: 3, monthlyGrossCost: 200 }),
    ],
  });

  const total = sumMemberCost(rows);
  const expected = 1034.475;
  assert.ok(
    Math.abs(total - expected) < 1,
    `annual sum ${total} within $1 of expected ${expected}`,
  );
});
