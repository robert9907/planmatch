// Shared helper: fetch the set of (contract / contract-plan) pairs Rob
// (NPN 10447418) is not contracted to sell. Ported from the consumer
// repo (~/Code/plan-match/api/_lib/non-commissionable.ts) so the agent
// flow has the same compliance posture as the consumer iframe — Rob
// must not see plans he cannot legally write business for, regardless
// of which surface he's using to quote them.
//
// Two exclusion granularities:
//   1. Contract-level (Humana convention) — plan_number IS NULL in
//      pm_non_commissionable_contracts. The whole contract is blocked.
//      Implemented as a PostgREST `contract_id=not.in.(H5216,…)` filter
//      so excluded rows never leave Supabase.
//   2. Plan-level (UHC convention) — plan_number IS NOT NULL. Only
//      that specific plan within the contract is blocked. We return
//      the encoded set and let callers filter post-fetch in JS.
//
// Fail closed on cold-start lookup error so we never surface plans we
// can't verify against the block list. Warm instances cache for 5 min
// and stale-serve on transient errors.

const TTL_MS = 5 * 60 * 1000;

export interface NonCommissionableSets {
  /** Contracts blocked in their entirety (plan_number IS NULL). */
  contracts: ReadonlySet<string>;
  /** Specific plans blocked, encoded as "<contract_id>-<plan_number>". */
  plans: ReadonlySet<string>;
}

interface Cache {
  sets: NonCommissionableSets;
  fetchedAt: number;
}

const cacheByYear = new Map<number, Cache>();
const inflightByYear = new Map<number, Promise<NonCommissionableSets>>();

async function fetchOnce(
  supabaseUrl: string,
  supabaseKey: string,
  planYear: number,
): Promise<NonCommissionableSets> {
  const base = supabaseUrl.replace(/\/$/, '');
  // Read the real rules table filtered to action='exclude' for THIS plan
  // year. The 2027 table also carries `allow` rows (the Wellcare focus-
  // plan allowlist) which must NEVER be treated as blocks. YEAR GATE: the
  // exclude rules are a PY2027 construct, so for plan_year < 2027 there
  // are no rows and nothing is filtered — the 2026 catalog is not
  // over-filtered by 2027 excludes. (UHC/Devoted carrier flags are
  // enforced via the shared library result, not here.)
  const url =
    `${base}/rest/v1/pm_non_commissionable_rules` +
    `?select=contract_id,plan_number&action=eq.exclude&plan_year=eq.${planYear}`;
  const resp = await fetch(url, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Accept: 'application/json',
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(
      `pm_non_commissionable_contracts fetch failed: ${resp.status} ${text.slice(0, 200)}`,
    );
  }
  const rows = (await resp.json()) as Array<{
    contract_id: string;
    plan_number: string | null;
  }>;
  const contracts = new Set<string>();
  const plans = new Set<string>();
  for (const r of rows) {
    if (!r.contract_id) continue;
    if (r.plan_number == null) {
      contracts.add(r.contract_id);
    } else {
      plans.add(`${r.contract_id}-${r.plan_number}`);
    }
  }
  return { contracts, plans };
}

const EMPTY_SETS: NonCommissionableSets = { contracts: new Set(), plans: new Set() };

export async function getNonCommissionableSets(
  supabaseUrl: string,
  supabaseKey: string,
  planYear: number,
): Promise<NonCommissionableSets> {
  // YEAR GATE: exclude rules are PY2027-only. For earlier years there are
  // no rows — return empty so the 2026 catalog isn't filtered.
  if (planYear < 2027) return EMPTY_SETS;
  const now = Date.now();
  const cached = cacheByYear.get(planYear);
  if (cached && now - cached.fetchedAt < TTL_MS) return cached.sets;
  const existing = inflightByYear.get(planYear);
  if (existing) return existing;
  const p = (async () => {
    try {
      const sets = await fetchOnce(supabaseUrl, supabaseKey, planYear);
      cacheByYear.set(planYear, { sets, fetchedAt: now });
      return sets;
    } catch (err) {
      if (cached) {
        console.warn('[non-commissionable] refresh failed, serving stale:', err);
        return cached.sets;
      }
      throw err;
    } finally {
      inflightByYear.delete(planYear);
    }
  })();
  inflightByYear.set(planYear, p);
  return p;
}

export function postgrestNotInValue(ids: ReadonlySet<string>): string | null {
  if (ids.size === 0) return null;
  return `not.in.(${[...ids].join(',')})`;
}

// pm_non_commissionable_contracts encodes the plan column as
// "plan_number" but pm_plans rows use "plan_id" — same value, different
// name. The helper here matches the agent's pm_plans row shape; the
// fetch above normalizes pm_non_commissionable_contracts.plan_number
// into the same wire format so the key compares 1:1.
export function filterPlanLevelExclusions<
  T extends { contract_id: string; plan_id: string },
>(rows: ReadonlyArray<T>, planExclusions: ReadonlySet<string>): T[] {
  if (planExclusions.size === 0) return rows.slice();
  return rows.filter(
    (r) => !planExclusions.has(`${r.contract_id}-${r.plan_id}`),
  );
}
