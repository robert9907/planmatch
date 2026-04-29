// parseDrugName — split an RxNorm display string into clean parts
// suitable for the AgentBase CRM client_medications columns.
//
// Input format (RxNorm display): "<ingredient> · <strength> · <form>"
// Examples:
//   "gabapentin · 300 MG · Oral Capsule"
//   "metformin · 500 MG · Oral Tablet · Extended Release"
//   "Ozempic · 1 MG / 0.74 ML · Pen Injector"
//   "lisinopril"  (no separator — bare ingredient)
//
// Output:
//   { name: title-cased segment 1,
//     dose: segment 2 (verbatim, preserves "1 MG / 0.74 ML"),
//     form: segments 3+ joined back with " · " (preserves "Oral Tablet · Extended Release") }
//
// Title-casing the name normalizes "gabapentin" → "Gabapentin" while
// leaving brand names like "Ozempic" intact (they're already capped).
// Dose and form are passed through verbatim — never transformed —
// because RxNorm's exact dose/form text is what carriers use to match
// formulary rows.

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

// Title-case a drug ingredient. Lowercase tokens like "gabapentin"
// become "Gabapentin"; tokens that already contain an uppercase
// letter (brand names: "Ozempic", "OxyContin") are left alone so we
// don't damage carrier-style capitalization.
function titleCaseDrug(s: string): string {
  return s
    .split(/(\s+)/) // keep separators so we can rejoin
    .map((tok) => {
      if (/^\s+$/.test(tok)) return tok;
      if (/[A-Z]/.test(tok)) return tok; // already has a capital — preserve
      return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
    })
    .join('');
}
