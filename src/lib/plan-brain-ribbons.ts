// Plan Brain — ribbon assignment + display-text generation.
//
// After composite-score ranking, walk the top N plans and assign
// at-most-one ribbon per plan. Plan #1 always gets BEST_OVERALL. The
// remaining ribbons go to category leaders that aren't already the
// composite leader, so the user sees "this plan is great because…"
// for each card instead of three identical "best overall" badges.

import type { CsnpCondition } from './brain-foreign-types';
import type { BrainScoredPlan, RibbonType, RankPopulation } from './plan-brain-types';

const NEAR_TIE_EPS = 2; // composite-score points; a leader within 2pt
                        // of the next plan is "tied" → no exclusive ribbon.

// Drug-coverage gate for top-pick badges. A plan that covers fewer than
// half of the user's medications is not a "best" anything — extras can't
// compensate for missing meds. Plans without drugs (totalCount === 0) or
// users who entered no drugs trivially pass. See plan-brain.ts where the
// same threshold gates the diversified Top 4.
//
// 0 / N → hard fail (plan is dangerous to recommend).
// <50%  → soft fail (passes ranked[] but blocked from leader badges).
// ≥50%  → eligible for any badge.
const TOP_PICK_COVERAGE_FLOOR = 0.5;
function passesCoverageGate(plan: BrainScoredPlan): boolean {
  const total = plan.score.totalCount;
  if (total === 0) return true;
  return plan.score.coveredCount / total >= TOP_PICK_COVERAGE_FLOOR;
}

// Optional context passed in by plan-brain. The priority gate predicate
// is supplied when the user picked tiered priorities (dental / vision)
// and gates EVERY ribbon — including the cost-leader badges. A plan that
// fails the user's stated dental or vision threshold can't wear ANY
// ribbon, even if it's the cheapest plan in the county. The Wellcare
// Giveback Open bug (Apr 2026): $45 dental claimed "Lowest OOP" while
// the user had asked for $2,000+ dental. Cost-leader exemption was the
// hole; this gate closes it. Cascade fallback is the responsibility of
// the caller — when the strict pool is too small to produce a Top 3,
// the caller relaxes the predicate before invoking assignRibbons.
export interface RibbonContext {
  /** Returns true when the plan satisfies the user's tiered priorities
   *  (or the user didn't pick any). When omitted, every plan passes. */
  passesPriorityGates?: (plan: BrainScoredPlan) => boolean;
}

// Walk the ranked list and decorate each plan with at most one
// ribbon. Mutates plans in place (assigning into score.ribbon).
//
// Gating policy: every ribbon (BEST_OVERALL, LOWEST_DRUG_COST,
// LOWEST_OOP, BEST_EXTRAS) requires both the drug-coverage gate AND
// the user's stated priority gates. A plan that fails the user's
// dental/vision threshold cannot win ANY ribbon — the user told us
// those benefits matter and "lowest cost" with $45 dental when they
// asked for $2,000+ is not a recommendation, it's noise.
export function assignRibbons(ranked: BrainScoredPlan[], ctx?: RibbonContext): void {
  if (ranked.length === 0) return;
  const passesPriorities = ctx?.passesPriorityGates ?? (() => true);
  const passesAllGates = (p: BrainScoredPlan): boolean =>
    passesCoverageGate(p) && passesPriorities(p);

  // Plan #1 always BEST_OVERALL — must pass both gates. When the
  // composite leader fails, walk down the list to the first plan that
  // passes both, then to the first that at least covers half the
  // drugs, and finally fall back to the raw composite leader so a
  // sparse pool still produces a #1.
  const overallWinner =
    ranked.find(passesAllGates) ??
    ranked.find(passesCoverageGate) ??
    ranked[0];
  overallWinner.score.ribbon = 'BEST_OVERALL';

  // LOWEST_DRUG_COST — lowest totalAnnualDrugCost among plans that
  // pass both gates. A plan with 0 covered drugs can have an
  // artificially low totalAnnualDrugCost (uncovered drugs fall back
  // to a retail estimate that may be lower than a high-tier plan's
  // copay sum), so the coverage gate prevents that pathology from
  // claiming the badge. Priority gate keeps it honest with the
  // user's stated dental/vision minimums.
  //
  // Walk the sorted list to the first un-ribboned plan: if the drug
  // leader is also BEST_OVERALL we want the next-lowest-cost plan to
  // earn the badge, not silently lose it.
  const drugCandidates = [...ranked]
    .filter(passesAllGates)
    .sort((a, b) => a.score.totalAnnualDrugCost - b.score.totalAnnualDrugCost);
  const drugLeader = drugCandidates.find((p) => p.score.ribbon == null);
  if (drugLeader) {
    drugLeader.score.ribbon = 'LOWEST_DRUG_COST';
  }

  // LOWEST_OOP — lowest plan MOOP among plans passing both gates.
  // The badge means "lowest worst-case ceiling" — that's the number
  // Margaret cares about ($3,200 beats $8,500, period). When two
  // plans share the same MOOP, realAnnualCost (condition-aware
  // expected spend) breaks the tie. Plans with null MOOP sort last.
  // Same walk-down rule as LOWEST_DRUG_COST.
  const oopCandidates = [...ranked]
    .filter(passesAllGates)
    .sort((a, b) => {
      const aMoop = a.row.moop ?? Number.POSITIVE_INFINITY;
      const bMoop = b.row.moop ?? Number.POSITIVE_INFINITY;
      if (aMoop !== bMoop) return aMoop - bMoop;
      return a.score.realAnnualCost.netAnnual - b.score.realAnnualCost.netAnnual;
    });
  const oopLeader = oopCandidates.find((p) => p.score.ribbon == null);
  if (oopLeader) {
    oopLeader.score.ribbon = 'LOWEST_OOP';
  }

  // BEST_EXTRAS — highest extrasValueAnnual among plans passing both
  // gates. The Aetna Eagle Giveback bug (0/2 drugs covered winning
  // "BEST EXTRA BENEFITS" because the extras axis is drug-coverage
  // independent) is what the coverage gate is for; the priority gate
  // ensures a plan can't claim "best extras" while failing the
  // benefit category the user told us matters most.
  const extrasCandidates = [...ranked]
    .filter(passesAllGates)
    .sort((a, b) => b.score.extrasValueAnnual - a.score.extrasValueAnnual);
  const extrasLeader = extrasCandidates.find((p) => p.score.ribbon == null);
  if (extrasLeader) {
    extrasLeader.score.ribbon = 'BEST_EXTRAS';
  }

  // ALL_DOCS_IN_NETWORK — first top-5 plan with all providers covered
  // and not already ribboned. Honors the priority gate so a plan that
  // fails the user's dental/vision threshold can't bubble up via this
  // badge. Higher priority than the secondary category badges below.
  for (const plan of ranked.slice(0, 5)) {
    if (
      plan.score.ribbon == null &&
      passesAllGates(plan) &&
      plan.score.allProvidersInNetwork &&
      !plan.score.anyProviderOutOfNetwork
    ) {
      plan.score.ribbon = 'ALL_DOCS_IN_NETWORK';
      break;
    }
  }

  // Secondary badges — only fire for the Top 3 (composite ribbon
  // surface) and only when the plan still has no ribbon AND passes
  // the priority gate. Filler badges shouldn't be a back door for a
  // gate-rejected plan.
  //
  // ZERO_PREMIUM is informational, not differentiating: when every
  // peer in the surface set is already $0 premium, the badge tells the
  // user nothing the rest of the lineup doesn't. Worse, in $0-rich
  // pools (Durham: 34 of 46 plans filed $0) the badge surfaces low-
  // extras plans that only got picked because they were $0, dressing
  // them up as a feature. Skip the badge unless at least one peer plan
  // (in ranked.slice(0, 4) — the Top 4 surface) carries a non-$0
  // premium, in which case "this one's free" is real signal.
  const top4HasNonZeroPremium = ranked
    .slice(0, 4)
    .some((p) => (p.row.monthly_premium ?? 0) > 0);
  for (const plan of ranked.slice(0, 3)) {
    if (plan.score.ribbon != null) continue;
    if (!passesAllGates(plan)) continue;
    if (plan.score.coveredCount > 0 && plan.score.coveredCount === plan.score.totalCount) {
      plan.score.ribbon = 'ALL_MEDS_COVERED';
      continue;
    }
    if ((plan.row.monthly_premium ?? 0) === 0 && top4HasNonZeroPremium) {
      plan.score.ribbon = 'ZERO_PREMIUM';
      continue;
    }
    const partB = plan.benefits.find((b) => b.benefit_category === 'partb_giveback');
    if (partB && (partB.coverage_amount ?? partB.copay ?? 0) > 0) {
      plan.score.ribbon = 'PART_B_SAVINGS';
      continue;
    }
  }

  void NEAR_TIE_EPS; // reserved for future score-tie heuristics
}

// Display-text generator — turns RibbonType + context into the
// CMS-compliant scoped string the Top 3 card renders verbatim.
export function ribbonDisplayText(
  ribbon: RibbonType,
  population: RankPopulation,
  county: string | null,
  csnpConditions: ReadonlyArray<CsnpCondition> | undefined,
  providerCount: number,
): string {
  const inCounty = county ? `IN ${county.toUpperCase()} COUNTY` : 'IN YOUR AREA';
  switch (ribbon) {
    case 'BEST_OVERALL': {
      if (population === 'csnp') {
        const condition = primaryCondition(csnpConditions);
        return `★ BEST PLAN FOR YOUR ${condition.toUpperCase()} ${inCounty}`;
      }
      if (population === 'dsnp' || population === 'dsnp-unsure') {
        return `★ BEST DUAL-ELIGIBLE PLAN ${inCounty}`;
      }
      return `★ STRONGEST MATCH ${inCounty}`;
    }
    case 'LOWEST_DRUG_COST': return `LOWEST DRUG COST ${inCounty}`;
    case 'LOWEST_OOP': return `LOWEST OUT-OF-POCKET ${inCounty}`;
    case 'BEST_EXTRAS': return `BEST EXTRA BENEFITS ${inCounty}`;
    case 'PART_B_SAVINGS': return `PART B GIVEBACK ${inCounty}`;
    case 'ZERO_PREMIUM': return `$0 PREMIUM ${inCounty}`;
    case 'ALL_MEDS_COVERED': return `ALL YOUR MEDS COVERED ${inCounty}`;
    case 'ALL_DOCS_IN_NETWORK':
      return `ALL ${providerCount} DOCTOR${providerCount === 1 ? '' : 'S'} IN-NETWORK`;
  }
}

function primaryCondition(conditions: ReadonlyArray<CsnpCondition> | undefined): string {
  if (!conditions || conditions.length === 0) return 'condition';
  const c = conditions[0];
  switch (c) {
    case 'diabetes': return 'diabetes';
    case 'cardio': return 'heart condition';
    case 'copd': return 'COPD';
    case 'esrd': return 'kidney condition';
    default: return 'condition';
  }
}

// One-line "why" string surfaced under the ribbon on Top 3 cards.
// Picks the most distinctive fact about the plan based on which
// ribbon got assigned.
export function ribbonWhyText(plan: BrainScoredPlan): string {
  const s = plan.score;
  switch (s.ribbon) {
    case 'BEST_OVERALL':
    case 'LOWEST_DRUG_COST':
      if (s.coveredCount > 0 && s.totalCount > 0) {
        return `Covers ${s.coveredCount} of your ${s.totalCount} drugs — ${s.lowTierCount} at Tier 1–2. Estimated $${s.totalAnnualDrugCost.toLocaleString()}/yr in drug costs.`;
      }
      return `Estimated $${s.realAnnualCost.netAnnual.toLocaleString()}/yr total — premium, drugs, and expected medical costs.`;
    case 'LOWEST_OOP': {
      const moop = plan.row.moop;
      if (moop != null) {
        return `$${moop.toLocaleString()} max out-of-pocket — lowest worst-case medical ceiling among the plans we're showing you.`;
      }
      return `$${s.realAnnualCost.netAnnual.toLocaleString()}/yr expected — lowest combined premium, drugs, and condition-aware medical spend.`;
    }
    case 'BEST_EXTRAS':
      return `$${s.extrasValueAnnual.toLocaleString()}/yr in dental, vision, OTC, and other supplemental benefits.`;
    case 'PART_B_SAVINGS':
      return `Reduces your Medicare Part B premium each month.`;
    case 'ZERO_PREMIUM':
      return `$0/mo plan premium — pay only your Medicare Part B.`;
    case 'ALL_MEDS_COVERED':
      return `All ${s.totalCount} of your medications on this plan's formulary.`;
    case 'ALL_DOCS_IN_NETWORK':
      return `Every provider you added is in this plan's network.`;
    default:
      return '';
  }
}
