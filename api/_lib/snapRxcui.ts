// Snap Link RxCUI resolver.
//
// A Snap capture only gives us the free text printed on a pill-bottle
// label ("Gabapentin", "300mg", "capsule"). Without an RxCUI the
// AgentBase client card shows "NO CODE · PICK DRUG" and Plan Match
// can't price the drug, so the broker had to hand-pick every Snap row.
//
// This resolves the label to an RxCUI using the same plan-match-prod
// `drug_match_candidates` RPC that AgentBase's picker uses — but only
// when the answer is unambiguous. Anything uncertain stays null and the
// broker picks by hand, exactly as before. The row is still written
// UNVERIFIED, so the tap-to-confirm step is unchanged.
//
// "Unambiguous" means ALL of:
//   1. The candidate is match_rank 1 (strength + form + release match).
//   2. Every ingredient word in the candidate (e.g. "tartrate",
//      "succinate", "enacarbil") also appears on the label, and so does
//      any release marker (ER / 24 HR). This is the metoprolol guard: a
//      bare "Metoprolol 25mg" label must NOT resolve to tartrate.
//   3. If the label names a dose form (capsule / tablet / …), the
//      candidate's dose form contains it.
//   4. Exactly one candidate survives — preferring the brand row only
//      when the label itself names that brand, otherwise the generic.

import type { SupabaseClient } from '@supabase/supabase-js';

interface Candidate {
  rxcui: string;
  drug_name: string;
  generic_name: string | null;
  strength: string | null;
  dose_form: string | null;
  is_brand: boolean;
  match_rank: number;
}

export interface LabelDrug {
  name: string;
  dose?: string | null;
  form?: string | null;
}

const RELEASE_RE = /\b(er|xr|xl|sr|cr|dr|la|ec|24\s*hr|12\s*hr|extended|delayed|sustained|controlled)\b/i;

function words(s: string): string[] {
  return s.toLowerCase().match(/[a-z]+/g) ?? [];
}

// Ingredient words of a candidate: drug_name minus the strength, units,
// dose form, release markers and the [Brand] bracket.
const NON_INGREDIENT = new Set([
  'mg', 'mcg', 'ml', 'g', 'unt', 'unit', 'units', 'hr', 'meq', 'actuat',
  'oral', 'tablet', 'tablets', 'capsule', 'capsules', 'solution', 'suspension',
  'injection', 'injectable', 'prefilled', 'syringe', 'pen', 'chewable',
  'disintegrating', 'topical', 'cream', 'ointment', 'gel', 'patch', 'transdermal',
  'inhaler', 'inhalation', 'powder', 'spray', 'nasal', 'ophthalmic', 'drops',
  'extended', 'release', 'delayed', 'sustained', 'controlled', 'film', 'coated',
  'metered', 'dose', 'for', 'auto', 'injector', 'cartridge', 'vial', 'kit', 'pack',
  'er', 'xr', 'xl', 'sr', 'cr', 'dr', 'ec', 'la', 'and',
  // Salts that never change which drug it is and that pharmacy labels
  // routinely drop ("Metformin 500mg" = metformin hydrochloride).
  // Clinically distinct salts (tartrate vs succinate) are NOT here.
  'hydrochloride', 'hcl', 'sodium', 'potassium',
]);

function ingredientWords(drugName: string): string[] {
  const noBrand = drugName.replace(/\[[^\]]*\]/g, ' ');
  return words(noBrand).filter((w) => !NON_INGREDIENT.has(w));
}

function brandOf(drugName: string): string | null {
  const m = drugName.match(/\[([^\]]+)\]/);
  return m ? m[1].toLowerCase() : null;
}

const FORM_WORDS = ['capsule', 'tablet', 'solution', 'suspension', 'injection', 'cream', 'ointment', 'patch', 'inhaler', 'spray', 'drops', 'gel'];

function labelForm(label: string): string | null {
  const l = label.toLowerCase();
  for (const f of FORM_WORDS) if (l.includes(f)) return f;
  if (/\bcap(s)?\b/.test(l)) return 'capsule';
  if (/\btab(s)?\b/.test(l)) return 'tablet';
  if (/\bliquid\b/.test(l)) return 'solution|suspension';
  return null;
}

export function pickUnambiguous(label: LabelDrug, candidates: Candidate[]): Candidate | null {
  const labelText = [label.name, label.dose, label.form].filter(Boolean).join(' ');
  const labelWords = new Set(words(labelText));
  const labelHasRelease = RELEASE_RE.test(labelText);
  const form = labelForm(labelText);

  const survivors = candidates.filter((c) => {
    if (c.match_rank !== 1) return false;
    const brand = brandOf(c.drug_name);
    const brandOnLabel = !!brand && words(brand).every((w) => labelWords.has(w));
    // Ingredient words must all be on the label — unless the label names
    // this candidate's brand (a "Lipitor" bottle never says atorvastatin).
    if (!brandOnLabel) {
      const ing = ingredientWords(c.drug_name);
      if (ing.length === 0 || !ing.every((w) => labelWords.has(w))) return false;
    }
    // Release markers must agree in both directions.
    if (RELEASE_RE.test(c.drug_name) !== labelHasRelease) return false;
    if (form) {
      const df = (c.dose_form ?? c.drug_name).toLowerCase();
      if (!form.split('|').some((f) => df.includes(f))) return false;
    }
    return true;
  });
  if (survivors.length === 0) return null;

  // A label that names the generic AND the brand ("Celecoxib (Celebrex)",
  // "generic for Celebrex") is a generic fill — the brand is only a
  // reference. Brand wins only when the generic name isn't on the label.
  const genericOnLabel = (c: Candidate) => {
    const ing = ingredientWords(c.drug_name);
    return ing.length > 0 && ing.every((w) => labelWords.has(w));
  };
  const brandMatches = survivors.filter((c) => {
    const b = brandOf(c.drug_name);
    return c.is_brand && !!b && words(b).every((w) => labelWords.has(w)) && !genericOnLabel(c);
  });
  if (brandMatches.length > 0) return brandMatches.length === 1 ? brandMatches[0] : null;

  const generics = survivors.filter((c) => !c.is_brand);
  return generics.length === 1 ? generics[0] : null;
}

export async function resolveSnapRxcui(
  sb: SupabaseClient,
  label: LabelDrug,
): Promise<string | null> {
  if (!label.name?.trim() || !label.dose?.trim()) return null; // no strength → never guess
  try {
    const { data, error } = await sb.rpc('drug_match_candidates', {
      p_name: label.name,
      p_dose: label.dose,
      p_limit: 12,
    });
    if (error) throw error;
    const pick = pickUnambiguous(label, (data ?? []) as Candidate[]);
    return pick ? String(pick.rxcui) : null;
  } catch (err) {
    console.warn('[snapRxcui] resolve failed', {
      name: label.name,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
