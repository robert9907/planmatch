// networkCheck — provider network status per plan.
//
// Real lookup against /api/network-check, which:
//   1. reads pm_provider_network_cache (per-plan covered booleans
//      populated by the consumer-side Medicare.gov writer);
//   2. on cache miss, calls Medicare.gov /plans/search with
//      ?providers=<NPI> and writes the parsed results back to the
//      cache;
//   3. returns per-plan { status, from, covered } so the agent UI
//      can show in/out/unknown plus where the answer came from.
//
// Both single (`checkNetwork`) and batch (`checkNetworkBatch`)
// helpers are exposed; the batch path is preferred from the
// Providers page because one round trip handles every finalist
// plan for a single NPI.
//
// Diagnostic logging stays on a `[network-check]` tag. The logged
// `source` field is now meaningful: 'cache' / 'live' / 'directory'
// reflect real data; 'fallback_unknown' is reserved for cases where
// neither the cache nor the live call could answer (network error,
// unparseable response, missing zip/fips). The hash mock is gone.

import type { Plan } from '@/types/plans';
import { fipsForCounty } from './ncFips';

export type NetworkStatus = 'in' | 'out' | 'unknown';
export type NetworkSource = 'cache' | 'live' | 'directory' | 'fallback_unknown';

export interface NetworkCheckResult {
  plan_id: string;
  carrier: string;
  status: NetworkStatus;
  source: NetworkSource;
  checked_at: number;
  /** Human-readable explanation — surfaced in the UI tooltip. */
  note: string;
}

interface BatchResultRow {
  plan_id: string;
  contract_id: string;
  plan_number: string;
  segment_id: string;
  status: NetworkStatus;
  from: 'cache' | 'live' | 'miss';
  covered: boolean | null;
}

interface BatchResponse {
  source: 'cache' | 'live' | 'mixed' | 'empty';
  results: BatchResultRow[];
  stats: { cacheHits: number; liveHits: number; misses: number; total: number };
  fhir_diagnostic?: unknown;
}

interface BatchContext {
  zip?: string | null;
  fips?: string | null;
  planType?: string;
  year?: number;
  /** When omitted, the helper derives FIPS from the NC table. */
  county?: string | null;
}

export async function checkNetworkBatch(
  npi: string,
  plans: Plan[],
  ctx: BatchContext = {},
): Promise<Map<string, NetworkCheckResult>> {
  const out = new Map<string, NetworkCheckResult>();
  if (plans.length === 0) return out;

  const fips = ctx.fips ?? fipsForCounty(ctx.county);
  const planIds = plans.map((p) => p.id);

  let body: BatchResponse | null = null;
  try {
    const resp = await fetch('/api/network-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        npi,
        plan_ids: planIds,
        zip: ctx.zip ?? undefined,
        fips: fips ?? undefined,
        plan_type: ctx.planType ?? 'PLAN_TYPE_MAPD',
        year: ctx.year ?? new Date().getFullYear(),
      }),
    });
    if (!resp.ok) {
      const sample = await resp.text();
      throw new Error(`api/network-check ${resp.status}: ${sample.slice(0, 200)}`);
    }
    body = (await resp.json()) as BatchResponse;
  } catch (err) {
    console.warn('[network-check] batch call failed:', (err as Error).message);
  }

  // Always log the call summary so Rob can correlate UI status to
  // upstream cache vs. live behavior.
  if (body) {
    console.info('[network-check] batch', {
      npi,
      plan_count: planIds.length,
      source: body.source,
      stats: body.stats,
    });
    if (body.fhir_diagnostic) {
      console.info('[network-check] live diagnostic:', body.fhir_diagnostic);
    }
  }

  const byPlanId = new Map<string, BatchResultRow>();
  for (const r of body?.results ?? []) byPlanId.set(r.plan_id, r);

  for (const plan of plans) {
    const row = byPlanId.get(plan.id);
    if (!row) {
      out.set(plan.id, fallbackResult(plan, 'no_response'));
      continue;
    }
    const source: NetworkSource =
      row.from === 'cache' ? 'cache' : row.from === 'live' ? 'live' : 'fallback_unknown';
    out.set(plan.id, {
      plan_id: plan.id,
      carrier: plan.carrier,
      status: row.status,
      source,
      checked_at: Date.now(),
      note:
        source === 'fallback_unknown'
          ? 'Cache miss; live Medicare.gov fetch could not answer (likely missing zip/fips or upstream error). Use the per-carrier "I verified this is wrong" override on the Providers page after confirming with the carrier.'
          : source === 'cache'
            ? 'Read from pm_provider_network_cache (Medicare.gov directory data, populated by the consumer-side writer).'
            : 'Fetched live from Medicare.gov plans/search and written back to pm_provider_network_cache.',
    });
  }
  return out;
}

export async function checkNetwork(
  npi: string,
  plan: Plan,
  ctx: BatchContext = {},
): Promise<NetworkCheckResult> {
  const map = await checkNetworkBatch(npi, [plan], ctx);
  return map.get(plan.id) ?? fallbackResult(plan, 'no_response');
}

export async function checkNetworkAcross(
  npi: string,
  plans: Plan[],
  ctx: BatchContext = {},
): Promise<NetworkCheckResult[]> {
  const map = await checkNetworkBatch(npi, plans, ctx);
  return plans.map((p) => map.get(p.id) ?? fallbackResult(p, 'no_response'));
}

function fallbackResult(plan: Plan, reason: string): NetworkCheckResult {
  return {
    plan_id: plan.id,
    carrier: plan.carrier,
    status: 'unknown',
    source: 'fallback_unknown',
    checked_at: Date.now(),
    note: `Network status unavailable (${reason}). Use the per-carrier override after confirming with the carrier.`,
  };
}
