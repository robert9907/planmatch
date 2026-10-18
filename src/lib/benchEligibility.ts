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

function snpKind(plan: Pick<Plan, 'plan_type' | 'snp_type'>): SnpKind {
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

export function qualifiesForBench(
  plan: Pick<Plan, 'plan_type' | 'snp_type'> & { has_drug_coverage?: boolean | null },
  client: BenchClient,
): boolean {
  const t = (plan.plan_type ?? '').toUpperCase();
  if (t === 'PDP' || t === 'MEDSUPP') return false;
  // No drug coverage = MA-only, whatever the plan_type label says.
  const maOnly = t === 'MA' || plan.has_drug_coverage === false;
  if (maOnly && client.hasVaDrugCoverage !== true) return false;
  switch (snpKind(plan)) {
    case 'D':
      return isDual(client);
    case 'C':
      return (client.csnpConditions ?? []).length > 0;
    case 'I':
      return client.livingSetting === 'institutional_or_hcbs';
    default:
      return t === 'MA' || t === 'MAPD';
  }
}
