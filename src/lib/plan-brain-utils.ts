// plan-brain-utils — utilization estimation, axis normalization, and
// constants for benefit dollar values.
//
// Two ways the Brain estimates a year's medical service mix:
//   1. Utilization profile (low / moderate / high) derived from medication
//      count when no condition is given.
//   2. Condition profile — explicit visit counts for diabetes / CHF /
//      COPD / cancer / hypertension. Overrides #1 when set.

import type {
  ConditionKey,
  UtilizationCounts,
  UtilizationProfile,
} from './plan-brain-types';

// IRA-mandated insulin cap, set by CMS for 2026 contract year.
export const INSULIN_CAP_MONTHLY = 35;

// Utilization-bucket service counts per spec.
const UTILIZATION_PROFILES: Record<UtilizationProfile, UtilizationCounts> = {
  low:      { pcp: 2, specialist: 1, lab: 1, imaging: 0, er: 0,    inpatient: 0 },
  moderate: { pcp: 4, specialist: 3, lab: 2, imaging: 1, er: 0.5,  inpatient: 0 },
  high:     { pcp: 6, specialist: 5, lab: 3, imaging: 2, er: 1,    inpatient: 0.3 },
};

// Condition-specific overrides. When a condition is selected these
// replace the utilization-bucket counts entirely.
const CONDITION_PROFILES: Record<ConditionKey, UtilizationCounts> = {
  diabetes:    { pcp: 4, specialist: 4,  lab: 6,  imaging: 0, er: 0.15, inpatient: 0.15 },
  chf:         { pcp: 4, specialist: 4,  lab: 4,  imaging: 3, er: 0.25, inpatient: 1.2 },
  copd:        { pcp: 4, specialist: 4,  lab: 0,  imaging: 3, er: 0.25, inpatient: 0.8 },
  cancer:      { pcp: 4, specialist: 12, lab: 24, imaging: 4, er: 0.35, inpatient: 2.0 },
  hypertension:{ pcp: 4, specialist: 1,  lab: 2,  imaging: 1, er: 0.05, inpatient: 0.04 },
};

export function deriveUtilization(medCount: number, condition?: ConditionKey | null): UtilizationProfile {
  // Condition trumps utilization — but we still report a bucket label
  // so the debug log can show "high" for cancer etc.
  if (condition === 'cancer' || condition === 'chf' || condition === 'copd') return 'high';
  if (condition === 'diabetes') return medCount >= 5 ? 'high' : 'moderate';
  if (condition === 'hypertension') return medCount >= 5 ? 'moderate' : 'low';
  if (medCount <= 2) return 'low';
  if (medCount <= 6) return 'moderate';
  return 'high';
}

export function utilizationServiceCounts(
  profile: UtilizationProfile,
  condition?: ConditionKey | null,
): UtilizationCounts {
  if (condition && CONDITION_PROFILES[condition]) return { ...CONDITION_PROFILES[condition] };
  return { ...UTILIZATION_PROFILES[profile] };
}

// Normalize an array of dollar values onto a 0-100 scale. lowIsBetter
// flips the sign so cheaper plans score higher. When all inputs are
// equal we return 100s so a single-plan pool doesn't render NaN.
export function normalizeAxis(values: number[], lowIsBetter: boolean): number[] {
  if (values.length === 0) return [];
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return values.map(() => 0);
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (max === min) return values.map(() => 100);
  return values.map((v) => {
    if (!Number.isFinite(v)) return 0;
    const ratio = (v - min) / (max - min);
    return lowIsBetter ? Math.round((1 - ratio) * 100) : Math.round(ratio * 100);
  });
}

// Default dollar values for extras when the plan offers the benefit.
// Per-spec — these become the per-row contribution to extrasValue.
export interface ExtraValueDefault {
  // Function so we can derive value from actual plan data when known
  // (e.g., $55/mo OTC → $660/yr) and fall back to the constant
  // when only a "covered" boolean is present.
  fn: (rawAmount: number | null) => number;
}

export const EXTRA_DEFAULTS: Record<string, ExtraValueDefault> = {
  dental_preventive:   { fn: (a) => (a != null ? a : 200) },
  dental_oral_exam:    { fn: () => 200 },
  dental_cleaning:     { fn: () => 200 },
  vision_exam:         { fn: () => 100 },
  vision_eyewear:      { fn: (a) => (a != null && a > 0 ? a : 75) },
  vision_contacts:     { fn: (a) => (a != null && a > 0 ? a : 75) },
  hearing_exam:        { fn: () => 50 },
  hearing_aid_rx:      { fn: (a) => (a != null && a > 0 ? a : 300) },
  hearing_aid_otc:     { fn: () => 100 },
  otc_quarter:         { fn: (a) => (a != null ? a * 4 : 0) },
  otc_items:           { fn: (a) => (a != null ? a * 4 : 0) },
  otc:                 { fn: (a) => (a != null ? a * 12 : 200) },
  food_card_month:     { fn: (a) => (a != null ? a * 12 : 0) },
  food_card:           { fn: (a) => (a != null ? a * 12 : 0) },
  fitness:             { fn: () => 300 },
  fitness_visit:       { fn: () => 300 },
  transportation:      { fn: () => 200 },
  transportation_trips:{ fn: (a) => (a != null && a > 0 ? a * 30 : 200) },
  meals_short_duration:{ fn: () => 150 },
  meals:               { fn: () => 150 },
  meal_benefit:        { fn: () => 150 },
  diabetic_supplies:   { fn: () => 400 },
  telehealth:          { fn: () => 100 },
  telehealth_visit:    { fn: () => 100 },
};

// Condition → extras key that gets the 1.5× condition boost.
export const CONDITION_KEY_EXTRAS: Record<ConditionKey, string[]> = {
  diabetes: ['food_card_month', 'food_card', 'diabetic_supplies'],
  copd: ['transportation_trips', 'transportation'],
  chf: ['meals', 'meal_benefit', 'meals_short_duration'],
  cancer: ['transportation_trips', 'transportation'],
  hypertension: ['food_card_month', 'food_card'],
};

// Map ma_benefits service-string flavours to the canonical benefit_type
// the engine expects. The scraper writes these names; older
// pbp_federal rows used different ones — normalize so both layers feed
// the same calculation.
export function canonicalBenefitType(raw: string): string {
  const t = (raw || '').toLowerCase();
  // Common aliases
  if (t === 'primary_care_visit') return 'primary_care';
  if (t === 'specialist_visit') return 'specialist';
  if (t === 'emergency_room') return 'emergency';
  if (t === 'inpatient_hospital') return 'inpatient_hospital';
  return t;
}
