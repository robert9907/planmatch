// Shared helper: fetch the plan-sellability signals that drive the
// three-state enrollment handoff, and attach them to plan rows.
//
// This REPLACES api/_lib/non-commissionable.ts as the input to the
// consumer plan endpoints (/api/plans, /api/plans-with-extras). The
// difference in posture is deliberate:
//
//   Old (non-commissionable): a non-sellable plan was FILTERED OUT of
//   results — it never appeared anywhere a plan could be picked.
//
//   New (sellability): NOTHING is filtered out. Every plan in the county
//   is returned. Each plan carries three independent booleans and the
//   enrollment-options sheet routes on them:
//     is_appointed     — active appointment with the carrier for this contract
//     is_certified     — PY2027 certification complete for this contract
//     pays_commission  — plan pays commission this plan year
//   can_enroll = is_appointed AND is_certified (computed client-side).
//
// pays_commission is carried through for the record only. It must NEVER
// affect display, ranking, or routing — the sheet is identical whether or
// not commission is paid. It is surfaced (never collapsed away) so the
// three signals stay independent end to end.
//
// Data model: pm_plan_sellability, keyed like the old table —
//   plan_number IS NULL      → contract-wide flags.
//   plan_number IS NOT NULL  → plan-specific override for one plan.
// A plan with no row at all defaults to appointed + certified + commission
// = true (State A). See migration 202609182000_pm_plan_sellability.sql.
//
// Compliance posture: fail CLOSED on cold-start lookup error (same as the
// old non-commissionable helper). We'd rather surface a 500 than route a
// plan Rob can't sell into the "enroll with Robert" flow because we
// couldn't load the appointment/certification list. Once a fetch has
// succeeded the value is cached on the warm instance and stale-served if
// the next refresh fails, so a transient PostgREST blip doesn't ripple
// into the consumer flow.

const TTL_MS = 5 * 60 * 1000; // 5 minutes — list changes rarely.

export interface SellabilityFlags {
  is_appointed: boolean;
  is_certified: boolean;
  pays_commission: boolean;
}

/** Default for a (contract[, plan]) with no row: fully sellable (State A). */
export const DEFAULT_SELLABILITY: Readonly<SellabilityFlags> = {
  is_appointed: true,
  is_certified: true,
  pays_commission: true,
};

export interface SellabilitySets {
  /** Contract-wide flags, keyed by contract_id (plan_number IS NULL rows). */
  byContract: ReadonlyMap<string, SellabilityFlags>;
  /** Plan-specific flags, keyed by "<contract_id>-<plan_number>". */
  byPlan: ReadonlyMap<string, SellabilityFlags>;
}

interface Cache {
  sets: SellabilitySets;
  fetchedAt: number;
}

let cache: Cache | null = null;
let inflight: Promise<SellabilitySets> | null = null;

async function fetchOnce(
  supabaseUrl: string,
  supabaseKey: string,
): Promise<SellabilitySets> {
  const base = supabaseUrl.replace(/\/$/, '');
  const url =
    `${base}/rest/v1/pm_plan_sellability` +
    `?select=contract_id,plan_number,is_appointed,is_certified,pays_commission`;
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
      `pm_plan_sellability fetch failed: ${resp.status} ${text.slice(0, 200)}`,
    );
  }
  const rows = (await resp.json()) as Array<{
    contract_id: string;
    plan_number: string | null;
    is_appointed: boolean;
    is_certified: boolean;
    pays_commission: boolean;
  }>;
  const byContract = new Map<string, SellabilityFlags>();
  const byPlan = new Map<string, SellabilityFlags>();
  for (const r of rows) {
    if (!r.contract_id) continue;
    const flags: SellabilityFlags = {
      is_appointed: !!r.is_appointed,
      is_certified: !!r.is_certified,
      pays_commission: !!r.pays_commission,
    };
    if (r.plan_number == null) {
      byContract.set(r.contract_id, flags);
    } else {
      byPlan.set(`${r.contract_id}-${r.plan_number}`, flags);
    }
  }
  return { byContract, byPlan };
}

/**
 * Returns the current sellability sets, cached for 5 minutes per warm
 * instance. On expiry, if the refresh fails but a cached value exists,
 * serves stale; if no cache exists (cold-start failure), the promise
 * rejects so the caller can fail closed.
 */
export async function getSellabilitySets(
  supabaseUrl: string,
  supabaseKey: string,
): Promise<SellabilitySets> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) {
    return cache.sets;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const sets = await fetchOnce(supabaseUrl, supabaseKey);
      cache = { sets, fetchedAt: now };
      return sets;
    } catch (err) {
      if (cache) {
        console.warn('[sellability] refresh failed, serving stale:', err);
        return cache.sets;
      }
      throw err;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Resolve the flags for one (contract, plan): a plan-specific row wins
 * over the contract-wide row, which wins over the "no row → fully
 * sellable" default. The three signals are never collapsed.
 */
export function resolveSellability(
  sets: SellabilitySets,
  contractId: string,
  planId: string,
): SellabilityFlags {
  return (
    sets.byPlan.get(`${contractId}-${planId}`) ??
    sets.byContract.get(contractId) ??
    DEFAULT_SELLABILITY
  );
}

/**
 * Attach { is_appointed, is_certified, pays_commission } to each plan
 * row. No row is dropped — every plan in the input is returned, annotated.
 * Generic over the row shape so callers can pass either endpoint's row.
 */
export function attachSellability<
  T extends { contract_id: string; plan_id: string },
>(rows: ReadonlyArray<T>, sets: SellabilitySets): Array<T & SellabilityFlags> {
  return rows.map((r) => ({ ...r, ...resolveSellability(sets, r.contract_id, r.plan_id) }));
}
