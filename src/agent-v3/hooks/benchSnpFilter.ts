// SNP-dimension predicate for the Compare bench filters. Pulled out of
// useBenchFilters so it can be tested without React.
//
// Encoding: a top-level token ("D-SNP") passes any plan in that bucket;
// a sub-token passes only plans whose attribute matches — "D-SNP:pop:QMB"
// for an accepted Medicaid population, "D-SNP:<status>" for integration
// status, "C-SNP:<condition>" for a C-SNP condition. OR across tokens.
//
// A D-SNP with no accepted populations on file (neither pm_dsnp_populations
// nor pm_plans.dsnp_accepted_populations) PASSES a population chip. Unknown
// is not "excluded": hiding it made every 2027 Wellpoint D-SNP vanish for a
// QMB client (Juddith Eddins, Tarrant TX, Nov 2 2026). The card shows
// "Dual categories not on file" so the broker confirms before enrolling.
// Same rule benchEligibility.acceptsMedicaidLevel already applies.

export const SNP_SUB_SEP = ':';
export const DSNP_POP_PREFIX = 'pop:';

export function parseSnpFilter(value: string): { top: string; sub: string | null } {
  const idx = value.indexOf(SNP_SUB_SEP);
  if (idx < 0) return { top: value, sub: null };
  return { top: value.slice(0, idx), sub: value.slice(idx + 1) };
}

export interface SnpFilterPlan {
  snpType: string | null;
  dsnpAcceptedPopulations: string[] | null;
  dsnpPopulationsSource: 'manual' | 'cms' | 'none';
  dsnpIntegration: string | null;
  csnpCondition: string | null;
  isVa: boolean;
}

export function passesSnpFilter(p: SnpFilterPlan, snpSet: ReadonlySet<string>): boolean {
  if (snpSet.size === 0) return true;
  for (const token of snpSet) {
    const { top, sub } = parseSnpFilter(token);
    if (top === 'VA') {
      if (p.isVa) return true;
      continue;
    }
    if (p.snpType !== top) continue;
    if (sub == null) return true;
    if (top === 'D-SNP') {
      if (sub.startsWith(DSNP_POP_PREFIX)) {
        if (p.dsnpPopulationsSource === 'none') return true;
        const pop = sub.slice(DSNP_POP_PREFIX.length);
        if ((p.dsnpAcceptedPopulations ?? []).includes(pop)) return true;
        continue;
      }
      if (p.dsnpIntegration === sub) return true;
      continue;
    }
    if (top === 'C-SNP' && p.csnpCondition === sub) return true;
  }
  return false;
}
