// Contract → carrier resolution for provider-network sentinels.
//
// MIRROR of the carrier-mapping half of the consumer repo's
// api/_lib/fhir-provider.ts (robert9907/plan-match): CarrierId, the two
// sentinel plan-id constants, loadContractToCarrierMap and
// carrierForContractId. The two repos share no npm package, so — exactly like
// api/_lib/network-row-precedence.ts and api/_lib/provider-provenance.ts —
// this logic is mirrored here rather than imported. Both repos read the SAME
// pm_fhir_plan_network rows in plan-match-prod, so keep this in step with the
// consumer source; a drift would route a plan to the wrong carrier on the
// agent surface only.
//
// Scope: only the contract→carrier lookup the Compare/Gate-1 server path
// (api/plan-brain-data.ts) needs to expand carrier sentinels onto real plans.
// The FHIR HTTP lookup itself stays in the consumer — the agent never queries
// carrier directories directly (see [[agent_doctor_lookup_delegates_consumer]]).

import type { SupabaseClient } from '@supabase/supabase-js';

export type CarrierId =
  | 'uhc'
  | 'humana'
  | 'devoted'
  | 'bcbsnc'
  | 'anthem'
  | 'wellcare'
  | 'healthteam';

// The carriers whose directories write sentinel rows (source='fhir_<id>').
export const FHIR_CARRIER_IDS: ReadonlyArray<CarrierId> = [
  'uhc', 'humana', 'bcbsnc', 'devoted', 'anthem', 'wellcare', 'healthteam',
];

// Sentinel plan_ids (see consumer fhir-provider.ts). Keyed on the NPI, not a
// real plan — a carrier-WIDE verdict for a doctor:
//   __NPI_NOT_FOUND__      absent from the carrier directory      → not_listed
//   __NPI_NO_MA_NETWORK__  found, but on no MA network for carrier → out_of_network
export const NPI_NOT_FOUND_PLAN_ID = '__NPI_NOT_FOUND__';
export const NPI_NO_MA_NETWORK_PLAN_ID = '__NPI_NO_MA_NETWORK__';

export interface PlanNetworkRow {
  carrier_id: CarrierId;
  contract_id: string;
  plan_year: number | null;
}

// Pure contract_id → owning carrier reducer over pm_fhir_plan_network rows.
// First-write-wins per contract, but a row whose plan_year === requestedYear
// upgrades an ownership first claimed by a fallback-year row (year-aware, like
// the consumer map which is built per requested year). Kept PURE so the mirror
// drift test (scripts/tests/carrier-map-mirror.test.ts) can compare it to the
// consumer's documented algorithm on the same rows without a DB. Any change
// here MUST stay in lockstep with the consumer's loadContractToCarrierMap
// (robert9907/plan-match api/_lib/fhir-provider.ts) — the daily cron
// /api/audit-carrier-map-mirror alerts if the live data could make them differ.
export function buildContractToCarrierMap(
  rows: ReadonlyArray<PlanNetworkRow>,
  requestedYear: number,
): Map<string, CarrierId> {
  const map = new Map<string, CarrierId>();
  const ownedYear = new Map<string, number | null>();
  for (const r of rows) {
    if (!FHIR_CARRIER_IDS.includes(r.carrier_id)) continue;
    if (!map.has(r.contract_id)) {
      map.set(r.contract_id, r.carrier_id);
      ownedYear.set(r.contract_id, r.plan_year);
    } else if (r.plan_year === requestedYear && ownedYear.get(r.contract_id) !== requestedYear) {
      map.set(r.contract_id, r.carrier_id);
      ownedYear.set(r.contract_id, r.plan_year);
    }
  }
  return map;
}

// contract_id → owning carrier, from pm_fhir_plan_network (the same source the
// consumer endpoint resolves through). Scoped to the given contracts + years.
export async function loadContractToCarrierMap(
  sb: SupabaseClient,
  contracts: string[],
  years: number[],
  requestedYear: number,
): Promise<Map<string, CarrierId>> {
  if (contracts.length === 0) return new Map<string, CarrierId>();
  const all: PlanNetworkRow[] = [];
  const pageSize = 1000;
  let from = 0;
  // Paginate — a county's worth of contracts can carry thousands of
  // (org, plan, segment) rows, past PostgREST's 1000-row cap. Stable order
  // keeps pages from overlapping or dropping rows.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await sb
      .from('pm_fhir_plan_network')
      .select('carrier_id, contract_id, plan_year')
      .in('carrier_id', FHIR_CARRIER_IDS as string[])
      .in('contract_id', contracts)
      .in('plan_year', years)
      .order('contract_id', { ascending: true })
      .order('carrier_id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = (data ?? []) as PlanNetworkRow[];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return buildContractToCarrierMap(all, requestedYear);
}

export function carrierForContractId(
  map: Map<string, CarrierId>,
  contractId: string,
): CarrierId | null {
  return map.get(contractId) ?? null;
}

// A trusted CARRIER-DIRECTORY source — the carrier's own feed answered. This is
// isTrustedSource (network-row-precedence) MINUS broker_verified (a human
// confirm, not a directory) and MINUS medicare_gov (Plan Finder, which
// under-reports). Used to decide whether a carrier's sentinel is contradicted.
export function isCarrierDirectorySource(source: string | null | undefined): boolean {
  if (!source) return false;
  return (
    source.startsWith('fhir_') ||
    source === 'healthteam' ||
    source === 'insurelytix' ||
    source === 'alignment' ||
    source === 'healthspring'
  );
}

// ─── Carrier sentinel expansion ────────────────────────────────────────

/** A row-of-record slot in networkByPlan[tripleId][npi]. */
export interface NetworkSlotRow {
  plan_id: string;
  segment_id: string;
  npi: string;
  covered: boolean | null;
  source?: string | null;
  checked_at?: string | null;
  plan_year?: number | null;
}

/** A carrier-wide sentinel row (plan_id = one of the two sentinel ids). */
export interface CarrierSentinelRow {
  plan_id: string;
  npi: string;
  source: string | null;
  checked_at: string | null;
  plan_year: number | null;
}

/** A real per-plan cache row, used to find carriers that answered for an NPI. */
export interface RealNetworkRow {
  plan_id: string;
  npi: string;
  source?: string | null;
}

function splitContract(id: string): { contract: string; plan: string; segment: string } | null {
  const parts = id.split('-');
  if (parts.length < 2) return null;
  return { contract: parts[0], plan: parts[1], segment: (parts[2] ?? '0').replace(/^0+/, '') || '0' };
}

// Expand carrier-WIDE sentinels onto the real requested plans, mutating
// `networkByPlan` in place. A sentinel (__NPI_NOT_FOUND__ → not_listed,
// __NPI_NO_MA_NETWORK__ → out_of_network) is a trusted carrier negative that
// eliminates at Gate 1; it is written as a synthetic covered=false row for
// every one of the carrier's requested plans that has no answer yet.
//
// Precedence (mirror of consumer library/provider-network §3b–§4):
//   • never overwrite an existing (plan, npi) slot — a real per-plan row or an
//     attributed broker row already won and beats any sentinel;
//   • a carrier that returned ANY real per-plan row for the NPI contradicts its
//     own sentinel → that carrier's sentinel is ignored carrier-wide for the NPI;
//   • a requested-year sentinel is preferred over a prior-year carry-over.
export function expandCarrierSentinels(args: {
  networkByPlan: Record<string, Record<string, NetworkSlotRow>>;
  sentinelRows: ReadonlyArray<CarrierSentinelRow>;
  realRows: ReadonlyArray<RealNetworkRow>;
  carrierMap: Map<string, CarrierId>;
  requestedIds: ReadonlyArray<string>;
  npis: ReadonlyArray<string>;
  requestedYear: number;
}): void {
  const { networkByPlan, sentinelRows, realRows, carrierMap, requestedIds, npis, requestedYear } = args;
  if (sentinelRows.length === 0) return;

  // (npi → carrier → best sentinel), preferring a requested-year row.
  const sentinelByNpiCarrier = new Map<string, Map<CarrierId, CarrierSentinelRow>>();
  for (const row of sentinelRows) {
    const cid = (row.source ?? '').replace(/^fhir_/, '') as CarrierId;
    if (!FHIR_CARRIER_IDS.includes(cid)) continue;
    const inner = sentinelByNpiCarrier.get(row.npi) ?? new Map<CarrierId, CarrierSentinelRow>();
    const prev = inner.get(cid);
    if (!prev || (row.plan_year === requestedYear && prev.plan_year !== requestedYear)) {
      inner.set(cid, row);
    }
    sentinelByNpiCarrier.set(row.npi, inner);
  }

  // Carriers that returned a trusted DIRECTORY row for an NPI — only then is the
  // carrier's own sentinel stale and ignored. A medicare_gov (Plan Finder) row
  // must NOT count: Plan Finder under-reports in-network doctors, and a stale PF
  // "not covered" carried over from last year would otherwise suppress the
  // carrier's not_listed verdict (Klein on BCBS NC / Humana read "?" instead of
  // ✗). A broker confirm is a human verdict, resolved by per-plan slot
  // precedence, not a directory answer.
  const foundCarrierByNpi = new Map<string, Set<CarrierId>>();
  for (const r of realRows) {
    if (!isCarrierDirectorySource(r.source)) continue;
    const cid = carrierForContractId(carrierMap, (r.plan_id ?? '').split('-')[0]);
    if (!cid) continue;
    const s = foundCarrierByNpi.get(r.npi) ?? new Set<CarrierId>();
    s.add(cid);
    foundCarrierByNpi.set(r.npi, s);
  }

  for (const id of requestedIds) {
    const t = splitContract(id);
    if (!t) continue;
    const carrier = carrierForContractId(carrierMap, t.contract);
    if (!carrier) continue;
    for (const npi of npis) {
      const verdict = sentinelByNpiCarrier.get(npi)?.get(carrier);
      if (!verdict) continue;
      if (foundCarrierByNpi.get(npi)?.has(carrier)) continue; // real row wins carrier-wide
      const slot = (networkByPlan[id] ||= {});
      if (slot[npi]) continue; // a real / broker row already answers this (plan, npi)
      slot[npi] = {
        plan_id: `${t.contract}-${t.plan}`,
        segment_id: t.segment,
        npi,
        covered: false, // trusted carrier negative → out_of_network at Gate 1
        source: `fhir_${carrier}`,
        checked_at: verdict.checked_at,
        plan_year: verdict.plan_year,
      };
    }
  }
}
