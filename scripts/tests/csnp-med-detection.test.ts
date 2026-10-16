// Rob (Oct 2026): med-detection must NOT auto-promote a client into a C-SNP on
// the agent surface either. Pool eligibility is self-reported / broker-confirmed
// csnpConditions only; a detected condition (from meds) is surfaced as a broker
// prompt before the quote — a "Yes" writes it to csnpConditions, a "No"/skip
// leaves it out. Detection still feeds utilization/cost. Mirrors the consumer
// (robert9907/plan-match #85). Durham analogue: Metformin → diabetes, H1036-308
// is a "Diabetes and Heart" C-SNP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPlanBrain } from '../../src/lib/plan-brain.js';
import type { BrainInputs } from '../../src/lib/plan-brain-types.js';

function makePlan(contract: string, plan: string, snpType: string | null): any {
  return {
    contract_id: contract,
    plan_id: plan,
    segment_id: '0',
    plan_name: `${contract}-${plan}`,
    carrier: 'TestCo',
    parent_organization: 'TestCo',
    plan_type: snpType ? `HMO ${snpType}` : 'HMO',
    state: 'NC',
    county_name: 'Durham',
    county_fips: '37063',
    monthly_premium: 30,
    annual_deductible: null,
    moop: 5000,
    drug_deductible: null,
    star_rating: null,
    snp: snpType != null,
    snp_type: snpType,
    sanctioned: false,
  };
}

function makeBenefits(contract: string, plan: string): any[] {
  const row = (cat: string): any => ({
    id: `${contract}-${plan}-${cat}`,
    contract_id: contract,
    plan_id: plan,
    segment_id: '0',
    benefit_category: cat,
    benefit_description: null,
    coverage_amount: null,
    copay: 0,
    coinsurance: null,
    max_coverage: null,
  });
  return [row('primary_care'), row('specialist')];
}

const REGULAR = makePlan('H0001', '001', null);
const CSNP = makePlan('H1036', '308', 'C-SNP');

function makeInputs(csnpConditions: string[]): BrainInputs {
  const plans = [REGULAR, CSNP];
  const benefitsByPlanKey = new Map<string, any[]>();
  for (const p of plans) benefitsByPlanKey.set(`${p.contract_id}-${p.plan_id}-0`, makeBenefits(p.contract_id, p.plan_id));
  return {
    plans,
    benefitsByPlanKey,
    formularyByPlanKey: new Map(),
    userProfile: {
      drugs: [{ rxcui: '861007', name: 'Metformin 500 MG' }],
      providers: [],
      priorities: new Set(),
      priorityThresholds: {},
      csnpConditions,
      hasVaDrugCoverage: false,
      medicaidLevel: 'none',
      lisTier: 'none',
      livingSetting: 'community',
    },
    county: 'Durham',
    formularyPublished: false,
  } as unknown as BrainInputs;
}

const csnpInRanked = (out: ReturnType<typeof runPlanBrain>) =>
  out.ranked.some((s: any) => s.row.contract_id === 'H1036' && s.row.plan_id === '308');

test('No / Not sure (diabetes NOT confirmed, meds only) → no C-SNP in the pool', () => {
  const out = runPlanBrain(makeInputs([]));
  assert.equal(csnpInRanked(out), false);
  assert.equal(out.ranked.some((s: any) => s.row.contract_id === 'H0001'), true);
});

test('Yes (diabetes confirmed / self-reported) → C-SNP is eligible', () => {
  const out = runPlanBrain(makeInputs(['diabetes']));
  assert.equal(csnpInRanked(out), true);
});
