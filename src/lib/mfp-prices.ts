// CMS Medicare Drug Price Negotiation — Maximum Fair Prices (MFP), 30-day
// supply. Used ONLY as a cost FALLBACK: when pm_drug_cost_cache has no row
// for a (plan, drug), an IRA-negotiated drug is priced at its MFP (the
// negotiated ceiling) through partDTimeline with the plan's IRA cost-share,
// instead of the retail-notional tier price. This lands within ~5% of Plan
// Finder (vs ~+20% for retail) until the drug-cost scrape fills the cache
// with the plan's exact point-of-sale price.
//
// Sources (CMS announcements, public):
//   Round 1 — effective 2026-01-01 (announced 2024-08-15), 10 drugs.
//   Round 2 — effective 2027-01-01 (announced 2025), 15 drugs.
// Values are the published 30-day-supply MFP in dollars. These are a
// national ceiling, not a per-plan point-of-sale price (which includes
// dispensing fees and can differ a few %), hence FALLBACK-only.

export interface MfpDrug {
  /** Lowercase ingredient tokens to match against the drug's RxNorm name. */
  ingredients: readonly string[];
  /** Lowercase brand names (the `[Brand]` bracket) to match. */
  brands: readonly string[];
  /** Published MFP per 30-day supply (USD). */
  mfp: number;
  /** First plan year the MFP is in effect. */
  since: 2026 | 2027;
}

export const MFP_DRUGS: readonly MfpDrug[] = [
  // ── Round 1 (effective 2026) ──────────────────────────────────────
  { ingredients: ['apixaban'], brands: ['eliquis'], mfp: 231, since: 2026 },
  { ingredients: ['empagliflozin'], brands: ['jardiance'], mfp: 197, since: 2026 },
  { ingredients: ['rivaroxaban'], brands: ['xarelto'], mfp: 197, since: 2026 },
  { ingredients: ['sitagliptin'], brands: ['januvia'], mfp: 113, since: 2026 },
  { ingredients: ['dapagliflozin'], brands: ['farxiga'], mfp: 178.5, since: 2026 },
  { ingredients: ['sacubitril', 'valsartan'], brands: ['entresto'], mfp: 295, since: 2026 },
  { ingredients: ['etanercept'], brands: ['enbrel'], mfp: 2355, since: 2026 },
  { ingredients: ['ibrutinib'], brands: ['imbruvica'], mfp: 9319, since: 2026 },
  { ingredients: ['ustekinumab'], brands: ['stelara'], mfp: 4695, since: 2026 },
  { ingredients: ['insulin aspart'], brands: ['novolog', 'fiasp'], mfp: 119, since: 2026 },
  // ── Round 2 (effective 2027) ──────────────────────────────────────
  { ingredients: ['semaglutide'], brands: ['ozempic', 'rybelsus', 'wegovy'], mfp: 274, since: 2027 },
  { ingredients: ['fluticasone', 'umeclidinium', 'vilanterol'], brands: ['trelegy'], mfp: 175, since: 2027 },
  { ingredients: ['enzalutamide'], brands: ['xtandi'], mfp: 7004, since: 2027 },
  { ingredients: ['pomalidomide'], brands: ['pomalyst'], mfp: 8650, since: 2027 },
  { ingredients: ['palbociclib'], brands: ['ibrance'], mfp: 7871, since: 2027 },
  { ingredients: ['nintedanib'], brands: ['ofev'], mfp: 6350, since: 2027 },
  { ingredients: ['linaclotide'], brands: ['linzess'], mfp: 136, since: 2027 },
  { ingredients: ['acalabrutinib'], brands: ['calquence'], mfp: 8600, since: 2027 },
  { ingredients: ['deutetrabenazine'], brands: ['austedo'], mfp: 4093, since: 2027 },
  { ingredients: ['fluticasone', 'vilanterol'], brands: ['breo'], mfp: 67, since: 2027 },
  { ingredients: ['linagliptin'], brands: ['tradjenta'], mfp: 78, since: 2027 },
  { ingredients: ['rifaximin'], brands: ['xifaxan'], mfp: 1000, since: 2027 },
  { ingredients: ['cariprazine'], brands: ['vraylar'], mfp: 770, since: 2027 },
  { ingredients: ['sitagliptin', 'metformin'], brands: ['janumet'], mfp: 80, since: 2027 },
  { ingredients: ['apremilast'], brands: ['otezla'], mfp: 1650, since: 2027 },
];

// Build a fast lookup. Combination products (Entresto, Trelegy, Breo,
// Janumet) are matched BRAND-first, since their ingredient set overlaps
// single-ingredient negotiated drugs (e.g. Janumet contains sitagliptin +
// metformin; sitagliptin alone is Januvia). Brand bracket always wins.
const BY_BRAND = new Map<string, MfpDrug>();
for (const d of MFP_DRUGS) for (const b of d.brands) BY_BRAND.set(b, d);

/**
 * Return the MFP (30-day) for a drug by its RxNorm name, or null when the
 * drug is not an IRA-negotiated drug in effect for `planYear`. Brand bracket
 * (`[Eliquis]`) is matched first; otherwise falls back to a whole-word
 * ingredient match. `planYear` gates Round 2 drugs out of a 2026 quote.
 */
export function mfpForDrug(name: string | null | undefined, planYear: number): number | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  const brandMatch = lower.match(/\[([^\]]+)\]/);
  if (brandMatch) {
    const hit = BY_BRAND.get(brandMatch[1].trim());
    if (hit && planYear >= hit.since) return hit.mfp;
    // A recognised brand that isn't negotiated (or not yet in effect) is
    // NOT a negotiated drug — don't fall through to ingredient matching
    // and mis-price a different brand of the same molecule.
    if (hit) return null;
  }
  for (const d of MFP_DRUGS) {
    if (planYear < d.since) continue;
    // Every ingredient token must appear as a whole word (handles combos).
    if (d.ingredients.every((ing) => new RegExp(`\\b${ing}\\b`).test(lower))) {
      return d.mfp;
    }
  }
  return null;
}
