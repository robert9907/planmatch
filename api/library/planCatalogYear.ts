// Which plan-year catalog a request should see. Mirrors the consumer repo's
// api/_lib/plan-catalog-year.ts (robert9907/plan-match) — kept lean here: the
// agent only needs the year RESOLVER to filter pm_plans + the pbp_benefits
// overlay.
//
// Lives in api/library/ (not api/_lib/) because the CLIENT imports it too:
// the Part D cards in src/agent-v3 resolve the same catalog year the API
// does, so a 2027 plan is never priced with 2026 Part D constants. Pure date
// math — no secrets, no node APIs, safe in the browser bundle. pm_plans is dual-year (PY2026 + PY2027); the pbp_benefits view now
// exposes plan_year, so readers filter both by the resolved catalog year and a
// 2027 plan never shows 2026 cost-shares (or the reverse).
//
// Resolution order: explicit plan_year → coverage effective date → date-driven
// AEP cutover (on/before 2026-10-14 → 2026, on/after 2026-10-15 → 2027).
// Date-driven so it rolls without a redeploy. Only allowlisted years resolve;
// anything else falls through to the next step (never interpolated raw).

export const PLAN_CATALOG_CUTOVER_MS = Date.UTC(2026, 9, 15); // 2026-10-15 UTC
export const KNOWN_PLAN_YEARS: ReadonlySet<number> = new Set([2026, 2027]);

import { planYearOverride } from './planYearOverride.js';

const YEAR_RE = /^\d{4}$/;

export function parsePlanYearParam(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!YEAR_RE.test(s)) return null;
  const n = Number(s);
  return KNOWN_PLAN_YEARS.has(n) ? n : null;
}

export function planYearFromEffectiveDate(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const y = new Date(t).getUTCFullYear();
  return KNOWN_PLAN_YEARS.has(y) ? y : null;
}

export interface ResolveCatalogYearOpts {
  explicit?: unknown;
  effectiveDate?: unknown;
  now?: Date;
}

export function resolvePlanCatalogYear(opts: ResolveCatalogYearOpts = {}): number {
  const explicit = parsePlanYearParam(opts.explicit);
  if (explicit !== null) return explicit;
  // Client-only: a ?plan_year= URL override. Consulted HERE rather than at
  // each call site so the Part D constants in src/agent-v3 and the plan rows
  // the fetchers request can never disagree about the year — the failure this
  // whole module exists to prevent. No-op on the server (no window), where
  // the same value arrives as `explicit` off the query string instead.
  const override = planYearOverride();
  if (override !== null) return override;
  const fromDate = planYearFromEffectiveDate(opts.effectiveDate);
  if (fromDate !== null) return fromDate;
  const nowMs = (opts.now ?? new Date()).getTime();
  return nowMs >= PLAN_CATALOG_CUTOVER_MS ? 2027 : 2026;
}
