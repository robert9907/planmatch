// Which pm_provider_network_cache row answers for a (doctor, plan, year)
// when several sources have one. Rob's ruling (Oct 11, 2026): Medicare
// Plan Finder wins every time. After it: broker-verified, then carrier
// directories, then Insurelytix, then anything else. Same rank → newest
// checked_at.

export interface RankableRow {
  source?: string | null;
  checked_at?: string | null;
}

export function sourceRank(source: string | null | undefined): number {
  if (source === 'medicare_gov') return 0;
  if (source === 'broker_verified') return 1;
  if (source && (source.startsWith('fhir_') || source === 'healthteam')) return 2;
  if (source === 'insurelytix') return 3;
  return 4;
}

/** true when `a` should answer instead of `b`. */
export function outranks(a: RankableRow, b: RankableRow): boolean {
  const ra = sourceRank(a.source);
  const rb = sourceRank(b.source);
  if (ra !== rb) return ra < rb;
  return (a.checked_at ?? '') > (b.checked_at ?? '');
}
