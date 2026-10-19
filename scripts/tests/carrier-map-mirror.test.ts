// Drift guard for the contract→carrier map that is MIRRORED (not shared)
// between this repo (agent-v3, api/_lib/fhir-plan-network.ts) and the consumer
// (robert9907/plan-match, api/_lib/fhir-provider.ts: loadContractToCarrierMap +
// carrierForContractId + API_DEFAULT_CARRIERS). The two read the SAME
// pm_fhir_plan_network rows with the SAME algorithm; they can only disagree if
// (a) their FHIR carrier sets differ, or (b) a contract is claimed by more than
// one carrier in the data (first-write-wins becomes order-dependent). This test
// pins (a) and the agent's algorithm to the shared spec; the daily cron
// /api/audit-carrier-map-mirror in plan-match watches (b) against live data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContractToCarrierMap,
  FHIR_CARRIER_IDS,
  type CarrierId,
  type PlanNetworkRow,
} from '../../api/_lib/fhir-plan-network';

// The canonical FHIR carrier set both repos MUST agree on. If a carrier is
// added to one directory, it must be added here AND to the consumer's
// API_DEFAULT_CARRIERS in the same change — otherwise the maps diverge.
const CANONICAL_FHIR_CARRIERS = ['anthem', 'bcbsnc', 'devoted', 'healthteam', 'humana', 'uhc', 'wellcare'];

// Reference implementation = the consumer's documented algorithm
// (loadContractToCarrierMap in plan-match api/_lib/fhir-provider.ts): first row
// per contract wins, a requested-year row upgrades a fallback-year claim,
// scoped to the canonical carrier set. If the agent's copy drifts from this,
// the assertion below fails.
function referenceMap(rows: ReadonlyArray<PlanNetworkRow>, requestedYear: number): Map<string, CarrierId> {
  const map = new Map<string, CarrierId>();
  const year = new Map<string, number | null>();
  for (const r of rows) {
    if (!CANONICAL_FHIR_CARRIERS.includes(r.carrier_id)) continue;
    if (!map.has(r.contract_id)) {
      map.set(r.contract_id, r.carrier_id);
      year.set(r.contract_id, r.plan_year);
    } else if (r.plan_year === requestedYear && year.get(r.contract_id) !== requestedYear) {
      map.set(r.contract_id, r.carrier_id);
      year.set(r.contract_id, r.plan_year);
    }
  }
  return map;
}

const eq = (a: Map<string, CarrierId>, b: Map<string, CarrierId>) =>
  a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

test('agent FHIR carrier set matches the canonical set (consumer API_DEFAULT_CARRIERS)', () => {
  assert.deepEqual([...FHIR_CARRIER_IDS].sort(), [...CANONICAL_FHIR_CARRIERS].sort());
});

test('agent map == consumer reference on the same rows (single carrier per contract)', () => {
  const rows: PlanNetworkRow[] = [
    { carrier_id: 'bcbsnc', contract_id: 'H3449', plan_year: 2027 },
    { carrier_id: 'humana', contract_id: 'H1036', plan_year: 2027 },
    { carrier_id: 'uhc', contract_id: 'H5253', plan_year: 2027 },
    { carrier_id: 'wellcare', contract_id: 'H0111', plan_year: 2026 },
  ];
  assert.ok(eq(buildContractToCarrierMap(rows, 2027), referenceMap(rows, 2027)));
});

test('agent map == consumer reference: requested year upgrades a prior-year claim', () => {
  const rows: PlanNetworkRow[] = [
    { carrier_id: 'humana', contract_id: 'H1036', plan_year: 2026 }, // prior-year first
    { carrier_id: 'humana', contract_id: 'H1036', plan_year: 2027 }, // requested-year upgrades
  ];
  const agent = buildContractToCarrierMap(rows, 2027);
  assert.ok(eq(agent, referenceMap(rows, 2027)));
  assert.equal(agent.get('H1036'), 'humana');
});

test('agent map == consumer reference: non-FHIR carrier rows are ignored', () => {
  const rows = [
    { carrier_id: 'bcbsnc', contract_id: 'H3449', plan_year: 2027 },
    { carrier_id: 'aetna' as CarrierId, contract_id: 'H5521', plan_year: 2027 }, // not in set
  ];
  const agent = buildContractToCarrierMap(rows, 2027);
  assert.ok(eq(agent, referenceMap(rows, 2027)));
  assert.equal(agent.has('H5521'), false);
});

test('both impls agree whenever each contract maps to one carrier (the cron invariant)', () => {
  // When a contract is claimed by two carriers, first-write-wins is
  // order-dependent and the two copies MAY differ — the daily cron alerts on
  // exactly this data condition. Here we assert the safe case holds identically.
  const rows: PlanNetworkRow[] = [
    { carrier_id: 'devoted', contract_id: 'H3080', plan_year: 2027 },
    { carrier_id: 'healthteam', contract_id: 'H2624', plan_year: 2027 },
  ];
  assert.ok(eq(buildContractToCarrierMap(rows, 2027), referenceMap(rows, 2027)));
});
