// searchDrug — pm_drugs-backed, mirroring useDrugSearch but as an
// async function so the imperative callers (useResolveRxcuis backfill,
// Step3Medications + v4 MedsPage autocompletes) can drop in. Replaces
// the old /api/rxnorm-search proxy that fanned out to RxNav's
// approximateTerm + drugs.json endpoints — that path returned silently
// empty for "Synthroid", "Losartan", "Simvastatin" etc. when the
// formulary-coverage rerank probe stalled, leaving CRM-hydrated meds
// stuck on a "No RxNorm match" badge for the rest of the broker session.
//
// pm_drugs is populated monthly by scripts/import-rxnorm.ts (RxNorm
// Prescribable Content, ~15-25k rows) on plan-match-prod. search_text
// is a generated column: lower(name || ' ' || coalesce(generic_name,'')
// || ' ' || coalesce(brand_name,'')) with a gin_trgm_ops index, so
// ilike scans are O(log n) and never silently empty for common drugs.

import { supabaseBrowser } from './supabaseBrowser';

export interface RxNormDrug {
  rxcui: string;
  name: string;
  synonym?: string;
  tty?: string;
  /** Parsed brand/strength/form fields. Used for the agent search row
   *  display: "Brand · strength · form" when brand_name is present,
   *  "generic · strength · form" otherwise. */
  brand_name?: string;
  generic_name?: string;
  strength?: string;
  dose_form?: string;
  is_brand?: boolean;
}

const MIN_CHARS = 2;
const FETCH_LIMIT = 25;
const DISPLAY_LIMIT = 6;

// Form ranking — lower = more common, surfaced first. Pre-fix
// Spironolactone alphabetized "5 MG/ML Oral Suspension" ahead of the
// 25/50/100 MG tablets; with this score, the tablet wins.
function formScore(form: string | null): number {
  if (!form) return 5;
  const f = form.trim();
  if (/^Oral Tablet$|^Oral Capsule$/i.test(f)) return 0;
  if (/Oral Tablet|Oral Capsule/i.test(f)) return 1; // ER/DR/etc tablet/capsule
  if (/Oral Solution|Oral Suspension/i.test(f)) return 3;
  if (/Injectable|Injector|Pen|Vial|Syringe|Inhaler|Patch/i.test(f)) return 4;
  return 5;
}

// Combo penalty — single-ingredient SCDs/SBDs surface ahead of combos
// when the user typed a single-ingredient query. Pre-fix
// "Hydrochlorothiazide" returned the HCTZ+triamterene combo first
// because of alphabetical sort.
function comboPenalty(name: string): number {
  return /\s\/\s|;\s|\s\+\s/.test(name) ? 2 : 0;
}

interface PmDrugRow {
  rxcui: string;
  name: string;
  generic_name: string | null;
  brand_name: string | null;
  strength: string | null;
  dose_form: string | null;
  is_brand: boolean | null;
}

export async function searchDrug(
  query: string,
  // Kept in the signature so existing Step3/v4 callers don't change.
  // supabase-js v2 doesn't expose AbortSignal pass-through on the query
  // builder; the calling effects already guard with `if (!signal.aborted)`
  // before applying results, so a no-op here is safe.
  _signal?: AbortSignal,
): Promise<RxNormDrug[]> {
  const q = query.trim();
  if (q.length < MIN_CHARS) return [];

  const supabase = supabaseBrowser();
  const { data, error } = await supabase
    .from('pm_drugs')
    .select('rxcui, name, generic_name, brand_name, strength, dose_form, is_brand')
    .ilike('search_text', `%${q.toLowerCase()}%`)
    .eq('is_prescribable', true)
    .limit(FETCH_LIMIT);
  if (error) throw new Error(`pm_drugs query failed — ${error.message}`);

  const qLower = q.toLowerCase();
  const ranked = ((data ?? []) as PmDrugRow[]).map((d) => {
    const displayName = d.brand_name || d.generic_name || d.name;
    return {
      d,
      displayName,
      startsRank: displayName.toLowerCase().startsWith(qLower) ? 0 : 1,
      combo: comboPenalty(d.name),
      form: formScore(d.dose_form),
    };
  });
  ranked.sort(
    (a, b) =>
      a.startsRank - b.startsRank ||
      a.combo - b.combo ||
      a.form - b.form ||
      a.displayName.localeCompare(b.displayName),
  );

  return ranked.slice(0, DISPLAY_LIMIT).map((r) => ({
    rxcui: r.d.rxcui,
    name: r.d.name,
    brand_name: r.d.brand_name ?? undefined,
    generic_name: r.d.generic_name ?? undefined,
    strength: r.d.strength ?? undefined,
    dose_form: r.d.dose_form ?? undefined,
    is_brand: r.d.is_brand ?? undefined,
  }));
}

/**
 * Display label for a search-result row. "Brand · Strength · Form"
 * when the concept carries a brand_name; otherwise
 * "generic · strength · form" with sensible fallbacks. Used by the
 * agent MedsPage search dropdown.
 */
export function displayLabel(d: RxNormDrug): string {
  const parts: string[] = [];
  if (d.brand_name) parts.push(d.brand_name);
  else if (d.generic_name) parts.push(d.generic_name);
  else parts.push(d.name);
  if (d.strength) parts.push(d.strength);
  if (d.dose_form) parts.push(d.dose_form);
  return parts.join(' · ');
}
