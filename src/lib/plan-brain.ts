// plan-brain — composite plan scoring engine for the agent quote screen.
//
// Pure function: takes pre-fetched data + the in-session user inputs,
// returns a ranked + ribboned list. No I/O. Mirrors the consumer-side
// Brain (commit 1702051) so identical inputs yield identical rankings.
//
// Pipeline:
//   1. SNP filter            — drop plans that don't match the user's
//                              about-you population (mapd/csnp/dsnp).
//   2. Three axes
//        Drug cost           — pm_drug_cost_cache → pm_formulary tier
//                              fallback → uncovered penalty, insulin
//                              capped at IRA $35/mo, sum to annual.
//        OOP cost            — visits × copays from pbp_benefits +
//                              premium − Part B giveback, capped at
//                              MOOP. Cancer = MOOP outright.
//        Extras value        — dollar value per benefit row, with
//                              user-priority 2× and condition-key 1.5×
//                              boosts (3× if both apply).
//   3. Composite             — weighted sum; weights per population.
//   4. Provider boost        — +5 if all in-network, −10 if any out.
//   5. Ribbons               — BEST_OVERALL to #1, then exclusive
//                              runner-up ribbons.
//   6. Cost breakdown        — per-plan human-readable string.
//   7. console.debug         — population, weights, top-3 summary.

import type { Plan } from '@/types/plans';
import type { Medication, Provider } from '@/types/session';
import type {
  BenefitRow,
  ConditionKey,
  PlanBrainInputs,
  PlanBrainResult,
  Population,
  ScoredPlan,
  UtilizationProfile,
  WeightProfile,
} from './plan-brain-types';
import {
  applyOverride,
  defaultWeights,
  redistributeForNoMeds,
} from './plan-brain-weights';
import {
  CONDITION_KEY_EXTRAS,
  EXTRA_DEFAULTS,
  INSULIN_CAP_MONTHLY,
  canonicalBenefitType,
  normalizeAxis,
} from './plan-brain-utils';
import { assignRibbons } from './plan-brain-ribbons';
import {
  conditionSet,
  detectConditions,
  isHealthyClient,
  type DetectedCondition,
} from './condition-detector';
import {
  applyBrokerRules,
  netRulePoints,
  type ClientProfile,
} from './broker-rules';
import {
  classifyArchetype,
  detectMedicationPatterns,
  detectRedFlags,
  whySwitchCopy,
  type ArchetypeMatch,
} from './broker-playbook';
import {
  buildUtilization,
  calculateRealAnnualCost,
  type UtilizationProfile as UtilProfileV2,
} from './utilization-model';

const UNCOVERED_DRUG_PENALTY = 1500; // $/yr per uncovered drug

function snpKind(plan: Plan): 'dsnp' | 'csnp' | 'isnp' | null {
  // Check plan_name (and ONLY plan_name) before falling back to the
  // AppPlanType enum. api/plans.ts mapPlanType collapses every SNP
  // variant — D-SNP, C-SNP, I-SNP — into the single AppPlanType='DSNP'
  // bucket, so plan_type is ambiguous. plan_name carries the canonical
  // "(HMO C-SNP)" / "(HMO D-SNP)" / "(HMO I-SNP)" suffix and is the
  // only reliable signal. Match C-SNP and I-SNP first so a name like
  // "Humana Gold Plus - Diabetes and Heart (HMO C-SNP)" doesn't get
  // dragged back into the D-SNP bucket by the catch-all.
  const name = (plan.plan_name ?? '').toUpperCase();
  if (/\bC-?SNP\b/.test(name)) return 'csnp';
  if (/\bI-?SNP\b/.test(name)) return 'isnp';
  if (/\bD-?SNP\b/.test(name) || plan.plan_type === 'DSNP') return 'dsnp';
  return null;
}

// C-SNPs are condition-specific. The plan name calls out the eligible
// condition cluster ("Diabetes and Heart", "Cardiovascular Disorders",
// "Chronic Lung Disorders", "End-Stage Renal Disease"). When the
// client's auto-detected condition matches the C-SNP's specialty, we
// keep the plan in the MAPD cohort so the broker can surface it; Rule 1
// then boosts it +25 if Klein-style PCP is in-network.
function csnpMatchesClientConditions(plan: Plan, conditions: Set<string>): boolean {
  const name = (plan.plan_name ?? '').toUpperCase();
  if (conditions.has('diabetes') && /\bDIABET/.test(name)) return true;
  if (
    conditions.has('chf') &&
    /(HEART|CARDIO|CHF|CONGEST)/.test(name)
  )
    return true;
  if (conditions.has('copd') && /(COPD|LUNG|RESPIRATORY|PULMONARY)/.test(name)) return true;
  if (conditions.has('ckd') && /(KIDNEY|RENAL|ESRD|CKD)/.test(name)) return true;
  return false;
}

function detectPopulation(client: PlanBrainInputs['client'], override?: Population | null): Population {
  if (override) return override;
  // medicaidConfirmed → DSNP cohort. Without it, treat as MAPD even if
  // planType=='DSNP' was selected by the agent (which sometimes pre-
  // selects but we want a real signal).
  if (client.medicaidConfirmed) return 'dsnp';
  return 'mapd';
}

export function runPlanBrain(inputs: PlanBrainInputs): PlanBrainResult {
  const { plans, client, medications, providers, data, conditionProfile } = inputs;
  const population = detectPopulation(client, inputs.populationOverride);

  // ─── Step 0: condition + pattern detection ────────────────────────
  // Run before the SNP filter so condition-aware C-SNP retention
  // works, and before archetype classification so patterns can shape
  // the "specialty drug" / "polypharmacy" signals.
  const detectedConditions = detectConditions(medications);
  const detectedSet = conditionSet(detectedConditions);
  const medicationPatterns = detectMedicationPatterns(medications);

  // Specialty drug detection — walk the formulary across ALL plans
  // looking for any client rxcui placed on tier 5. If any plan files
  // it as specialty, treat the whole client as specialty-drug for
  // archetype classification (tier coverage will vary plan-to-plan
  // anyway, but the client's profile is the same).
  const hasSpecialtyDrug = detectSpecialtyDrug(medications, data);
  const isInsulinUser = medications.some((m) =>
    /insulin|humalog|novolog|lantus|levemir|tresiba|toujeo|basaglar|fiasp|lyumjev|humulin|novolin/i.test(m.name),
  );

  // ─── Step 1: SNP filter (condition-aware) ─────────────────────────
  const filteredOut: { plan: Plan; reason: string }[] = [];
  const eligible = plans.filter((p) => {
    const kind = snpKind(p);
    if (population === 'mapd' && kind) {
      // Allow C-SNPs through when the client has the matching
      // condition. Rule 1 / Rule 4 then boost it +25 if Klein is
      // in-network. D-SNP and I-SNP stay filtered (D-SNP requires
      // Medicaid, I-SNP requires institutional residence).
      if (kind === 'csnp' && csnpMatchesClientConditions(p, detectedSet as unknown as Set<string>)) {
        return true;
      }
      filteredOut.push({ plan: p, reason: `${kind?.toUpperCase()} excluded for standard MAPD` });
      return false;
    }
    if (population === 'csnp' && kind !== 'csnp') {
      filteredOut.push({ plan: p, reason: 'C-SNP cohort selected' });
      return false;
    }
    if (population === 'dsnp' && kind !== 'dsnp') {
      filteredOut.push({ plan: p, reason: 'D-SNP cohort selected' });
      return false;
    }
    return true;
  });

  // ─── Step 2: archetype classification ────────────────────────────
  // Drives weights, plan-type preferences, and the Why-switch copy
  // template. Replaces the population-only weight defaults — those
  // were too coarse (every diabetic got the same MAPD weights as a
  // healthy 65-year-old).
  const age = clientAge(client);
  const archetype: ArchetypeMatch = classifyArchetype({
    age,
    conditions: detectedConditions,
    conditionSet: detectedSet,
    medications,
    providers,
    isInsulinUser,
    hasSpecialtyDrug,
  });

  // ─── Weights ──────────────────────────────────────────────────────
  // Archetype weights win unless caller provides a populationOverride
  // (legacy intake) or weightOverride (UI weight slider). When the
  // client has zero meds the drug axis is meaningless — redistribute.
  let weights: WeightProfile =
    inputs.populationOverride
      ? defaultWeights(population)
      : { ...archetype.weights };
  if (medications.length === 0) weights = redistributeForNoMeds(weights);
  weights = applyOverride(weights, inputs.weightOverride);

  // ─── Utilization profile ──────────────────────────────────────────
  // Old (deriveUtilization + UTILIZATION_PROFILES) returned three
  // buckets and didn't stack conditions. The new model takes MAX of
  // visit counts and combines probabilities via 1 − Π(1 − pᵢ).
  const utilProfile: UtilProfileV2 = buildUtilization(detectedSet);
  // Bucket label for the debug log + result.utilization (UI displays
  // "low / moderate / high"). Approximate from PCP+specialist totals.
  const utilization = bucketLabel(utilProfile);
  // Legacy visit shape for computeMedicalCost — derived from the new
  // profile so the OOP axis stays consistent with the realAnnualCost
  // calc downstream.
  const visits = {
    pcp: utilProfile.pcp,
    specialist: utilProfile.specialist,
    lab: utilProfile.labs,
    imaging: 0,
    er: utilProfile.erProbability,
    inpatient: utilProfile.hospitalProbability * utilProfile.hospitalDays,
  };

  // ─── Per-plan calc ───────────────────────────────────────────────
  type Row = {
    plan: Plan;
    drugCost: number;
    medicalCost: number;
    totalOOP: number;
    extrasValue: number;
    uncovered: string[];
    networkStatus: ScoredPlan['providerNetworkStatus'];
    drugLines: string[];
    medicalLines: string[];
    extrasLines: string[];
    drugCostByRxcui: Record<string, number>;
  };

  const rows: Row[] = eligible.map((plan) => {
    const benefits = data.benefitsByPlan[plan.id] ?? [];
    const drugRes = computeDrugCost({
      plan,
      medications,
      data,
      benefits,
    });
    const isCancer = conditionProfile === 'cancer';
    const medicalRes = computeMedicalCost({
      plan,
      benefits,
      visits,
      isCancer,
    });
    const extrasRes = computeExtrasValue({
      benefits,
      conditionProfile,
      userPriorities: inputs.userPriorities ?? [],
    });
    const networkStatus = computeNetworkStatus(plan, providers, data);
    const totalOOP = medicalRes.cost + drugRes.cost;
    return {
      plan,
      drugCost: drugRes.cost,
      medicalCost: medicalRes.cost,
      totalOOP,
      extrasValue: extrasRes.value,
      uncovered: drugRes.uncovered,
      networkStatus,
      drugLines: drugRes.lines,
      medicalLines: medicalRes.lines,
      extrasLines: extrasRes.lines,
      drugCostByRxcui: drugRes.byRxcui,
    };
  });

  // ─── Normalize axes 0-100 ─────────────────────────────────────────
  const drugScores = normalizeAxis(rows.map((r) => r.drugCost), true);
  const oopScores = normalizeAxis(rows.map((r) => r.totalOOP), true);
  const extrasScores = normalizeAxis(rows.map((r) => r.extrasValue), false);

  // ─── Build client profile ────────────────────────────────────────
  // Conditions were detected at Step 0 (above the SNP filter so
  // condition-matched C-SNPs stay in the MAPD cohort). Now wrap them
  // with age + flags and hand to the broker rules.
  const clientProfile: ClientProfile = buildClientProfile({
    client,
    medications,
    providers,
    detectedConditions,
  });

  // ─── Composite + provider boost ──────────────────────────────────
  const scored: ScoredPlan[] = rows.map((r, i) => {
    const composite =
      drugScores[i] * weights.drug +
      oopScores[i] * weights.oop +
      extrasScores[i] * weights.extras;
    const boost = providerBoost(r.networkStatus);
    const baseComposite = Math.round((composite + boost) * 100) / 100;
    return {
      plan: r.plan,
      rank: 0,
      composite: baseComposite,
      drugScore: drugScores[i],
      oopScore: oopScores[i],
      extrasScore: extrasScores[i],
      totalAnnualDrugCost: Math.round(r.drugCost),
      annualMedicalCost: Math.round(r.medicalCost),
      totalOOPEstimate: Math.round(r.totalOOP),
      extrasValue: Math.round(r.extrasValue),
      providerBoost: boost,
      providerNetworkStatus: r.networkStatus,
      uncoveredDrugRxcuis: r.uncovered,
      ribbon: null,
      breakdown: '',
      breakdownLines: [],
      drugCostByRxcui: r.drugCostByRxcui,
      appliedRules: [],
      brokerRuleAdjustment: 0,
      isCsnp: snpKind(r.plan) === 'csnp',
      realAnnualCost: null,
      redFlags: [],
      disqualified: false,
      whySwitchCopy: '',
    };
  });

  // ─── Broker rules pass ───────────────────────────────────────────
  // Apply 12 broker rules per plan AFTER axis scoring + provider boost,
  // BEFORE final sort/ribbon. Adjustments are bounded so a single rule
  // can't catapult a $9K-MOOP plan to #1 — boosts and penalties cap
  // out at ±25 individually but accumulate.
  for (const s of scored) {
    const rIdx = scored.indexOf(s);
    const r = rows[rIdx];
    const applied = applyBrokerRules(s.plan, s, clientProfile, {
      benefits: data.benefitsByPlan[s.plan.id] ?? [],
      drugCostByRxcui: r.drugCostByRxcui,
    });
    const delta = netRulePoints(applied);
    s.appliedRules = applied;
    s.brokerRuleAdjustment = delta;
    s.composite = Math.round((s.composite + delta) * 100) / 100;
  }

  // ─── Red-flag pass ───────────────────────────────────────────────
  // Detects severe per-plan signals: chronic + MOOP at ceiling, all
  // providers out (DISQUALIFY), cost-driver-not-on-formulary,
  // giveback-trap. Disqualified plans are removed from the final
  // ranking but kept on the scored list with disqualified=true so
  // the UI can render them differently if the broker overrides.
  const costDriverRxcui = identifyCostDriver(rows);
  for (const s of scored) {
    const rIdx = scored.indexOf(s);
    const r = rows[rIdx];
    const totalRx = Object.values(r.drugCostByRxcui).reduce((a, b) => a + b, 0);
    const driverCost = costDriverRxcui ? r.drugCostByRxcui[costDriverRxcui] ?? 0 : 0;
    const driverIsCostDriverHere = totalRx > 0 && driverCost / totalRx >= 0.8;
    const formularyForPlan =
      data.formularyByContractPlan[`${s.plan.contract_id}-${s.plan.plan_number}`] ?? {};
    const driverNotOnFormulary =
      !!costDriverRxcui && driverIsCostDriverHere && !formularyForPlan[costDriverRxcui];
    const flags = detectRedFlags(s.plan, s, {
      hasChronicCondition: clientProfile.hasChronicCondition,
      isInsulinUser,
      costDriverRxcuis: costDriverRxcui ? [costDriverRxcui] : [],
      costDriverNotOnFormulary: driverNotOnFormulary,
      // Giveback-trap math is comparison-based; defer to a later pass
      // by passing 0 here. A full implementation would compute the
      // delta against the cheapest non-giveback alternative — that
      // requires the full scored list, which we have, so do it inline:
      givebackTrapDelta: computeGivebackTrapDelta(s, scored, rows),
    });
    s.redFlags = flags;
    const flagDelta = flags.reduce((sum, f) => sum + f.pointsAdjustment, 0);
    if (flagDelta !== 0) s.composite = Math.round((s.composite + flagDelta) * 100) / 100;
    s.disqualified = flags.some((f) => f.disqualify);
  }

  // ─── realAnnualCost per plan ─────────────────────────────────────
  // The structured dollar breakdown the V4 quote table renders in the
  // Total Annual Value row. Derived from the same utilization profile
  // the OOP axis used, so the two numbers stay consistent.
  for (const s of scored) {
    const benefits = data.benefitsByPlan[s.plan.id] ?? [];
    const inpatientDayOne = readInpatientFirstStage(benefits);
    // diabetic_supplies copay from pbp_benefits (single-row category).
    const supplyRow = benefits.find((b) => /diabet.*suppl/i.test(b.benefit_type));
    const suppliesCopay = supplyRow?.copay ?? 0;
    s.realAnnualCost = calculateRealAnnualCost({
      plan: s.plan,
      drugAnnual: s.totalAnnualDrugCost,
      util: utilProfile,
      diabeticSuppliesCopay: suppliesCopay,
      inpatientDayOne,
    });
  }

  // ─── Sort + rank ─────────────────────────────────────────────────
  // Disqualified plans sort to the end; within each tier sort by
  // composite descending. The UI will render disqualified rows with
  // visual de-emphasis and the broker can still see them on the
  // overflow but they're not eligible for the comparison columns.
  scored.sort((a, b) => {
    if (a.disqualified !== b.disqualified) return a.disqualified ? 1 : -1;
    return b.composite - a.composite;
  });
  scored.forEach((s, i) => (s.rank = i + 1));

  // ─── Ribbons ─────────────────────────────────────────────────────
  assignRibbons(scored);

  // ─── Cost breakdown strings ──────────────────────────────────────
  for (let i = 0; i < scored.length; i++) {
    const s = scored[i];
    const r = rows.find((rr) => rr.plan.id === s.plan.id)!;
    s.breakdown = buildBreakdown({
      plan: s.plan,
      drugCost: r.drugCost,
      medicalCost: r.medicalCost,
      conditionLabel: conditionLabelFor(conditionProfile),
      drugLines: r.drugLines,
      medicalLines: r.medicalLines,
    });
    s.breakdownLines = [
      { label: 'Premium', amount: s.plan.premium * 12, detail: `$${s.plan.premium}/mo` },
      { label: 'Medical estimate', amount: r.medicalCost - s.plan.premium * 12 },
      { label: 'Drug estimate', amount: r.drugCost },
      { label: 'Extras value', amount: -r.extrasValue, detail: 'subtract' },
    ];
  }

  // ─── Why-switch copy per plan ────────────────────────────────────
  // Use the #1 ranked plan as the implicit baseline for "savings vs
  // baseline". This matches what the V4 table does when no current
  // plan is set — top-ranked = benchmark.
  const baselineNet = scored[0]?.realAnnualCost?.netAnnual ?? null;
  for (const s of scored) {
    const myNet = s.realAnnualCost?.netAnnual ?? null;
    const savings = baselineNet != null && myNet != null ? baselineNet - myNet : null;
    s.whySwitchCopy = whySwitchCopy({
      archetype: archetype.archetype,
      savings,
      plan: s.plan,
      scored: s,
    });
  }

  // ─── Console.debug per spec ──────────────────────────────────────
  emitDebugLog(population, weights, scored);

  return {
    population,
    weights,
    utilization,
    scored,
    filteredOut,
    detectedConditions,
    medicationPatterns,
    archetype,
    utilizationProfile: utilProfile,
  };
}

// Identify the rxcui that contributes the most across all plans —
// used as "the" cost-driver for red-flag checks.
function identifyCostDriver(rows: Array<{ drugCostByRxcui: Record<string, number> }>): string | null {
  const totals = new Map<string, number>();
  for (const r of rows) {
    for (const [rxcui, cost] of Object.entries(r.drugCostByRxcui)) {
      totals.set(rxcui, (totals.get(rxcui) ?? 0) + cost);
    }
  }
  let best: string | null = null;
  let bestSum = 0;
  for (const [rxcui, sum] of totals) {
    if (sum > bestSum) {
      best = rxcui;
      bestSum = sum;
    }
  }
  // Only call it a cost driver when its mean per-plan cost is non-trivial
  // ($30/yr or more — anything below is generic noise that doesn't
  // create a giveback trap or formulary risk).
  if (rows.length === 0 || bestSum / rows.length < 30) return null;
  return best;
}

// Giveback-trap math: this plan's giveback minus the drug-cost
// differential vs the cheapest non-giveback alternative. Negative
// number = trap (the giveback is offset by higher Rx costs).
function computeGivebackTrapDelta(
  thisPlan: ScoredPlan,
  all: ScoredPlan[],
  rows: Array<{ plan: Plan; drugCost: number }>,
): number {
  if ((thisPlan.plan.part_b_giveback ?? 0) <= 0) return 0;
  const myRow = rows.find((r) => r.plan.id === thisPlan.plan.id);
  if (!myRow) return 0;
  const nonGiveback = all.filter((s) => (s.plan.part_b_giveback ?? 0) === 0);
  if (nonGiveback.length === 0) return 0;
  const cheapestRxAlt = nonGiveback.reduce((min, s) => {
    const row = rows.find((r) => r.plan.id === s.plan.id);
    if (!row) return min;
    return row.drugCost < min ? row.drugCost : min;
  }, Number.POSITIVE_INFINITY);
  if (!Number.isFinite(cheapestRxAlt)) return 0;
  const giveback = (thisPlan.plan.part_b_giveback ?? 0) * 12;
  const drugDelta = myRow.drugCost - cheapestRxAlt; // positive = this plan costs more on Rx
  return Math.round(giveback - drugDelta);
}

// Walk the formulary across all plans looking for any tier-5 placement
// of any client rxcui. The archetype classifier needs a single boolean
// — if ANY plan files the drug as specialty, the broker's quote needs
// to lead with formulary coverage on that drug.
function detectSpecialtyDrug(
  medications: Medication[],
  data: PlanBrainInputs['data'],
): boolean {
  const rxcuis = medications.map((m) => m.rxcui).filter((x): x is string => !!x);
  if (rxcuis.length === 0) return false;
  for (const formulary of Object.values(data.formularyByContractPlan)) {
    for (const rxcui of rxcuis) {
      const row = formulary[rxcui];
      if (row && row.tier === 5) return true;
    }
  }
  return false;
}

// Approximate the legacy 'low' / 'moderate' / 'high' bucket from the
// new utilization profile — used only for the result.utilization label
// rendered in the V4 footer ("Plan Brain · utilization moderate"). The
// real numbers live in result.utilizationProfile.
function bucketLabel(p: UtilProfileV2): UtilizationProfile {
  const score = p.pcp + p.specialist + p.labs + p.hospitalProbability * 30 + p.erProbability * 5;
  if (score < 5) return 'low';
  if (score < 18) return 'moderate';
  return 'high';
}

// Build the client profile consumed by broker-rules. Pulled out so the
// scoring loop stays linear and the profile shape can be exported for
// the UI to render condition pills and the "newly eligible" hint.
function buildClientProfile({
  client,
  medications,
  providers,
  detectedConditions,
}: {
  client: PlanBrainInputs['client'];
  medications: Medication[];
  providers: Provider[];
  detectedConditions: DetectedCondition[];
}): ClientProfile {
  const age = clientAge(client);
  const cset = conditionSet(detectedConditions);
  // hasChronicCondition powers Rule 9 (red flag at MOOP ceiling). Only
  // certain/likely detections count — possible-confidence shouldn't
  // trip the most aggressive penalty.
  const hasChronicCondition = detectedConditions.some(
    (d) => d.confidence === 'certain' || d.confidence === 'likely',
  );
  const isInsulinUser = medications.some((m) =>
    /insulin|humalog|novolog|lantus|levemir|tresiba|toujeo|basaglar|fiasp|lyumjev|humulin|novolin/i.test(m.name),
  );
  const isNewlyEligible = age != null && age >= 64 && age <= 66;
  return {
    age,
    conditions: detectedConditions,
    conditionSet: cset,
    hasChronicCondition,
    medications,
    providers,
    isHealthyClient: isHealthyClient(medications, detectedConditions),
    isInsulinUser,
    isNewlyEligible,
  };
}

function clientAge(client: PlanBrainInputs['client']): number | null {
  if (!client.dob) return null;
  const d = new Date(client.dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a -= 1;
  return a;
}

// ─── Provider boost ──────────────────────────────────────────────────
function providerBoost(status: ScoredPlan['providerNetworkStatus']): number {
  if (status === 'all_in') return 5;
  if (status === 'all_out' || status === 'partial') return -10;
  return 0;
}

function computeNetworkStatus(
  plan: Plan,
  providers: Provider[],
  data: PlanBrainInputs['data'],
): ScoredPlan['providerNetworkStatus'] {
  const npis = providers.map((p) => p.npi).filter((x): x is string => !!x);
  if (npis.length === 0) return 'unknown';
  const planNetwork = data.networkByPlan[plan.id] ?? {};
  let any = false;
  let allIn = true;
  let anyOut = false;
  for (const npi of npis) {
    const row = planNetwork[npi];
    if (!row) {
      allIn = false; // unknown counts as not-confirmed-in
      continue;
    }
    any = true;
    if (row.covered) {
      // ok
    } else {
      allIn = false;
      anyOut = true;
    }
  }
  if (!any) return 'unknown';
  if (allIn) return 'all_in';
  if (anyOut) return 'partial';
  return 'unknown';
}

// ─── Drug cost ───────────────────────────────────────────────────────
function computeDrugCost({
  plan,
  medications,
  data,
  benefits,
}: {
  plan: Plan;
  medications: Medication[];
  data: PlanBrainInputs['data'];
  benefits: BenefitRow[];
}): { cost: number; uncovered: string[]; lines: string[]; byRxcui: Record<string, number> } {
  if (medications.length === 0) return { cost: 0, uncovered: [], lines: [], byRxcui: {} };

  const tripleId = plan.id;
  const contractPlan = `${plan.contract_id}-${plan.plan_number}`;
  const cache = data.drugCostCache[tripleId] ?? {};
  const formulary = data.formularyByContractPlan[contractPlan] ?? {};
  const tierCosts = readTierCopays(benefits);

  let total = 0;
  const uncovered: string[] = [];
  const lines: string[] = [];
  const byRxcui: Record<string, number> = {};

  for (const med of medications) {
    if (!med.rxcui) continue;
    const ndcRow = data.ndcByRxcui[med.rxcui];
    let drugAnnual: number | null = null;
    let tierUsed: number | null = null;

    // ── 1. Cache hit ──
    if (ndcRow) {
      const cached = cache[ndcRow.ndc];
      if (cached?.estimated_yearly_total != null) {
        drugAnnual = cached.estimated_yearly_total;
        tierUsed = cached.tier;
      }
    }

    // ── 2. Formulary fallback ──
    if (drugAnnual == null) {
      const f = formulary[med.rxcui];
      if (f) {
        if (f.tier === null && f.copay === null && f.coinsurance === null) {
          // listed but no cost → treat as covered with tier-1-style $0
          drugAnnual = 0;
          tierUsed = f.tier ?? 1;
        } else {
          tierUsed = f.tier ?? null;
          // Per-fill cost: prefer formulary copay/coinsurance, else
          // fall back to plan's tier copay from pbp_benefits.
          const perFill =
            f.copay ?? tierCosts[`${f.tier}`]?.copay ?? null;
          const coinsurance =
            f.coinsurance ?? tierCosts[`${f.tier}`]?.coinsurance ?? null;
          if (perFill != null) drugAnnual = perFill * 12;
          else if (coinsurance != null) {
            // Without a list price we can't price coinsurance accurately;
            // approximate with $80/fill × 12 × coinsurance%.
            drugAnnual = (80 * coinsurance) / 100 * 12;
          } else {
            drugAnnual = 0;
          }
        }
      } else {
        // Not on formulary at all = penalty.
        uncovered.push(med.rxcui);
        drugAnnual = UNCOVERED_DRUG_PENALTY;
      }
    }

    // ── 3. Insulin IRA cap ──
    if (looksLikeInsulin(med)) {
      const cappedAnnual = INSULIN_CAP_MONTHLY * 12;
      if (drugAnnual == null || drugAnnual > cappedAnnual) drugAnnual = cappedAnnual;
    }

    if (drugAnnual == null) drugAnnual = 0;
    total += drugAnnual;
    byRxcui[med.rxcui] = drugAnnual;
    lines.push(`${med.name} ($${Math.round(drugAnnual)}/yr${tierUsed ? `, tier ${tierUsed}` : ''})`);
  }

  return { cost: total, uncovered, lines, byRxcui };
}

function looksLikeInsulin(med: Medication): boolean {
  return /insulin|humalog|novolog|lantus|levemir|tresiba|toujeo|basaglar/i.test(med.name);
}

// ─── Medical cost (line-item × visit count, capped at MOOP) ─────────
function computeMedicalCost({
  plan,
  benefits,
  visits,
  isCancer,
}: {
  plan: Plan;
  benefits: BenefitRow[];
  visits: { pcp: number; specialist: number; lab: number; imaging: number; er: number; inpatient: number };
  isCancer: boolean;
}): { cost: number; lines: string[] } {
  const annualPremium = plan.premium * 12;
  const giveback = (plan.part_b_giveback ?? 0) * 12;
  const moop = plan.moop_in_network ?? 0;

  if (isCancer && moop > 0) {
    return {
      cost: moop + annualPremium - giveback,
      lines: [`MOOP $${moop} (cancer profile assumes hit)`],
    };
  }

  const copays = readSingleCopays(benefits);
  const lines: string[] = [];

  function applyVisits(label: string, key: string, count: number, fallback: number) {
    if (count <= 0) return 0;
    const cs = copays[key];
    let perVisit = cs?.copay ?? fallback;
    // Coinsurance proxy: 20% of $200 service estimate when no copay
    // is set but coinsurance is present.
    if (perVisit == null && cs?.coinsurance != null) perVisit = (200 * cs.coinsurance) / 100;
    if (perVisit == null) perVisit = fallback;
    const sub = perVisit * count;
    lines.push(`${label}: ${count}×$${perVisit} = $${Math.round(sub)}`);
    return sub;
  }

  let medical = 0;
  medical += applyVisits('PCP visits', 'primary_care', visits.pcp, 0);
  medical += applyVisits('Specialist visits', 'specialist', visits.specialist, 35);
  medical += applyVisits('Lab', 'lab', visits.lab, 0);
  medical += applyVisits('Imaging', 'diagnostic_radiology', visits.imaging, 100);
  medical += applyVisits('ER', 'emergency', visits.er, 120);
  // Inpatient stages: use day_1-5 if present, else day_1-7, else 0.
  const inpatient = readInpatientFirstStage(benefits);
  if (visits.inpatient > 0 && inpatient != null) {
    const sub = inpatient * Math.max(1, Math.round(visits.inpatient));
    lines.push(`Inpatient: ${visits.inpatient.toFixed(2)} stays × $${inpatient} = $${Math.round(sub)}`);
    medical += sub;
  }

  // Cap at MOOP, then add premium and subtract giveback.
  const capped = moop > 0 ? Math.min(medical, moop) : medical;
  const total = capped + annualPremium - giveback;
  return { cost: total, lines };
}

// ─── Extras value ────────────────────────────────────────────────────
function computeExtrasValue({
  benefits,
  conditionProfile,
  userPriorities,
}: {
  benefits: BenefitRow[];
  conditionProfile?: ConditionKey | null;
  userPriorities: string[];
}): { value: number; lines: string[] } {
  const conditionKeys = conditionProfile ? CONDITION_KEY_EXTRAS[conditionProfile] ?? [] : [];
  const userSet = new Set(
    userPriorities
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .map((s) => s.toLowerCase()),
  );
  const conditionSet = new Set(conditionKeys);

  // Walk benefits; sum each present extra at its dollar value with the
  // appropriate boost. Each benefit_type contributes once per plan.
  const counted = new Set<string>();
  let value = 0;
  const lines: string[] = [];
  for (const row of benefits) {
    const t = canonicalBenefitType(row.benefit_type);
    const def = EXTRA_DEFAULTS[t];
    if (!def) continue;
    if (counted.has(t)) continue;
    counted.add(t);
    // Skip rows that are explicitly "not offered" (no copay, no
    // coinsurance, no description, no description text saying covered).
    const offered = row.copay != null || row.coinsurance != null || (row.description ?? '').length > 0;
    if (!offered) continue;
    const raw = row.copay ?? null;
    const baseValue = def.fn(raw);
    if (!Number.isFinite(baseValue) || baseValue <= 0) continue;
    let mult = 1;
    if (userSet.has(t)) mult *= 2;
    if (conditionSet.has(t)) mult *= 1.5;
    if (mult > 3) mult = 3;
    const contribution = baseValue * mult;
    value += contribution;
    lines.push(`${t} ${mult > 1 ? `(×${mult})` : ''}: $${Math.round(contribution)}`);
  }
  return { value, lines };
}

// ─── pbp_benefits readers ────────────────────────────────────────────
function readSingleCopays(rows: BenefitRow[]): Record<string, { copay: number | null; coinsurance: number | null }> {
  const out: Record<string, { copay: number | null; coinsurance: number | null }> = {};
  for (const r of rows) {
    const t = canonicalBenefitType(r.benefit_type);
    // Prefer the "min" tier when ranges are split (medicare_gov scrape
    // emits min/max pairs); otherwise prefer the unkeyed row.
    if (out[t] && r.tier_id !== 'min' && r.tier_id !== '' && r.tier_id != null) continue;
    if (r.tier_id === 'max') continue;
    out[t] = { copay: r.copay, coinsurance: r.coinsurance };
  }
  return out;
}

function readTierCopays(rows: BenefitRow[]): Record<string, { copay: number | null; coinsurance: number | null }> {
  const out: Record<string, { copay: number | null; coinsurance: number | null }> = {};
  for (const r of rows) {
    if (r.benefit_type !== 'rx_tier') continue;
    const tier = r.tier_id ?? '';
    // Headline tier (no _90 / _mail suffix) is the standard-retail 30-day.
    if (/_/.test(tier)) continue;
    out[tier] = { copay: r.copay, coinsurance: r.coinsurance };
  }
  return out;
}

function readInpatientFirstStage(rows: BenefitRow[]): number | null {
  for (const r of rows) {
    if (r.benefit_type !== 'inpatient_hospital') continue;
    const tier = r.tier_id ?? '';
    if (/^days_1[-_]/i.test(tier) && r.copay != null) return r.copay;
  }
  for (const r of rows) {
    if (r.benefit_type !== 'inpatient_hospital') continue;
    if (r.copay != null) return r.copay;
  }
  return null;
}

// ─── Cost-breakdown text ────────────────────────────────────────────
function buildBreakdown({
  plan,
  drugCost,
  medicalCost,
  conditionLabel,
  drugLines,
  medicalLines,
}: {
  plan: Plan;
  drugCost: number;
  medicalCost: number;
  conditionLabel: string | null;
  drugLines: string[];
  medicalLines: string[];
}): string {
  const total = Math.round(drugCost + medicalCost);
  if (conditionLabel) {
    const focus = medicalLines.slice(0, 3).join('; ');
    const rxFocus = drugLines.slice(0, 2).join('; ');
    return `Your ${conditionLabel} care on this plan: ${focus || 'no scripted visits'}; ${rxFocus || 'no Rx'}. Estimated annual total: $${total.toLocaleString()}.`;
  }
  return `Your year on this plan: $${plan.premium}/mo premium, $${Math.round(medicalCost - plan.premium * 12).toLocaleString()}/yr medical, $${Math.round(drugCost).toLocaleString()}/yr drugs. Estimated annual total: $${total.toLocaleString()}.`;
}

function conditionLabelFor(c?: ConditionKey | null): string | null {
  if (!c) return null;
  if (c === 'chf') return 'CHF';
  if (c === 'copd') return 'COPD';
  return c.charAt(0).toUpperCase() + c.slice(1);
}

// ─── Debug log ──────────────────────────────────────────────────────
function emitDebugLog(population: Population, weights: WeightProfile, scored: ScoredPlan[]): void {
  if (typeof console === 'undefined') return;
  const w = `weights={drug:${weights.drug.toFixed(2)},oop:${weights.oop.toFixed(2)},extras:${weights.extras.toFixed(2)}}`;
  console.debug(`[plan-brain] population=${population} ${w} pool=${scored.length}`);
  for (const s of scored.slice(0, 3)) {
    const ribbon = s.ribbon ?? '—';
    console.debug(
      `[#${s.rank}] ${s.plan.id} composite=${s.composite.toFixed(2)} ribbon=${ribbon} | drug=${s.drugScore} oop=${s.oopScore} extras=${s.extrasScore} | $drug=${s.totalAnnualDrugCost} $oop=${s.totalOOPEstimate} $extras=${s.extrasValue}`,
    );
  }
}

// Re-export the ribbon helper for screens that want to render badge text.
export { bestOverallText } from './plan-brain-ribbons';
export type * from './plan-brain-types';
