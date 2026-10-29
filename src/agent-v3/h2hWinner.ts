// Pure — no React, no path aliases — so tests can import it directly.

/** The two fields of a Plan the winner needs. */
export interface WinnerPlan {
  id: string;
  premium: number;
}

// ── Head to Head winner ─────────────────────────────────────────
//
// One winner, on the whole plan (Rob, 2026-10-28) — not a count of rows
// won (a Fitness row used to weigh the same as the MOOP).
//   1. Gates: a plan that leaves one of her drugs uncovered, or has one of
//      her doctors confirmed OUT of network, can't beat a plan that doesn't.
//      Unknown network status is not a failure (same rule as Gate 1).
//   2. Otherwise the lower whole-plan yearly cost wins — premium + drugs −
//      Part B giveback + the brain's expected medical copays from her usage
//      estimate (rank-plans total_annual_cost_with_medical). No tie window:
//      $5 or $3,000, the cheaper plan wins; an exact tie keeps the baseline.

export interface H2HWinner {
  winnerId: string;
  /** What the winner saves per year vs the other side; 0 when the winner
   *  costs the same or more (it won on a gate). */
  savings: number;
}

export function pickH2HWinner(args: {
  baseline: WinnerPlan;
  challenger: WinnerPlan;
  wholeCostByPlanId: Record<string, number>;
  annualDrugByPlanId: Record<string, number | null>;
  drugsCoveredByPlanId: Record<string, number>;
  drugsTotalByPlanId: Record<string, number>;
  providers: ReadonlyArray<{ networkStatus?: Record<string, string> | undefined }>;
}): H2HWinner {
  const { baseline, challenger } = args;
  const passesGates = (p: WinnerPlan): boolean => {
    const covered = args.drugsCoveredByPlanId[p.id];
    const total = args.drugsTotalByPlanId[p.id];
    if (covered != null && total != null && covered < total) return false;
    if (args.providers.some((pr) => pr.networkStatus?.[p.id] === 'out')) return false;
    return true;
  };
  // Both sides on the same cost basis: the whole-plan cost when rank-plans
  // has it for both, else premium + drugs for both.
  const haveWhole =
    args.wholeCostByPlanId[baseline.id] != null && args.wholeCostByPlanId[challenger.id] != null;
  const cost = (p: WinnerPlan): number =>
    haveWhole
      ? args.wholeCostByPlanId[p.id]
      : args.annualDrugByPlanId[p.id] != null
        ? p.premium * 12 + (args.annualDrugByPlanId[p.id] as number)
        : Number.POSITIVE_INFINITY;
  const bCost = cost(baseline);
  const cCost = cost(challenger);
  const bOk = passesGates(baseline);
  const cOk = passesGates(challenger);

  let winner: WinnerPlan;
  if (bOk !== cOk) winner = bOk ? baseline : challenger;
  else winner = cCost < bCost ? challenger : baseline;

  const loserCost = winner === baseline ? cCost : bCost;
  const winnerCost = winner === baseline ? bCost : cCost;
  const diff = loserCost - winnerCost;
  return {
    winnerId: winner.id,
    savings: Number.isFinite(diff) && diff > 0 ? Math.round(diff) : 0,
  };
}
