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
  // Day-tier ladder categories. pm_plan_benefits stores the day-1 copay
  // in the structured `copay` column with the rest of the ladder in
  // `benefit_description` ("Days 1-20: $0/day · Days 21-50: $218/day").
  // Surfaces must parse the description (lib/inpatient-format.ts) and
  // render every tier — see [[feedback_inpatient_full_ladder]].
  mental_health_inpatient: CostShare;
  snf: CostShare;
  // Field names match pm_plan_benefits.benefit_category exactly so the
  // loader doesn't need alias entries. Where a category wasn't filed
  // the value is `{copay:null, coinsurance:null}` and the UI renders
  // "Not available".
  outpatient_surgery_hospital: CostShare;
  outpatient_surgery_asc: CostShare;
  outpatient_observation: CostShare;
  lab_services: CostShare;
  diagnostic_procedures: CostShare;
  xray: CostShare;
  advanced_imaging: CostShare;
  mental_health_individual: CostShare;
  mental_health_group: CostShare;
  physical_speech_therapy: CostShare;
  occupational_therapy: CostShare;
  telehealth: CostShare;
  // Transport
  ambulance: CostShare;
  air_transportation: CostShare;
  // Specialty
  chiropractic: CostShare;
  acupuncture: CostShare;
  podiatry: CostShare;
  substance_abuse: CostShare;
  // Equipment / drugs filed under medical
  dme_prosthetics: CostShare;
  partb_drugs: CostShare;
  diabetic_supplies: CostShare;
  insulin: CostShare;
  // Long-term / home
  home_health: CostShare;
  renal_dialysis: CostShare;
}

export interface RxTierCopays {
  tier_1: CostShare;
  tier_2: CostShare;
  tier_3: CostShare;
  tier_4: CostShare;
  tier_5: CostShare;
  // Tier 6+ are valid CMS coverage tiers (carrier-specific buckets:
  // "Select Care", "Excluded Generics with QL", "Specialty Tier 2").
  // Wellcare H1914 files atorvastatin/metformin/lisinopril at tier 6
  // with $0 copay — treating tier 6 as "excluded" misrepresents real
  // coverage. Optional so seed plans don't have to populate.
  tier_6?: CostShare;
  tier_7?: CostShare;
  tier_8?: CostShare;
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
  // Raw landscape plan_type string from pm_plans ("HMO" | "Local PPO" |
  // "Regional PPO" | "HMOPOS" | "PFFS" | "MSA" | "Cost" | "PDP" | null).
  // plan_type is the app-level bucket and never contains the network
  // shape, so the compare bench HMO/PPO filter needs this raw value.
  plan_shape: string | null;
  // Raw snp_type string from pm_plans ("D-SNP" | "C-SNP" | "I-SNP" | null).
  // plan_type already buckets SNP variants, but the compare bench filter
  // partitions D-SNP vs C-SNP separately and needs the raw value.
  snp_type: string | null;
  // Landscape-sourced D-SNP integration status. Populated only when
  // snp_type === 'D-SNP'; null otherwise. Value space: 'FIDE' |
  // 'HIDE' | 'Coordination Only' | 'AIP' (CY2027 target). Drives the
  // Compare bench's SNP sub-filter — brokers routinely need to pull
  // just FIDE plans for care-management workflows that differ from
  // HIDE / coord-only, so this can't be inferred from snp_type alone.
  dsnp_integration_status: string | null;
  // Landscape-sourced D-SNP "zero-dollar cost-sharing" flag. True only
  // when snp_type === 'D-SNP' AND the plan is fully-integrated enough
  // that QMB+ / full-benefit duals pay nothing at point-of-service. A
  // sub-slice of D-SNPs (usually FIDE + some HIDE) — surfaced as its
  // own Cost & Quality predicate on the bench.
  zero_cost_sharing: boolean;
  // Landscape-sourced C-SNP condition type. Populated only when
  // snp_type === 'C-SNP'; null otherwise. CMS files this as a CamelCase
  // comma-separated list ("CardiovascularDisorders,DiabetesMellitus")
  // — display code humanizes; the raw string is the filter key.
  csnp_condition_type: string | null;
  // D-SNP accepted Medicaid populations, sourced from the CMS SNP
  // Comprehensive Report. Populated only when snp_type === 'D-SNP'.
  // CMS files this at the (contract, plan) grain as a single
  // "Partial Dual" boolean; the ingest expands it to the concrete set:
  //   • Partial Dual = No  → ['FBDE','QMB+','SLMB+']  (full-benefit only)
  //   • Partial Dual = Yes → ['FBDE','QMB+','QMB','SLMB+','SLMB','QI']
  // Bench filter predicates read the array — "Accepts Partial Duals",
  // "Full-Benefit Only" — so the raw set stays the filter key.
  dsnp_accepted_populations: string[] | null;
  // True when the plan's contract is D-SNP-only (no mixed MA/D-SNP
  // under the same contract number). Signals a carrier with a
  // dedicated dual-population network + care model.
  dsnp_only_contract: boolean | null;
  premium: number;
  // The premium a member actually pays. For D-SNP (dual-eligible) plans
  // this is $0 because LIS auto-covers the Part D Basic Premium that
  // D-SNPs carry; for every other plan it equals `premium`. `premium`
  // itself retains the structural Part D Basic value so the brain's
  // cost-ranking + annual-total math stay consistent — UI surfaces that
  // need to show "what the member pays" should read `consumer_premium`.
  consumer_premium: number;
  annual_deductible: number | null;
  moop_in_network: number;
  moop_out_of_network: number | null;
  drug_deductible: number | null;
  // Derived from drug_deductible: false ⇒ MA-only (no Part D bundled),
  // which the broker filters as "VA" in the compare bench.
  has_drug_coverage: boolean;
  part_b_giveback: number;
  star_rating: number;
  // Medicare.gov Plan Compare deep-link for the plan's Summary of
  // Benefits page (`/plan-compare/#/plan-details/<year>/<triple>`).
  // /api/plans always populates this; static fallback rows construct
  // it from the id triple. Used by the agent UI to surface a "📄
  // Summary of Benefits ↗" link next to every plan rendering so Rob
  // can read the carrier-filed SoB during a member call without
  // leaving Plan Match for medicare.gov.
  sbf_url: string;
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
