// Normalization helpers shared by the AgentBase write paths.
//
// Two surfaces:
//   • parseDrugName  — split an RxNorm display string
//                      ("gabapentin · 300 MG · Oral Capsule") into
//                      { name, dose, form } so client_medications
//                      gets a clean ingredient name in the name
//                      column and the dose lives on its own.
//   • normalizeProviderName — collapse "Dr. Kombiz Klein, DO" and
//                      "KOMBIZ KLEIN, DO" to the same key so
//                      provider lookups don't insert duplicate
//                      directory rows for the same person.
//
// The browser-side mirror is src/lib/parseDrugName.ts. Kept in two
// files because Vercel functions can't @-alias into the Vite app's
// src/ tree without more tsconfig surgery than this file warrants.

export interface ParsedDrugName {
  name: string;
  dose: string | null;
  form: string | null;
}

export function parseDrugName(rxnormDisplay: string | null | undefined): ParsedDrugName {
  const raw = (rxnormDisplay ?? '').trim();
  if (!raw) return { name: '', dose: null, form: null };

  const parts = raw.split('·').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { name: '', dose: null, form: null };

  const name = titleCaseDrug(parts[0]);
  const dose = parts[1] ?? null;
  const form = parts.length > 2 ? parts.slice(2).join(' · ') : null;

  return { name, dose, form };
}

function titleCaseDrug(s: string): string {
  return s
    .split(/(\s+)/)
    .map((tok) => {
      if (/^\s+$/.test(tok)) return tok;
      if (/[A-Z]/.test(tok)) return tok; // already capitalized — preserve
      return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
    })
    .join('');
}

// Strip honorifics and degree suffixes, lowercase, collapse whitespace
// so "Dr. Kombiz Klein, DO" and "KOMBIZ KLEIN, DO" → "kombiz klein".
// Used as the name-fallback dedup key when NPI is absent on either
// side of the match.
const HONORIFICS = /^(dr\.?|doctor|mr\.?|mrs\.?|ms\.?|prof\.?)\s+/i;
const SUFFIXES = /,?\s*(?:do|md|np|pa-c|pa|rn|crnp|dnp|phd|md-?phd|fnp(-bc)?|aprn|psyd)\.?\s*$/i;

export function normalizeProviderName(raw: string | null | undefined): string {
  let s = (raw ?? '').trim();
  if (!s) return '';
  // Iteratively peel honorifics and suffixes — handles "Dr. Mr. Jane"
  // and "Smith, MD, FACP" without writing complex regex.
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(HONORIFICS, '').trim();
    s = s.replace(SUFFIXES, '').trim();
  }
  return s.toLowerCase().replace(/\s+/g, ' ');
}
