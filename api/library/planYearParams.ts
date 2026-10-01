// Per-plan-year Part D structural constants — the values that shift on
// each CMS Announcement / IRA anniversary and need to roll cleanly from
// one year to the next. Keeping them in a single data module so a new
// plan year is a one-line addition, not a scavenger hunt across the
// codebase.
//
// 2026 numbers per the CMS 2026 Rate Announcement:
//   • Deductible max        $615
//   • RxMOOP / catastrophic $2,100  (IRA §11201)
//   • Insulin monthly cap   $35     (IRA §11406)
//   • Vaccine member cost   $0      (IRA §11401 — ACIP-recommended)
//
// The 2025 baseline is included too so a caller can back-test
// against last year's benefit filings.
//
// ⚠ CROSS-REPO SYNC — this file exists at two locations:
//   robert9907/planmatch:  api/library/planYearParams.ts       (agent)
//   robert9907/plan-match: packages/shared/src/planYearParams.ts (consumer)
// Any change must be mirrored to the other. CI job partd-drift.yml
// runs scripts/check-partd-drift.mjs which enforces byte-identity.

export interface PlanYearParams {
  /** Maximum Part D deductible the plan may charge. Plans may file
   *  lower; this is the ceiling and the ceiling changes annually. */
  partDDeductibleMax: number;
  /** True out-of-pocket threshold. Once TrOOP crosses this, the member
   *  pays $0 for the rest of the plan year (IRA §11201). */
  troopCap: number;
  /** IRA insulin cap — member pays no more than this per one-month
   *  supply of a covered insulin product, in any phase. */
  insulinMonthlyCap: number;
  /** Part D ACIP-recommended vaccine cost to member. */
  vaccineMemberCost: number;
}

export const PLAN_YEAR_PARAMS: Readonly<Record<number, PlanYearParams>> = {
  2025: {
    partDDeductibleMax: 590,
    troopCap: 2000,
    insulinMonthlyCap: 35,
    vaccineMemberCost: 0,
  },
  2026: {
    partDDeductibleMax: 615,
    troopCap: 2100,
    insulinMonthlyCap: 35,
    vaccineMemberCost: 0,
  },
  2027: {
    // CMS 2027 Rate Announcement — verified in cms_watch.facts 2026-09-12,
    // status 'confirmed':
    //   • Deductible max $700 (Attachment V) — up $85 from 2026, the biggest
    //     single-year jump since the IRA. fact_key partd_2027_deductible.
    //   • RxMOOP / TrOOP $2,400 — up from $2,100. fact_key partd_2027_oop_cap.
    partDDeductibleMax: 700,
    troopCap: 2400,
    // Statutory IRA constants, NOT annually-indexed CMS figures — do not go
    // hunting for these in a Rate Announcement next year:
    //   • $35/month insulin cap — IRA §11406 (flat, carries forward unchanged).
    //   • $0 ACIP-recommended vaccine member cost — IRA §11401.
    insulinMonthlyCap: 35,
    vaccineMemberCost: 0,
  },
};

// Thrown — rather than returning a silent default — when a plan year has no
// Part D structural constants yet. A placeholder would quietly mis-price every
// drug for that year; a named, traceable throw turns "wrong numbers" into an
// obvious, greppable failure that names the year and exactly where to fix it.
// (Nothing requests an unlisted year today — the brain's BUNDLE_PLAN_YEAR and
// the client's PART_D_2026 are pinned to 2026 — so this only fires the moment
// real per-year Part D math first runs for a new year.)
export class MissingPlanYearParamsError extends Error {
  readonly planYear: number;
  constructor(planYear: number) {
    super(
      `planYearParams: no Part D constants for plan year ${planYear}. ` +
        `Add a PLAN_YEAR_PARAMS[${planYear}] entry in planYearParams.ts ` +
        `(packages/shared/src in robert9907/plan-match, api/library in ` +
        `robert9907/planmatch — the two copies are byte-identical, enforced ` +
        `by scripts/check-partd-drift.mjs, so land both in one commit). ` +
        `Required fields from the CMS ${planYear} Rate Announcement + IRA: ` +
        `partDDeductibleMax, troopCap, insulinMonthlyCap, vaccineMemberCost.`,
    );
    this.name = 'MissingPlanYearParamsError';
    this.planYear = planYear;
  }
}

export function getPlanYearParams(planYear: number): PlanYearParams {
  const params = PLAN_YEAR_PARAMS[planYear];
  if (!params) {
    throw new MissingPlanYearParamsError(planYear);
  }
  return params;
}
