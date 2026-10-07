// Optional `?plan_year=YYYY` URL override for the plan catalog year, on the
// AGENT surface.
//
// Why this exists: the agent's year is otherwise purely date-driven — 2026
// until the Oct 15 cutover, 2027 after. But CMS permits marketing next-year
// plans from Oct 1, and the consumer surface already routes an AEP-intent
// shopper to PY2027 inside that window (resolveRequestedCatalogYear in
// robert9907/plan-match). That left Oct 1-14 as a hole on the agent side: a
// shopper could see 2027 plans on the website while the broker quoting them
// could only pull 2026.
//
// Append `?plan_year=2027` to the agent URL and every plan, brain and
// formulary read requests that year. After the cutover the same mechanism
// runs backwards: `?plan_year=2026` pins the prior catalog for the mid-year
// SEP and effective-date work that continues through Dec 31.
//
// Absent, malformed, or not an allowlisted year => null => callers send no
// plan_year and the API applies its own resolver, i.e. exactly today's
// behavior. Read-only, SSR-safe.
//
// The server is the authoritative gate — planCatalogYear.ts's KNOWN_PLAN_YEARS
// validates every request regardless of what any client sends. The allowlist
// is duplicated below rather than imported: planCatalogYear.ts imports THIS
// module, so importing it back would make the two circular. Keep the two
// lists in lockstep when a catalog year is added.
//
// Mirrors apps/web/src/lib/planYearOverride.ts in robert9907/plan-match,
// which carries its own copy for the same reason.

const KNOWN_PLAN_YEARS: ReadonlySet<number> = new Set([2026, 2027]);

export function planYearOverride(): number | null {
  // Read `location` off globalThis rather than `window`: this file lives in
  // api/library, which is type-checked by the node tsconfig with no DOM lib.
  // Absent on the server, which is exactly the no-override case.
  const loc = (globalThis as { location?: { search?: string } }).location;
  if (!loc || typeof loc.search !== 'string') return null;
  try {
    const raw = new URLSearchParams(loc.search).get('plan_year');
    if (raw && /^\d{4}$/.test(raw.trim())) {
      const n = Number(raw.trim());
      if (KNOWN_PLAN_YEARS.has(n)) return n;
    }
  } catch {
    // Malformed URL / sandboxed location — fall through to the default.
  }
  return null;
}
