// Gate-1 fix: the Compare server path (api/plan-brain-data.ts) must expand
// carrier-WIDE sentinels (__NPI_NOT_FOUND__ → not_listed, __NPI_NO_MA_NETWORK__
// → out_of_network) onto the carrier's real requested plans, so a doctor who
// is not in a carrier's Medicare directory eliminates that carrier's plans at
// Gate 1. These assert the precedence: real per-plan rows and attributed
// broker rows beat a sentinel; a carrier that answered for the NPI has its
// (stale) sentinel ignored carrier-wide; a carrier with no sentinel is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  expandCarrierSentinels,
  NPI_NOT_FOUND_PLAN_ID,
  NPI_NO_MA_NETWORK_PLAN_ID,
  type NetworkSlotRow,
  type CarrierId,
} from '../../api/_lib/fhir-plan-network';

const KLEIN = '1619976297';
const YEAR = 2027;

// Durham-shaped: BCBS NC, Humana, HealthTeam, Wellcare plans.
const CARRIER_MAP = new Map<string, CarrierId>([
  ['H3449', 'bcbsnc'],
  ['H1036', 'humana'],
  ['H9772', 'healthteam'],
  ['H1234', 'wellcare'],
]);
const sentinel = (npi: string, source: string, plan_id = NPI_NOT_FOUND_PLAN_ID, plan_year = YEAR) =>
  ({ plan_id, npi, source, checked_at: '2026-10-18T00:00:00Z', plan_year });

test('Klein not_listed: TRUSTED carriers (Humana, HealthTeam) eliminate; an UNTRUSTED directory (BCBS NC) stays call-to-verify; Wellcare in-network survives', () => {
  const networkByPlan: Record<string, Record<string, NetworkSlotRow>> = {
    // Wellcare has a real in-network row — Klein IS on Wellcare.
    'H1234-001-000': { [KLEIN]: { plan_id: 'H1234-001', segment_id: '0', npi: KLEIN, covered: true, source: 'fhir_wellcare', plan_year: YEAR } },
  };
  expandCarrierSentinels({
    networkByPlan,
    sentinelRows: [
      sentinel(KLEIN, 'fhir_bcbsnc'),      // __NPI_NOT_FOUND__ from an UNTRUSTED directory
      sentinel(KLEIN, 'fhir_humana'),      // trusted
      sentinel(KLEIN, 'fhir_healthteam'),  // trusted
    ],
    realRows: [{ plan_id: 'H1234-001', npi: KLEIN, source: 'fhir_wellcare' }],
    carrierMap: CARRIER_MAP,
    requestedIds: ['H3449-024-000', 'H1036-123-000', 'H9772-001-000', 'H1234-001-000'],
    npis: [KLEIN],
    requestedYear: YEAR,
  });
  // Humana + HealthTeam not-found → trusted covered=false → eliminated.
  for (const id of ['H1036-123-000', 'H9772-001-000']) {
    assert.equal(networkByPlan[id]?.[KLEIN]?.covered, false, `${id} should be out`);
    assert.ok((networkByPlan[id][KLEIN].source ?? '').startsWith('fhir_'), `${id} trusted source`);
  }
  // BCBS NC not-found is NOT trusted to eliminate (unreliable directory) → no
  // slot written → the plan stays 'unknown' ("call to verify") downstream.
  assert.equal(networkByPlan['H3449-024-000']?.[KLEIN], undefined, 'BCBS NC not_listed must NOT eliminate');
  // Wellcare keeps its real in-network row — survives.
  assert.equal(networkByPlan['H1234-001-000'][KLEIN].covered, true);
  assert.equal(networkByPlan['H1234-001-000'][KLEIN].source, 'fhir_wellcare');
});

test('a real in-network row beats a stale same-carrier sentinel — carrier-wide', () => {
  const networkByPlan: Record<string, Record<string, NetworkSlotRow>> = {
    'H3449-024-000': { [KLEIN]: { plan_id: 'H3449-024', segment_id: '0', npi: KLEIN, covered: true, source: 'fhir_bcbsnc', plan_year: YEAR } },
  };
  expandCarrierSentinels({
    networkByPlan,
    sentinelRows: [sentinel(KLEIN, 'fhir_bcbsnc')],
    realRows: [{ plan_id: 'H3449-024', npi: KLEIN, source: 'fhir_bcbsnc' }],
    carrierMap: CARRIER_MAP,
    // a second BCBS plan with NO real row — the stale sentinel must NOT apply,
    // because BCBS answered for this NPI elsewhere (found carrier-wide).
    requestedIds: ['H3449-024-000', 'H3449-099-000'],
    npis: [KLEIN],
    requestedYear: YEAR,
  });
  assert.equal(networkByPlan['H3449-024-000'][KLEIN].covered, true, 'confirmed plan untouched');
  assert.equal(networkByPlan['H3449-099-000']?.[KLEIN], undefined, 'sentinel ignored carrier-wide');
});

test('an attributed broker ✓ beats a sentinel on the confirmed plan', () => {
  const networkByPlan: Record<string, Record<string, NetworkSlotRow>> = {
    'H3449-024-000': { [KLEIN]: { plan_id: 'H3449-024', segment_id: '0', npi: KLEIN, covered: true, source: 'broker_verified', plan_year: YEAR } },
  };
  expandCarrierSentinels({
    networkByPlan,
    sentinelRows: [sentinel(KLEIN, 'fhir_bcbsnc')],
    realRows: [{ plan_id: 'H3449-024', npi: KLEIN, source: 'broker_verified' }],
    carrierMap: CARRIER_MAP,
    requestedIds: ['H3449-024-000'],
    npis: [KLEIN],
    requestedYear: YEAR,
  });
  assert.equal(networkByPlan['H3449-024-000'][KLEIN].covered, true);
  assert.equal(networkByPlan['H3449-024-000'][KLEIN].source, 'broker_verified');
});

test('a carrier with no sentinel row is kept (no_data / error → unknown, not eliminated)', () => {
  const networkByPlan: Record<string, Record<string, NetworkSlotRow>> = {};
  expandCarrierSentinels({
    networkByPlan,
    sentinelRows: [sentinel(KLEIN, 'fhir_humana')], // only Humana (trusted) answered definitively
    realRows: [],
    carrierMap: CARRIER_MAP,
    requestedIds: ['H1036-123-000', 'H3449-024-000'], // BCBS returned no sentinel
    npis: [KLEIN],
    requestedYear: YEAR,
  });
  assert.equal(networkByPlan['H1036-123-000']?.[KLEIN]?.covered, false, 'Humana eliminated');
  assert.equal(networkByPlan['H3449-024-000']?.[KLEIN], undefined, 'BCBS kept (no sentinel)');
});

test('__NPI_NO_MA_NETWORK__ resolves to a trusted covered=false (out_of_network)', () => {
  const networkByPlan: Record<string, Record<string, NetworkSlotRow>> = {};
  expandCarrierSentinels({
    networkByPlan,
    sentinelRows: [sentinel(KLEIN, 'fhir_bcbsnc', NPI_NO_MA_NETWORK_PLAN_ID)],
    realRows: [],
    carrierMap: CARRIER_MAP,
    requestedIds: ['H3449-024-000'],
    npis: [KLEIN],
    requestedYear: YEAR,
  });
  assert.equal(networkByPlan['H3449-024-000'][KLEIN].covered, false);
});

test('a stale medicare_gov row does NOT suppress a carrier sentinel (Klein BCBS/Humana "?" bug)', () => {
  // Klein has only a prior-year medicare_gov covered=false row on BCBS/Humana
  // (Plan Finder under-reports). That non-trusted row must NOT count as "the
  // carrier answered" — the fhir_bcbsnc / fhir_humana not_listed sentinel must
  // still eliminate. In plan-brain-data the medicare_gov covered=false slot is
  // dropped before expansion, so the slot is empty here; the risk is purely
  // foundCarrierByNpi wrongly including the carrier off the medicare_gov row.
  // bcbsnc uses a NO_MA_NETWORK sentinel (positive finding — eliminates
  // regardless of the completeness gate); humana a trusted NOT_FOUND. Both must
  // survive the stale medicare_gov row (which must NOT count as "carrier answered").
  const networkByPlan: Record<string, Record<string, NetworkSlotRow>> = {};
  expandCarrierSentinels({
    networkByPlan,
    sentinelRows: [sentinel(KLEIN, 'fhir_bcbsnc', NPI_NO_MA_NETWORK_PLAN_ID), sentinel(KLEIN, 'fhir_humana')],
    realRows: [
      { plan_id: 'H3449-012', npi: KLEIN, source: 'medicare_gov' }, // stale PF, must not count
      { plan_id: 'H1036-167', npi: KLEIN, source: 'medicare_gov' },
    ],
    carrierMap: new Map<string, CarrierId>([['H3449', 'bcbsnc'], ['H1036', 'humana']]),
    requestedIds: ['H3449-012-000', 'H1036-167-000'],
    npis: [KLEIN],
    requestedYear: YEAR,
  });
  assert.equal(networkByPlan['H3449-012-000'][KLEIN].covered, false, 'BCBS no-MA-network eliminated despite PF row');
  assert.equal(networkByPlan['H1036-167-000'][KLEIN].covered, false, 'Humana eliminated despite PF row');
});

test('a real fhir in-network row DOES suppress the same-carrier sentinel carrier-wide', () => {
  const networkByPlan: Record<string, Record<string, NetworkSlotRow>> = {
    'H3449-012-000': { [KLEIN]: { plan_id: 'H3449-012', segment_id: '0', npi: KLEIN, covered: true, source: 'fhir_bcbsnc', plan_year: YEAR } },
  };
  expandCarrierSentinels({
    networkByPlan,
    sentinelRows: [sentinel(KLEIN, 'fhir_bcbsnc')],
    realRows: [{ plan_id: 'H3449-012', npi: KLEIN, source: 'fhir_bcbsnc' }],
    carrierMap: new Map<string, CarrierId>([['H3449', 'bcbsnc']]),
    requestedIds: ['H3449-012-000', 'H3449-099-000'],
    npis: [KLEIN],
    requestedYear: YEAR,
  });
  assert.equal(networkByPlan['H3449-012-000'][KLEIN].covered, true);
  assert.equal(networkByPlan['H3449-099-000']?.[KLEIN], undefined, 'trusted directory row suppresses carrier-wide');
});

test('a requested-year sentinel is preferred over a prior-year carry-over', () => {
  const networkByPlan: Record<string, Record<string, NetworkSlotRow>> = {};
  expandCarrierSentinels({
    networkByPlan,
    sentinelRows: [
      sentinel(KLEIN, 'fhir_humana', NPI_NOT_FOUND_PLAN_ID, 2026), // prior-year
      sentinel(KLEIN, 'fhir_humana', NPI_NOT_FOUND_PLAN_ID, 2027), // requested-year
    ],
    realRows: [],
    carrierMap: CARRIER_MAP,
    requestedIds: ['H1036-123-000'],
    npis: [KLEIN],
    requestedYear: YEAR,
  });
  assert.equal(networkByPlan['H1036-123-000'][KLEIN].plan_year, 2027);
});

// Completeness gate (Rob, 2026-10-26): a __NPI_NOT_FOUND__ absence only
// eliminates for a bulk-complete+reliable carrier; an unreliable directory's
// absence stays call-to-verify. A __NPI_NO_MA_NETWORK__ positive finding is
// never gated.
test('gate: BCBS NC (untrusted) __NPI_NOT_FOUND__ does NOT eliminate, but its __NPI_NO_MA_NETWORK__ does', () => {
  const nf: Record<string, Record<string, NetworkSlotRow>> = {};
  expandCarrierSentinels({
    networkByPlan: nf,
    sentinelRows: [sentinel(KLEIN, 'fhir_bcbsnc', NPI_NOT_FOUND_PLAN_ID)],
    realRows: [],
    carrierMap: CARRIER_MAP,
    requestedIds: ['H3449-024-000'],
    npis: [KLEIN],
    requestedYear: YEAR,
  });
  assert.equal(nf['H3449-024-000']?.[KLEIN], undefined, 'untrusted NOT_FOUND → call to verify, not eliminated');

  const noma: Record<string, Record<string, NetworkSlotRow>> = {};
  expandCarrierSentinels({
    networkByPlan: noma,
    sentinelRows: [sentinel(KLEIN, 'fhir_bcbsnc', NPI_NO_MA_NETWORK_PLAN_ID)],
    realRows: [],
    carrierMap: CARRIER_MAP,
    requestedIds: ['H3449-024-000'],
    npis: [KLEIN],
    requestedYear: YEAR,
  });
  assert.equal(noma['H3449-024-000']?.[KLEIN]?.covered, false, 'NO_MA_NETWORK positive finding still eliminates');
});
