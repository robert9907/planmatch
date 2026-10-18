// Sibling-pick for RxNav-expanded formulary matching.
//
// api/plan-brain-data expands the user's rxcui to its RxNorm siblings and
// queries pm_formulary for any of them. When the user's EXACT rxcui isn't on
// a plan's formulary, several siblings may be present at different tiers — the
// old "first row wins" indexer picked an arbitrary one, so a tier-4 oral
// SOLUTION could beat the tier-2 TABLET the user actually takes, or a tier-3
// COMBINATION product (Janumet) could answer a plain-metformin request.
//
// Rules (Rob, 2026-10-18):
//   1. A combination product is NEVER a match for a single-ingredient request.
//      A plan that files ONLY the combo shows the requested drug NOT COVERED.
//   2. Among remaining siblings, pick the one whose strength + dose form
//      (tablet vs solution, ER vs IR) + brand/generic best match the user's
//      drug. Generic request → generic row; brand request → brand row.
//   3. If no sibling matches the dose form, fall back to the same ingredient +
//      strength in the closest oral SOLID form (tablet > capsule), and flag it.
//   4. Exact rxcui always wins outright.

export interface DrugProfile {
  combo: boolean;
  brand: boolean;
  er: boolean;
  form: 'tablet' | 'capsule' | 'solution' | 'injection' | 'patch' | 'other' | null;
  strengths: string[]; // normalized, e.g. ["600 MG"], ["50 MG/ML"]
}

export interface FormularyRowLike {
  rxcui: string;
  drug_name: string | null;
  tier: number | null;
}

// A combination product name separates ingredients with " / " (space slash
// space). Note "50 MG/ML" is a ratio, NOT a combo — no surrounding spaces.
export function isComboName(name: string | null | undefined): boolean {
  return typeof name === 'string' && / \/ /.test(name);
}

function normStrengths(name: string): string[] {
  const out: string[] = [];
  const re = /(\d+(?:\.\d+)?)\s*(MG|MCG|ML|UNT|%)(\s*\/\s*ML)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(name)) !== null) {
    const unit = m[2].toUpperCase();
    const perMl = m[3] ? '/ML' : '';
    out.push(`${m[1]} ${unit}${perMl}`);
  }
  return out;
}

export function parseDrugProfile(name: string | null | undefined): DrugProfile {
  const n = (name ?? '').trim();
  const lower = n.toLowerCase();
  const form: DrugProfile['form'] =
    /oral solution|\bsolution\b|oral suspension|\bsuspension\b|\belixir\b|\bsyrup\b/.test(lower) ? 'solution'
    : /injection|injectable|\bprefilled\b|\bpen\b|\bvial\b|\bcartridge\b|flextouch|flexpen|solostar/.test(lower) ? 'injection'
    : /\bpatch\b|transdermal/.test(lower) ? 'patch'
    : /\bcapsule\b/.test(lower) ? 'capsule'
    : /\btablet\b/.test(lower) ? 'tablet'
    : null;
  return {
    combo: isComboName(n),
    brand: /\[[^\]]+\]/.test(n),
    er: /extended release|extended-release|24 hr|12 hr|\ber\b|\bxr\b|\bsr\b|modified .*release|once-daily/i.test(n),
    form,
    strengths: normStrengths(n),
  };
}

// Score a candidate row against the user's drug profile. Higher = better.
// Returns null when the row must be excluded (combo vs single-ingredient).
function scoreRow(orig: DrugProfile, rowName: string): { score: number; strengthHit: boolean; formHit: boolean } | null {
  const rp = parseDrugProfile(rowName);
  if (rp.combo && !orig.combo) return null; // rule 1 — never match a combo
  let score = 0;
  // Strength — the strongest discriminator (600 MG tablet vs 50 MG/ML solution).
  const strengthHit = orig.strengths.length === 0 || orig.strengths.every((s) => rp.strengths.includes(s));
  if (strengthHit) score += 1000;
  // Dose form.
  let formHit = false;
  if (orig.form) {
    if (orig.form === rp.form) { score += 100; formHit = true; }
  } else {
    // No form on the request (SCDC) → prefer oral SOLID (rule 3 fallback order).
    if (rp.form === 'tablet') { score += 40; formHit = true; }
    else if (rp.form === 'capsule') { score += 30; formHit = true; }
    else if (rp.form === 'solution') score += 5;
    // injection/patch score 0 for an oral request
  }
  // ER vs IR — only when the request specifies ER.
  if (orig.er) { if (rp.er) score += 50; } else { if (!rp.er) score += 10; }
  // Brand / generic parity.
  if (orig.brand === rp.brand) score += 20; else if (orig.brand && !rp.brand) score -= 5;
  return { score, strengthHit, formHit };
}

export interface PickResult<T extends FormularyRowLike = FormularyRowLike> {
  row: T | null;
  fallback: boolean; // true when matched on ingredient+strength but NOT dose form
  excludedCombos: number;
}

/**
 * Pick the single best formulary row for the user's drug from the set of
 * expansion-sibling rows the plan files. `origRxcui` is the user's searched
 * rxcui; `origProfile` its parsed profile; `rows` the plan's rows whose rxcui
 * is in the expansion of origRxcui.
 */
export function pickBestFormularyRow<T extends FormularyRowLike>(
  origRxcui: string,
  origProfile: DrugProfile,
  rows: T[],
): PickResult<T> {
  // Rule 4 — exact rxcui wins outright.
  const exact = rows.find((r) => r.rxcui === origRxcui);
  if (exact) return { row: exact, fallback: false, excludedCombos: 0 };

  let excludedCombos = 0;
  let best: T | null = null;
  let bestScore = -Infinity;
  let bestStrengthHit = false;
  let bestFormHit = false;
  for (const r of rows) {
    const sc = scoreRow(origProfile, r.drug_name ?? '');
    if (sc === null) { excludedCombos++; continue; }
    const tier = r.tier ?? 99;
    const bestTier = best?.tier ?? 99;
    // Higher score wins; tie-break on lower tier.
    if (sc.score > bestScore || (sc.score === bestScore && tier < bestTier)) {
      best = r; bestScore = sc.score; bestStrengthHit = sc.strengthHit; bestFormHit = sc.formHit;
    }
  }
  if (!best) return { row: null, fallback: false, excludedCombos }; // only combos existed → NOT COVERED
  // Fallback = we matched ingredient (+ usually strength) but not the dose form.
  const fallback = bestStrengthHit && !bestFormHit;
  return { row: best, fallback, excludedCombos };
}
