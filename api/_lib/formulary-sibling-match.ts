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
  /** Brand name from the RxNorm `[Brand]` bracket, normalized lowercase
   *  (e.g. "ozempic", "xarelto"). null for generic rows. Used to enforce
   *  brand exactness: a brand request must never match a DIFFERENT brand of
   *  the same molecule (Ozempic → never Wegovy). */
  brandName: string | null;
  er: boolean;
  form: 'tablet' | 'capsule' | 'solution' | 'injection' | 'patch' | 'inhaler' | 'other' | null;
  /** Non-systemic route of administration. null = oral / injected /
   *  transdermal. undefined = the request's name is unknown, so route is
   *  not enforced. A sibling never crosses a known route — see rule 1c. */
  route?: DrugRoute | null;
  strengths: string[]; // normalized, e.g. ["600 MG"], ["50 MG/ML"]
}

export type DrugRoute = 'ophthalmic' | 'otic' | 'nasal' | 'inhaled' | 'vaginal' | 'rectal' | 'topical';

export function parseDrugRoute(name: string | null | undefined): DrugRoute | null {
  const l = (name ?? '').toLowerCase();
  if (/ophthalmic|\beye drops?\b/.test(l)) return 'ophthalmic';
  if (/\botic\b/.test(l)) return 'otic';
  if (/\bnasal\b/.test(l)) return 'nasal';
  if (/\binhaler\b|\binhalation\b|\bnebuliz/.test(l)) return 'inhaled';
  if (/\bvaginal\b/.test(l)) return 'vaginal';
  if (/\brectal\b|\bsuppository\b/.test(l)) return 'rectal';
  if (/\btopical\b|\bointment\b|\bcream\b|\blotion\b|\bshampoo\b|\bfoam\b|\bgel\b/.test(l)) return 'topical';
  return null;
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
    let unit = m[2].toUpperCase();
    let value = Number(m[1]);
    // 50 MCG and 0.05 MG are the same strength — normalize MCG to MG.
    if (unit === 'MCG') {
      unit = 'MG';
      value = Number((value / 1000).toPrecision(12));
    }
    const perMl = m[3] ? '/ML' : '';
    out.push(`${value} ${unit}${perMl}`);
  }
  return out;
}

export function parseDrugProfile(name: string | null | undefined): DrugProfile {
  const n = (name ?? '').trim();
  const lower = n.toLowerCase();
  const form: DrugProfile['form'] =
    // Nebulizer "Inhalation Solution"/"Inhalation Suspension" is a solution
    // first — it must NOT fold into the aerosol/powder inhaler bucket below
    // (an HFA request is not a nebule, and vice versa).
    /oral solution|\bsolution\b|oral suspension|\bsuspension\b|\belixir\b|\bsyrup\b/.test(lower) ? 'solution'
    // Metered-dose / dry-powder / soft-mist inhalers (HFA, Ellipta, Respimat,
    // Diskus, Flexhaler, HandiHaler, …). "Inhalation Powder/Aerosol/Spray" and
    // "Metered/Dry… Inhaler" land here; nebulizer solutions were caught above.
    : /metered dose inhaler|dry powder inhaler|breath activated|\binhaler\b|inhalation (?:spray|aerosol|powder)|\baerosol\b|\bhfa\b|\brespimat\b|\bellipta\b|\bdiskus\b|flexhaler|handihaler|twisthaler|neohaler|respiclick|digihaler/.test(lower) ? 'inhaler'
    : /injection|injectable|\bprefilled\b|\bpen\b|\bvial\b|\bcartridge\b|flextouch|flexpen|solostar/.test(lower) ? 'injection'
    : /\bpatch\b|transdermal/.test(lower) ? 'patch'
    : /\bcapsule\b/.test(lower) ? 'capsule'
    : /\btablet\b/.test(lower) ? 'tablet'
    : null;
  const brandMatch = n.match(/\[([^\]]+)\]/);
  return {
    combo: isComboName(n),
    brand: brandMatch != null,
    brandName: brandMatch ? brandMatch[1].trim().toLowerCase() : null,
    er: /extended release|extended-release|24 hr|12 hr|\ber\b|\bxr\b|\bsr\b|modified .*release|once-daily/i.test(n),
    form,
    route: parseDrugRoute(n),
    strengths: normStrengths(n),
  };
}

// Score a candidate row against the user's drug profile. Higher = better.
// Returns null when the row must be excluded (combo vs single-ingredient).
function scoreRow(orig: DrugProfile, rowName: string): { score: number; strengthHit: boolean; formHit: boolean } | null {
  const rp = parseDrugProfile(rowName);
  if (rp.combo && !orig.combo) return null; // rule 1 — never match a combo
  // Rule 1c (Rob, 2026-10-20) — never cross route. An inhaler is not a nasal
  // spray or an ointment; a tablet is not a cream. A plan that files the
  // ingredient only in another route shows the requested drug NOT COVERED.
  if (orig.route !== undefined && orig.route !== rp.route) return null;
  // Rule 1b (Rob, 2026-10-19) — brand exactness. A brand request must never
  // resolve to a DIFFERENT brand of the same molecule (Ozempic → never
  // Wegovy, NovoLog → never Fiasp). A plan that files only another brand /
  // the generic shows the requested brand NOT COVERED as entered — we do not
  // substitute. Exact rxcui still wins in pickBestFormularyRow before scoring.
  // (Same-brand form siblings at the SAME strength are kept — rule 1d.) Only applies when we know
  // the requested brand name; a generic request is unaffected.
  // Brand ≠ generic for coverage (Rob — symmetric rule, mirrors consumer).
  if (orig.brand) {
    if (!rp.brand) return null; // a generic row is not "that brand"
    if (orig.brandName && rp.brandName && rp.brandName !== orig.brandName) return null; // different brand
  } else if (rp.brand) {
    return null; // generic request: a brand row is not the entered generic
  }
  let score = 0;
  // Strength — the strongest discriminator (600 MG tablet vs 50 MG/ML solution).
  const strengthHit = orig.strengths.length === 0 || orig.strengths.every((s) => rp.strengths.includes(s));
  // Rule 1d (Rob, 2026-10-20) — a different strength is a different drug.
  // When the request carries a strength, a sibling at another strength is
  // excluded: the plan shows NOT COVERED rather than pricing the 220 mcg
  // inhaler for someone on 50 mcg. Exact rxcui still wins before scoring.
  if (!strengthHit) return null;
  score += 1000;
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
