// Rob's ruling (Oct 11, 2026): Plan Finder wins every time when doctor-network
// sources disagree. Used by plan-brain-data (brain Gate 1 input), the
// networkCheck fallback, the status endpoint and the Enroll proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outranks, pickRowsOfRecord, sourceRank } from '../../api/_lib/network-row-precedence';

type R = { plan_id: string; npi: string; covered: boolean; source: string; checked_at: string };
const key = (r: R) => `${r.plan_id}|${r.npi}`;

test('Plan Finder beats a newer carrier, broker or Insurelytix row', () => {
  const rows: R[] = [
    { plan_id: 'H5253-189', npi: '1619976297', covered: true, source: 'fhir_humana', checked_at: '2026-10-12' },
    { plan_id: 'H5253-189', npi: '1619976297', covered: true, source: 'insurelytix', checked_at: '2026-10-12' },
    { plan_id: 'H5253-189', npi: '1619976297', covered: true, source: 'broker_verified', checked_at: '2026-10-12' },
    { plan_id: 'H5253-189', npi: '1619976297', covered: false, source: 'medicare_gov', checked_at: '2026-10-01' },
  ];
  const w = pickRowsOfRecord(rows, key).get('H5253-189|1619976297')!;
  assert.equal(w.source, 'medicare_gov');
  assert.equal(w.covered, false); // a later "in network" never overrides Plan Finder's "out"
});

test('order of rows does not change the answer (was last-row-wins)', () => {
  const a: R = { plan_id: 'P', npi: 'N', covered: true, source: 'insurelytix', checked_at: '2026-10-12' };
  const b: R = { plan_id: 'P', npi: 'N', covered: false, source: 'fhir_uhc', checked_at: '2026-10-01' };
  assert.equal(pickRowsOfRecord([a, b], key).get('P|N')!.source, 'fhir_uhc');
  assert.equal(pickRowsOfRecord([b, a], key).get('P|N')!.source, 'fhir_uhc');
});

test('one "in network" row no longer beats everything (was any-true-wins)', () => {
  const rows: R[] = [
    { plan_id: 'P', npi: 'N', covered: true, source: 'insurelytix', checked_at: '2026-10-12' },
    { plan_id: 'P', npi: 'N', covered: false, source: 'fhir_anthem', checked_at: '2026-10-02' },
  ];
  assert.equal(pickRowsOfRecord(rows, key).get('P|N')!.covered, false);
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

test('rank order: Plan Finder < broker < carrier directory < Insurelytix < unknown', () => {
  assert.ok(sourceRank('medicare_gov') < sourceRank('broker_verified'));
  assert.ok(sourceRank('broker_verified') < sourceRank('fhir_anthem'));
  assert.ok(sourceRank('fhir_anthem') < sourceRank('insurelytix'));
  assert.ok(sourceRank('insurelytix') < sourceRank('legacy_unknown'));
  assert.equal(outranks({ source: 'healthteam' }, { source: 'insurelytix' }), true);
});
