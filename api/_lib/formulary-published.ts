// Is the Part D formulary for a given plan year actually loaded?
//
// pm_plans is dual-year (PY2026 + PY2027) well before the formulary is. The
// CMS SPUF drug file for a new plan year posts mid-AEP (~Oct 31) and only then
// lands in pm_formulary / pm_formulary_v2. Between the catalog flipping to the
// new year and that load, a year-filtered formulary read returns ZERO rows for
// every 2027 plan. Zero rows must NOT be read as "$0", "full retail", "Tier 1",
// or a silently-dropped drug — it means "not yet published."
//
// The authoritative signal is cms_spuf_releases: exactly one row per plan_year
// reaches status='active' (partial unique index enforces it), set when the app
// formulary tables are swapped to that release. No active release for a year =
// that year's formulary is not published. We key off this tiny, indexed table
// rather than counting pm_formulary (19M+ rows — a count there times out).

import type { SupabaseClient } from '@supabase/supabase-js';

// Cheap enough to call per request (one indexed row), but the active release
// changes at most a few times a year, so memoize per (year) for the lifetime
// of the warm function instance. A value is only ever cached once true — we
// never cache "false" for long, so the first request after a promotion still
// flips to published without waiting out a TTL.
const publishedYears = new Set<number>();

export async function isFormularyPublished(
  db: SupabaseClient,
  planYear: number,
): Promise<boolean> {
  if (publishedYears.has(planYear)) return true;
  const { data, error } = await db
    .from('cms_spuf_releases')
    .select('release_id')
    .eq('plan_year', planYear)
    .eq('status', 'active')
    .limit(1);
  if (error) throw error;
  const published = (data?.length ?? 0) > 0;
  if (published) publishedYears.add(planYear);
  return published;
}
