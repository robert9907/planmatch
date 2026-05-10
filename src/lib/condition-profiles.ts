// Condition-aware utilization profiles.
//
// When a user picks a chronic condition in the About-You Step-2 grid,
// the Plan Brain swaps the generic low/moderate/high utilization
// (derived from drug-count) for the per-condition profile below.
// Each profile encodes the typical-year visit pattern used by
// Medicare actuaries when pricing C-SNP plans, plus the extras
// categories that materially change quality-of-life for that
// population (food card for diabetes, transport for COPD, etc.).
//
// Cost-breakdown text rendering uses the labels here to write
// "4 endocrinologist visits ($100)" instead of just "4 specialist
// visits" — distinguishes a diabetes-specific summary from a
// generic one.

import type { CsnpCondition } from './brain-foreign-types';
import type { Utilization } from './plan-brain-types';

export interface ConditionSupply {
  readonly key: string;
  readonly label: string;                  // Intake-checklist label
  readonly humanLabel: string;             // Margaret-friendly display
  readonly brands?: ReadonlyArray<string>; // Brand names that count as covered
                                           // for this supply. When the plan's
                                           // pbp_benefits.benefit_description
                                           // doesn't mention any of these
                                           // brands, it's still scored as
                                           // covered (assumes default brand
                                           // selection). When it DOES mention
                                           // brands, only listed brands count.
  readonly annualValue: number;            // Annual value used for extras
                                           // axis when covered.
  readonly benefitCategory: string;        // pbp_benefits.benefit_category
                                           // key to look up coverage.
}

export interface ConditionProfile {
  readonly key: CsnpCondition;
  readonly label: string;                  // Display word, lowercase
                                           // ("diabetes", "CHF", "COPD")
  readonly utilization: Utilization;
  readonly specialistLabel: string;        // "endocrinologist", "cardiologist"
  readonly imagingLabel?: string;          // "CT/PET scan", "echo"
  readonly labLabel?: string;              // "A1C", "BNP", "PFT"
  readonly suppliesLabel?: string;         // "diabetic supplies", "oxygen supplies"
  // High-cost drug names that drive the cost-breakdown's drug callout.
  // Case-insensitive substring match against user drug.name.
  readonly highCostDrugRe: RegExp;
  // Extras categories materially relevant to this condition. These
  // get an extra 1.5× boost in the Brain's extras axis on top of any
  // user-priority doubling.
  readonly keyExtras: ReadonlyArray<string>;
  // Typical med list — surfaced by future cross-sell prompts and the
  // "did you forget to add…" reconciliation. Plain names, not rxcuis.
  readonly typicalMeds: ReadonlyArray<string>;
  // When true, treat the plan's full MOOP as the medical cost for
  // ranking. Cancer patients almost always hit MOOP via Part B chemo
  // + frequent imaging; ranking by per-service copay would understate
  // their real spend dramatically.
  readonly assumeMoopHit?: boolean;
  // Condition-specific supplies the user picks on the supply
  // sub-step. Empty for conditions without a supply checklist
  // (cancer, hypertension currently — they're driven by med list
  // alone).
  readonly supplies: ReadonlyArray<ConditionSupply>;
}

// ─── Diabetes Type 2 ─────────────────────────────────────────────────
// 4 PCP, 2 endocrinologist, 4 A1C labs, 2 CMP, 1 dilated eye exam,
// 1 podiatry. Supplies (test strips/lancets/monitor) typically $0 on
// C-SNP. ER 15%, inpatient 5% × 3 days.
const DIABETES_SUPPLIES: ReadonlyArray<ConditionSupply> = [
  {
    key: 'test_strips',
    label: 'Test strips, lancets + glucose monitor',
    humanLabel: 'Test strips, monitor, lancets',
    brands: ['Contour', 'Accu-Chek', 'OneTouch', 'TrueMetrix'],
    annualValue: 400,
    benefitCategory: 'insulin', // pbp_benefits keys diabetic supplies under 'insulin'
  },
  {
    key: 'cgm',
    label: 'Continuous glucose monitor (FreeStyle Libre, Dexcom)',
    humanLabel: 'Continuous glucose monitor',
    brands: ['FreeStyle Libre', 'Dexcom'],
    annualValue: 3600,
    benefitCategory: 'cgm',
  },
  {
    key: 'insulin_pump',
    label: 'Insulin pump supplies',
    humanLabel: 'Insulin pump supplies',
    annualValue: 2400,
    benefitCategory: 'dme',
  },
  {
    key: 'therapeutic_shoes',
    label: 'Therapeutic shoes or inserts',
    humanLabel: 'Special diabetes shoes',
    annualValue: 300,
    benefitCategory: 'therapeutic_shoes',
  },
];

const DIABETES: ConditionProfile = {
  key: 'diabetes',
  label: 'diabetes',
  utilization: {
    pcp_visits: 4,
    specialist_visits: 4,        // 2 endocrinology + 1 dilated eye + 1 podiatry
    lab_visits: 6,                // 4 A1C + 2 CMP
    imaging_visits: 0,
    er_visits: 0.15,
    inpatient_days: 0.15,         // 0.05 × 3 days
  },
  specialistLabel: 'endocrinologist',
  labLabel: 'A1C / metabolic panel',
  suppliesLabel: 'diabetic supplies',
  highCostDrugRe: /\b(ozempic|trulicity|mounjaro|jardiance|farxiga|invokana|lantus|tresiba|toujeo|levemir|humalog|novolog|fiasp|admelog|basaglar|semglee)\b/i,
  keyExtras: ['insulin', 'meals', 'meal_benefit', 'fitness', 'otc'],
  typicalMeds: ['Metformin', 'Glipizide', 'Jardiance', 'Ozempic', 'Trulicity', 'Lantus', 'Humalog', 'Novolog'],
  supplies: DIABETES_SUPPLIES,
};

// ─── CHF / Cardiovascular ────────────────────────────────────────────
// 4 PCP, 4 cardiologist, 2 echo, 4 BNP labs, 1 chest X-ray. ER 25%,
// inpatient 30% × 4 days — the inpatient rate is what makes CHF the
// highest-MOOP-pressure non-cancer condition.
const CHF: ConditionProfile = {
  key: 'cardio',
  label: 'CHF / cardiovascular',
  utilization: {
    pcp_visits: 4,
    specialist_visits: 4,
    lab_visits: 4,
    imaging_visits: 3,            // 2 echo + 1 chest X-ray
    er_visits: 0.25,
    inpatient_days: 1.2,          // 0.30 × 4 days
  },
  specialistLabel: 'cardiologist',
  imagingLabel: 'echo / chest X-ray',
  labLabel: 'BNP',
  highCostDrugRe: /\b(entresto|jardiance|farxiga|eliquis|xarelto|pradaxa)\b/i,
  keyExtras: ['meal_benefit', 'transportation', 'meals', 'telehealth'],
  typicalMeds: ['Lisinopril', 'Losartan', 'Metoprolol', 'Carvedilol', 'Furosemide', 'Spironolactone'],
  supplies: [
    {
      key: 'bp_monitor',
      label: 'Home blood pressure monitor',
      humanLabel: 'Blood pressure monitor',
      annualValue: 60,
      benefitCategory: 'dme',
    },
    {
      key: 'heart_monitor',
      label: 'Portable heart monitor',
      humanLabel: 'Portable heart monitor',
      annualValue: 600,
      benefitCategory: 'dme',
    },
  ],
};

// ─── COPD ────────────────────────────────────────────────────────────
// 4 PCP, 4 pulmonologist, 2 PFTs, 1 chest CT. ER 25%, inpatient 20%
// × 4 days. Transport + telehealth matter — many COPD patients have
// limited mobility and benefit from in-home video visits.
const COPD: ConditionProfile = {
  key: 'copd',
  label: 'COPD',
  utilization: {
    pcp_visits: 4,
    specialist_visits: 4,
    lab_visits: 0,
    imaging_visits: 3,            // 2 PFT + 1 chest CT
    er_visits: 0.25,
    inpatient_days: 0.8,          // 0.20 × 4 days
  },
  specialistLabel: 'pulmonologist',
  imagingLabel: 'PFT / chest CT',
  highCostDrugRe: /\b(symbicort|spiriva|breo\s*ellipta|trelegy|advair|anoro|incruse|stiolto|prednisone)\b/i,
  keyExtras: ['transportation', 'telehealth', 'otc'],
  typicalMeds: ['Albuterol', 'Symbicort', 'Spiriva', 'Breo Ellipta', 'Prednisone'],
  supplies: [
    {
      key: 'home_oxygen',
      label: 'Home oxygen',
      humanLabel: 'Home oxygen',
      annualValue: 1200,
      benefitCategory: 'dme',
    },
    {
      key: 'nebulizer',
      label: 'Nebulizer + supplies',
      humanLabel: 'Nebulizer + supplies',
      annualValue: 480,
      benefitCategory: 'dme',
    },
  ],
};

// ─── Cancer (active treatment) ───────────────────────────────────────
// 4 PCP, 12 oncologist, 4 CT/PET, 24 labs. Part B chemo 20%
// coinsurance. ER 35%, inpatient 40% × 5 days. Active-treatment
// cancer patients almost always hit MOOP — assumeMoopHit drives the
// Brain to use the plan's full MOOP as the medical line so plans
// with lower MOOPs rank higher than plans with cheap copays but
// higher MOOPs.
const CANCER: ConditionProfile = {
  key: 'cancer',
  label: 'cancer treatment',
  utilization: {
    pcp_visits: 4,
    specialist_visits: 12,
    lab_visits: 24,
    imaging_visits: 4,
    er_visits: 0.35,
    inpatient_days: 2.0,          // 0.40 × 5 days
  },
  specialistLabel: 'oncologist',
  imagingLabel: 'CT / PET scan',
  highCostDrugRe: /\b(keytruda|opdivo|tagrisso|imbruvica|revlimid|verzenio|ibrance|kisqali|lynparza|tecentriq|enhertu|trodelvy)\b/i,
  keyExtras: ['transportation', 'meal_benefit', 'telehealth'],
  typicalMeds: ['Ondansetron', 'Compazine', 'Lorazepam', 'Filgrastim', 'Tamoxifen', 'Anastrozole'],
  assumeMoopHit: true,
  supplies: [],
};

// ─── Hypertension (BP-only, no other cardiac dx) ─────────────────────
// 4 PCP, 1 specialist, 2 CMP, 1 EKG. ER 5%, inpatient 2% × 2 days.
// The lowest-utilization condition profile — most plans price the
// same for these users. Fitness + telehealth matter for behavior-
// change support.
const HYPERTENSION: ConditionProfile = {
  key: 'hypertension',
  label: 'hypertension',
  utilization: {
    pcp_visits: 4,
    specialist_visits: 1,
    lab_visits: 2,                // CMP
    imaging_visits: 1,            // EKG
    er_visits: 0.05,
    inpatient_days: 0.04,         // 0.02 × 2 days
  },
  specialistLabel: 'cardiologist',
  imagingLabel: 'EKG',
  labLabel: 'metabolic panel',
  highCostDrugRe: /\b(entresto|valsartan)\b/i,
  keyExtras: ['fitness', 'telehealth'],
  typicalMeds: ['Amlodipine', 'Lisinopril', 'Hydrochlorothiazide', 'Atenolol', 'Losartan', 'Valsartan'],
  supplies: [],
};

// ESRD doesn't have a per-condition profile yet — falls back to the
// generic high-utilization profile in plan-brain-utils. Stub kept so
// exhaustiveness checks on CsnpCondition don't break.
const PROFILES_BY_KEY: Partial<Record<CsnpCondition, ConditionProfile>> = {
  diabetes: DIABETES,
  cardio: CHF,
  copd: COPD,
  cancer: CANCER,
  hypertension: HYPERTENSION,
};

export const ALL_CONDITION_PROFILES: ReadonlyArray<ConditionProfile> = [
  DIABETES, CHF, COPD, CANCER, HYPERTENSION,
];

// Pick the dominant condition when a user has multiple selections.
// Severity order: cancer > CHF > COPD > diabetes > hypertension > esrd.
// First-match wins from this priority list.
const SEVERITY_ORDER: ReadonlyArray<CsnpCondition> = [
  'cancer', 'cardio', 'copd', 'diabetes', 'hypertension', 'esrd',
];

export function dominantConditionProfile(
  conditions: ReadonlyArray<CsnpCondition> | undefined,
): ConditionProfile | null {
  if (!conditions || conditions.length === 0) return null;
  const set = new Set(conditions);
  for (const k of SEVERITY_ORDER) {
    if (set.has(k)) {
      const p = PROFILES_BY_KEY[k];
      if (p) return p;
    }
  }
  return null;
}

export function conditionProfileFor(key: CsnpCondition): ConditionProfile | null {
  return PROFILES_BY_KEY[key] ?? null;
}
