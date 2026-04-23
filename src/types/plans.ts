import type { PlanType, StateCode } from './session';

export type FormularyTier = 1 | 2 | 3 | 4 | 5 | 'excluded';

export interface DentalBenefit {
  preventive: boolean;
  comprehensive: boolean;
  annual_max: number;
}

export interface VisionBenefit {
  exam: boolean;
  eyewear_allowance_year: number;
}

export interface HearingBenefit {
  aid_allowance_year: number;
  exam: boolean;
}

export interface TransportationBenefit {
  rides_per_year: number;
  distance_miles: number;
}

export interface OtcBenefit {
  allowance_per_quarter: number;
}

export interface FoodCardBenefit {
  allowance_per_month: number;
  restricted_to_medicaid_eligible: boolean;
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
