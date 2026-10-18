// CP9 — per-drug Part D utilization-management restrictions (PA / ST / QL)
// must survive from the matched pm_formulary row (FormularyCoverage) through
// to BrainScore.drugBreakdown, including the filed quantity-limit amount and
// days. CompareScreen reads these to flag "Prior authorization", "Step
// therapy", and "Quantity limit: N per D days" per drug per plan — Medicare
// Plan Finder parity. Mirrors the consumer regression
// (robert9907/plan-match cp9-formulary-restrictions.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPlanBrain } from '../../src/lib/plan-brain.js';
import type { BrainInputs } from '../../src/lib/plan-brain-types.js';
import type { FormularyCoverage } from '../../src/lib/brain-foreign-types.js';

const PA_DRUG = '111111';
const CLEAN_DRUG = '222222';

function makePlan(): any {
  return {
    contract_id: 'H0001', plan_id: '001', segment_id: '0',
    plan_name: 'Test MAPD', carrier: 'TestCo', parent_organization: 'TestCo',
    plan_type: 'HMO', state: 'NC', county_name: 'Durham', county_fips: '37063',
    monthly_premium: 0, annual_deductible: null, moop: 4000,
    drug_deductible: null, star_rating: 4, snp: false, snp_type: null,
    sanctioned: false,
  };
}

function makeBenefits(): any[] {
  const row = (cat: string): any => ({
    id: `H0001-001-${cat}`, contract_id: 'H0001', plan_id: '001', segment_id: '0',
    benefit_category: cat, benefit_description: null, coverage_amount: null,
    copay: 0, coinsurance: null, max_coverage: null,
  });
  return [row('primary_care'), row('specialist'), row('rx_tier_3')];
}

function cov(opts: Partial<FormularyCoverage> & { rxcui: string }): FormularyCoverage {
  return {
    drug_name: null, tier: 3, copay: 10, coinsurance: null,
    prior_auth: false, step_therapy: false, quantity_limit: false,
    quantity_limit_amount: null, quantity_limit_days: null,
    ...opts,
  } as FormularyCoverage;
}

function makeInputs(): BrainInputs {
  const formularyByPlanKey = new Map<string, Map<string, FormularyCoverage>>();
  formularyByPlanKey.set('H0001-001', new Map<string, FormularyCoverage>([
    [PA_DRUG, cov({
      rxcui: PA_DRUG, prior_auth: true, step_therapy: true,
      quantity_limit: true, quantity_limit_amount: 30, quantity_limit_days: 30,
    })],
    [CLEAN_DRUG, cov({ rxcui: CLEAN_DRUG })],
  ]));
  const benefitsByPlanKey = new Map<string, any[]>([['H0001-001-0', makeBenefits()]]);
  return {
    plans: [makePlan()],
    benefitsByPlanKey,
    formularyByPlanKey,
    userProfile: {
      drugs: [
        { rxcui: PA_DRUG, name: 'Restricted Drug' },
        { rxcui: CLEAN_DRUG, name: 'Clean Drug' },
      ],
      providers: [], priorities: new Set(), priorityThresholds: {},
      csnpConditions: [], hasVaDrugCoverage: false,
      medicaidLevel: 'none', lisTier: 'none', livingSetting: 'community',
    },
    county: 'Durham',
    formularyPublished: true,
  } as unknown as BrainInputs;
}

const plan = (out: ReturnType<typeof runPlanBrain>) =>
  out.ranked.find((s: any) => s.row.contract_id === 'H0001');

test('CP9 — PA/ST/QL + amount thread from the matched formulary row into drugBreakdown', () => {
  const p = plan(runPlanBrain(makeInputs()));
  assert.ok(p, 'plan H0001 present in ranked');
  const bd: any[] = (p as any).score.drugBreakdown;
  const restricted = bd.find((d) => d.rxcui === PA_DRUG);
  assert.ok(restricted, 'restricted drug in drugBreakdown');
  assert.equal(restricted.priorAuth, true);
  assert.equal(restricted.stepTherapy, true);
  assert.equal(restricted.quantityLimit, true);
  assert.equal(restricted.quantityLimitAmount, 30);
  assert.equal(restricted.quantityLimitDays, 30);
});

test('CP9 — unrestricted drug carries false/null flags', () => {
  const p = plan(runPlanBrain(makeInputs()));
  const bd: any[] = (p as any).score.drugBreakdown;
  const clean = bd.find((d) => d.rxcui === CLEAN_DRUG);
  assert.ok(clean, 'clean drug in drugBreakdown');
  assert.equal(clean.priorAuth, false);
  assert.equal(clean.stepTherapy, false);
  assert.equal(clean.quantityLimit, false);
  assert.equal(clean.quantityLimitAmount, null);
  assert.equal(clean.quantityLimitDays, null);
});
