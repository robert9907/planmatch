// Condition-driven annual utilization + cost model.
//
// What it solves: the Report Card was showing "$17/yr" for a diabetic on
// Ozempic + Metformin + Lisinopril + Atorvastatin. That's just the
// premium net of giveback. A real diabetic's calendar year on a Medicare
// plan is thousands — endocrinologist visits, quarterly labs, diabetic
// supplies, diabetic-emergency probability, hospitalization probability.
//
// This module:
//   1. Defines a per-condition utilization profile (visits, labs, ER /
//      hospital probability, supply months) — actuarial-typical for the
//      population.
//   2. Combines profiles when a user has multiple conditions: count
//      fields take the MAX (overlapping visits, not sum) and probability
//      fields combine via 1 - (1-p1)(1-p2) (either condition could
//      trigger the event).
//   3. Calculates the real annual cost on a given plan: premium + drugs
//      + medical (utilization × copays) + supplies + expected ER cost
//      + expected hospital cost − Part B giveback. Medical-side costs
//      are MOOP-capped (worst case is bounded by the in-network MOOP).
//
// The brain calls this once per plan, stores the AnnualCostEstimate on
// BrainScore.realAnnualCost, and uses .netAnnual as the OOP axis input
// (replacing the old totalOOPEstimate that omitted ER/hospital risk and
// supplies). Cards display .netAnnual in place of the premium-only number.

export type UtilizationCondition =
  | 'diabetes'
  | 'chf'
  | 'copd'
  | 'ckd'
  | 'hypertension'
  | 'healthy';

export interface AnnualUtilization {
  pcpVisits: number;
  specialistVisits: number;
  labDraws: number;
  erProbability: number;        // 0.0 to 1.0
  hospitalProbability: number;  // 0.0 to 1.0
  hospitalDays: number;         // average if admitted
  imagingScans: number;
  eyeExams: number;
  podiatryVisits: number;
  diabeticSuppliesMonths: number;
  telehealth: number;
  // Step 3 — categories added so the Gate 4 cost sort sees them. Each
  // routes a copay or coinsurance through the medical bucket pre-MOOP.
  snfDaysExpected: number;        // expected SNF days per year
  ambulanceTripsExpected: number; // expected emergency transport trips
  dmeAnnualSpend: number;         // notional retail $ that DME coins applies to
}

export interface AnnualCostEstimate {
  premium: number;              // monthly_premium × 12
  drugCost: number;             // totalAnnualDrugCost
  medicalCost: number;          // utilization × copays (pre-cap)
  suppliesCost: number;         // diabetic supplies × 12 (when diabetic)
  erExpected: number;           // ER copay × probability
  hospitalExpected: number;     // hospital per-day × days × probability
  // Step 3 — Gate 4 cost components.
  snfExpected: number;          // SNF day-1 copay × expected days
  ambulanceExpected: number;    // per-trip copay × expected trips
  dmeExpected: number;          // DME coinsurance × annual DME spend
  deductibleCost: number;       // pm_plans.annual_deductible passthrough
  partBGivebackSavings: number; // annualized giveback (subtracted)
  // Medical bucket capped at in-network MOOP (medical + supplies + ER +
  // hospital + SNF + ambulance + DME + deductible). MOOP doesn't cover
  // premium or drugs, so those stay raw.
  cappedMedicalBucket: number;
  // Final number to surface on cards — premium + drugs + capped medical
  // bucket − giveback. Floor at 0.
  netAnnual: number;
}

// Per-condition utilization. Actuarial-typical for the Medicare-age
// population with that diagnosis, drawn from CMS prevalence + AGS care
// guidelines. Used as input to combineUtilization — never consumed
// directly because a real user almost always has more than one
// condition.
const UTILIZATION_PROFILES: Record<UtilizationCondition, AnnualUtilization> = {
  diabetes: {
    pcpVisits: 4,                  // quarterly checkups
    specialistVisits: 4,           // endocrinologist quarterly
    labDraws: 6,                   // A1C q3mo + metabolic + kidney
    erProbability: 0.15,           // diabetic emergency / hypoglycemia
    hospitalProbability: 0.08,
    hospitalDays: 4,
    imagingScans: 0,
    eyeExams: 1,                   // retinopathy screening
    podiatryVisits: 2,             // neuropathy foot care
    diabeticSuppliesMonths: 12,
    telehealth: 4,
    snfDaysExpected: 1,            // rare diabetic complication SNF stay
    ambulanceTripsExpected: 0.15,  // tracks ER probability
    dmeAnnualSpend: 600,           // CGM sensors, lancets, monitors
  },
  chf: {
    pcpVisits: 4,
    specialistVisits: 6,           // cardiologist + possibly nephrologist
    labDraws: 8,                   // BNP, metabolic, kidney
    erProbability: 0.25,           // CHF exacerbations
    hospitalProbability: 0.20,     // high readmission rate
    hospitalDays: 5,
    imagingScans: 2,               // echo, chest X-ray
    eyeExams: 0,
    podiatryVisits: 0,
    diabeticSuppliesMonths: 0,
    telehealth: 6,                 // weight monitoring
    snfDaysExpected: 5,            // post-hospitalization rehab common
    ambulanceTripsExpected: 0.25,
    dmeAnnualSpend: 400,
  },
  copd: {
    pcpVisits: 4,
    specialistVisits: 4,           // pulmonologist
    labDraws: 4,
    erProbability: 0.20,           // exacerbations
    hospitalProbability: 0.12,
    hospitalDays: 4,
    imagingScans: 2,               // chest X-ray, CT
    eyeExams: 0,
    podiatryVisits: 0,
    diabeticSuppliesMonths: 0,
    telehealth: 4,
    snfDaysExpected: 2,
    ambulanceTripsExpected: 0.20,
    dmeAnnualSpend: 800,           // oxygen, nebulizer, CPAP
  },
  ckd: {
    pcpVisits: 4,
    specialistVisits: 6,           // nephrologist
    labDraws: 12,                  // monthly kidney function
    erProbability: 0.15,
    hospitalProbability: 0.10,
    hospitalDays: 5,
    imagingScans: 0,
    eyeExams: 0,
    podiatryVisits: 0,
    diabeticSuppliesMonths: 0,
    telehealth: 6,
    snfDaysExpected: 3,
    ambulanceTripsExpected: 0.15,
    dmeAnnualSpend: 200,
  },
  hypertension: {
    pcpVisits: 3,
    specialistVisits: 1,           // possible cardiologist
    labDraws: 3,                   // metabolic + lipids
    erProbability: 0.05,
    hospitalProbability: 0.03,
    hospitalDays: 3,
    imagingScans: 0,
    eyeExams: 0,
    podiatryVisits: 0,
    diabeticSuppliesMonths: 0,
    telehealth: 0,
    snfDaysExpected: 0,
    ambulanceTripsExpected: 0.05,
    dmeAnnualSpend: 0,
  },
  healthy: {
    pcpVisits: 2,                  // annual wellness + 1 follow-up
    specialistVisits: 0,
    labDraws: 1,                   // annual labs
    erProbability: 0.05,
    hospitalProbability: 0.02,
    hospitalDays: 3,
    imagingScans: 0,
    eyeExams: 1,
    podiatryVisits: 0,
    diabeticSuppliesMonths: 0,
    telehealth: 0,
    snfDaysExpected: 0,
    ambulanceTripsExpected: 0.05,
    dmeAnnualSpend: 0,
  },
};

// Combine multiple conditions into one utilization profile.
// Counts (visits, labs, days) take the MAX across all conditions —
// a diabetic with hypertension still sees the doctor 4×/year, not 7×.
// Probabilities (ER, hospital) combine via 1 - ∏(1 - pᵢ) — either
// condition can independently trigger the event.
// Empty list → 'healthy' baseline.
export function combineUtilization(
  conditions: ReadonlyArray<UtilizationCondition>,
): AnnualUtilization {
  const deduped = Array.from(new Set(conditions));
  const profiles = deduped.length === 0
    ? [UTILIZATION_PROFILES.healthy]
    : deduped.map((c) => UTILIZATION_PROFILES[c]);

  const out: AnnualUtilization = {
    pcpVisits: 0,
    specialistVisits: 0,
    labDraws: 0,
    erProbability: 0,
    hospitalProbability: 0,
    hospitalDays: 0,
    imagingScans: 0,
    eyeExams: 0,
    podiatryVisits: 0,
    diabeticSuppliesMonths: 0,
    telehealth: 0,
    snfDaysExpected: 0,
    ambulanceTripsExpected: 0,
    dmeAnnualSpend: 0,
  };

  for (const p of profiles) {
    out.pcpVisits = Math.max(out.pcpVisits, p.pcpVisits);
    out.specialistVisits = Math.max(out.specialistVisits, p.specialistVisits);
    out.labDraws = Math.max(out.labDraws, p.labDraws);
    out.hospitalDays = Math.max(out.hospitalDays, p.hospitalDays);
    out.imagingScans = Math.max(out.imagingScans, p.imagingScans);
    out.eyeExams = Math.max(out.eyeExams, p.eyeExams);
    out.podiatryVisits = Math.max(out.podiatryVisits, p.podiatryVisits);
    out.diabeticSuppliesMonths = Math.max(out.diabeticSuppliesMonths, p.diabeticSuppliesMonths);
    out.telehealth = Math.max(out.telehealth, p.telehealth);
    out.snfDaysExpected = Math.max(out.snfDaysExpected, p.snfDaysExpected);
    out.ambulanceTripsExpected = Math.max(
      out.ambulanceTripsExpected,
      p.ambulanceTripsExpected,
    );
    out.dmeAnnualSpend = Math.max(out.dmeAnnualSpend, p.dmeAnnualSpend);
    // Probabilities — independent-event combination. Both conditions
    // can trigger an ER visit; combined prob = 1 - (1-p1)(1-p2)…
    out.erProbability = 1 - (1 - out.erProbability) * (1 - p.erProbability);
    out.hospitalProbability =
      1 - (1 - out.hospitalProbability) * (1 - p.hospitalProbability);
  }
  return out;
}

export interface RealAnnualCostInputs {
  /** Monthly premium × 12. */
  annualPremium: number;
  /** Sum of all per-drug yearly cost estimates. */
  totalAnnualDrugCost: number;
  /** Annualized Part B giveback (already × 12). Subtracted from total. */
  partBGivebackAnnual: number;
  /** In-network MOOP. Caps the medical-side bucket. null → no cap. */
  moopInNetwork: number | null;
  /** Combined utilization profile. */
  utilization: AnnualUtilization;
  /** True when the user has diabetes — gates supply cost in. */
  isDiabetic: boolean;
  /** Per-service copays the brain extracted from pbp_benefits. Each
   *  optional — when null/undefined, cost contribution is 0 except
   *  ER + inpatient which fall back to CMS-typical defaults so the
   *  expected-cost terms aren't silently zeroed by a data gap. */
  copays: {
    pcp?: number | null;
    specialist?: number | null;
    lab?: number | null;
    imaging?: number | null;
    telehealth?: number | null;
    er?: number | null;
    inpatientPerDay?: number | null;
    diabeticSupplies?: number | null;
    // Plan's actual podiatry copay. Routes podiatry visits separately
    // from the specialist bucket when filed — many plans set podiatry
    // lower ($0–$15) than specialist ($45+). Falls back to specialist
    // when null. (Latent bug pre-fix: podiatryVisits were always
    // multiplied by the specialist copay.)
    podiatry?: number | null;
    // SNF day-1 copay (parsed from inpatient-format ladder by caller).
    // Multiplied by expected SNF days from utilization.
    snfPerDay?: number | null;
    // Per-trip ambulance copay.
    ambulancePerTrip?: number | null;
    // DME / prosthetics coinsurance (0–100). Multiplied by an annual
    // notional DME spend so users with chronic DME needs see the cost
    // gap between $0-coins and 20%-coins plans.
    dmeCoinsurancePct?: number | null;
    // pm_plans.annual_deductible (medical, in-network). Added to the
    // medical bucket before the MOOP cap so deductibles affect rank.
    annualDeductible?: number | null;
  };
}

const ER_COPAY_FALLBACK = 150;
const INPATIENT_PER_DAY_FALLBACK = 250;

export function calculateRealAnnualCost(
  args: RealAnnualCostInputs,
): AnnualCostEstimate {
  const u = args.utilization;
  const c = args.copays;

  const pcpCost = u.pcpVisits * (c.pcp ?? 0);
  const specCost = u.specialistVisits * (c.specialist ?? 0);
  // Podiatry uses the plan's filed podiatry copay when present, falling
  // back to specialist. Carriers commonly file podiatry at $0–$15 even
  // when specialist is $45+, so routing through specialist over-counted
  // the cost for diabetic users with neuropathy.
  const podiatryCopay = c.podiatry ?? c.specialist ?? 0;
  const podiatryCost = u.podiatryVisits * podiatryCopay;
  const labCost = u.labDraws * (c.lab ?? 0);
  const imagingCost = u.imagingScans * (c.imaging ?? 0);
  const telehealthCost = u.telehealth * (c.telehealth ?? 0);
  // Eye exams are typically covered preventive on MAPD plans — no copay
  // contribution (intentional; the wellness benefit absorbs it).

  const medicalCost =
    pcpCost + specCost + podiatryCost + labCost + imagingCost + telehealthCost;

  // Diabetic supplies: only counted when the user is diabetic AND the
  // plan files an insulin/supplies category. When the plan doesn't file
  // it, the user pays retail (~$50/mo) — but that's a "she pays out-of-
  // pocket" cost the cards already surface via the supplies-gap
  // section, so we don't double-count it here. Keep this strictly the
  // copay paid to the plan.
  const suppliesCost = args.isDiabetic
    ? u.diabeticSuppliesMonths * (c.diabeticSupplies ?? 0)
    : 0;

  // Expected ER cost — probability × copay. ER copay falls back to a
  // CMS-typical $150 when the plan didn't file it, so a data gap doesn't
  // silently zero the risk term.
  const erCopay = c.er != null && c.er > 0 ? c.er : ER_COPAY_FALLBACK;
  const erExpected = u.erProbability * erCopay;

  // Expected hospital cost — probability × per-day copay × days. Same
  // fallback rationale.
  const ipPerDay =
    c.inpatientPerDay != null && c.inpatientPerDay > 0
      ? c.inpatientPerDay
      : INPATIENT_PER_DAY_FALLBACK;
  const hospitalExpected = u.hospitalProbability * ipPerDay * u.hospitalDays;

  // Step 3 — SNF day-1 copay × expected days. Day-1 is the broker-
  // visible cost; the full ladder lives in benefit_description but for
  // ranking we use the highest-impact tier.
  const snfExpected = (c.snfPerDay ?? 0) * u.snfDaysExpected;

  // Step 3 — ambulance per-trip × expected trips (probabilistic).
  const ambulanceExpected = (c.ambulancePerTrip ?? 0) * u.ambulanceTripsExpected;

  // Step 3 — DME coinsurance × notional annual DME spend. dmeCoinsurance
  // arrives as 0–100 (percent); convert to fraction.
  const dmePctFraction = (c.dmeCoinsurancePct ?? 0) / 100;
  const dmeExpected = dmePctFraction * u.dmeAnnualSpend;

  // Step 3 — medical deductible passthrough. Member pays up to the
  // deductible before plan cost-share kicks in; the medical bucket
  // copay terms already model post-deductible cost-share, so adding
  // the deductible is the pre-cost-share floor exposure. The MOOP cap
  // still applies; in practice it's only relevant on plans where
  // utilization × copays sums to less than the deductible (very low-
  // utilization users on a deductible-bearing plan).
  const deductibleCost = c.annualDeductible ?? 0;

  // MOOP cap on the medical-side bucket. MOOP does NOT cover premium
  // or Part D drugs — those stay raw. The cap protects against
  // implausibly high estimates from heavy-utilization profiles being
  // applied to plans with high copays — actual exposure is bounded.
  const medicalBucketRaw =
    medicalCost +
    suppliesCost +
    erExpected +
    hospitalExpected +
    snfExpected +
    ambulanceExpected +
    dmeExpected +
    deductibleCost;
  const cappedMedicalBucket =
    args.moopInNetwork != null && args.moopInNetwork > 0
      ? Math.min(medicalBucketRaw, args.moopInNetwork)
      : medicalBucketRaw;

  const netAnnual = Math.max(
    0,
    args.annualPremium +
      args.totalAnnualDrugCost +
      cappedMedicalBucket -
      args.partBGivebackAnnual,
  );

  return {
    premium: Math.round(args.annualPremium),
    drugCost: Math.round(args.totalAnnualDrugCost),
    medicalCost: Math.round(medicalCost),
    suppliesCost: Math.round(suppliesCost),
    erExpected: Math.round(erExpected),
    hospitalExpected: Math.round(hospitalExpected),
    snfExpected: Math.round(snfExpected),
    ambulanceExpected: Math.round(ambulanceExpected),
    dmeExpected: Math.round(dmeExpected),
    deductibleCost: Math.round(deductibleCost),
    partBGivebackSavings: Math.round(args.partBGivebackAnnual),
    cappedMedicalBucket: Math.round(cappedMedicalBucket),
    netAnnual: Math.round(netAnnual),
  };
}
