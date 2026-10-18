// Which county plans may appear on the Compare bench for this client.
//
// Rob, Oct 17 2026: "I do not need to see plans this person does not
// qualify for." The bench used to list EVERY county plan (D-SNPs, I-SNPs,
// C-SNPs, PDPs) so the broker could drag anything onto the board — which put
// dual-only plans in front of a non-dual client. Now the bench is the plans
// the client can actually choose:
//
//   • Medicare Advantage (MA / MAPD, no SNP)      → always
//   • D-SNP  → only when the client is marked dual (dsnpEligible === true,
//              the same strict check the brain's filterPlanPool uses)
//   • C-SNP  → only when a qualifying chronic condition is on file
//              (csnpConditions — self-reported / broker-confirmed, never
//              med-detection; mirrors the brain)
//   • I-SNP  → only when living setting is institutional / HCBS
//   • PDP / Medigap → never (this is the Medicare Advantage compare board)
//
// The brain's Top-4 board is unchanged; this only narrows the bench.

import type { Plan } from '@/types/plans';
import type { Client } from '@/types/session';

export type BenchClient = Pick<Client, 'dsnpEligible' | 'csnpConditions' | 'livingSetting'>;

type SnpKind = 'D' | 'C' | 'I' | null;

function snpKind(plan: Pick<Plan, 'plan_type' | 'snp_type'>): SnpKind {
  const s = (plan.snp_type ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  const t = (plan.plan_type ?? '').toUpperCase();
  if (s === 'DSNP' || t === 'DSNP') return 'D';
  if (s === 'CSNP' || t === 'CSNP') return 'C';
  if (s === 'ISNP' || t === 'ISNP') return 'I';
  return null;
}

export function qualifiesForBench(plan: Pick<Plan, 'plan_type' | 'snp_type'>, client: BenchClient): boolean {
  const t = (plan.plan_type ?? '').toUpperCase();
  if (t === 'PDP' || t === 'MEDSUPP') return false;
  switch (snpKind(plan)) {
    case 'D':
      return client.dsnpEligible === true;
    case 'C':
      return (client.csnpConditions ?? []).length > 0;
    case 'I':
      return client.livingSetting === 'institutional_or_hcbs';
    default:
      return t === 'MA' || t === 'MAPD';
  }
}
