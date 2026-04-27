// utilization-model — condition-driven service-utilization profiles
// and a real-annual-cost calculator for the V4 quote table.
//
// Why a new model: the previous deriveUtilization() emitted three
// fixed buckets (low / moderate / high) plus a separate CONDITION_PROFILES
// map. Conditions didn't stack — diabetes + CHF used CHF's profile and
// dropped diabetes's supply count. The real-broker view needs:
//   • probabilities for ER/hospital, not visit counts (a 15% chance of
//     a $120 ER copay is ~$18, not $120 × 0.15 = $18 by accident)
//   • monthly supplies count separate from medical visits
//   • condition stacking via MAX(visits) and 1−Π(1−p) for probabilities
//
// calculateRealAnnualCost composes the human-readable dollar number
// rendered in the Total Annual Value row. Premium + drugs + (visit
// copays + supplies + ER expectation + hospital expectation, capped at
// MOOP) − giveback. The breakdown object lets the UI tooltip surface
// every line item without re-deriving them.

import type { Plan } from '@/types/plans';
import type { Condition } from './condition-detector';

export interface UtilizationProfile {
  /** PCP visits per year. */
  pcp: number;
  /** Specialist visits per year. */
  specialist: number;
  /** Lab tests per year. */
  labs: number;
  /** Probability (0..1) of ≥1 ER visit in the year. */
  erProbability: number;
  /** Probability (0..1) of ≥1 hospital admission in the year. */
  hospitalProbability: number;
  /** Expected days hospitalized IF admitted. */
  hospitalDays: number;
  /** Months of medical supplies needed (12 = year-round, e.g. diabetic
   *  test strips). 0 means no recurring supplies. */
  monthlySupplies: number;
}

const HEALTHY: UtilizationProfile = {
  pcp: 2,
  specialist: 0,
  labs: 1,
  erProbability: 0.05,
  hospitalProbability: 0.02,
  hospitalDays: 3,
  monthlySupplies: 0,
};

// Per-condition profiles. Numbers are clinical typical-utilization for
// well-controlled Medicare-age patients. Conservative — a poorly
// controlled patient lands above these counts; the broker's job is to
// quote against typical utilization, not the worst case.
const PROFILES: Record<Condition, UtilizationProfile> = {
  diabetes: {
    pcp: 4, specialist: 4, labs: 6,
    erProbability: 0.15, hospitalProbability: 0.08,
    hospitalDays: 4, monthlySupplies: 12,
  },
  chf: {
    pcp: 4, specialist: 6, labs: 8,
    erProbability: 0.25, hospitalProbability: 0.20,
    hospitalDays: 5, monthlySupplies: 0,
  },
  copd: {
    pcp: 4, specialist: 4, labs: 4,
    erProbability: 0.20, hospitalProbability: 0.12,
    hospitalDays: 4, monthlySupplies: 0,
  },
  ckd: {
    pcp: 4, specialist: 6, labs: 12,
    erProbability: 0.15, hospitalProbability: 0.10,
    hospitalDays: 4, monthlySupplies: 0,
  },
  hypertension: {
    pcp: 3, specialist: 1, labs: 3,
    erProbability: 0.05, hospitalProbability: 0.03,
    hospitalDays: 3, monthlySupplies: 0,
  },
  // AFib piggybacks on hypertension utilization — most cost shows up
  // in anticoagulant Rx, not extra visits.
  afib: {
    pcp: 4, specialist: 4, labs: 6,
    erProbability: 0.15, hospitalProbability: 0.10,
    hospitalDays: 4, monthlySupplies: 0,
  },
};

/**
 * Combine multiple condition profiles into one. Visit fields take MAX
 * (most-acute condition wins per category); probabilities combine via
 * 1 − Π(1 − pᵢ) (independent-event union). monthlySupplies takes MAX
 * (one supplies stream covers the whole year).
 */
export function buildUtilization(conditions: Iterable<Condition>): UtilizationProfile {
  const list = [...conditions];
  if (list.length === 0) return { ...HEALTHY };
  const out: UtilizationProfile = { ...HEALTHY };
  // Reset probabilities to 0 so the first condition isn't combined
  // with healthy's 5%/2% baseline (otherwise diabetes alone would
  // read as 19% ER instead of its filed 15%).
  out.erProbability = 0;
  out.hospitalProbability = 0;
  for (const c of list) {
    const p = PROFILES[c];
    if (!p) continue;
    out.pcp = Math.max(out.pcp, p.pcp);
    out.specialist = Math.max(out.specialist, p.specialist);
    out.labs = Math.max(out.labs, p.labs);
    out.hospitalDays = Math.max(out.hospitalDays, p.hospitalDays);
    out.monthlySupplies = Math.max(out.monthlySupplies, p.monthlySupplies);
    out.erProbability = 1 - (1 - out.erProbability) * (1 - p.erProbability);
    out.hospitalProbability = 1 - (1 - out.hospitalProbability) * (1 - p.hospitalProbability);
  }
  // Round probabilities so the breakdown tooltip doesn't read like
  // "ER risk $23.4567/yr".
  out.erProbability = Math.round(out.erProbability * 1000) / 1000;
  out.hospitalProbability = Math.round(out.hospitalProbability * 1000) / 1000;
  return out;
}

export interface RealAnnualCost {
  /** Monthly premium × 12. */
  premium: number;
  /** Annual Rx total (caller supplies — already net of IRA insulin
   *  cap, formulary tier estimates, etc.). */
  drugs: number;
  /** PCP + specialist + lab copays × utilization counts. */
  medicalVisits: number;
  /** Diabetic supplies copay × monthlySupplies. 0 unless supplies. */
  supplies: number;
  /** ER copay × erProbability — expected-value, not best/worst case. */
  erExpected: number;
  /** Inpatient day-1 copay × hospitalDays × hospitalProbability. */
  hospitalExpected: number;
  /** Annual giveback credit (positive number; subtracted from net). */
  givebackSavings: number;
  /** Sum of (medicalVisits + supplies + erExpected + hospitalExpected),
   *  pre-cap. Surfaced so the UI can show whether MOOP kicked in. */
  medicalGross: number;
  /** medicalGross capped at plan.moop_in_network when MOOP > 0. */
  medicalCapped: number;
  /** True when medicalGross would have exceeded MOOP. */
  cappedAtMoop: boolean;
  /** premium + drugs + medicalCapped − givebackSavings. The number
   *  rendered in the Total Annual Value row. */
  netAnnual: number;
}

interface CostShareLite {
  copay: number | null;
  coinsurance: number | null;
}

function asNumber(x: number | null | undefined, fallback: number): number {
  if (x == null) return fallback;
  if (!Number.isFinite(x)) return fallback;
  return x;
}

function copayOrEstimatedCoinsurance(cs: CostShareLite | undefined, serviceEstimate: number): number {
  if (!cs) return 0;
  if (cs.copay != null) return cs.copay;
  if (cs.coinsurance != null) return (serviceEstimate * cs.coinsurance) / 100;
  return 0;
}

/**
 * Compose the structured annual-cost breakdown for one plan against
 * one client's utilization profile.
 *
 * @param plan          Plan record from /api/plans (needs .premium,
 *                      .moop_in_network, .part_b_giveback, and
 *                      .benefits.medical for visit copays).
 * @param drugAnnual    Annual Rx total ($/yr) — already computed by
 *                      the brain's drug-cost loop.
 * @param util          Utilization profile from buildUtilization().
 * @param diabeticSuppliesCopay  Per-month supplies copay if the plan
 *                      files diabetic_supplies in pbp_benefits, else
 *                      0. Caller threads this in so we don't reach
 *                      back into the benefit-row data here.
 * @param inpatientDayOne  Plan's inpatient day-1 copay from
 *                      pbp_benefits.inpatient_hospital tier_id="days_1-…",
 *                      or null if the plan files coinsurance instead.
 */
export function calculateRealAnnualCost(args: {
  plan: Plan;
  drugAnnual: number;
  util: UtilizationProfile;
  diabeticSuppliesCopay: number;
  inpatientDayOne: number | null;
}): RealAnnualCost {
  const { plan, drugAnnual, util, diabeticSuppliesCopay, inpatientDayOne } = args;

  const premium = asNumber(plan.premium, 0) * 12;
  const giveback = asNumber(plan.part_b_giveback, 0) * 12;
  const moop = asNumber(plan.moop_in_network, 0);

  // Visit copays. Specialist falls back to $35 (typical 2026 MAPD
  // network specialist copay) when the plan files null, mirroring
  // what computeMedicalCost on the OOP axis already does.
  const med = plan.benefits.medical;
  const pcpCopay = copayOrEstimatedCoinsurance(med.primary_care, 200);
  const specialistCopay = copayOrEstimatedCoinsurance(med.specialist, 200) || 35;
  const labCopay = copayOrEstimatedCoinsurance(med.lab_services, 100);
  const erCopay = copayOrEstimatedCoinsurance(med.emergency, 1500) || 120;

  const medicalVisits =
    util.pcp * pcpCopay +
    util.specialist * specialistCopay +
    util.labs * labCopay;

  const supplies = util.monthlySupplies * diabeticSuppliesCopay;

  const erExpected = erCopay * util.erProbability;

  // Hospital — use day-1 copay × days × probability. When the plan
  // doesn't file a day-interval copay (coinsurance plans), fall back
  // to a representative $295/day (CMS 2026 average inpatient day-1).
  const hospitalDayCopay = inpatientDayOne ?? 295;
  const hospitalExpected = hospitalDayCopay * util.hospitalDays * util.hospitalProbability;

  const medicalGross = medicalVisits + supplies + erExpected + hospitalExpected;
  const medicalCapped = moop > 0 ? Math.min(medicalGross, moop) : medicalGross;
  const cappedAtMoop = moop > 0 && medicalGross > moop;

  const netAnnual = Math.round(premium + drugAnnual + medicalCapped - giveback);

  return {
    premium: Math.round(premium),
    drugs: Math.round(drugAnnual),
    medicalVisits: Math.round(medicalVisits),
    supplies: Math.round(supplies),
    erExpected: Math.round(erExpected),
    hospitalExpected: Math.round(hospitalExpected),
    givebackSavings: Math.round(giveback),
    medicalGross: Math.round(medicalGross),
    medicalCapped: Math.round(medicalCapped),
    cappedAtMoop,
    netAnnual,
  };
}

// Convenience: compose a "Why this number" tooltip string from a
// RealAnnualCost. Placed here so the UI doesn't re-derive component
// names that may drift over time.
export function formatRealAnnualCostBreakdown(c: RealAnnualCost): string {
  const parts: string[] = [];
  if (c.drugs > 0) parts.push(`Rx $${c.drugs.toLocaleString()}`);
  if (c.premium > 0) parts.push(`+ Premium $${c.premium.toLocaleString()}`);
  if (c.medicalVisits > 0) parts.push(`+ Medical $${c.medicalVisits.toLocaleString()}`);
  if (c.supplies > 0) parts.push(`+ Supplies $${c.supplies.toLocaleString()}`);
  if (c.erExpected > 0) parts.push(`+ ER risk $${c.erExpected.toLocaleString()}`);
  if (c.hospitalExpected > 0) parts.push(`+ Hospital risk $${c.hospitalExpected.toLocaleString()}`);
  if (c.cappedAtMoop) parts.push('(medical capped at MOOP)');
  if (c.givebackSavings > 0) parts.push(`− Giveback $${c.givebackSavings.toLocaleString()}`);
  parts.push(`= $${c.netAnnual.toLocaleString()}/yr`);
  return parts.join(' ');
}
