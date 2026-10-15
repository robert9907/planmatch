// Rob's ruling (Oct 13, 2026) — SUPERSEDES the Oct-11 "Plan Finder wins every
// time" rule, and mirrors the consumer repo: the CARRIER is authoritative on
// its own network. broker_verified > carrier directory
// (fhir_*/healthteam/insurelytix/alignment/healthspring) > medicare_gov >
// other. A medicare_gov "not covered" is UNKNOWN, not out-of-network
// (isTrustedSource). Used by plan-brain-data (brain Gate 1 input), the
// networkCheck fallback and the Enroll proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outranks, pickRowsOfRecord, sourceRank, isTrustedSource } from '../../api/_lib/network-row-precedence';

type R = { plan_id: string; npi: string; covered: boolean; source: string; checked_at: string };
const key = (r: R) => `${r.plan_id}|${r.npi}`;

test('broker-verified beats a newer carrier, Plan Finder or Insurelytix row', () => {
  const rows: R[] = [
    { plan_id: 'H5253-189', npi: '1619976297', covered: false, source: 'fhir_humana', checked_at: '2026-10-12' },
    { plan_id: 'H5253-189', npi: '1619976297', covered: true, source: 'insurelytix', checked_at: '2026-10-12' },
    { plan_id: 'H5253-189', npi: '1619976297', covered: true, source: 'broker_verified', checked_at: '2026-10-11' },
    { plan_id: 'H5253-189', npi: '1619976297', covered: false, source: 'medicare_gov', checked_at: '2026-10-14' },
  ];
  const w = pickRowsOfRecord(rows, key).get('H5253-189|1619976297')!;
  assert.equal(w.source, 'broker_verified'); // a human confirmation wins even if older
  assert.equal(w.covered, true);
});

test('a carrier directory beats medicare_gov even when Plan Finder is newer', () => {
  const rows: R[] = [
    { plan_id: 'H3449-024', npi: '1619976297', covered: true, source: 'fhir_bcbsnc', checked_at: '2026-09-01' },
    { plan_id: 'H3449-024', npi: '1619976297', covered: false, source: 'medicare_gov', checked_at: '2026-10-14' },
  ];
  const w = pickRowsOfRecord(rows, key).get('H3449-024|1619976297')!;
  assert.equal(w.source, 'fhir_bcbsnc'); // the carrier is authoritative on its own network
  assert.equal(w.covered, true);
});

test('order of rows does not change the answer (was last-row-wins)', () => {
  const a: R = { plan_id: 'P', npi: 'N', covered: true, source: 'insurelytix', checked_at: '2026-10-12' };
  const b: R = { plan_id: 'P', npi: 'N', covered: false, source: 'fhir_uhc', checked_at: '2026-10-01' };
  // fhir_uhc and insurelytix are both carrier-tier → freshest wins → insurelytix.
  assert.equal(pickRowsOfRecord([a, b], key).get('P|N')!.source, 'insurelytix');
  assert.equal(pickRowsOfRecord([b, a], key).get('P|N')!.source, 'insurelytix');
});

test('same source → newest check wins; different plans or doctors never mix', () => {
  const rows: R[] = [
    { plan_id: 'P', npi: 'N', covered: false, source: 'fhir_humana', checked_at: '2026-10-01' },
    { plan_id: 'P', npi: 'N', covered: true, source: 'fhir_humana', checked_at: '2026-10-12' },
    { plan_id: 'Q', npi: 'N', covered: false, source: 'medicare_gov', checked_at: '2026-10-12' },
  ];
  const m = pickRowsOfRecord(rows, key);
  assert.equal(m.get('P|N')!.covered, true);
  assert.equal(m.get('Q|N')!.covered, false);
  assert.equal(m.size, 2);
});

test('rank order: broker < carrier directory < Plan Finder < other', () => {
  assert.ok(sourceRank('broker_verified') < sourceRank('fhir_anthem'));
  assert.ok(sourceRank('fhir_anthem') < sourceRank('medicare_gov'));
  assert.ok(sourceRank('medicare_gov') < sourceRank('legacy_unknown'));
  // healthspring and alignment are carrier-tier alongside fhir_* / healthteam / insurelytix.
  assert.equal(sourceRank('healthspring'), sourceRank('fhir_bcbsnc'));
  assert.equal(sourceRank('alignment'), sourceRank('fhir_bcbsnc'));
  assert.equal(outranks({ source: 'healthteam' }, { source: 'medicare_gov' }), true);
});

test('isTrustedSource: carriers + broker are trusted; medicare_gov and unknown are not', () => {
  for (const s of ['broker_verified', 'fhir_bcbsnc', 'fhir_uhc', 'healthteam', 'insurelytix', 'alignment', 'healthspring']) {
    assert.equal(isTrustedSource(s), true, `${s} should be trusted`);
  }
  for (const s of ['medicare_gov', 'plan_finder', 'legacy_unknown', '', null, undefined]) {
    assert.equal(isTrustedSource(s), false, `${String(s)} should NOT be trusted`);
  }
});
