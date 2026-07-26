// Reconciliation between api/library/partDTimeline (new, per-fill
// straddle-aware) and src/lib/plan-brain-utils::estimateBundleYearlyCost
// (incumbent, integer-month deductible approximation, no catastrophic
// gating).
//
// The two are NOT expected to match everywhere — the timeline function
// is documented as more accurate. This suite pins down exactly WHERE
// they diverge and by how much, so any future edit to either that
// changes the delta gets caught. The user-facing annual number in the
// Compare screen still comes from the incumbent for now, so silent
// numeric drift between them is a regression.
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

test('mid-month straddle: incumbent under-charges by ~1 initial-copay share', () => {
  const s: Scenario = {
    drugDeductible: 615,
    deductibleAppliesToTiers: [3, 4, 5],
    drugs: [
      { rxcui: 's1', name: 'StraddleDrug', tier: 3, monthlyRetail: 200, monthlyCopay: 47 },
    ],
  };
  const incumbent = runIncumbent(s);
  const { total: timeline, month12Cumulative } = runTimeline(s);
  // Incumbent: monthsToDeductible=ceil(615/200)=4, deductiblePaid=615,
  //            remainingMonths=8, yearly = 615 + 47*8 = 991
  // Timeline:  3 * 200 (Jan-Mar full ded) + (15 + 47*185/200) April
  //            straddle + 47*8 May-Dec = 600 + 58.475 + 376 = 1034.475
  const delta = timeline - incumbent;
  console.log(
    `  [straddle]  incumbent=$${incumbent.toFixed(2)} ` +
    `timeline=$${timeline.toFixed(2)} delta=+$${delta.toFixed(2)} ` +
    `(timeline higher — captures initial-phase piece of the crossing fill)`,
  );
  assert.ok(
    Math.abs(month12Cumulative - timeline) < 0.02,
    `cumulative vs sum drift: ${month12Cumulative} vs ${timeline}`,
  );
  // Pin the delta so a future edit that changes either function is noticed.
  //   43.475 = 47 * (185/200) — the initial-copay share applied to the
  //   post-deductible portion of the April fill.
  assert.ok(
    Math.abs(delta - 43.475) < 0.01,
    `expected straddle delta ≈ +$43.475 (incumbent under by 1 proportional copay), got +$${delta.toFixed(2)}`,
  );
});

// ─── D. Catastrophic-in-Q1 — divergence expected and REPORTED ────────

test('specialty tier-3 hits catastrophic — incumbent keeps charging, timeline caps at TrOOP', () => {
  const s: Scenario = {
    drugDeductible: 615,
    deductibleAppliesToTiers: [3, 4, 5],
    drugs: [
      // Tier 3 (so estimateBundleYearlyCost includes it in tier3plus
      // deductible burn), high monthly retail so TrOOP crosses fast.
      { rxcui: 'x1', name: 'CatDrug', tier: 3, monthlyRetail: 900, monthlyCopay: 500 },
    ],
  };
  const incumbent = runIncumbent(s);
  const { total: timeline, month12Cumulative } = runTimeline(s);
  const delta = incumbent - timeline;
  console.log(
    `  [catastrophic]  incumbent=$${incumbent.toFixed(2)} ` +
    `timeline=$${timeline.toFixed(2)} delta=-$${delta.toFixed(2)} ` +
    `(timeline lower — capped at TrOOP $2,100 per IRA §11201)`,
  );
  assert.ok(
    Math.abs(month12Cumulative - timeline) < 0.02,
    `cumulative vs sum drift: ${month12Cumulative} vs ${timeline}`,
  );
  // Timeline must NEVER exceed the RxMOOP cap of $2,100 for a member's
  // out-of-pocket in a given plan year.
  assert.ok(
    timeline <= 2100 + 0.01,
    `timeline ${timeline} exceeds TrOOP cap $2,100`,
  );
  // Incumbent is expected to blow through the cap since it doesn't
  // model catastrophic — pin that it's meaningfully higher.
  assert.ok(
    incumbent > timeline,
    `incumbent ${incumbent} should exceed timeline ${timeline} in catastrophic case`,
  );
});

// ─── Summary of the incumbent's known gaps ──────────────────────────

test('SUMMARY — the two divergences the incumbent has vs the timeline', () => {
  // No assertion — this test exists to keep the summary visible in the
  // test output. Console.log lines are consumed by `tsx --test` and
  // printed alongside pass/fail markers.
  console.log(`
  INCUMBENT (estimateBundleYearlyCost) known gaps vs TIMELINE (partDTimeline):

    1. Integer-month deductible approximation:
       Bundles the whole crossing fill into deductible, then switches
       to copay for the remaining months. Misses the initial-phase
       copay piece of the crossing fill → under-charges by up to 1×
       proportional copay per drug with a straddle (~$43 for a $200/
       mo tier-3 drug with $47 copay).

    2. No catastrophic gating:
       Keeps applying deductible + copay for the full year regardless
       of TrOOP. Over-charges for high-cost specialty baskets once
       TrOOP crosses $2,100 (IRA §11201 caps member cost at $0
       thereafter).

  Neither divergence is a bug in the timeline. The user-facing Compare
  screen still uses the incumbent for the annual number; when it's
  cut over to the timeline library (a separate follow-up), both
  numbers converge on the more-accurate timeline output.
  `);
});
