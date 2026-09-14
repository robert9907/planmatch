// scripts/_lib/dsnp-populations.ts
//
// The Partial-Dual → accepted-populations mapping, and the inversion
// detector built on it. Pure; no database, no spreadsheet.
//
// THE BUG THIS EXISTS FOR
//
// CMS files a coarse two-value "Partial Dual" flag per D-SNP. Its
// semantic is easy to read backwards, and it WAS read backwards until
// 2026-08-12:
//
//   "No"  = the plan is NOT restricted to partial duals — it accepts
//           ALL dual subtypes. The permissive case.
//   "Yes" = the plan enrols PARTIAL DUALS ONLY. The restrictive case.
//
// The pre-fix importer mapped "No" to the restrictive three-population
// set and "Yes" to the permissive seven. That is the inversion. It ran
// for roughly a month before anyone noticed, because nothing compared
// the result back against CMS.
//
// What an inversion does to a beneficiary: a full-benefit dual (FBDE)
// or QMB is told a plan will not take them when it will, and a
// partial-dual is shown plans they cannot actually enrol in. Both
// directions are wrong at the point where someone picks a plan.
//
// Keep these two sets in step with runFoodClassifierPass's siblings in
// scripts/import-snp-comprehensive-report.ts — that importer WRITES the
// column, this library CHECKS it, and they are deliberately independent
// so a single edit cannot move both.

/** All seven CMS-defined D-SNP populations. Partial Dual = "No". */
export const POPS_ALL_DUALS = ['FBDE', 'QMB+', 'QMB', 'SLMB+', 'SLMB', 'QI', 'QDWI'] as const;

/** Partial-dual populations only. Partial Dual = "Yes". */
export const POPS_PARTIAL_ONLY = ['SLMB', 'QDWI', 'QI'] as const;

export type PartialDualFlag = 'Yes' | 'No';

/** Normalise CMS's flag. Anything else is null — never guessed. */
export function parsePartialDual(raw: unknown): PartialDualFlag | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'yes') return 'Yes';
  if (s === 'no') return 'No';
  return null;
}

/**
 * The population set CMS's flag implies.
 *
 * Note the direction, since it is the whole point: "No" is the
 * PERMISSIVE answer and yields the LARGER set.
 */
export function expectedPopulations(flag: PartialDualFlag): readonly string[] {
  return flag === 'Yes' ? POPS_PARTIAL_ONLY : POPS_ALL_DUALS;
}

/** Order-insensitive set comparison — pm_plans stores a Postgres array
 *  whose order is the importer's display order, not a guarantee. */
export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every((x) => bs.has(x));
}

export interface PlanPopulationCheck {
  key: string;
  flag: PartialDualFlag;
  stored: readonly string[];
  expected: readonly string[];
  ok: boolean;
  /** True when this row holds exactly the set the OPPOSITE flag implies. */
  inverted: boolean;
}

export function checkPlan(
  key: string,
  flag: PartialDualFlag,
  stored: readonly string[],
): PlanPopulationCheck {
  const expected = expectedPopulations(flag);
  const opposite = expectedPopulations(flag === 'Yes' ? 'No' : 'Yes');
  const ok = sameSet(stored, expected);
  return { key, flag, stored, expected, ok, inverted: !ok && sameSet(stored, opposite) };
}

/**
 * Classify a whole run.
 *
 * A per-plan diff already catches the inversion — every row mismatches —
 * but it reports it as hundreds of unrelated failures. Naming the
 * pattern turns that into one sentence, which is the difference between
 * a five-minute diagnosis and an afternoon.
 */
export function summarise(checks: readonly PlanPopulationCheck[]): {
  total: number;
  failed: number;
  inverted: number;
  wholesaleInversion: boolean;
} {
  const failed = checks.filter((c) => !c.ok);
  const inverted = failed.filter((c) => c.inverted);
  return {
    total: checks.length,
    failed: failed.length,
    inverted: inverted.length,
    // Every failure is a clean swap, and there is at least one of each
    // flag among them — the signature of the July bug rather than a
    // handful of per-plan divergences.
    wholesaleInversion:
      failed.length > 0 &&
      inverted.length === failed.length &&
      new Set(inverted.map((c) => c.flag)).size === 2,
  };
}
