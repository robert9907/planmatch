// networkCheck — provider network status per plan.
//
// Primary path: calls /api/library/provider-network (shared library
// endpoint on the consumer). That endpoint runs cache + FHIR live
// fallback (UHC / Humana / BCBS NC / Devoted) and writes resolved
// rows back to pm_provider_network_cache so subsequent reads from
// any product hit instantly. Same data the local plan-brain pipeline
// uses — single source of truth.
//
// Fallback path: when ctx.state/county aren't supplied (caller hasn't
// threaded them yet), drop to the legacy direct supabaseBrowser query
// against pm_provider_network_cache. No FHIR resolution in that path,
// just the cache snapshot.
//
// Plan id keying: pm_provider_network_cache stores plan_id as the
// "<contract>-<plan>" pair. The agent's Plan.id triple
// ("H5521-241-0") is reduced before the local fallback query. The
// library endpoint accepts triples directly and reduces internally.

import type { Plan } from '@/types/plans';
import { supabaseBrowser } from './supabaseBrowser';
import { checkProviderNetwork } from './library-client';

export type NetworkStatus = 'in' | 'out' | 'unknown';
export type NetworkSource = 'cache' | 'fallback_unknown' | 'fhir_live';

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
  plan_id: string;
  npi: string;
  covered: boolean | null;
}

interface BatchContext {
  zip?: string | null;
  fips?: string | null;
  county?: string | null;
  state?: string | null;
}

const NOTE_BY_SOURCE: Readonly<Record<NetworkSource, Partial<Record<NetworkStatus, string>>>> = {
  fhir_live: {
    in: 'In-network per the carrier\'s live FHIR provider directory (UHC / Humana / BCBS NC / Devoted). Resolved this session and cached.',
    out: 'Out-of-network per the carrier\'s live FHIR provider directory. Use the per-carrier override if the carrier has confirmed otherwise.',
    unknown: 'FHIR returned no decision for this carrier — cached as unknown.',
  },
  cache: {
    in: 'In-network per pm_provider_network_cache (consumer-side scraper).',
    out: 'Out-of-network per pm_provider_network_cache. Use the per-carrier override if the carrier has confirmed otherwise.',
    unknown: 'Unknown — cache row exists but covered field is null.',
  },
  fallback_unknown: {
    unknown:
      "No cache row for this (NPI, plan) yet. Use the per-carrier 'I verified this is wrong' override on the Providers page if you've confirmed with the carrier.",
  },
};

function makeResult(
  plan: Plan,
  status: NetworkStatus,
  source: NetworkSource,
): NetworkCheckResult {
  const note =
    NOTE_BY_SOURCE[source][status] ??
    NOTE_BY_SOURCE.cache[status] ??
    NOTE_BY_SOURCE.fallback_unknown.unknown ??
    '';
  return {
    plan_id: plan.id,
    carrier: plan.carrier,
    status,
    source,
    checked_at: Date.now(),
    note,
  };
}

// ─── Library path ────────────────────────────────────────────────
// Used when ctx.state and ctx.county are supplied. The library
// endpoint accepts plan triples and returns per-NPI plan arrays —
// reshape to the agent's plan-keyed Map.
async function libraryBatch(
  npi: string,
  plans: Plan[],
  state: string,
  county: string,
): Promise<Map<string, NetworkCheckResult>> {
  const out = new Map<string, NetworkCheckResult>();
  const plansByTriple = new Map<string, Plan>();
  for (const p of plans) plansByTriple.set(p.id, p);

  const resp = await checkProviderNetwork({
    npis: [npi],
    state,
    county,
    plan_ids: plans.map((p) => p.id),
  });
  const npiBlock = resp.by_npi[npi];
  if (!npiBlock) {
    console.warn(
      `[network-check] library returned no block for npi ${npi}. by_npi keys:`,
      Object.keys(resp.by_npi ?? {}),
    );
    return out;
  }
  let inMatch = 0;
  let inMiss = 0;
  for (const lib of npiBlock.plans) {
    const plan = plansByTriple.get(lib.plan_id);
    if (!plan) {
      // Plan-id key mismatch — log a sample so the user can see which
      // direction the divergence is (agent triple vs library triple).
      if (inMiss < 3) {
        console.warn(
          `[network-check] library plan_id "${lib.plan_id}" not in agent plansByTriple (status: ${lib.status})`,
        );
      }
      inMiss += 1;
      continue;
    }
    inMatch += 1;
    const status: NetworkStatus =
      lib.status === 'in_network'
        ? 'in'
        : lib.status === 'out_of_network'
          ? 'out'
          : 'unknown';
    const source: NetworkSource =
      lib.source === 'fhir_live'
        ? 'fhir_live'
        : lib.source === 'unknown'
          ? 'fallback_unknown'
          : 'cache';
    out.set(plan.id, makeResult(plan, status, source));
  }
  // Any plan the library didn't enumerate stays 'unknown' (kept for
  // UI consistency — the library iterates by plan input order so
  // omissions should be rare, but guard defensively).
  for (const p of plans) {
    if (!out.has(p.id)) out.set(p.id, makeResult(p, 'unknown', 'fallback_unknown'));
  }
  // Counts so the broker can see at a glance from devtools whether the
  // mapping is healthy.
  let inN = 0;
  let outN = 0;
  let unkN = 0;
  for (const r of out.values()) {
    if (r.status === 'in') inN += 1;
    else if (r.status === 'out') outN += 1;
    else unkN += 1;
  }
  console.log(
    `[network-check] library mapped npi=${npi}: matched=${inMatch} missed=${inMiss} ` +
      `→ in=${inN} out=${outN} unknown=${unkN} (input plans=${plans.length})`,
  );
  return out;
}

// ─── Legacy direct-cache path ────────────────────────────────────
// Kept so call sites that haven't threaded state+county yet still
// resolve to cache snapshots. No FHIR live fallback in this path.
async function directBatch(
  npi: string,
  plans: Plan[],
): Promise<Map<string, NetworkCheckResult>> {
  const out = new Map<string, NetworkCheckResult>();

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

  const coveredByCp = new Map<string, boolean>();
  for (const r of rows) {
    const prior = coveredByCp.get(r.plan_id);
    if (prior === true) continue;
    if (r.covered === true) coveredByCp.set(r.plan_id, true);
    else if (r.covered === false) coveredByCp.set(r.plan_id, false);
  }

  for (const [cp, planList] of planIdsByContractPlan) {
    const covered = coveredByCp.get(cp);
    for (const plan of planList) {
      if (covered === true) out.set(plan.id, makeResult(plan, 'in', 'cache'));
      else if (covered === false) out.set(plan.id, makeResult(plan, 'out', 'cache'));
      else out.set(plan.id, makeResult(plan, 'unknown', 'fallback_unknown'));
    }
  }
  return out;
}

/**
 * Read network status for one NPI across many plans. Returns a Map
 * keyed on the agent-side plan.id (the original triple form).
 *
 * When ctx.state + ctx.county are supplied, runs the library endpoint
 * (cache + FHIR live for UHC / Humana / BCBS NC / Devoted). Otherwise
 * falls back to a direct pm_provider_network_cache read with no FHIR
 * resolution.
 */
export async function checkNetworkBatch(
  npi: string,
  plans: Plan[],
  ctx: BatchContext = {},
): Promise<Map<string, NetworkCheckResult>> {
  if (plans.length === 0 || !npi) return new Map();
  const state = ctx.state ?? null;
  const county = ctx.county ?? null;
  if (state && county) {
    try {
      return await libraryBatch(npi, plans, state, county);
    } catch (err) {
      console.warn(
        '[network-check] library call failed, falling back to direct cache:',
        (err as Error).message,
      );
      return directBatch(npi, plans);
    }
  }
  return directBatch(npi, plans);
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
