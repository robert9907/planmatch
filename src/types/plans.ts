import type { PlanType, StateCode } from './session';

export type FormularyTier = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 'excluded';

// Each benefit carries an optional description from
// pm_plan_benefits.benefit_description. Surfaces dental copay /
// coverage details when the structured dollar fields are null —
// e.g. "Preventive + comprehensive dental · $45 copay" — so the
// UI can render meaningful copy instead of "—" on plans that
// clearly DO cover the benefit but didn't file an annual cap.

export interface DentalBenefit {
  preventive: boolean;
  comprehensive: boolean;
  annual_max: number;
  description?: string | null;
}

export interface VisionBenefit {
  exam: boolean;
  eyewear_allowance_year: number;
  description?: string | null;
}

export interface HearingBenefit {
  aid_allowance_year: number;
  exam: boolean;
  description?: string | null;
}

export interface TransportationBenefit {
  rides_per_year: number;
  distance_miles: number;
  description?: string | null;
}

export interface OtcBenefit {
  allowance_per_quarter: number;
  description?: string | null;
}

export interface FoodCardBenefit {
  allowance_per_month: number;
  restricted_to_medicaid_eligible: boolean;
  description?: string | null;
}

export interface DiabeticBenefit {
  covered: boolean;
  preferred_brands: string[];
}

export type FitnessProgram = 'SilverSneakers' | 'Renew Active' | 'OneCall' | 'Active&Fit' | null;
export interface FitnessBenefit {
  enabled: boolean;
  program: FitnessProgram;
}

// Cost-share for a single service line (copay OR coinsurance — PBP
// extracts populate one or the other). null/null means the category
// wasn't present in pm_plan_benefits for this plan and the UI should
// render "—".
export interface CostShare {
  copay: number | null;
  coinsurance: number | null;
  description: string | null;
}

export interface MedicalCopays {
  primary_care: CostShare;
  specialist: CostShare;
  urgent_care: CostShare;
  emergency: CostShare;
  inpatient: CostShare;
  // New categories imported from PBP b7/b8/b9 for v4 Quote & Delivery.
  // Every field is still optional-by-nullness — a plan that didn't file a
  // given row shows `{copay:null, coinsurance:null}` and the UI renders $0
  // (Original Medicare default) or the coinsurance percent accordingly.
  outpatient_surgery_hospital: CostShare;
  outpatient_surgery_asc: CostShare;
  outpatient_observation: CostShare;
  lab_services: CostShare;
  diagnostic_tests: CostShare;
  xray: CostShare;
  diagnostic_radiology: CostShare;
  therapeutic_radiology: CostShare;
  mental_health_individual: CostShare;
  mental_health_group: CostShare;
  physical_therapy: CostShare;
  telehealth: CostShare;
}

export interface RxTierCopays {
  tier_1: CostShare;
  tier_2: CostShare;
  tier_3: CostShare;
  tier_4: CostShare;
  tier_5: CostShare;
}

export interface PlanBenefits {
  dental: DentalBenefit;
  vision: VisionBenefit;
  hearing: HearingBenefit;
  transportation: TransportationBenefit;
  otc: OtcBenefit;
  food_card: FoodCardBenefit;
  diabetic: DiabeticBenefit;
  fitness: FitnessBenefit;
  medical: MedicalCopays;
  rx_tiers: RxTierCopays;
}

export interface Plan {
  id: string;
  contract_id: string;
  plan_number: string;
  carrier: string;
  plan_name: string;
  state: StateCode;
  counties: string[];
  plan_type: PlanType;
  premium: number;
  annual_deductible: number | null;
  moop_in_network: number;
  moop_out_of_network: number | null;
  drug_deductible: number | null;
  part_b_giveback: number;
  star_rating: number;
  benefits: PlanBenefits;
  formulary: Record<string, FormularyTier>;
  in_network_npis: string[];
}

export type BenefitKey =
  | 'dental'
  | 'vision'
  | 'hearing'
  | 'transportation'
  | 'otc'
  | 'food_card'
  | 'diabetic'
  | 'fitness';

export interface BenefitFilter {
  enabled: boolean;
  subToggles: Record<string, boolean>;
  tier: 'any' | 'basic' | 'enhanced' | 'premium';
}

export type BenefitFilterState = Record<BenefitKey, BenefitFilter>;

export type CutReason =
  | 'benefit_filter'
  | 'formulary_gap'
  | 'provider_out_of_network'
  | 'premium_too_high'
  | 'wrong_state'
  | 'wrong_plan_type';

export interface CutTag {
  plan_id: string;
  reason: CutReason;
  detail: string;
}

export interface FunnelSnapshot {
  total: number;
  after_providers: number;
  after_formulary: number;
  finalists: number;
  cuts: CutTag[];
}
