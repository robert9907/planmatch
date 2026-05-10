// Plan Brain — default weight profiles per population.
//
// The three axes are (in order): drug cost, OOP cost, extras value.
// The weights below sum to 1.0 within each profile. Adjust here to
// shift the Brain's preference globally; for per-session overrides
// the agent dashboard will pass weightsOverride through BrainInputs.
//
// Per Rob's spec:
//   Standard MAPD : 50/30/20 — drugs dominate; most non-SNP seniors
//                              are healthy enough that OOP differences
//                              are small year-over-year, and extras
//                              are nice-to-have not load-bearing.
//   C-SNP         : 40/25/35 — extras matter more (food card,
//                              diabetic supplies, meal benefit) for
//                              chronic-condition populations whose
//                              drug regimens are similar across plans.
//   D-SNP         : 35/25/40 — extras dominate. Medicaid covers most
//                              copays for duals so OOP signal is
//                              weaker; transportation/OTC/food are
//                              lifeline benefits.

import type { BrainWeights, RankPopulation } from './plan-brain-types';

export const WEIGHTS_STANDARD: BrainWeights = { drug: 0.50, oop: 0.30, extras: 0.20 };
export const WEIGHTS_CSNP: BrainWeights = { drug: 0.40, oop: 0.25, extras: 0.35 };
export const WEIGHTS_DSNP: BrainWeights = { drug: 0.35, oop: 0.25, extras: 0.40 };
// Healthy client — fewer than 3 meds, no chronic condition, no SNP.
// They won't hit MOOP, so OOP differences between plans are tiny;
// the Part B giveback is their biggest dollar lever. Bumping extras
// (which the giveback boost rides through composite scoring) makes
// giveback plans surface organically in Top 3.
export const WEIGHTS_HEALTHY: BrainWeights = { drug: 0.40, oop: 0.20, extras: 0.40 };

export function defaultWeightsFor(pop: RankPopulation): BrainWeights {
  if (pop === 'csnp') return WEIGHTS_CSNP;
  if (pop === 'dsnp' || pop === 'dsnp-unsure') return WEIGHTS_DSNP;
  return WEIGHTS_STANDARD;
}

// When the user enters NO drugs the drug axis is meaningless. We
// redistribute its mass to OOP (70%) and extras (30%) per spec.
export function noDrugsRedistribution(base: BrainWeights): BrainWeights {
  const carryover = base.drug;
  return {
    drug: 0,
    oop: base.oop + carryover * 0.7,
    extras: base.extras + carryover * 0.3,
  };
}
