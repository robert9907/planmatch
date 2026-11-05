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

// Regression (2026-10-21 — Cynthia Kline, AgentBase #394). Search results
// below are verbatim from /api/library/drug-search.
import { parseStrengths, strengthsMatch } from '../../src/lib/resolveAgentBaseDrugs';

const table: Record<string, RxNormDrug[]> = {
  'fluticasone propionate nasal spray': [
    drug('1797907', 'fluticasone propionate 0.05 MG/ACTUAT Metered Dose Nasal Spray', null, '0.05 MG/ACTUAT'),
    drug('1946583', 'fluticasone propionate 0.093 MG/ACTUAT Metered Dose Nasal Spray', null, '0.093 MG/ACTUAT'),
  ],
  'hydrocodone 10 mg / acetaminophen 325 mg': [
    drug('856999', 'acetaminophen 325 MG / hydrocodone bitartrate 10 MG Oral Tablet', null, '325 MG'),
    drug('857001', 'acetaminophen 325 MG / hydrocodone bitartrate 10 MG Oral Tablet [Norco]', 'Norco', '325 MG'),
  ],
  'hydrocodone acetaminophen': [
    drug('856987', 'acetaminophen 300 MG / hydrocodone bitartrate 5 MG Oral Tablet', null, '300 MG'),
  ],
  'estradiol vaginal cream': [
    drug('310169', 'estradiol 0.1 MG/ML Vaginal Cream', null, '0.1 MG/ML'),
    drug('890918', 'estradiol 0.1 MG/ML Vaginal Cream [Estrace]', 'Estrace', '0.1 MG/ML'),
  ],
  zepbound: [
    drug('2669706', '0.5 ML tirzepatide 5 MG/ML Auto-Injector [Zepbound]', 'Zepbound', '5 MG/ML'),
    drug('2669709', '0.5 ML tirzepatide 10 MG/ML Auto-Injector [Zepbound]', 'Zepbound', '10 MG/ML'),
  ],
};
const realSearch = async (q: string): Promise<RxNormDrug[]> => table[q.toLowerCase()] ?? [];

test('fluticasone nasal spray, USP 50 mcg → the 0.05 MG/ACTUAT nasal spray', async () => {
  const [r] = await resolveAgentBaseDrugs([{ id: 'f', name: 'Fluticasone Propionate Nasal Spray, USP', dose: '50 mcg' }], undefined, realSearch);
  assert.equal(r.rxcui, '1797907');
});

test('hydrocodone-acetaminophen "10-325" → 10/325, never 5/300', async () => {
  const [r] = await resolveAgentBaseDrugs([{ id: 'h', name: 'HYDROcodone-ACETAMINOPHEN', dose: '10-325' }], undefined, realSearch);
  assert.equal(r.rxcui, '856999');
  assert.equal(r.strengthMatched, true);
});

test('estradiol cream 0.01% → 0.1 MG/ML vaginal cream', async () => {
  const [r] = await resolveAgentBaseDrugs([{ id: 'e', name: 'Estradiol Vaginal Cream', dose: '0.01%' }], undefined, realSearch);
  assert.equal(r.rxcui, '310169');
});

test('Zepbound "5 mg/0.5 mL" → the 10 MG/ML Zepbound pen', async () => {
  const [r] = await resolveAgentBaseDrugs([{ id: 'z', name: 'ZEPBOUND', dose: '5 mg/0.5 mL' }], undefined, realSearch);
  assert.equal(r.rxcui, '2669709');
});

test('strength parsing: units, ratios, percent', () => {
  assert.ok(strengthsMatch(parseStrengths('50 mcg'), parseStrengths('fluticasone propionate 0.05 MG/ACTUAT Nasal Spray')));
  assert.ok(strengthsMatch(parseStrengths('5 mg/0.5 mL'), parseStrengths('0.5 ML tirzepatide 10 MG/ML Auto-Injector')));
  assert.ok(!strengthsMatch(parseStrengths('5 mg/0.5 mL'), parseStrengths('0.5 ML tirzepatide 5 MG/ML Auto-Injector')));
  assert.ok(strengthsMatch(parseStrengths('0.01%'), parseStrengths('estradiol 0.1 MG/ML Vaginal Cream')));
  assert.ok(!strengthsMatch(parseStrengths('10-325', true), parseStrengths('acetaminophen 300 MG / hydrocodone bitartrate 5 MG')));
  assert.ok(strengthsMatch(parseStrengths('20MG'), parseStrengths('atorvastatin 20 MG Oral Tablet')));
});

// Regression (2026-10-21, live): drug-search 500s on a query with a comma
// ("Fluticasone Propionate Nasal Spray, USP 50 MCG"). One failing query must
// not abort the remaining variants.
test('a failing search query does not stop the remaining variants', async () => {
  const flaky = async (q: string): Promise<RxNormDrug[]> => {
    if (q.includes(',')) throw new Error('library/drug-search 500');
    return table[q.toLowerCase()] ?? [];
  };
  const [r] = await resolveAgentBaseDrugs([{ id: 'f', name: 'Fluticasone Propionate Nasal Spray, USP', dose: '50 mcg' }], undefined, flaky);
  assert.equal(r.rxcui, '1797907');
});

// Regression (Rob, 2026-11-05 — Laura Goodman, AgentBase #401): the CRM
// row "Levothyroxine" 112mcg tablet carried rxcui 966407 — levothyroxine
// 0.05 MG Oral CAPSULE, wrong strength AND form — and the resolver trusted
// any stored rxcui unchanged, so Meds showed "Tier ? · Not covered" on all
// 46 plans for a drug on every 2027 formulary. A stored rxcui on an oral
// solid is now checked against the row's filed dose/form and re-resolved
// when it disagrees.
const LEVO_112 = [
  drug('966248', 'levothyroxine sodium 0.112 MG Oral Tablet', null, '0.112 MG'),
  drug('966185', 'levothyroxine sodium 0.112 MG Oral Tablet [Synthroid]', 'Synthroid', '0.112 MG'),
];
const ROSU_10 = [
  drug('2167557', 'rosuvastatin 10 MG Oral Capsule', null, '10 MG'),
  drug('859747', 'rosuvastatin calcium 10 MG Oral Tablet', null, '10 MG'),
];
const concepts: Record<string, string> = {
  '966407': 'levothyroxine sodium 0.05 MG Oral Capsule',
  '905199': 'hydralazine hydrochloride 10 MG Oral Tablet',
  '2167557': 'rosuvastatin 10 MG Oral Capsule',
  '2398842': '3 ML semaglutide 1.34 MG/ML Pen Injector [Ozempic]',
};
const lookup = async (ids: string[]): Promise<Record<string, string>> =>
  Object.fromEntries(ids.filter((id) => concepts[id]).map((id) => [id, concepts[id]]));

test('stored rxcui at the wrong strength/form is re-resolved (levothyroxine 112 mcg tablet)', async () => {
  const [r] = await resolveAgentBaseDrugs(
    [{ id: '3229', name: 'Levothyroxine', dose: '112mcg', form: 'tablet', rxcui: '966407' }],
    undefined,
    fakeSearch({ 'levothyroxine 0.112 mg': LEVO_112, 'levothyroxine 112 mcg': LEVO_112 }),
    lookup,
  );
  assert.equal(r.rxcui, '966248');
  assert.equal(r.correctedFrom, '966407');
  assert.equal(r.hadInputRxcui, false);
  assert.equal(r.strengthMatched, true);
});

test('stored rxcui with the wrong form is re-resolved (rosuvastatin 10 mg tablet stored as capsule)', async () => {
  const [r] = await resolveAgentBaseDrugs(
    [{ id: '3196', name: 'Rosuvastatin', dose: '10mg', form: 'tablet', rxcui: '2167557' }],
    undefined,
    fakeSearch({ 'rosuvastatin 10 mg': ROSU_10 }),
    lookup,
  );
  assert.equal(r.rxcui, '859747');
  assert.equal(r.correctedFrom, '2167557');
});

test('stored rxcui that agrees with the filed dose is kept', async () => {
  const [r] = await resolveAgentBaseDrugs(
    [{ id: 'c', name: 'hydralazine hydrochloride 10 MG', dose: '10 MG', rxcui: '905199' }],
    undefined,
    fakeSearch({}),
    lookup,
  );
  assert.equal(r.rxcui, '905199');
  assert.equal(r.hadInputRxcui, true);
  assert.equal(r.correctedFrom, undefined);
});

test('stored injectable rxcui is not second-guessed on a per-dose strength', async () => {
  const [r] = await resolveAgentBaseDrugs(
    [{ id: 'o', name: 'Ozempic', dose: '1mg', rxcui: '2398842' }],
    undefined,
    fakeSearch({}),
    lookup,
  );
  assert.equal(r.rxcui, '2398842');
  assert.equal(r.hadInputRxcui, true);
});

test('stored wrong rxcui with no correct match → unresolved, never the wrong drug', async () => {
  const [r] = await resolveAgentBaseDrugs(
    [{ id: 'n', name: 'levothyroxine sodium', dose: '150mcg', form: 'tablet', rxcui: '966407' }],
    undefined,
    async () => [],
    lookup,
  );
  assert.equal(r.rxcui, null);
  assert.equal(r.correctedFrom, '966407');
});
