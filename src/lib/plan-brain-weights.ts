// plan-brain-weights — default weight profiles + redistribution rules.
//
// Drug / OOP / Extras weights sum to 1.0. Defaults differ by population
// because SNP populations care more about extras (transportation, OTC,
// dental) and less about drug optimization since their formularies are
// already tuned for the SNP cohort.

import type { Population, WeightProfile } from './plan-brain-types';

const PROFILES: Record<Population, WeightProfile> = {
  mapd: { drug: 0.5, oop: 0.3, extras: 0.2 },
  csnp: { drug: 0.4, oop: 0.25, extras: 0.35 },
  dsnp: { drug: 0.35, oop: 0.25, extras: 0.4 },
};

export function defaultWeights(population: Population): WeightProfile {
  return { ...PROFILES[population] };
}

// When the user has zero medications the drug axis is meaningless —
// redistribute its weight to OOP (70%) and extras (30%) so the
// composite still discriminates between plans. Per spec.
export function redistributeForNoMeds(weights: WeightProfile): WeightProfile {
  const drugSlice = weights.drug;
  return {
    drug: 0,
    oop: weights.oop + drugSlice * 0.7,
    extras: weights.extras + drugSlice * 0.3,
  };
}

// Allow callers to tweak individual axes (e.g. UI weight sliders) while
// keeping the sum at 1.0 — proportionally rescale the untouched axes.
export function applyOverride(
  base: WeightProfile,
  override: Partial<WeightProfile> | null | undefined,
): WeightProfile {
  if (!override) return base;
  const next: WeightProfile = { ...base, ...override };
  const sum = next.drug + next.oop + next.extras;
  if (sum <= 0) return base;
  return {
    drug: next.drug / sum,
    oop: next.oop / sum,
    extras: next.extras / sum,
  };
}
