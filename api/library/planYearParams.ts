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
};

export function getPlanYearParams(planYear: number): PlanYearParams {
  const params = PLAN_YEAR_PARAMS[planYear];
  if (!params) {
    throw new Error(
      `planYearParams: no entry for ${planYear} — add one to PLAN_YEAR_PARAMS`,
    );
  }
  return params;
}
