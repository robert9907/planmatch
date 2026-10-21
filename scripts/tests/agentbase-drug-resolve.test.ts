// Regression (Rob, 2026-10-20 — Janet Moses, AgentBase client #21):
// the CRM row "oxycodone hydrochloride" dose "5mg" was resolved to
// "Oxycontin 10 MG" (12 HR extended-release) — a different drug at double
// the strength. The precision query "oxycodone 5 MG" returned only OxyContin
// rows; with no 5 MG row in that result set the resolver fell back to the
// full list and stopped, never trying "oxycodone hydrochloride 5 MG", which
// returns the correct 5 MG immediate-release tablet.
//
// Search results below are verbatim from /api/library/drug-search.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentBaseDrugs } from '../../src/lib/resolveAgentBaseDrugs';
import type { RxNormDrug } from '../../src/lib/rxnorm';

function drug(rxcui: string, name: string, brand: string | null, strength: string): RxNormDrug {
  return {
    rxcui,
    name,
    brand_name: brand,
    generic_name: null,
    strength,
    dose_form: null,
  } as unknown as RxNormDrug;
}

const OXYCONTIN_ROWS = [
  drug('1049504', 'Abuse-Deterrent 12 HR oxycodone hydrochloride 10 MG Extended Release Oral Tablet [Oxycontin]', 'Oxycontin', '10 MG'),
  drug('1049545', 'Abuse-Deterrent 12 HR oxycodone hydrochloride 15 MG Extended Release Oral Tablet [Oxycontin]', 'Oxycontin', '15 MG'),
  drug('1049565', 'Abuse-Deterrent 12 HR oxycodone hydrochloride 20 MG Extended Release Oral Tablet [Oxycontin]', 'Oxycontin', '20 MG'),
];
const OXY_HCL_5 = [
  drug('1049621', 'oxycodone hydrochloride 5 MG Oral Tablet', null, '5 MG'),
  drug('1049696', 'oxycodone hydrochloride 5 MG Oral Capsule', null, '5 MG'),
  drug('1944541', 'Abuse-Deterrent oxycodone hydrochloride 5 MG Oral Tablet', null, '5 MG'),
  drug('1664448', 'oxycodone hydrochloride 5 MG Oral Tablet [Oxaydo]', 'Oxaydo', '5 MG'),
];

function fakeSearch(table: Record<string, RxNormDrug[]>) {
  return async (q: string): Promise<RxNormDrug[]> => table[q.toLowerCase()] ?? OXYCONTIN_ROWS;
}

test('oxycodone 5mg resolves to the 5 MG IR tablet, never OxyContin 10 MG', async () => {
  const [r] = await resolveAgentBaseDrugs(
    [{ id: 'a', name: 'oxycodone hydrochloride', dose: '5mg' }],
    undefined,
    fakeSearch({ 'oxycodone hydrochloride 5 mg': OXY_HCL_5 }),
  );
  assert.equal(r.rxcui, '1049621');
  assert.equal(r.strengthMatched, true);
});

test('no strength match anywhere → unresolved (re-search), not a wrong-strength guess', async () => {
  const [r] = await resolveAgentBaseDrugs(
    [{ id: 'b', name: 'oxycodone hydrochloride', dose: '5mg' }],
    undefined,
    fakeSearch({}),
  );
  assert.equal(r.rxcui, null);
  assert.equal(r.resolved, false);
});

test('a CRM row that already carries an rxcui is trusted unchanged', async () => {
  const [r] = await resolveAgentBaseDrugs(
    [{ id: 'c', name: 'hydralazine hydrochloride 10 MG', dose: '10 MG', rxcui: '905199' }],
    undefined,
    fakeSearch({}),
  );
  assert.equal(r.rxcui, '905199');
  assert.equal(r.hadInputRxcui, true);
});
