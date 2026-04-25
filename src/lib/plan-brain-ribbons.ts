// plan-brain-ribbons — assigns at most one ribbon per plan.
//
// Rank 1 (highest composite) always gets BEST_OVERALL.  Each subsequent
// plan can claim at most one of the remaining ribbon slots, in priority
// order. A ribbon is only awarded if the candidate genuinely earned it
// (e.g. ZERO_PREMIUM only for $0/mo plans, ALL_DOCS_IN_NETWORK only
// when every selected provider is in-network).

import type { ScoredPlan, RibbonKey } from './plan-brain-types';

const RUNNERUP_PRIORITY: RibbonKey[] = [
  'LOWEST_DRUG_COST',
  'LOWEST_OOP',
  'BEST_EXTRAS',
  'ALL_DOCS_IN_NETWORK',
  'ALL_MEDS_COVERED',
  'PART_B_SAVINGS',
  'ZERO_PREMIUM',
];

export function assignRibbons(scored: ScoredPlan[]): void {
  if (scored.length === 0) return;

  // Step 1 — rank 1 gets BEST_OVERALL outright.
  scored[0].ribbon = 'BEST_OVERALL';

  // Step 2 — pre-compute who's "best" at each axis so we can hand out
  // the runner-up ribbons to the actual leaders, not just rank 2/3.
  // Lookups by triple id so re-sorts don't break this.
  const byKey: Record<RibbonKey, string | null> = {
    BEST_OVERALL: scored[0].plan.id,
    LOWEST_DRUG_COST: pickBestId(scored, (p) => p.totalAnnualDrugCost, true),
    LOWEST_OOP: pickBestId(scored, (p) => p.totalOOPEstimate, true),
    BEST_EXTRAS: pickBestId(scored, (p) => p.extrasValue, false),
    ALL_DOCS_IN_NETWORK: pickFirst(
      scored,
      (p) => p.providerNetworkStatus === 'all_in',
    ),
    ALL_MEDS_COVERED: pickFirst(
      scored,
      (p) => p.uncoveredDrugRxcuis.length === 0,
    ),
    PART_B_SAVINGS: pickFirst(scored, (p) => (p.plan.part_b_giveback ?? 0) > 0),
    ZERO_PREMIUM: pickFirst(scored, (p) => p.plan.premium === 0),
  };

  // Step 3 — walk runners-up in rank order, giving each the highest-
  // priority ribbon they qualify for and that hasn't been taken.
  const claimed = new Set<RibbonKey>(['BEST_OVERALL']);
  for (let i = 1; i < scored.length; i++) {
    const plan = scored[i];
    if (plan.ribbon) continue;
    for (const ribbon of RUNNERUP_PRIORITY) {
      if (claimed.has(ribbon)) continue;
      if (byKey[ribbon] !== plan.plan.id) continue;
      plan.ribbon = ribbon;
      claimed.add(ribbon);
      break;
    }
  }
}

// Returns the plan id with the lowest (or highest) value of `getter`.
// Skips plans where the value is non-finite so a single missing data
// point doesn't make the leader undefined.
function pickBestId(
  scored: ScoredPlan[],
  getter: (p: ScoredPlan) => number,
  lowIsBetter: boolean,
): string | null {
  let bestId: string | null = null;
  let bestVal = lowIsBetter ? Infinity : -Infinity;
  for (const p of scored) {
    const v = getter(p);
    if (!Number.isFinite(v)) continue;
    if (lowIsBetter ? v < bestVal : v > bestVal) {
      bestVal = v;
      bestId = p.plan.id;
    }
  }
  return bestId;
}

function pickFirst(
  scored: ScoredPlan[],
  predicate: (p: ScoredPlan) => boolean,
): string | null {
  for (const p of scored) if (predicate(p)) return p.plan.id;
  return null;
}

// Badge/headline text for the BEST_OVERALL ribbon — population-aware
// copy per spec. Other ribbons just render their key.
export function bestOverallText(
  population: 'mapd' | 'csnp' | 'dsnp',
  county: string,
  conditionLabel?: string,
): string {
  const where = county ? ` in ${county}` : '';
  if (population === 'csnp') {
    const cond = conditionLabel ? ` ${conditionLabel}` : '';
    return `Best plan for your${cond} care${where}`.trim();
  }
  if (population === 'dsnp') return `Best dual-eligible plan${where}`.trim();
  return `Strongest match${where}`.trim();
}
