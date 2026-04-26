// networkCheck — provider network status per plan.
//
// Reads pm_provider_network_cache directly from the browser using the
// anon-keyed Supabase client. This mirrors the consumer repo's working
// implementation in apps/web/src/hooks/useProviderNetworkStatus.ts —
// same Supabase project (plan-match-prod, rpcbrkmvalvdmroqzpaq), same
// table, same query shape, same RLS public-read access. The two repos
// share the same network data source.
//
// Plan id keying: pm_provider_network_cache stores plan_id as the
// "<contract>-<plan>" pair (e.g. "H5521-241"). The agent's Plan.id
// triple ("H5521-241-0") is reduced to the contract-plan form before
// querying. There's no segment_id in the lookup key — the cache rolls
// up across segments (a (npi, contract-plan) pair has one covered
// boolean regardless of which county/segment).
//
// What this REPLACES: the previous version round-tripped through
// /api/network-check, which normalized triple ids on the way in but
// echoed them back in a different form on the way out — every lookup
// missed → every carrier showed "Unknown". Direct browser-side reads
// match the consumer repo and remove that translation layer entirely.

import type { Plan } from '@/types/plans';
import { supabaseBrowser } from './supabaseBrowser';

export type NetworkStatus = 'in' | 'out' | 'unknown';
export type NetworkSource = 'cache' | 'fallback_unknown';

export interface NetworkCheckResult {
  plan_id: string;
  carrier: string;
  status: NetworkStatus;
  source: NetworkSource;
  checked_at: number;
  /** Human-readable explanation — surfaced in the UI tooltip. */
  note: string;
}

interface CacheRow {
  plan_id: string;        // "<contract>-<plan>", e.g. "H5521-241"
  npi: string;
  covered: boolean | null;
}

interface BatchContext {
  // Kept for backwards-compatibility with existing call sites that
  // thread zip/county through; the direct cache read doesn't use
  // them but a future live-refresh path might.
  zip?: string | null;
  fips?: string | null;
  county?: string | null;
}

/**
 * Read network status for one NPI across many plans. Returns a Map
 * keyed on the agent-side plan.id (the original triple form) so
 * callers can do `map.get(plan.id)` without re-normalizing.
 */
export async function checkNetworkBatch(
  npi: string,
  plans: Plan[],
  _ctx: BatchContext = {},
): Promise<Map<string, NetworkCheckResult>> {
  const out = new Map<string, NetworkCheckResult>();
  if (plans.length === 0 || !npi) return out;

  // Cache rows are keyed on contract-plan; build the in-list and a
  // map from contract-plan back to every plan.id that resolves there
  // (one contract-plan can appear in multiple counties → multiple
  // Plan rows in the agent's eligible set, but they all share the
  // same network status for this NPI).
  const contractPlans = new Set<string>();
  const planIdsByContractPlan = new Map<string, Plan[]>();
  for (const p of plans) {
    const cp = `${p.contract_id}-${p.plan_number}`;
    contractPlans.add(cp);
    const list = planIdsByContractPlan.get(cp);
    if (list) list.push(p);
    else planIdsByContractPlan.set(cp, [p]);
  }

  let rows: CacheRow[] = [];
  try {
    const { data, error } = await supabaseBrowser()
      .from('pm_provider_network_cache')
      .select('plan_id, npi, covered')
      .eq('npi', npi)
      .in('plan_id', [...contractPlans]);
    if (error) throw error;
    rows = (data ?? []) as unknown as CacheRow[];
  } catch (err) {
    console.warn('[network-check] cache read failed:', (err as Error).message);
  }

  console.info('[network-check] cache query', {
    npi,
    contract_plans_in: [...contractPlans],
    rows_returned: rows.length,
    sample: rows.slice(0, 3),
  });

  // Index covered booleans by contract-plan. If multiple cache rows
  // exist for the same (contract-plan, npi) — possible if one provider
  // has multiple location_ids — "any in-network wins" matches the
  // consumer hook's treatment of a single covered=true as in-network.
  const coveredByCp = new Map<string, boolean>();
  for (const r of rows) {
    const prior = coveredByCp.get(r.plan_id);
    if (prior === true) continue;            // already in-network — sticky
    if (r.covered === true) coveredByCp.set(r.plan_id, true);
    else if (r.covered === false) coveredByCp.set(r.plan_id, false);
  }

  // Fan out: every Plan that maps to the contract-plan gets the same
  // status. Plans with no cache row stay 'unknown' (cache is the
  // source of truth — a missing row means the consumer-side scraper
  // hasn't covered that plan yet).
  for (const [cp, planList] of planIdsByContractPlan) {
    const covered = coveredByCp.get(cp);
    for (const plan of planList) {
      if (covered === true) {
        out.set(plan.id, makeResult(plan, 'in', 'cache'));
      } else if (covered === false) {
        out.set(plan.id, makeResult(plan, 'out', 'cache'));
      } else {
        out.set(plan.id, makeResult(plan, 'unknown', 'fallback_unknown'));
      }
    }
  }
  return out;
}

export async function checkNetwork(
  npi: string,
  plan: Plan,
  ctx: BatchContext = {},
): Promise<NetworkCheckResult> {
  const map = await checkNetworkBatch(npi, [plan], ctx);
  return map.get(plan.id) ?? makeResult(plan, 'unknown', 'fallback_unknown');
}

export async function checkNetworkAcross(
  npi: string,
  plans: Plan[],
  ctx: BatchContext = {},
): Promise<NetworkCheckResult[]> {
  const map = await checkNetworkBatch(npi, plans, ctx);
  return plans.map((p) => map.get(p.id) ?? makeResult(p, 'unknown', 'fallback_unknown'));
}

function makeResult(plan: Plan, status: NetworkStatus, source: NetworkSource): NetworkCheckResult {
  return {
    plan_id: plan.id,
    carrier: plan.carrier,
    status,
    source,
    checked_at: Date.now(),
    note:
      source === 'fallback_unknown'
        ? "No cache row for this (NPI, plan) yet. Use the per-carrier 'I verified this is wrong' override on the Providers page if you've confirmed with the carrier."
        : status === 'in'
          ? 'In-network per pm_provider_network_cache (Medicare.gov directory data, populated by the consumer-side scraper).'
          : status === 'out'
            ? 'Out-of-network per pm_provider_network_cache. Use the per-carrier override if the carrier has confirmed otherwise.'
            : 'Unknown — cache row exists but covered field is null.',
  };
}
