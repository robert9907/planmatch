// Shared types for the Plan Match ↔ Medicare Plan Finder parity audit.
//
// Field numbering follows docs/parity-audit/SPEC.md sections 3.1–3.13.
// Two spec fields removed by corrections log C5 (inpatient + psych day
// limits) — effective field count is 92.

// ─── Beneficiary profile ─────────────────────────────────────────────

export type USState = 'NC' | 'TX' | 'GA';

export type MedicaidStatus =
  | 'none'
  | 'qmb'         // Qualified Medicare Beneficiary
  | 'slmb'        // Specified Low-Income Medicare Beneficiary
  | 'qi'          // Qualifying Individual
  | 'qdwi'        // Qualified Disabled and Working Individual
  | 'full-dual';  // Full Medicaid + Medicare

// Post-IRA §11404 (effective 2024-01-01) partial LIS levels no longer exist.
// Everyone previously on partial LIS is now on full LIS at one of two income bands
// resolved at snapshot time (see pm-snapshot.ts::deriveLisTier).
export type LISLevel = 'none' | 'full';

export type DrugPart = 'part-b' | 'part-d' | 'part-b-or-d';

export type Tier = 1 | 2 | 3 | 4 | 5 | 6;

export type ExpectedTier = Tier | 'part-b' | 'otc';

export type SNPCategory = 'c-snp-diabetes' | 'c-snp-chf' | 'c-snp-copd' | 'i-snp' | 'd-snp';

// Administration setting — used to disambiguate Part-B-or-D drugs (Prolia,
// Benlysta, Radicava, Filgrastim). When absent, Part D formulary presence
// is treated as valid (assumes self-administered, no F9 misclassification).
export type AdminSetting = 'office' | 'provider-administered' | 'home' | 'self-administered';

export interface Drug {
  name: string;                 // Brand or generic label name
  strength: string;             // "49/51mg", "1000mg", "5mg"
  quantityPerMonth: number;     // Numeric units; use 30 for 1 pen/mo, etc.
  form?: string;                // "tabs", "caps", "pen", "inhaler", "injection"
  expectedTier: ExpectedTier;   // Advisory (from spec) — actual comes from formulary
  part: DrugPart;
  setting?: AdminSetting;       // Only set when the profile pins the route
  notes?: string;
}

export interface BeneficiaryProfile {
  id: string;                   // "01-margaret" — kebab case, prefixed with zero-padded index
  name: string;                 // "Margaret"
  age: number;
  state: USState;
  countyName: string;           // "Durham" (no "County" suffix)
  countyFips: string;           // "37063"
  zip: string;                  // "27707"
  medicaid: MedicaidStatus;
  lis: LISLevel;
  esrd: boolean;
  disabilityBased: boolean;     // Under-65 disability-based Medicare
  snpEligibility: SNPCategory[];
  conditions: string[];
  specialists: string[];        // "Cardiology", "Nephrology"
  hospital: {
    admissionsPerYear: number;
    erVisitsPerYear: number;
    inpatientAvgDays?: number;
  };
  snf: {
    staysPerYear: number;
    avgDaysPerStay: number;
  };
  dme?: string[];
  drugs: Drug[];
  language?: 'en' | 'es';
  auditFocus: string;
  complexityScore: number;
}

// ─── Plan snapshot (mirrors 94-field spec §3.1–3.13, minus C5 removals) ──

export interface PlanIdentification {
  planName: string;
  contractId: string;           // "H5253"
  planId: string;               // "189"
  segmentId: string;            // "000"
  planType: string;             // "MAPD" | "MA" | "PDP" | "D-SNP" | "C-SNP" | ...
  starRating: number | null;    // 1.0–5.0, half-star
  orgName: string;              // Parent organization
}

export interface PremiumAndDeductible {
  monthlyPremium: number | null;
  partBPremiumReduction: number | null;
  partDPremium: number | null;
  medicalDeductibleIN: number | null;
  medicalDeductibleOON: number | null;
  partDDrugDeductible: number | null;
  drugDeductibleTierExceptions: string | null;
  annualMoopIN: number | null;
}

// Inpatient — Fields 19 (day limit) and 21 (psych day limit) removed by C5.
export interface InpatientCostSharing {
  perAdmissionCopay: number | null;
  perDayTiered: Array<{ dayRange: string; copay: number }> | null;
  coinsurance: number | null;
  psychInpatientCopay: number | null;
  snfDays1to20: number | null;
  snfDays21to100: number | null;
}

export interface OutpatientCostSharing {
  pcpCopay: number | null;
  specialistCopay: number | null;
  preventiveCopay: number | null;  // Must be 0 per ACA
  urgentCareCopay: number | null;
  erCopay: number | null;
  ambulanceGroundCopay: number | null;
  ambulanceAirCopay: number | null;
  outpatientSurgeryAsc: number | null;
  outpatientSurgeryHospital: number | null;
  diagnosticLabsCopay: number | null;
  diagnosticRadiologyCopay: number | null;
  advancedImagingCopay: number | null;
  mhOutpatientIndividual: number | null;
  mhOutpatientGroup: number | null;
  substanceAbuseCopay: number | null;
}

export interface TherapyAndDme {
  ptCopay: number | null;
  otCopay: number | null;
  stCopay: number | null;
  cardiacRehabCopay: number | null;
  pulmonaryRehabCopay: number | null;
  dmeCoinsurance: number | null;
}

export interface OtherMedical {
  homeHealthCopay: number | null;
  telehealthCopay: number | null;
  partBDrugCoinsurance: number | null;
  dialysisCopay: number | null;
  skilledNursingHomeCopay: number | null;
  chiropracticCopay: number | null;
  podiatryCopay: number | null;
}

// Rx structure — pref/std pharmacy split per tier + mail order.
export interface RxTierCostSharing {
  preferredPharmacy30: number | null;
  standardPharmacy30: number | null;
  preferredMailOrder90: number | null;
  standardMailOrder90: number | null;
  // Coinsurance flag when the value above is % not $. UI resolves.
  isCoinsurance: boolean;
}

export interface RxStructure {
  tier1: RxTierCostSharing;
  tier2: RxTierCostSharing;
  tier3: RxTierCostSharing;
  tier4: RxTierCostSharing;
  tier5: RxTierCostSharing;
  tier6: RxTierCostSharing | null; // Some plans have 6 tiers
}

// Rx phases — post-IRA corrections (C1, C2) — ICL and gap fields removed.
export interface RxPhases {
  partDOopCap: number | null;               // $2,100 CY2026 (up from $2,000 CY2025); indexed annually per IRA §11201
  catastrophicCopayGeneric: number | null;  // $0 post-IRA
  catastrophicCopayBrand: number | null;    // $0 post-IRA
  partDVaccinesZero: boolean | null;        // Should be true per IRA §11401
}

export interface DrugCoverage {
  drug: Drug;
  onFormulary: boolean;
  tier: Tier | null;
  priorAuth: boolean;
  quantityLimit: boolean;
  quantityLimitAmount: number | null;
  quantityLimitDays: number | null;
  stepTherapy: boolean;
  specialtyPharmacy: boolean;
  // Preferred/standard pharmacy copay for this specific drug at profile's tier.
  preferredCopay: number | null;
  standardCopay: number | null;
  isCoinsurance: boolean;
}

export interface DentalBenefits {
  preventiveCovered: boolean | null;
  comprehensiveCovered: boolean | null;
  annualMax: number | null;
  copay: number | null;
}

export interface VisionBenefits {
  routineExamCovered: boolean | null;
  eyewearAllowance: number | null;
  contactLensAllowance: number | null;
  examCopay: number | null;
}

export interface HearingBenefits {
  routineExamCovered: boolean | null;
  hearingAidBenefit: number | null;
  examCopay: number | null;
}

export interface SupplementalBenefits {
  otcAllowance: number | null;              // Quarterly or monthly $
  otcAllowancePeriod: 'monthly' | 'quarterly' | null;
  transportationTripsPerYear: number | null;
  mealsPostDischarge: string | null;        // e.g., "14 meals for 2 weeks"
  fitnessBenefit: string | null;            // "SilverSneakers" | "Renew Active"
  telehealthAccess: boolean | null;
  foodCardMonthly: number | null;           // D-SNP grocery card $
  caregiverSupport: boolean | null;
  inHomeSupportHoursPerMonth: number | null;
  acupunctureVisitsPerYear: number | null;
  worldwideEmergency: boolean | null;
  nurseHotline: boolean | null;
}

export interface PlanSnapshot {
  source: 'mpf' | 'pm';
  capturedAt: string;                       // ISO
  profileId: string;
  ident: PlanIdentification;
  premium: PremiumAndDeductible;
  inpatient: InpatientCostSharing;
  outpatient: OutpatientCostSharing;
  therapy: TherapyAndDme;
  otherMedical: OtherMedical;
  rxStructure: RxStructure;
  rxPhases: RxPhases;
  drugCoverage: DrugCoverage[];
  dental: DentalBenefits;
  vision: VisionBenefits;
  hearing: HearingBenefits;
  supplemental: SupplementalBenefits;
}

// ─── Comparison / report types ────────────────────────────────────────

export type FieldStatus = 'PASS' | 'CONDITIONAL' | 'FAIL' | 'N/A';

export type FailCode =
  | 'F1'   // Value mismatch
  | 'F2'   // Missing field
  | 'F3'   // Extra field
  | 'F4'   // Formulary error
  | 'F5'   // Eligibility filter error
  | 'F6'   // Plan missing
  | 'F7'   // LIS/Dual override failure
  | 'F8'   // IRA provision error
  | 'F9'   // Part B vs D misclassification
  | 'F10'; // Supplemental benefit error

export type FieldSeverity = 'critical' | 'major' | 'minor' | 'display';

export interface FieldComparison {
  fieldPath: string;              // "premium.monthlyPremium" | "drugCoverage[0].tier"
  category: string;               // "3.2 Premium & Deductible"
  mpfValue: unknown;
  pmValue: unknown;
  status: FieldStatus;
  failCode?: FailCode;
  severity: FieldSeverity;
  note?: string;
}

export interface PlanComparison {
  planKey: string;                // "H5253-189-000"
  planName: string;
  comparisons: FieldComparison[];
  passCount: number;
  conditionalCount: number;
  failCount: number;
  naCount: number;
  weightedScore: number;          // 0..1
  unweightedParity: number;       // 0..1
}

export interface ProfileReport {
  profileId: string;
  runAt: string;                  // ISO
  planComparisons: PlanComparison[];
  aggregatePassRate: number;      // 0..1 (excludes N/A from denominator)
  aggregateWeightedRate: number;  // 0..1
  criticalFailures: FieldComparison[];
}

export interface RollupReport {
  runAt: string;
  profiles: ProfileReport[];
  byState: Record<USState, { passRate: number; weightedRate: number }>;
  byCategory: Record<string, { passRate: number; failCount: number }>;
  rootCausePareto: Array<{ code: FailCode; count: number }>;
  overallPassRate: number;
  overallWeightedRate: number;
  meetsTarget: boolean;           // >= 98.9% unweighted AND >= 97.5% weighted
  // False when zero comparisons were recorded across all profiles+plans.
  // Prevents the "0/0 = 100%" vacuous PASS on runs where MPF returned no
  // plans, Supabase was empty, or every comparison came back N/A.
  hasData: boolean;
  totalComparisons: number;
}
