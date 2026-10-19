// Exact-brand hardening (Rob, 2026-10-19): a BRAND drug request must never
// resolve to a DIFFERENT brand of the same molecule. Ozempic → never Wegovy
// (both semaglutide); NovoLog → never Fiasp (both insulin aspart). If the plan
// files only another brand / the generic, the requested brand is NOT COVERED
// as entered — we do not substitute. Exact rxcui still wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDrugProfile, pickBestFormularyRow } from '../../api/_lib/formulary-sibling-match.js';

// Real 2027 RxNorm names (pm_drugs).
const OZEMPIC = { rxcui: '2619154', drug_name: '0.25 MG, 0.5 MG Dose 3 ML semaglutide 0.68 MG/ML Pen Injector [Ozempic]', tier: 3 };
const OZEMPIC_OTHER = { rxcui: '2398842', drug_name: '3 ML semaglutide 1.34 MG/ML Pen Injector [Ozempic]', tier: 3 };
const WEGOVY = { rxcui: '2553603', drug_name: '0.5 ML semaglutide 1 MG/ML Auto-Injector [Wegovy]', tier: 2 }; // lower tier — would win a lowest-tier pick
const SEMAGLUTIDE_GENERIC = { rxcui: '9999001', drug_name: 'semaglutide 1 MG/ML Injectable Solution', tier: 1 };

const NOVOLOG = { rxcui: '1653204', drug_name: '3 ML insulin aspart, human 100 UNT/ML Pen Injector [NovoLog]', tier: 3 };
const FIASP = { rxcui: '1986354', drug_name: 'Niacinamide insulin aspart, human 100 UNT/ML Injectable Solution [Fiasp]', tier: 1 }; // lower tier

const ozempicProfile = parseDrugProfile(OZEMPIC.drug_name);
const novologProfile = parseDrugProfile(NOVOLOG.drug_name);

test('parseDrugProfile extracts the brand name', () => {
  assert.equal(ozempicProfile.brand, true);
  assert.equal(ozempicProfile.brandName, 'ozempic');
  assert.equal(novologProfile.brandName, 'novolog');
  assert.equal(parseDrugProfile(SEMAGLUTIDE_GENERIC.drug_name).brandName, null);
});

test('Ozempic request → never Wegovy (even when Wegovy is lower tier)', () => {
  // Non-exact: user rxcui not on plan; plan files Wegovy (tier 2) + Ozempic (tier 3).
  const pick = pickBestFormularyRow('0000000', ozempicProfile, [WEGOVY, OZEMPIC_OTHER]);
  assert.ok(pick.row, 'an Ozempic row is matched');
  assert.equal(pick.row!.rxcui, OZEMPIC_OTHER.rxcui);
  assert.notEqual(pick.row!.rxcui, WEGOVY.rxcui);
});

test('Ozempic request, plan files ONLY Wegovy → NOT COVERED (never Wegovy)', () => {
  const pick = pickBestFormularyRow('0000000', ozempicProfile, [WEGOVY]);
  assert.equal(pick.row, null);
});

test('Ozempic request, plan files ONLY the generic → NOT COVERED as the brand', () => {
  const pick = pickBestFormularyRow('0000000', ozempicProfile, [SEMAGLUTIDE_GENERIC]);
  assert.equal(pick.row, null);
});

test('NovoLog request → never Fiasp (even when Fiasp is lower tier)', () => {
  const pick = pickBestFormularyRow('0000000', novologProfile, [FIASP, NOVOLOG]);
  assert.ok(pick.row);
  assert.equal(pick.row!.rxcui, NOVOLOG.rxcui);
});

test('NovoLog request, plan files ONLY Fiasp → NOT COVERED (never Fiasp)', () => {
  const pick = pickBestFormularyRow('0000000', novologProfile, [FIASP]);
  assert.equal(pick.row, null);
});

test('exact rxcui still wins regardless of brand guard', () => {
  const pick = pickBestFormularyRow(OZEMPIC.rxcui, ozempicProfile, [WEGOVY, OZEMPIC]);
  assert.equal(pick.row!.rxcui, OZEMPIC.rxcui);
});

test('same-brand strength sibling is still matched', () => {
  // User wants Ozempic 0.68; plan files a different Ozempic strength only.
  const pick = pickBestFormularyRow('0000000', ozempicProfile, [OZEMPIC_OTHER]);
  assert.equal(pick.row!.rxcui, OZEMPIC_OTHER.rxcui);
});
