// Agent own-brain LIS TrOOP accrual — mirror of consumer plan-match #175.
//
// applyDualEligibleCostAdjustment now charges min(plan per-fill copay, LIS tier
// cap) per fill and accrues the STANDARD (non-LIS) member cost-share
// (drug.standardAnnual) toward PART_D_OOP_CAP; once the accrual hits the cap the
// LIS copay drops to $0 (interleaved over 12 monthly fills). The prior model
// summed 12× the LIS copay and capped the TOTAL — it never zeroed mid-year for
// small LIS copays, over-charging duals with expensive baskets. These tests lock
// the new semantics: the cutoff rides standardAnnual, not the LIS-capped total,
// and not full gross.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDualEligibleCostAdjustment } from '../../src/lib/dual-eligible.js';
import { PART_D_OOP_CAP } from '../../src/lib/plan-brain-utils.js';
import type { BrainScore } from '../../src/lib/plan-brain-types.js';
import type { PmPlanRow } from '../../src/lib/brain-foreign-types.js';

type DrugRow = BrainScore['drugBreakdown'][number];

function drug(partial: Partial<DrugRow>): DrugRow {
  return {
    rxcui: partial.rxcui ?? 'rx',
    name: partial.name ?? 'Drug',
    covered: partial.covered ?? true,
    tier: partial.tier ?? 3,
    monthlyCopay: partial.monthlyCopay ?? null,
    annualCost: partial.annualCost ?? 0,
    standardAnnual: partial.standardAnnual,
    isBrand: partial.isBrand ?? true,
    priorAuth: false,
    stepTherapy: false,
    quantityLimit: false,
    quantityLimitAmount: null,
    quantityLimitDays: null,
  } as DrugRow;
}

function makeScore(drugBreakdown: DrugRow[]): BrainScore {
  const totalDrug = drugBreakdown.reduce((s, d) => s + d.annualCost, 0);
  return {
    totalAnnualDrugCost: totalDrug,
    annualMedicalCost: 0,
    drugBreakdown,
    realAnnualCost: {
      premium: 0,
      drugCost: totalDrug,
      medicalCost: 0,
      suppliesCost: 0,
      erExpected: 0,
      hospitalExpected: 0,
      snfExpected: 0,
      ambulanceExpected: 0,
      dmeExpected: 0,
      deductibleCost: 0,
      cappedMedicalBucket: 0,
      partBGivebackSavings: 0,
      netAnnual: totalDrug,
    },
  } as unknown as BrainScore;
}

// A non-D-SNP MA plan (no premium/medical zeroing side effects) in 2027.
const PLAN = { plan_type: 'HMO', snp_type: null, plan_year: 2027 } as unknown as PmPlanRow;

// full_low = FBDE ≤100% FPL: $1.65 generic / $5.00 brand per fill (Table V-2 2027).

test('cutoff rides standardAnnual: huge standard cost-share zeroes LIS copays mid-year', () => {
  // One brand drug. Member per-fill = min(annualCost/12, $5 brand cap) = $5.
  // standardAnnual $4,800 → $400/fill → cumulative hits $2,400 at the 6th fill,
  // so only 6 fills are charged: 6 × $5 = $30 (NOT 12 × $5 = $60).
  const s = makeScore([drug({ annualCost: 600, standardAnnual: 4800, isBrand: true })]);
  const out = applyDualEligibleCostAdjustment(s, PLAN, 'none', 'community', 'full_low');
  assert.equal(out.drugBreakdown[0].annualCost, 30);
  assert.equal(out.totalAnnualDrugCost, 30);
  // Prior cap-the-total model would have charged all 12 fills = $60.
  assert.ok(out.totalAnnualDrugCost < 60, 'new accrual charges fewer than 12 months');
});

test('no cutoff when standard cost-share stays under the cap: full 12 LIS copays', () => {
  // standardAnnual $600 → $50/fill → never reaches $2,400 in 12 fills, so the
  // member pays the $5 brand cap all 12 months = $60.
  const s = makeScore([drug({ annualCost: 600, standardAnnual: 600, isBrand: true })]);
  const out = applyDualEligibleCostAdjustment(s, PLAN, 'none', 'community', 'full_low');
  assert.equal(out.drugBreakdown[0].annualCost, 60);
});

test('standardAnnual (not the LIS-capped total) drives the cutoff', () => {
  // Tiny LIS-capped member cost but a large standard cost-share. The OLD model
  // capped the LIS-capped running total (which never approaches $2,400), so it
  // charged all 12 months. The new model sees standardAnnual reach $2,400 and
  // stops early — proving the accrual basis is standardAnnual, not annualCost.
  const s = makeScore([drug({ annualCost: 240, standardAnnual: 9600, isBrand: true })]);
  const out = applyDualEligibleCostAdjustment(s, PLAN, 'none', 'community', 'full_low');
  // $9,600/yr = $800/fill → cap at the 3rd fill → 3 × min($20, $5) = 3 × $5 = $15.
  assert.equal(out.drugBreakdown[0].annualCost, 15);
});

test('falls back to annualCost when standardAnnual is absent', () => {
  // No standardAnnual → accrual basis = annualCost ($600 → $50/fill) → never caps
  // → 12 × $5 = $60. (Legacy callers that predate the field still behave.)
  const s = makeScore([drug({ annualCost: 600, standardAnnual: undefined, isBrand: true })]);
  const out = applyDualEligibleCostAdjustment(s, PLAN, 'none', 'community', 'full_low');
  assert.equal(out.drugBreakdown[0].annualCost, 60);
});

test('$0-tier covered drug stays $0 and does not accrue a member charge', () => {
  const s = makeScore([
    drug({ name: '$0 generic', annualCost: 0, standardAnnual: 0, isBrand: false, tier: 1 }),
    drug({ name: 'brand', annualCost: 600, standardAnnual: 600, isBrand: true }),
  ]);
  const out = applyDualEligibleCostAdjustment(s, PLAN, 'none', 'community', 'full_low');
  assert.equal(out.drugBreakdown[0].annualCost, 0);
  assert.equal(out.drugBreakdown[1].annualCost, 60);
});

test('institutional (LIS $0) → covered drugs cost $0', () => {
  const s = makeScore([drug({ annualCost: 600, standardAnnual: 9600, isBrand: true })]);
  const out = applyDualEligibleCostAdjustment(s, PLAN, 'none', 'nursing_home', 'full_institutional');
  assert.equal(out.drugBreakdown[0].annualCost, 0);
});

test('uncovered (off-formulary) spend is outside Part D — unchanged, sits on top', () => {
  const s = makeScore([
    drug({ name: 'uncovered', covered: false, annualCost: 2037, tier: null }),
    drug({ name: 'brand', annualCost: 600, standardAnnual: 600, isBrand: true }),
  ]);
  const out = applyDualEligibleCostAdjustment(s, PLAN, 'none', 'community', 'full_low');
  assert.equal(out.drugBreakdown[0].annualCost, 2037); // uncovered unchanged
  assert.equal(out.totalAnnualDrugCost, 2037 + 60); // covered LIS + uncovered on top
});

test('backstop clamp: covered total never exceeds PART_D_OOP_CAP', () => {
  assert.ok(Number.isFinite(PART_D_OOP_CAP) && PART_D_OOP_CAP > 0);
  // 30 brands each priced ABOVE the cap per fill (pathological, no cap-trigger
  // because standardAnnual is 0 → never reaches catastrophic) → clamp binds.
  const many = Array.from({ length: 30 }, (_, i) =>
    drug({ rxcui: `rx${i}`, annualCost: 1200, standardAnnual: 0, isBrand: true }),
  );
  const out = applyDualEligibleCostAdjustment(makeScore(many), PLAN, 'none', 'community', 'full_low');
  assert.ok(out.totalAnnualDrugCost <= PART_D_OOP_CAP);
});
