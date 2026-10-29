// Canonical dental tier — derived straight from CMS PBP Section B16, never
// from the annual maximum. This is a byte-identical mirror of the CONSUMER
// repo's packages/shared/src/dental-tier.ts so the agent (Compare, Head-to-
// Head, quotes) and the consumer classify a plan's dental identically.
//
//   comprehensive = plan files ANY B16c MAJOR category — restorative/fillings
//                   (rs), endodontics/root canals (end), periodontics/gum
//                   treatment (peri), extractions & oral surgery (omsg),
//                   dentures (prm), crowns & bridges (prf), implants (impl),
//                   maxillofacial prosthetics (mxpr).
//   preventive    = plan files B16b (exams, cleanings, X-rays, fluoride).
//   The annual maximum is DISPLAY ONLY and NEVER decides the tier.
//
// The consumer's api/_lib/b16-dental.ts computes these flags at ingest from
// the real B16 service columns and (once the pm_plan_benefits migration lands)
// stores them as files_preventive / files_comprehensive. Until then we read
// the benefit_description HEAD, which b16-dental.ts also sets straight from
// B16 ("Comprehensive dental", "Preventive + comprehensive dental", …).
//
// ⚠ Keep in sync with ~/Code/plan-match packages/shared/src/dental-tier.ts.

export type DentalTier = 'none' | 'preventive' | 'comprehensive';

export interface DentalRowLike {
  benefit_description?: string | null;
  files_preventive?: boolean | null;
  files_comprehensive?: boolean | null;
}

export interface DentalSignals {
  preventive: boolean;
  comprehensive: boolean;
  tier: DentalTier;
}

const NONE: DentalSignals = { preventive: false, comprehensive: false, tier: 'none' };

export function dentalSignalsFromRow(row: DentalRowLike | null | undefined): DentalSignals {
  if (!row) return NONE;

  if (row.files_preventive != null || row.files_comprehensive != null) {
    const preventive = row.files_preventive === true;
    const comprehensive = row.files_comprehensive === true;
    return {
      preventive,
      comprehensive,
      tier: comprehensive ? 'comprehensive' : preventive ? 'preventive' : 'none',
    };
  }

  const head = (row.benefit_description ?? '').split('·')[0].toLowerCase();
  if (!head.includes('dental')) return NONE;
  const comprehensive = head.includes('comprehensive');
  const preventive = head.includes('preventive');
  return {
    preventive,
    comprehensive,
    tier: comprehensive ? 'comprehensive' : 'preventive',
  };
}
