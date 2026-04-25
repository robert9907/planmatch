// plan-brain-types — interfaces shared by the agent-side scoring engine.
//
// Shape mirrors the consumer-side Plan Brain (commit 1702051 + condition
// profiles) so the same inputs produce identical rankings on both sides.

import type { Plan } from '@/types/plans';
import type { Client, Medication, Provider } from '@/types/session';

export type Population = 'mapd' | 'csnp' | 'dsnp';

export type ConditionKey =
  | 'diabetes'
  | 'chf'
  | 'copd'
  | 'cancer'
  | 'hypertension';

export type UtilizationProfile = 'low' | 'moderate' | 'high';

export type RibbonKey =
  | 'BEST_OVERALL'
  | 'LOWEST_DRUG_COST'
  | 'LOWEST_OOP'
  | 'BEST_EXTRAS'
  | 'ALL_DOCS_IN_NETWORK'
  | 'PART_B_SAVINGS'
  | 'ZERO_PREMIUM'
  | 'ALL_MEDS_COVERED';

export interface WeightProfile {
  drug: number;
  oop: number;
  extras: number;
}

export interface UtilizationCounts {
  pcp: number;
  specialist: number;
  lab: number;
  imaging: number;
  er: number;
  inpatient: number; // average inpatient days/year
}

// Rows returned by /api/plans-with-extras for a single plan.
export interface BenefitRow {
  benefit_type: string;
  tier_id: string | null;
  copay: number | null;
  coinsurance: number | null;
  description: string | null;
  source: 'medicare_gov' | 'sb_ocr' | 'manual' | 'pbp_federal';
}

// One row from pm_drug_cost_cache, keyed by (plan_id, segment_id, ndc).
export interface DrugCostCacheRow {
  plan_id: string;       // "<contract>-<plan>"
  segment_id: string;
  ndc: string;
  tier: number | null;
  full_cost: number | null;
  covered: boolean | null;
  estimated_yearly_total: number | null;
}

// One row from pm_formulary — tier + cost-share by (contract+plan, rxcui).
export interface FormularyRow {
  contract_id: string;
  plan_id: string;
  rxcui: string;
  tier: number | null;
  copay: number | null;
  coinsurance: number | null;
  prior_auth: boolean | null;
  step_therapy: boolean | null;
}

// Bridge rxcui → NDC + default fill quantity.
export interface NdcRow {
  rxcui: string;
  ndc: string;
  default_quantity_30: number | null;
  default_quantity_90: number | null;
}

// Provider network row keyed by (plan_id, segment_id, npi).
export interface ProviderNetworkRow {
  plan_id: string;
  segment_id: string;
  npi: string;
  covered: boolean | null;
}

// Aggregated server payload — what /api/plan-brain-data returns and what
// runPlanBrain() consumes alongside the in-session plan list.
export interface PlanBrainData {
  // benefit rows keyed on triple id "<contract>-<plan>-<segment>"
  benefitsByPlan: Record<string, BenefitRow[]>;
  // drug-cost cache keyed first by triple id, then by ndc
  drugCostCache: Record<string, Record<string, DrugCostCacheRow>>;
  // formulary rows keyed by "<contract>-<plan>" (no segment), then rxcui
  formularyByContractPlan: Record<string, Record<string, FormularyRow>>;
  // rxcui → NDC bridge (most recent / preferred row per rxcui)
  ndcByRxcui: Record<string, NdcRow>;
  // provider network coverage keyed by triple id, then npi
  networkByPlan: Record<string, Record<string, ProviderNetworkRow>>;
}

export interface PlanBrainInputs {
  plans: Plan[];
  client: Client;
  medications: Medication[];
  providers: Provider[];
  data: PlanBrainData;
  // Optional condition profile — overrides utilization estimation when set.
  conditionProfile?: ConditionKey | null;
  // Benefit keys the user said they personally cared about — get a 2x
  // boost in the extras axis. Examples: 'food_card', 'dental_max'.
  userPriorities?: string[];
  // Override the population auto-detection when needed (legacy intake).
  populationOverride?: Population | null;
  // Override default weight profile (e.g. UI weight tweakers).
  weightOverride?: Partial<WeightProfile> | null;
}

export interface PlanCostBreakdownLine {
  label: string;
  amount: number;
  detail?: string;
}

export interface ScoredPlan {
  plan: Plan;
  rank: number; // 1-based rank by composite descending
  composite: number;
  drugScore: number;
  oopScore: number;
  extrasScore: number;
  // Raw dollar figures behind the scores, for the cost-breakdown UI.
  totalAnnualDrugCost: number;
  annualMedicalCost: number;
  totalOOPEstimate: number;
  extrasValue: number;
  // Provider boost applied to composite (+5, 0, -10).
  providerBoost: number;
  // What the engine knows about this plan's network coverage.
  providerNetworkStatus: 'all_in' | 'partial' | 'all_out' | 'unknown';
  // Drugs that came back not_covered against this plan's formulary.
  uncoveredDrugRxcuis: string[];
  // One ribbon max per plan (BEST_OVERALL is exclusive to rank 1).
  ribbon: RibbonKey | null;
  // Human-readable cost summary for the v4 quote screen.
  breakdown: string;
  breakdownLines: PlanCostBreakdownLine[];
}

export interface PlanBrainResult {
  population: Population;
  weights: WeightProfile;
  utilization: UtilizationProfile;
  scored: ScoredPlan[];
  // Plans that were filtered out before scoring (SNP rules).
  filteredOut: { plan: Plan; reason: string }[];
}
