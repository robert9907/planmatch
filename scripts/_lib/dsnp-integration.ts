// scripts/_lib/dsnp-integration.ts
//
// The pure half of scripts/audit-dsnp-integration-status.ts — the
// CMS-code to pm_plans-label mapping and the segment normalisation the
// join depends on. Split out so both are testable without a database or
// a 40MB spreadsheet.
//
// pm_plans.dsnp_integration_status is the label a consumer sees on a
// D-SNP card, and it is the first column an outside auditor checks:
// FIDE / HIDE / Coordination-Only is a federal determination with real
// consequences, since a FIDE plan carries integrated Medicaid benefits
// and its own appeals path. Nothing in either repo WRITES this column —
// no script, no API, no migration — so it can only go wrong by drifting
// away from CMS on a re-ingest.

/** The values CMS files in SNP_REPORT_PART_17 "Integration Status". */
export type CmsIntegrationCode = 'FIDE' | 'HIDE' | 'CO';

/** The labels pm_plans.dsnp_integration_status stores. */
export type PmIntegrationLabel = 'FIDE' | 'HIDE' | 'Coordination Only';

/**
 * CMS files the coordination-only case as the two-letter "CO"; pm_plans
 * stores the spelled-out label the UI renders. FIDE and HIDE match.
 *
 * A blank Integration Status is NOT coordination-only — CMS leaves it
 * empty on non-dual SNPs (C-SNP, I-SNP), which this audit never looks
 * at. Returning null rather than defaulting keeps a blank on a D-SNP
 * visible as a coverage gap, instead of silently becoming "Coordination
 * Only" — which would be a fabricated federal determination on a
 * consumer-facing card.
 */
export function cmsCodeToPmLabel(raw: unknown): PmIntegrationLabel | null {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  if (s === 'FIDE') return 'FIDE';
  if (s === 'HIDE') return 'HIDE';
  if (s === 'CO') return 'Coordination Only';
  return null;
}

/**
 * Segment keys have to agree on both sides or the join silently drops
 * the segmented contracts — H3256, H4513-060, H5322-049/050 and H8849
 * all file multiple segments, and H4513-060 alone spans five.
 *
 * pm_plans stores '0' / '000' / '' inconsistently; CMS files a bare
 * integer. Normalise both by stripping leading zeros, with an empty
 * result meaning segment 0.
 */
export function normalizeSegment(raw: unknown): string {
  const stripped = String(raw ?? '').trim().replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

/** Join key for one plan segment. */
export function planKey(contractId: unknown, planId: unknown, segmentId: unknown): string {
  const c = String(contractId ?? '').trim();
  const p = String(planId ?? '').trim().padStart(3, '0');
  return `${c}-${p}-${normalizeSegment(segmentId)}`;
}

/** True when CMS's "Special Needs Plan Type" names a dual-eligible SNP. */
export function isDualSnpType(raw: unknown): boolean {
  return String(raw ?? '').toLowerCase().includes('dual');
}
