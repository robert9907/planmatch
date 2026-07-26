// Reconciliation between api/library/partDTimeline and the incumbent
// src/lib/plan-brain-utils::estimateBundleYearlyCost.
//
// As of the "retire the incumbent" commit, estimateBundleYearlyCost's
// body IS a partDTimeline call — the two functions must return the
// same basket total (within $1 rounding drift from the incumbent
// coercing per-drug yearlyCost to integer dollars, which loses
// fractional cents when summed across drugs). Any delta >$1 on the
// pinned scenarios means the wrapper is failing to translate a call
// site's inputs — STOP and diagnose before shipping.
//
// The four scenario shapes below are preserved verbatim from when
// the two functions DID diverge (integer-month deductible
// approximation + missing TrOOP cap). If a future edit accidentally
// re-introduces either, the delta shows up here first.
//
//   tsx --test scripts/tests/partDTimeline-incumbent.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  partDTimeline,
  type DrugFill,
  type PlanInput,
} from '../../api/library/partDTimeline.js';
import { estimateBundleYearlyCost } from '../../src/lib/plan-brain-utils.js';

// ─── Shared scenario builder ─────────────────────────────────────────
//
// The two functions take VERY different input shapes. This helper
// takes a compact scenario description and materializes both.

interface BasketDrug {
  rxcui: string;
  name: string;
  tier: number;
  monthlyRetail: number;
  monthlyCopay: number;   // plan's post-deductible tier copay
}

interface Scenario {
  drugDeductible: number;
  deductibleAppliesToTiers: number[];
  drugs: BasketDrug[];
}

function toIncumbentInputs(s: Scenario) {
  const formulary = new Map<string, { tier: number; covered: boolean }>();
  for (const d of s.drugs) formulary.set(d.rxcui, { tier: d.tier, covered: true });
  // estimateBundleYearlyCost reads rx_tier_N rows from pm_plan_benefits
  // shape to derive post-deductible cost. Only the tier + copay matter
  // for this reconciliation.
  const tiersSeen = new Set(s.drugs.map((d) => d.tier));
  const benefits = Array.from(tiersSeen).map((t) => {
    const d = s.drugs.find((x) => x.tier === t)!;
    return {
      benefit_category: `rx_tier_${t}`,
      benefit_description: null,
      coverage_amount: null,
      copay: d.monthlyCopay,
      coinsurance: null,
      max_coverage: null,
    };
  });
  return {
    drugs: s.drugs.map((d) => ({ rxcui: d.rxcui, name: d.name })),
    formulary,
    benefits,
    drugDeductible: s.drugDeductible,
  };
}

function toTimelineInputs(s: Scenario): { plan: PlanInput; drugs: DrugFill[] } {
  const tierCostShares: PlanInput['tierCostShares'] = {};
  for (const d of s.drugs) {
    tierCostShares[d.tier] = {
      initial: { type: 'copay', amount: d.monthlyCopay },
    };
  }
  return {
    plan: {
      deductible: s.drugDeductible,
      deductibleAppliesToTiers: s.deductibleAppliesToTiers,
      tierCostShares,
    },
    drugs: s.drugs.map((d): DrugFill => ({
      rxcui: d.rxcui,
      name: d.name,
      tier: d.tier,
      monthlyGrossCost: d.monthlyRetail,
      fillsPerYear: 12,
    })),
  };
}

function runIncumbent(s: Scenario): number {
  const inputs = toIncumbentInputs(s);
  const per = estimateBundleYearlyCost(inputs);
  return per.reduce((sum, r) => sum + r.yearlyCost, 0);
}

function runTimeline(s: Scenario): { total: number; month12Cumulative: number } {
  const inputs = toTimelineInputs(s);
  const rows = partDTimeline({
    planYear: 2026,
    plan: inputs.plan,
    drugs: inputs.drugs,
  });
  const total = rows.reduce((s, r) => s + r.memberCost, 0);
  const month12Cumulative = rows[11].cumulativeMemberCost;
  return { total, month12Cumulative };
}

// ─── A. Waived-deductible basket — both must agree at $0 ─────────────

test('waived-deductible tier-1 generic: incumbent and timeline both = $0', () => {
  const s: Scenario = {
    drugDeductible: 0,
    deductibleAppliesToTiers: [],
    drugs: [
      { rxcui: 'g1', name: 'Metformin', tier: 1, monthlyRetail: 8, monthlyCopay: 0 },
    ],
  };
  const incumbent = runIncumbent(s);
  const { total: timeline, month12Cumulative } = runTimeline(s);
  assert.equal(incumbent, 0);
  assert.equal(timeline, 0);
  assert.equal(month12Cumulative, 0);
});

// ─── B. Deductible burns on a natural month boundary — expect match ──
//
// IMPORTANT calibration note: the incumbent estimateBundleYearlyCost
// IGNORES per-drug retail input and uses NOTIONAL_TIER_FULL_COST from
// plan-brain-utils (Tier 3 = $200/mo). Reconciliation scenarios have
// to use retails that match those notionals or the two functions
// operate on different assumed prices and diverge trivially.

test('single tier-3 drug @ notional $200/mo, ded $600 — clears in 3 months, no straddle', () => {
  // Deductible must be ≤ 2026 max ($615) or the timeline clamps
  // defensively while the incumbent doesn't — trivial divergence.
  // $600 evenly divides 200/mo × 3, so month 3's fill fully hits the
  // last $200 of ded with no straddle.
  const s: Scenario = {
    drugDeductible: 600,
    deductibleAppliesToTiers: [3, 4, 5],
    drugs: [
      { rxcui: 'b1', name: 'BoundaryDrug', tier: 3, monthlyRetail: 200, monthlyCopay: 47 },
    ],
  };
  const incumbent = runIncumbent(s);
  const { total: timeline, month12Cumulative } = runTimeline(s);
  // Incumbent: monthsToDeductible = ceil(600/200) = 3, deductiblePaid = 600,
  //            remainingMonths = 9, yearly = 600 + 47*9 = 1023.
  // Timeline:  Jan-Mar = 200 * 3 = 600 (each fill fully in ded, no
  //            straddle in March because 200 = remaining 200).
  //            Apr-Dec = 47 * 9 = 423. Total = 1023.
  const delta = Math.abs(timeline - incumbent);
  console.log(
    `  [boundary]  incumbent=$${incumbent.toFixed(2)} ` +
    `timeline=$${timeline.toFixed(2)} delta=$${delta.toFixed(2)}`,
  );
  // month12Cumulative is the internally-tracked total (single rounding);
  // `timeline` is sum(memberCost) which double-rounds. Allow $0.01.
  assert.ok(
    Math.abs(month12Cumulative - timeline) < 0.02,
    `cumulative vs sum drift: ${month12Cumulative} vs ${timeline}`,
  );
  assert.ok(
    delta <= 1,
    `expected boundary case within $1, got delta=$${delta.toFixed(2)}`,
  );
});

// ─── C. Mid-month straddle — divergence expected and REPORTED ────────

test('mid-month straddle: incumbent now delegates → convergence within $1 rounding drift', () => {
  const s: Scenario = {
    drugDeductible: 615,
    deductibleAppliesToTiers: [3, 4, 5],
    drugs: [
      { rxcui: 's1', name: 'StraddleDrug', tier: 3, monthlyRetail: 200, monthlyCopay: 47 },
    ],
  };
  const incumbent = runIncumbent(s);
  const { total: timeline, month12Cumulative } = runTimeline(s);
  // Both compute the same underlying $1034.475: 3 * 200 (Jan-Mar full
  // ded) + (15 + 47*185/200) April straddle + 47*8 May-Dec = 600 +
  // 58.475 + 376. Incumbent rounds per-drug yearlyCost to integer
  // dollars; timeline sums per-month 2dp memberCost. Drift up to $1
  // from those two rounding boundaries is expected.
  const delta = timeline - incumbent;
  console.log(
    `  [straddle]  incumbent=$${incumbent.toFixed(2)} ` +
    `timeline=$${timeline.toFixed(2)} delta=+$${delta.toFixed(2)}`,
  );
  assert.ok(
    Math.abs(month12Cumulative - timeline) < 0.02,
    `cumulative vs sum drift: ${month12Cumulative} vs ${timeline}`,
  );
  assert.ok(
    Math.abs(delta) < 1,
    `expected convergence within $1 (incumbent now delegates to timeline), got |$${delta.toFixed(2)}|`,
  );
});

// ─── D. Catastrophic-in-Q1 — divergence expected and REPORTED ────────

test('specialty tier-3 hits catastrophic — incumbent respects TrOOP cap via timeline', () => {
  const s: Scenario = {
    drugDeductible: 615,
    deductibleAppliesToTiers: [3, 4, 5],
    drugs: [
      // Tier 3 with high monthly retail so TrOOP crosses fast. Under
      // the pre-retirement incumbent this basket returned ~$4,615/yr
      // (no cap). Now the incumbent delegates to partDTimeline, both
      // clamp at $2,100.
      { rxcui: 'x1', name: 'CatDrug', tier: 3, monthlyRetail: 900, monthlyCopay: 500 },
    ],
  };
  const incumbent = runIncumbent(s);
  const { total: timeline, month12Cumulative } = runTimeline(s);
  const delta = incumbent - timeline;
  console.log(
    `  [catastrophic]  incumbent=$${incumbent.toFixed(2)} ` +
    `timeline=$${timeline.toFixed(2)} delta=$${delta.toFixed(2)}`,
  );
  assert.ok(
    Math.abs(month12Cumulative - timeline) < 0.02,
    `cumulative vs sum drift: ${month12Cumulative} vs ${timeline}`,
  );
  // Both sides must respect the RxMOOP cap of $2,100 (IRA §11201).
  assert.ok(
    timeline <= 2100 + 0.01,
    `timeline ${timeline} exceeds TrOOP cap $2,100`,
  );
  assert.ok(
    incumbent <= 2100 + 0.01,
    `incumbent ${incumbent} exceeds TrOOP cap $2,100 — retirement didn't take effect for this call site?`,
  );
  assert.ok(
    Math.abs(delta) < 1,
    `expected convergence within $1 (incumbent now delegates), got |$${delta.toFixed(2)}|`,
  );
});

// ─── Summary of the closed gaps ─────────────────────────────────────

test('SUMMARY — historical divergences now closed by the retirement', () => {
  // No assertion — this test exists to keep the summary visible in the
  // test output. Console.log lines are consumed by `tsx --test` and
  // printed alongside pass/fail markers.
  console.log(`
  HISTORY — before the retirement commit, estimateBundleYearlyCost had
  two known gaps vs partDTimeline:

    1. Integer-month deductible approximation:
       Bundled the whole crossing fill into deductible, then switched
       to copay for the remaining months. Missed the initial-phase
       copay piece of the crossing fill → under-charged by up to 1×
       proportional copay per drug with a straddle (~$43 for a $200/
       mo tier-3 drug with $47 copay).

    2. No catastrophic gating:
       Kept applying deductible + copay for the full year regardless
       of TrOOP. Over-charged for high-cost specialty baskets once
       TrOOP crossed $2,100 (IRA §11201 caps member cost at $0
       thereafter — was over by $2,500+ on a $900/mo tier-3 basket).

  Both are closed as of the retirement commit — estimateBundleYearlyCost
  now delegates its basket math to partDTimeline and returns the
  month-12 cumulative. Per-drug attribution is proportional-solo.
  Assertions above tolerate up to $1 of drift from integer rounding
  in the wrapper.
  `);
});
