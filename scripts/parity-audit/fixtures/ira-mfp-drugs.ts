// IRA Maximum Fair Price (MFP) drug list — Round 1, effective January 1, 2026.
// Source: SPEC.md §5.7. Ten drugs selected by CMS Medicare Drug Price Negotiation Program.
//
// When Round 2 (2027, including Ozempic/Wegovy/Rybelsus semaglutide) takes effect,
// add IRA_MFP_DRUGS_2027 and update `isMfpDrug()` to dispatch by year.

export const IRA_MFP_DRUGS_2026: readonly string[] = [
  'Eliquis',      // apixaban — Blood clots, AFib
  'Jardiance',    // empagliflozin — Diabetes, CKD, HF (matches "Empagliflozin" label too)
  'Xarelto',      // rivaroxaban — Blood clots
  'Januvia',      // sitagliptin — Diabetes
  'Farxiga',      // dapagliflozin — Diabetes, CKD, HF (matches "Dapagliflozin" label)
  'Entresto',     // sacubitril/valsartan — Heart failure
  'Enbrel',       // etanercept — RA, autoimmune
  'Imbruvica',    // ibrutinib — Cancer
  'Stelara',      // ustekinumab — Autoimmune
  'Fiasp',        // insulin aspart — Diabetes (also matches "NovoLog", "insulin aspart")
  'NovoLog',
  'insulin aspart',
  'Empagliflozin',
  'Dapagliflozin',
];

const MFP_LOWER = IRA_MFP_DRUGS_2026.map((s) => s.toLowerCase());

// Case-insensitive contains-match. Handles brand + generic names + parenthesized
// aliases in fixtures (e.g., "Empagliflozin (Jardiance)").
export function isMfpDrug(drugName: string): boolean {
  const norm = drugName.toLowerCase();
  return MFP_LOWER.some((mfp) => norm.includes(mfp));
}
