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

export interface PlanBenefits {
  dental: DentalBenefit;
  vision: VisionBenefit;
  hearing: HearingBenefit;
  transportation: TransportationBenefit;
  otc: OtcBenefit;
  food_card: FoodCardBenefit;
  diabetic: DiabeticBenefit;
  fitness: FitnessBenefit;
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
  moop_in_network: number;
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
