// ⚠ DEPRECATED as the primary plan catalog.
//
// This file is now the *fallback* for planCatalog.ts — the real source
// of truth is pm_plans + pm_plan_benefits in Supabase, fetched via
// /api/plans. The 12-plan static array below only renders when the
// server route errors (graceful degradation so Rob can still demo
// during a Supabase outage).
//
// Formulary lookups move to formularyLookup.ts / pm_formulary; leaving
// the inline Plan.formulary dicts here only because the Plan TS type
// still carries the field.

import type { FormularyTier, Plan } from '@/types/plans';

const BASE_FORMULARY: Record<string, FormularyTier> = {
  gabapentin: 1,
  metformin: 1,
  atorvastatin: 1,
  lisinopril: 1,
  levothyroxine: 1,
  amlodipine: 1,
  losartan: 1,
  omeprazole: 2,
  simvastatin: 1,
  hydrochlorothiazide: 1,
  insulin_glargine: 3,
  eliquis: 3,
  xarelto: 3,
  tamsulosin: 2,
  sertraline: 1,
  escitalopram: 1,
  tradjenta: 3,
  januvia: 3,
  humira: 5,
  ozempic: 3,
};

// Per-state service-area seeds. Expanded well past the launch counties
// so that real-world clients (Cabarrus, Union, Johnston, Rowan…) don't
// fall out of the pool. When a plan is written by contract in the
// entire state, listing every county explicitly is noisy but matches
// the shape of the CMS landscape CSV, so we keep the array form for
// parity with the eventual real-data import.
const NC_COUNTIES = [
  'Alamance', 'Brunswick', 'Buncombe', 'Burke', 'Cabarrus', 'Caldwell', 'Carteret',
  'Catawba', 'Chatham', 'Cleveland', 'Columbus', 'Craven', 'Cumberland',
  'Davidson', 'Duplin', 'Durham', 'Edgecombe', 'Forsyth', 'Franklin',
  'Gaston', 'Granville', 'Guilford', 'Halifax', 'Harnett', 'Haywood',
  'Henderson', 'Hoke', 'Iredell', 'Johnston', 'Lee', 'Lenoir', 'Lincoln',
  'Mecklenburg', 'Moore', 'Nash', 'New Hanover', 'Onslow', 'Orange',
  'Pender', 'Person', 'Pitt', 'Randolph', 'Robeson', 'Rockingham', 'Rowan',
  'Rutherford', 'Sampson', 'Stanly', 'Stokes', 'Surry', 'Union', 'Vance',
  'Wake', 'Watauga', 'Wayne', 'Wilkes', 'Wilson',
];
const TX_COUNTIES = [
  'Bexar', 'Brazoria', 'Collin', 'Dallas', 'Denton', 'El Paso', 'Fort Bend',
  'Galveston', 'Harris', 'Hays', 'Hidalgo', 'Jefferson', 'Lubbock',
  'McLennan', 'Montgomery', 'Nueces', 'Tarrant', 'Travis', 'Webb', 'Williamson',
];
const GA_COUNTIES = [
  'Bibb', 'Bulloch', 'Chatham', 'Cherokee', 'Clayton', 'Cobb', 'Columbia',
  'DeKalb', 'Douglas', 'Forsyth', 'Fulton', 'Glynn', 'Gwinnett', 'Hall',
  'Henry', 'Houston', 'Lowndes', 'Muscogee', 'Newton', 'Paulding',
  'Richmond', 'Rockdale',
];

const EMPTY_COST_SHARE = { copay: null, coinsurance: null, description: null };
const EMPTY_MEDICAL = {
  primary_care: EMPTY_COST_SHARE,
  specialist: EMPTY_COST_SHARE,
  urgent_care: EMPTY_COST_SHARE,
  emergency: EMPTY_COST_SHARE,
  inpatient: EMPTY_COST_SHARE,
};
const EMPTY_RX_TIERS = {
  tier_1: EMPTY_COST_SHARE,
  tier_2: EMPTY_COST_SHARE,
  tier_3: EMPTY_COST_SHARE,
  tier_4: EMPTY_COST_SHARE,
  tier_5: EMPTY_COST_SHARE,
};

type PlanOverride = Omit<Partial<Plan>, 'benefits'> &
  Pick<Plan, 'id' | 'contract_id' | 'plan_number' | 'carrier' | 'plan_name' | 'state' | 'plan_type'> & {
    benefits?: Partial<Plan['benefits']>;
  };

function p(override: PlanOverride): Plan {
  const counties =
    override.state === 'NC' ? NC_COUNTIES :
    override.state === 'TX' ? TX_COUNTIES :
    GA_COUNTIES;
  const defaultBenefits: Plan['benefits'] = {
    dental: { preventive: true, comprehensive: true, annual_max: 2000 },
    vision: { exam: true, eyewear_allowance_year: 300 },
    hearing: { aid_allowance_year: 2000, exam: true },
    transportation: { rides_per_year: 36, distance_miles: 60 },
    otc: { allowance_per_quarter: 185 },
    food_card: { allowance_per_month: 0, restricted_to_medicaid_eligible: true },
    diabetic: { covered: true, preferred_brands: ['OneTouch', 'Accu-Chek'] },
    fitness: { enabled: true, program: 'SilverSneakers' },
    medical: EMPTY_MEDICAL,
    rx_tiers: EMPTY_RX_TIERS,
  };
  const { benefits: benefitsOverride, ...rest } = override;
  return {
    counties,
    premium: 0,
    annual_deductible: null,
    moop_in_network: 4900,
    moop_out_of_network: null,
    drug_deductible: null,
    part_b_giveback: 0,
    star_rating: 4,
    benefits: { ...defaultBenefits, ...(benefitsOverride ?? {}) },
    formulary: { ...BASE_FORMULARY },
    in_network_npis: [],
    ...rest,
  };
}

const PLANS: Plan[] = [
  // -------- NC D-SNP plans --------
  p({
    id: 'H5253-041-000',
    contract_id: 'H5253',
    plan_number: '041',
    carrier: 'UnitedHealthcare',
    plan_name: 'UnitedHealthcare Dual Complete (HMO D-SNP)',
    state: 'NC',
    plan_type: 'DSNP',
    star_rating: 4,
    benefits: {
      dental: { preventive: true, comprehensive: true, annual_max: 3000 },
      vision: { exam: true, eyewear_allowance_year: 400 },
      hearing: { aid_allowance_year: 2500, exam: true },
      transportation: { rides_per_year: 48, distance_miles: 60 },
      otc: { allowance_per_quarter: 225 },
      food_card: { allowance_per_month: 160, restricted_to_medicaid_eligible: true },
      diabetic: { covered: true, preferred_brands: ['OneTouch'] },
      fitness: { enabled: true, program: 'Renew Active' },
    },
    in_network_npis: ['1003000142', '1003000324', '1609877524'],
  }),
  p({
    id: 'H1427-004-000',
    contract_id: 'H1427',
    plan_number: '004',
    carrier: 'Humana',
    plan_name: 'Humana Gold Plus SNP-DE (HMO D-SNP)',
    state: 'NC',
    plan_type: 'DSNP',
    star_rating: 4,
    benefits: {
      dental: { preventive: true, comprehensive: true, annual_max: 2500 },
      vision: { exam: true, eyewear_allowance_year: 350 },
      hearing: { aid_allowance_year: 2000, exam: true },
      transportation: { rides_per_year: 36, distance_miles: 50 },
      otc: { allowance_per_quarter: 175 },
      food_card: { allowance_per_month: 140, restricted_to_medicaid_eligible: true },
      diabetic: { covered: true, preferred_brands: ['Accu-Chek'] },
      fitness: { enabled: true, program: 'SilverSneakers' },
    },
    formulary: { ...BASE_FORMULARY, eliquis: 2, januvia: 2 },
    in_network_npis: ['1003000142', '1427000001', '1609877524'],
  }),
  p({
    id: 'H5216-315-000',
    contract_id: 'H5216',
    plan_number: '315',
    carrier: 'Aetna',
    plan_name: 'Aetna Medicare Dual Select (HMO D-SNP)',
    state: 'NC',
    plan_type: 'DSNP',
    star_rating: 3.5,
    benefits: {
      dental: { preventive: true, comprehensive: true, annual_max: 2200 },
      vision: { exam: true, eyewear_allowance_year: 300 },
      hearing: { aid_allowance_year: 2000, exam: true },
      transportation: { rides_per_year: 24, distance_miles: 50 },
      otc: { allowance_per_quarter: 195 },
      food_card: { allowance_per_month: 125, restricted_to_medicaid_eligible: true },
      diabetic: { covered: true, preferred_brands: ['OneTouch', 'Accu-Chek'] },
      fitness: { enabled: true, program: 'SilverSneakers' },
    },
    in_network_npis: ['1003000142', '1005216001'],
  }),
  p({
    id: 'H5253-039-000',
    contract_id: 'H5253',
    plan_number: '039',
    carrier: 'UnitedHealthcare',
    plan_name: 'UnitedHealthcare Dual Complete Choice (PPO D-SNP)',
    state: 'NC',
    plan_type: 'DSNP',
    star_rating: 4,
    benefits: {
      dental: { preventive: true, comprehensive: false, annual_max: 1500 },
      vision: { exam: true, eyewear_allowance_year: 300 },
      hearing: { aid_allowance_year: 1500, exam: true },
      transportation: { rides_per_year: 24, distance_miles: 60 },
      otc: { allowance_per_quarter: 150 },
      food_card: { allowance_per_month: 100, restricted_to_medicaid_eligible: true },
      diabetic: { covered: true, preferred_brands: ['OneTouch'] },
      fitness: { enabled: true, program: 'Renew Active' },
    },
    in_network_npis: ['1003000142', '1003000324', '1609877524', '1427000001'],
  }),
  p({
    id: 'H3330-009-000',
    contract_id: 'H3330',
    plan_number: '009',
    carrier: 'Wellcare',
    plan_name: 'Wellcare Assist (HMO D-SNP)',
    state: 'NC',
    plan_type: 'DSNP',
    star_rating: 3.5,
    benefits: {
      dental: { preventive: true, comprehensive: true, annual_max: 1800 },
      vision: { exam: true, eyewear_allowance_year: 250 },
      hearing: { aid_allowance_year: 1500, exam: true },
      transportation: { rides_per_year: 60, distance_miles: 75 },
      otc: { allowance_per_quarter: 165 },
      food_card: { allowance_per_month: 150, restricted_to_medicaid_eligible: true },
      diabetic: { covered: true, preferred_brands: ['Accu-Chek'] },
      fitness: { enabled: true, program: 'SilverSneakers' },
    },
    in_network_npis: ['1003000142', '1609877524'],
  }),
  p({
    id: 'H1406-002-000',
    contract_id: 'H1406',
    plan_number: '002',
    carrier: 'Anthem BCBS',
    plan_name: 'Anthem MediBlue Dual Advantage (HMO D-SNP)',
    state: 'NC',
    plan_type: 'DSNP',
    star_rating: 4,
    benefits: {
      dental: { preventive: true, comprehensive: true, annual_max: 2000 },
      vision: { exam: true, eyewear_allowance_year: 350 },
      hearing: { aid_allowance_year: 2500, exam: true },
      transportation: { rides_per_year: 30, distance_miles: 50 },
      otc: { allowance_per_quarter: 200 },
      food_card: { allowance_per_month: 0, restricted_to_medicaid_eligible: true },
      diabetic: { covered: true, preferred_brands: ['OneTouch'] },
      fitness: { enabled: true, program: 'SilverSneakers' },
    },
    in_network_npis: ['1003000324', '1427000001'],
  }),

  // -------- NC MAPD (non-DSNP) --------
  p({
    id: 'H1406-015-000',
    contract_id: 'H1406',
    plan_number: '015',
    carrier: 'Anthem BCBS',
    plan_name: 'Anthem MediBlue Access (PPO)',
    state: 'NC',
    plan_type: 'MAPD',
    premium: 18,
    moop_in_network: 6700,
    star_rating: 4,
    benefits: {
      dental: { preventive: true, comprehensive: false, annual_max: 1000 },
      vision: { exam: true, eyewear_allowance_year: 200 },
      hearing: { aid_allowance_year: 1000, exam: true },
      transportation: { rides_per_year: 0, distance_miles: 0 },
      otc: { allowance_per_quarter: 50 },
      food_card: { allowance_per_month: 0, restricted_to_medicaid_eligible: false },
      diabetic: { covered: true, preferred_brands: [] },
      fitness: { enabled: true, program: 'SilverSneakers' },
    },
    in_network_npis: ['1003000142', '1003000324'],
  }),

  // -------- TX D-SNP --------
  p({
    id: 'H4514-069-000',
    contract_id: 'H4514',
    plan_number: '069',
    carrier: 'Humana',
    plan_name: 'Humana Gold Plus SNP-DE (HMO D-SNP) TX',
    state: 'TX',
    plan_type: 'DSNP',
    star_rating: 4,
    benefits: {
      dental: { preventive: true, comprehensive: true, annual_max: 3000 },
      vision: { exam: true, eyewear_allowance_year: 400 },
      hearing: { aid_allowance_year: 2500, exam: true },
      transportation: { rides_per_year: 48, distance_miles: 60 },
      otc: { allowance_per_quarter: 250 },
      food_card: { allowance_per_month: 180, restricted_to_medicaid_eligible: true },
      diabetic: { covered: true, preferred_brands: ['Accu-Chek'] },
      fitness: { enabled: true, program: 'SilverSneakers' },
    },
    in_network_npis: ['1427069001', '1609877524'],
  }),
  p({
    id: 'H7778-008-000',
    contract_id: 'H7778',
    plan_number: '008',
    carrier: 'Molina',
    plan_name: 'Molina Healthcare Medicare Choice (HMO D-SNP)',
    state: 'TX',
    plan_type: 'DSNP',
    star_rating: 3.5,
    benefits: {
      dental: { preventive: true, comprehensive: true, annual_max: 2000 },
      vision: { exam: true, eyewear_allowance_year: 300 },
      hearing: { aid_allowance_year: 1500, exam: true },
      transportation: { rides_per_year: 60, distance_miles: 75 },
      otc: { allowance_per_quarter: 150 },
      food_card: { allowance_per_month: 100, restricted_to_medicaid_eligible: true },
      diabetic: { covered: true, preferred_brands: ['OneTouch'] },
      fitness: { enabled: true, program: 'SilverSneakers' },
    },
    in_network_npis: ['1427069001', '1777800001'],
  }),

  // -------- GA D-SNP --------
  p({
    id: 'H1111-004-000',
    contract_id: 'H1111',
    plan_number: '004',
    carrier: 'UnitedHealthcare',
    plan_name: 'UnitedHealthcare Dual Complete (HMO D-SNP) GA',
    state: 'GA',
    plan_type: 'DSNP',
    star_rating: 4,
    benefits: {
      dental: { preventive: true, comprehensive: true, annual_max: 2500 },
      vision: { exam: true, eyewear_allowance_year: 350 },
      hearing: { aid_allowance_year: 2000, exam: true },
      transportation: { rides_per_year: 36, distance_miles: 60 },
      otc: { allowance_per_quarter: 200 },
      food_card: { allowance_per_month: 150, restricted_to_medicaid_eligible: true },
      diabetic: { covered: true, preferred_brands: ['OneTouch'] },
      fitness: { enabled: true, program: 'Renew Active' },
    },
    in_network_npis: ['1111111001', '1003000324'],
  }),
  p({
    id: 'H1036-287-000',
    contract_id: 'H1036',
    plan_number: '287',
    carrier: 'Humana',
    plan_name: 'Humana Gold Plus SNP-DE (HMO D-SNP) GA',
    state: 'GA',
    plan_type: 'DSNP',
    star_rating: 4,
    benefits: {
      dental: { preventive: true, comprehensive: true, annual_max: 2800 },
      vision: { exam: true, eyewear_allowance_year: 350 },
      hearing: { aid_allowance_year: 2000, exam: true },
      transportation: { rides_per_year: 36, distance_miles: 60 },
      otc: { allowance_per_quarter: 200 },
      food_card: { allowance_per_month: 155, restricted_to_medicaid_eligible: true },
      diabetic: { covered: true, preferred_brands: ['Accu-Chek'] },
      fitness: { enabled: true, program: 'SilverSneakers' },
    },
    in_network_npis: ['1427000001', '1111111001'],
  }),
  p({
    id: 'H6622-012-000',
    contract_id: 'H6622',
    plan_number: '012',
    carrier: 'Aetna',
    plan_name: 'Aetna Medicare Dual Advantage (HMO D-SNP) GA',
    state: 'GA',
    plan_type: 'DSNP',
    star_rating: 3.5,
    benefits: {
      dental: { preventive: true, comprehensive: true, annual_max: 1800 },
      vision: { exam: true, eyewear_allowance_year: 250 },
      hearing: { aid_allowance_year: 1500, exam: true },
      transportation: { rides_per_year: 24, distance_miles: 50 },
      otc: { allowance_per_quarter: 160 },
      food_card: { allowance_per_month: 120, restricted_to_medicaid_eligible: true },
      diabetic: { covered: true, preferred_brands: ['OneTouch'] },
      fitness: { enabled: true, program: 'SilverSneakers' },
    },
    in_network_npis: ['1005216001', '1111111001'],
  }),
];

export function getAllPlans(): Plan[] {
  return PLANS;
}

export function plansForState(state: string | null): Plan[] {
  if (!state) return PLANS;
  return PLANS.filter((p) => p.state === state);
}

// Normalize a county string for tolerant matching. The intake form is
// free-text, a ZIP → county lookup may emit "Durham" while the client
// or a CSV might write "Durham County" / "durham" / " Durham ", and
// CMS's own landscape file occasionally throws in a trailing "Co.".
// All of those should match the same plan service area.
function normalizeCounty(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/\s+co\.?$/i, '')
    .replace(/\s+county$/i, '')
    .replace(/\s+parish$/i, '')
    .trim();
}

/**
 * Fallback plan filter used by planCatalog.ts when the /api/plans
 * server route errors. Keep the signature compatible with the legacy
 * `plansForClient` so consumers that haven't been migrated yet still
 * compile.
 */
export function fallbackPlansForClient(client: {
  state: string | null;
  planType: string | null;
  county: string;
}): Plan[] {
  return plansForClient(client);
}

export function plansForClient(client: { state: string | null; planType: string | null; county: string }): Plan[] {
  const wanted = normalizeCounty(client.county);
  return PLANS.filter((plan) => {
    if (client.state && plan.state !== client.state) return false;
    if (client.planType && plan.plan_type !== client.planType) return false;
    if (!wanted) return true;
    // A plan with an empty counties list is treated as statewide —
    // we only hard-filter a plan out when it explicitly declares a
    // service area AND the client's county isn't in it. This keeps
    // the Finalists pool populated when the seed data doesn't yet
    // enumerate every county in the state (demo / pre-landscape-
    // import build).
    if (!Array.isArray(plan.counties) || plan.counties.length === 0) return true;
    const planCounties = plan.counties.map(normalizeCounty);
    return planCounties.includes(wanted);
  });
}

export function lookupByHNumber(h: string): Plan | null {
  const normalized = h.trim().toUpperCase().replace(/\s+/g, '');
  for (const plan of PLANS) {
    if (plan.id.toUpperCase().replace(/-/g, '') === normalized.replace(/-/g, '')) return plan;
    if (plan.id.toUpperCase().startsWith(normalized + '-')) return plan;
    if (plan.id.toUpperCase() === normalized) return plan;
  }
  return null;
}

export function findPlan(id: string): Plan | null {
  return PLANS.find((p) => p.id === id) ?? null;
}

export function formularyTierFor(plan: Plan, drugName: string): FormularyTier | null {
  const key = drugName.trim().toLowerCase().split(/\s+/)[0];
  if (!key) return null;
  return plan.formulary[key] ?? null;
}
