// searchDrug — now backed by the Plan Match Library API.
//
// Previously: direct pm_drugs query via supabaseBrowser. Worked, but
// required every product to keep its own VITE_SUPABASE_URL +
// VITE_SUPABASE_PUBLISHABLE_KEY env config. Now we POST to
// /api/library/drug-search on the consumer (planmatch.generationhealth.me)
// and get the same rxcui resolution centrally. One source of truth
// across the agent, agentbase-crm, plan-match-aca, and anything else
// that wants drug-name → rxcui resolution.
//
// Shape preserved: callers in Step3Medications, v4/MedsPage, and
// useResolveRxcuis still receive RxNormDrug[] — no caller changes.

import { searchDrugs, type LibraryDrug } from './library-client';

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

function libraryToRxNorm(d: LibraryDrug): RxNormDrug {
  return {
    rxcui: d.rxcui,
    name: d.name,
    brand_name: d.brand_name || undefined,
    generic_name: d.generic_name || undefined,
    strength: d.strength || undefined,
    dose_form: d.dose_form || undefined,
    is_brand: d.is_brand,
  };
}

export async function searchDrug(
  query: string,
  signal?: AbortSignal,
): Promise<RxNormDrug[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const drugs = await searchDrugs(q, 6, signal);
  return drugs.map(libraryToRxNorm);
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
