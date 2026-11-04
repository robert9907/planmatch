// Which county plans may appear on the Compare bench for this client.
//
// Rob, Oct 17 2026: "I need MAPD. If someone qualifies for MA (very rare)
// we show those plans. If someone is on Medicare and Medicaid we show those
// plans." So the bench is the plans the client can actually choose:
//
//   • MAPD with drug coverage                     → always
//   • MA-only (no drug coverage — Patriot No Rx, Eagle, USAA Giveback…)
//            → only when Intake says VA / TRICARE drug coverage
//              (hasVaDrugCoverage === true, the same switch the brain's
//              MA-only filter reads). Plan type alone isn't enough: CMS
//              landscape tags many no-Rx plans "MAPD", so the plan's
//              has_drug_coverage flag decides.
//   • D-SNP  → only when the client is on Medicare + Medicaid
//              (dsnpEligible === true, or a Medicaid level on file)
//   • C-SNP  → only with a confirmed chronic condition (csnpConditions)
//   • I-SNP  → only when living setting is institutional / HCBS
//   • PDP / Medigap → never (this is the Medicare Advantage compare board)
//
// The brain's Top-4 board is unchanged; this only narrows the bench.

import type { Plan } from '@/types/plans';
import type { Client } from '@/types/session';

export type BenchClient = Pick<
  Client,
  'dsnpEligible' | 'csnpConditions' | 'livingSetting' | 'hasVaDrugCoverage' | 'medicaidLevel'
>;

type SnpKind = 'D' | 'C' | 'I' | null;

function snpKind(plan: { plan_type?: string | null; snp_type?: string | null }): SnpKind {
  const s = (plan.snp_type ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  const t = (plan.plan_type ?? '').toUpperCase();
  if (s === 'DSNP' || t === 'DSNP') return 'D';
  if (s === 'CSNP' || t === 'CSNP') return 'C';
  if (s === 'ISNP' || t === 'ISNP') return 'I';
  return null;
}

export function isDual(client: BenchClient): boolean {
  return client.dsnpEligible === true || (!!client.medicaidLevel && client.medicaidLevel !== 'none');
}

// D-SNP accepted Medicaid populations, per-plan manual capture first, then
// the CMS-derived set — same precedence as the brain's filterPlanPool and
// the bench filters. Tokens like "QMB+" normalize to the session's "qmb_plus".
type DsnpPopsPlan = {
  snp_type?: string | null;
  plan_type?: string | null;
  dsnp_accepted_populations?: string[] | null;
  dsnp_accepted_populations_manual?: string[] | null;
};

export function effectiveDsnpPopulations(plan: DsnpPopsPlan): string[] | null {
  const manual = plan.dsnp_accepted_populations_manual;
  const cms = plan.dsnp_accepted_populations;
  return manual && manual.length > 0 ? manual : cms && cms.length > 0 ? cms : null;
}

function popToken(p: string): string {
  return p.trim().toLowerCase().replace(/\+$/, '_plus').replace(/[\s-]/g, '');
}

/** Can a client in Medicaid category `level` enroll in this D-SNP?
 *  'accepts' / 'rejects' from the filed populations; 'unknown' when no
 *  population data is on file; 'n/a' for non-D-SNPs or no category set. */
export function dsnpMedicaidVerdict(
  plan: DsnpPopsPlan,
  level: BenchClient['medicaidLevel'],
): 'accepts' | 'rejects' | 'unknown' | 'n/a' {
  if (snpKind(plan) !== 'D') return 'n/a';
  if (!level || level === 'none') return 'n/a';
  const pops = effectiveDsnpPopulations(plan);
  if (!pops) return 'unknown';
  return pops.some((p) => popToken(p) === level) ? 'accepts' : 'rejects';
}

function acceptsMedicaidLevel(plan: DsnpPopsPlan, level: BenchClient['medicaidLevel']): boolean {
  // No population filed → keep the plan (an unmapped D-SNP may still fit);
  // the card flags it as unverified.
  return dsnpMedicaidVerdict({ ...plan, snp_type: 'D-SNP' }, level) !== 'rejects';
}

export function qualifiesForBench(
  plan: Pick<Plan, 'plan_type' | 'snp_type'> & {
    has_drug_coverage?: boolean | null;
    dsnp_accepted_populations?: string[] | null;
    dsnp_accepted_populations_manual?: string[] | null;
  },
  client: BenchClient,
): boolean {
  const t = (plan.plan_type ?? '').toUpperCase();
  if (t === 'PDP' || t === 'MEDSUPP') return false;
  // No drug coverage = MA-only, whatever the plan_type label says.
  const maOnly = t === 'MA' || plan.has_drug_coverage === false;
  if (maOnly && client.hasVaDrugCoverage !== true) return false;
  switch (snpKind(plan)) {
    case 'D':
      // A D-SNP only enrolls the Medicaid categories it accepts (e.g. Full
      // Dual plans take FBDE / QMB+ / SLMB+, not QMB-only).
      return isDual(client) && acceptsMedicaidLevel(plan, client.medicaidLevel);
    case 'C':
      return (client.csnpConditions ?? []).length > 0;
    case 'I':
      return client.livingSetting === 'institutional_or_hcbs';
    default:
      return t === 'MA' || t === 'MAPD';
  }
}
