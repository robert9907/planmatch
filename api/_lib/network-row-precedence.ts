// Which pm_provider_network_cache row answers for a (doctor, plan, year)
// when several sources have one.
//
// Rob's ruling (Oct 13, 2026) — SUPERSEDES the Oct-11 "Medicare Plan
// Finder wins every time" rule, and mirrors the consumer repo's
// api/_lib/network-row-precedence.ts exactly: the CARRIER is
// authoritative on its own network. Broker-verified (a human
// confirmation) wins, then carrier directories (FHIR / HealthTeam /
// Insurelytix / Alignment / HealthSpring), then Medicare Plan Finder,
// then anything else. Same rank → newest checked_at.
//
// Why the flip: medicare.gov Plan Finder routinely lists a doctor as
// out-of-network who IS in-network (stale/partial CMS feed). Letting a
// medicare_gov "false" override a carrier FHIR "true" wrongly eliminated
// real in-network plans (Dr. Klein on BCBS). A medicare_gov-only "false"
// is now treated as UNKNOWN, not out-of-network — see isTrustedSource +
// every caller (plan-brain-data, networkCheck, providerEvidence).

export interface RankableRow {
  source?: string | null;
  checked_at?: string | null;
}

export function sourceRank(source: string | null | undefined): number {
  if (source === 'broker_verified') return 0;
  if (source && (source.startsWith('fhir_') || source === 'healthteam' || source === 'insurelytix' || source === 'alignment' || source === 'healthspring')) return 1;
  if (source === 'medicare_gov') return 2;
  return 3;
}

/** A trusted source's "not covered" is proof of out-of-network (eliminates
 *  at Gate 1). A non-trusted "not covered" — notably medicare_gov, which
 *  under-reports in-network providers — is treated as UNKNOWN, not out. */
export function isTrustedSource(source: string | null | undefined): boolean {
  if (!source) return false;
  return (
    source === 'broker_verified' ||
    source === 'healthteam' ||
    source === 'insurelytix' ||
    source === 'alignment' ||
    source === 'healthspring' ||
    source.startsWith('fhir_')
  );
}

/** true when `a` should answer instead of `b`. */
export function outranks(a: RankableRow, b: RankableRow): boolean {
  const ra = sourceRank(a.source);
  const rb = sourceRank(b.source);
  if (ra !== rb) return ra < rb;
  return (a.checked_at ?? '') > (b.checked_at ?? '');
}

/** One row of record per key (e.g. plan|npi), by the precedence above. */
export function pickRowsOfRecord<T extends RankableRow>(
  rows: ReadonlyArray<T>,
  keyOf: (r: T) => string,
): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) {
    const k = keyOf(r);
    const cur = out.get(k);
    if (!cur || outranks(r, cur)) out.set(k, r);
  }
  return out;
}
