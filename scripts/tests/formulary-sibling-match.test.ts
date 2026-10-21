// Sibling-pick matcher (api/_lib/formulary-sibling-match.ts): combos never
// match a single-ingredient request; among siblings pick by strength + dose
// form + brand/generic; exact rxcui wins. Real pm_formulary row names/tiers
// (CY2027, verified against the DB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDrugProfile, pickBestFormularyRow } from '../../api/_lib/formulary-sibling-match.js';

const row = (rxcui: string, drug_name: string, tier: number | null) => ({ rxcui, drug_name, tier });

test('parseDrugProfile — combo / brand / er / form / strength', () => {
  assert.deepEqual(parseDrugProfile('gabapentin 600 MG'), { combo: false, brand: false, brandName: null, er: false, form: null, route: null, strengths: ['600 MG'] });
  const janumet = parseDrugProfile('24 HR metformin hydrochloride 1000 MG / sitagliptin phosphate 50 MG Extended Release Oral Tablet [Janumet]');
  assert.equal(janumet.combo, true);
  assert.equal(janumet.brand, true);
  assert.equal(janumet.er, true);
  const far = parseDrugProfile('dapagliflozin 10 MG Oral Tablet [Farxiga]');
  assert.equal(far.brand, true);
  assert.equal(far.form, 'tablet');
  assert.deepEqual(far.strengths, ['10 MG']);
  assert.equal(parseDrugProfile('gabapentin 50 MG/ML Oral Solution').form, 'solution');
});

test('A02 gabapentin 600 (SCDC) → tier-2 tablet, NOT tier-4 solution', () => {
  const orig = parseDrugProfile('gabapentin 600 MG'); // rxcui 346145
  const rows = [
    row('283523', 'gabapentin 50 MG/ML Oral Solution', 4),
    row('310433', 'gabapentin 600 MG Oral Tablet', 2),
    row('310431', 'gabapentin 300 MG Oral Capsule', 2),
  ];
  const r = pickBestFormularyRow('346145', orig, rows);
  assert.equal(r.row?.rxcui, '310433');
  assert.equal(r.row?.tier, 2);
});

test('A02 metformin ER 500 → tier-1 plain metformin, Janumet combo EXCLUDED', () => {
  const orig = parseDrugProfile('Modified 24 HR metformin hydrochloride 500 MG Extended Release Oral Tablet'); // 1807915
  const rows = [
    row('1243833', '24 HR metformin hydrochloride 1000 MG / sitagliptin phosphate 50 MG Extended Release Oral Tablet [Janumet]', 3),
    row('860975', '24 HR metformin hydrochloride 500 MG Extended Release Oral Tablet', 1),
    row('861007', 'metformin hydrochloride 500 MG Oral Tablet', 1),
  ];
  const r = pickBestFormularyRow('1807915', orig, rows);
  assert.equal(r.row?.tier, 1);
  assert.equal(r.row?.rxcui, '860975'); // ER form preferred over IR
});

test('combo-only plan → NOT COVERED (null row)', () => {
  const orig = parseDrugProfile('metformin hydrochloride 500 MG'); // plain metformin
  const rows = [
    row('1243833', '24 HR metformin hydrochloride 1000 MG / sitagliptin phosphate 50 MG Extended Release Oral Tablet [Janumet]', 3),
    row('861783', 'metformin hydrochloride 500 MG / pioglitazone 15 MG Oral Tablet', 1),
  ];
  const r = pickBestFormularyRow('860974', orig, rows);
  assert.equal(r.row, null);
  assert.equal(r.excludedCombos, 2);
});

test('A06 Farxiga brand → brand row (exact rxcui wins)', () => {
  const orig = parseDrugProfile('dapagliflozin 10 MG Oral Tablet [Farxiga]'); // 1486977
  const rows = [
    row('1488569', 'dapagliflozin 10 MG Oral Tablet', 1), // generic
    row('1486977', 'dapagliflozin 10 MG Oral Tablet [Farxiga]', 3), // brand (exact)
  ];
  const r = pickBestFormularyRow('1486977', orig, rows);
  assert.equal(r.row?.rxcui, '1486977');
  assert.equal(r.row?.tier, 3);
});

test('brand request, no exact row → prefer the branded sibling', () => {
  const orig = parseDrugProfile('dapagliflozin 10 MG Oral Tablet [Farxiga]');
  const rows = [
    row('1488569', 'dapagliflozin 10 MG Oral Tablet', 1),
    row('9999999', 'dapagliflozin 10 MG Oral Tablet [Farxiga]', 3),
  ];
  const r = pickBestFormularyRow('1486977', orig, rows); // 1486977 not in rows
  assert.equal(r.row?.rxcui, '9999999'); // branded wins on brand parity
});

test('A10 furosemide 80 (SCDC) → tier-1 tablet, not the injection', () => {
  const orig = parseDrugProfile('furosemide 80 MG'); // 317377
  const rows = [
    row('1719286', '10 ML furosemide 10 MG/ML Injection', 2),
    row('197732', 'furosemide 80 MG Oral Tablet', 1),
  ];
  const r = pickBestFormularyRow('317377', orig, rows);
  assert.equal(r.row?.rxcui, '197732');
  assert.equal(r.row?.tier, 1);
});

test('exact rxcui wins even at a higher tier', () => {
  const orig = parseDrugProfile('gabapentin 600 MG');
  const rows = [
    row('310433', 'gabapentin 600 MG Oral Tablet', 2),
    row('346145', 'gabapentin 600 MG', 5), // exact, higher tier
  ];
  const r = pickBestFormularyRow('346145', orig, rows);
  assert.equal(r.row?.rxcui, '346145');
});

test('insulin degludec never matches glargine/aspart (rxcui-expansion + combo guard)', () => {
  // Expansion gives only degludec rows; a plan with none → not covered. (Here
  // the matcher receives only what the plan files from the degludec expansion.)
  const orig = parseDrugProfile('insulin degludec 100 UNT/ML Pen Injector [Tresiba]');
  const r = pickBestFormularyRow('1670008', orig, []); // plan files no degludec sibling
  assert.equal(r.row, null);
});

// ── Inhaler dose-form + route (Rob, 2026-10-20; both surfaces) ──────────
// C08 Denise Holloway albuterol HFA: PF covers it $0 on H5302-012. The HFA
// metered-dose inhaler must win over the nebulizer Inhalation Solution and
// the oral tablet; and an inhaler never crosses to a nasal spray / topical.
test('parseDrugProfile — inhaler form + inhaled route; nebulizer solution stays solution', () => {
  const hfa = parseDrugProfile('NDA020983 200 ACTUAT albuterol 0.09 MG/ACTUAT Metered Dose Inhaler');
  assert.equal(hfa.form, 'inhaler');
  assert.equal(hfa.route, 'inhaled');
  const dpi = parseDrugProfile('200 ACTUAT albuterol 0.09 MG/ACTUAT Dry Powder Inhaler');
  assert.equal(dpi.form, 'inhaler');
  const neb = parseDrugProfile('albuterol 0.83 MG/ML Inhalation Solution');
  assert.equal(neb.form, 'solution');
  assert.equal(neb.route, 'inhaled');
});

test('C08 albuterol HFA → metered-dose inhaler, not the nebulizer solution or oral tablet', () => {
  const hfa = parseDrugProfile('NDA020983 200 ACTUAT albuterol 0.09 MG/ACTUAT Metered Dose Inhaler');
  const rows = [
    row('2123076', 'NDA020983 200 ACTUAT albuterol 0.09 MG/ACTUAT Metered Dose Inhaler', 2),
    row('630208', 'albuterol 0.83 MG/ML Inhalation Solution', 2),
    row('197316', 'albuterol 2 MG Oral Tablet', 4),
  ];
  const r = pickBestFormularyRow('__nonexact__', hfa, rows);
  assert.equal(r.row?.rxcui, '2123076');
  assert.equal(r.fallback, false);
  // exact rxcui still wins outright
  assert.equal(pickBestFormularyRow('2123076', hfa, rows).row?.rxcui, '2123076');
});

test('inhaler never crosses route to a nasal spray / ointment', () => {
  const diskus = parseDrugProfile('60 ACTUAT fluticasone propionate 0.05 MG/ACTUAT Dry Powder Inhaler');
  const nasal = row('N', 'fluticasone propionate 0.05 MG/ACTUAT Metered Dose Nasal Spray', 1);
  const ointment = row('T', 'fluticasone propionate 0.00005 MG/MG Topical Ointment', 2);
  assert.equal(pickBestFormularyRow('896018', diskus, [nasal, ointment]).row, null);
  const hfa = row('H', '120 ACTUAT fluticasone propionate 0.044 MG/ACTUAT Metered Dose Inhaler', 3);
  assert.equal(pickBestFormularyRow('896018', diskus, [nasal, hfa]).row?.rxcui, 'H');
});
