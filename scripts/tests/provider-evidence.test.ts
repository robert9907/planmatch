// Enrollment doctor-network proof (Rob, Oct 2026): at Enroll, each doctor's
// network answer for the exact plan + plan year is recorded from the
// database, with its source and check date. A doctor with no answer is
// recorded as not_confirmed — never assumed in or out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceRows, pickRowOfRecord, type CacheRowLite } from '../../api/_lib/providerEvidence';

const base = {
  sessionId: 's1', agentbaseClientId: 7, clientName: 'Test Client', planYear: 2027,
  contractId: 'H5253', planId: '189', segmentId: '0',
};

test('no cache row → not_confirmed with no source', () => {
  const rows = buildEvidenceRows({
    ...base,
    providers: [{ npi: '1619976297', name: 'Dr A', network_status: 'in' }],
    cacheRows: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'not_confirmed');
  assert.equal(rows[0].source, null);
  assert.equal(rows[0].shown_to_broker, 'in'); // what the screen showed is kept for comparison
});

test('covered row → in_network with its source and date', () => {
  const cacheRows: CacheRowLite[] = [
    { plan_id: 'H5253-189', segment_id: '0', npi: '1619976297', covered: true, source: 'fhir_humana', checked_at: '2026-10-12T09:10:00Z' },
  ];
  const [r] = buildEvidenceRows({ ...base, providers: [{ npi: '1619976297', name: 'Dr A', network_status: 'in' }], cacheRows });
  assert.equal(r.status, 'in_network');
  assert.equal(r.source, 'fhir_humana');
  assert.equal(r.source_checked_at, '2026-10-12T09:10:00Z');
});

test('another plan\'s row never answers for this plan', () => {
  const cacheRows: CacheRowLite[] = [
    { plan_id: 'H5253-190', segment_id: '0', npi: '1619976297', covered: true, source: 'fhir_humana', checked_at: '2026-10-12T09:10:00Z' },
  ];
  const [r] = buildEvidenceRows({ ...base, providers: [{ npi: '1619976297', name: 'Dr A', network_status: 'unknown' }], cacheRows });
  assert.equal(r.status, 'not_confirmed');
});

test('exact segment wins, then newest check', () => {
  const rows: CacheRowLite[] = [
    { plan_id: 'H5253-189', segment_id: '002', npi: 'x', covered: true, source: 'a', checked_at: '2026-10-12' },
    { plan_id: 'H5253-189', segment_id: '000', npi: 'x', covered: false, source: 'b', checked_at: '2026-10-01' },
    { plan_id: 'H5253-189', segment_id: '0', npi: 'x', covered: true, source: 'c', checked_at: '2026-10-05' },
  ];
  assert.equal(pickRowOfRecord(rows, '0')?.source, 'c');
  assert.equal(pickRowOfRecord(rows, '002')?.source, 'a');
});

test('doctor with no NPI is still recorded, as not_confirmed', () => {
  const [r] = buildEvidenceRows({ ...base, providers: [{ npi: '', name: 'Dr No NPI', network_status: 'unknown' }], cacheRows: [] });
  assert.equal(r.status, 'not_confirmed');
  assert.equal(r.provider_name, 'Dr No NPI');
});
