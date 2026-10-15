// Human-readable provenance for a provider-network answer.
//
// Copy of the consumer repo's api/_lib/provider-provenance.ts (the two
// repos are separate npm projects / Vercel deploys, so the helper cannot
// be imported across them — it is duplicated verbatim so both surfaces
// label an answer identically).
//
// Accepts EITHER a raw cache source ('fhir_bcbsnc', 'medicare_gov',
// 'broker_verified', 'healthteam', 'insurelytix', 'alignment',
// 'healthspring') OR the already-classified provider-network-status enum
// ('carrier_directory' | 'plan_finder' | 'broker_verified' | 'other'), so
// callers on both sides map the same way.
//
//   carrier FHIR / carrier directory  → "carrier directory"
//   medicare_gov / plan_finder        → "Medicare.gov"
//   broker_verified                   → "confirmed by your agent"
//   prior-year carry-over             → + " (YYYY network)"
//   anything else / missing           → "unknown"

export function provenanceLabel(
  source: string | null | undefined,
  fallbackYear?: number | null,
): string {
  const s = (source ?? '').toLowerCase();
  let base: string;
  if (s === 'broker_verified') base = 'confirmed by your agent';
  else if (s.startsWith('fhir_') || s === 'carrier_directory' || s === 'healthteam' || s === 'insurelytix' || s === 'alignment' || s === 'healthspring') base = 'carrier directory';
  else if (s === 'medicare_gov' || s === 'plan_finder') base = 'Medicare.gov';
  else base = 'unknown';
  // A prior-year network answer carried over to the requested year is still
  // valid (networks rarely change), but the broker should see it's last
  // year's network — never silently present it as the requested year.
  if (base !== 'unknown' && fallbackYear != null) base += ` (${fallbackYear} network)`;
  return base;
}
