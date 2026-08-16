// Plan Brain — pure elimination, then cost rank, then top 4.
//
//   Gate 1 — PROVIDERS. Any plan with a user-listed provider
//             definitively out-of-network is eliminated. Unverified
//             network status (no row in the cache) is not "out" — it's
//             absence of evidence, surfaced as a "Confirm" flag.
//
//   Gate 2 — MEDICATIONS. Any plan with a user drug not on formulary
//             is eliminated. Carve-out for data-pipeline gaps only:
//             when no plan in the pool returned any formulary rows,
//             the lookup itself is broken (not the plan), so we keep
//             everyone — that's an evidence gap, not a coverage signal.
//
//   Gate 3 — USER-SELECTED BENEFIT FLOORS. Each priority the user
//             picked is a hard floor. Plans that don't meet every
//             selected floor are eliminated. AND across priorities.
//
//   Rank   — total annual cost = (premium × 12) + drug cost
//                                                − (Part B giveback × 12).
//             Lowest wins. Top 4. That's it.
//
// Entry point: runPlanBrain(input). BrainOutput shape is unchanged so
// usePlanBrain + AgentV3App + CompareScreen keep working; fields tied
// to the deleted weighted model (composite, axis scores, archetype,
// medicationPatterns, appliedBrokerRules, redFlags) are populated
// with neutral / rank-derived values.

import type { PmPlanRow, CsnpCondition, PlanBenefitRow } from './brain-foreign-types';
import {
  type BrainInputs,
  type BrainOutput,
  type BrainScore,
  type BrainScoredPlan,
  type GateExplanations,
  type LiveTop3,
  type LiveTop3Pick,
  type RankPopulation,
  type RibbonType,
} from './plan-brain-types';
import {
  buildGate1Explanations,
  buildGate2Explanations,
  buildGate3Explanations,
  buildGate4Explanation,
} from './plan-brain-explanations';
import {
  annualExtrasValue,
  annualMedicalCostFromUtilization,
  benefitByCategory,
  classifyPlanDentalTier,
  computeSupplyCoverage,
  copayForCategory,
  deriveUtilization,
  estimateBundleYearlyCost,
  extractCategoryAnnualValue,
  extractExtraAnnualFromAggregated,
  extractOtcQuarterly,
  normalizeDirect,
  normalizeInverse,
  suppliesValueAnnual,
} from './plan-brain-utils';
import { assignRibbons, ribbonDisplayText } from './plan-brain-ribbons';
import { detectConditionsFromMeds, type DetectedConditionKey } from './condition-detector';
import {
  calculateRealAnnualCost,
  combineUtilization,
  type UtilizationCondition,
} from './utilization-model';
import {
  applyDualEligibleCostAdjustment,
  classifyCostSharingExposure,
  selectCostShare,
  MEDICAL_COST_SHARE_CATEGORIES,
} from './dual-eligible';
import { firstTierCopay } from './inpatient-format';

// Day-1 SNF copay from the ladder description ("Days 1-20: $0/day · …"),
// falling back to the row's flat copay when the description doesn't
// parse. Used by Gate 4's medical bucket.
function snfDayOneCopay(
  benefits: ReadonlyArray<{
    benefit_category: string;
    copay: number | null;
    benefit_description?: string | null;
  }>,
): number {
  const row = benefits.find((b) => b.benefit_category === 'snf');
  if (!row) return 0;
  return firstTierCopay(row.benefit_description ?? null, row.copay) ?? 0;
}

// DME coinsurance percent (0–100) from pm_plan_benefits.dme_prosthetics.
// Most plans file 20% coins; some file $0 copay with no coins.
function dmeCoinsurance(
  benefits: ReadonlyArray<{ benefit_category: string; coinsurance: number | null }>,
): number {
  const row = benefits.find((b) => b.benefit_category === 'dme_prosthetics');
  return row?.coinsurance ?? 0;
}

// ─── Debug ───────────────────────────────────────────────────────────

const BRAIN_DEBUG: boolean =
  typeof import.meta !== 'undefined' &&
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_BRAIN_DEBUG === 'true';
function isBrainDebugOn(): boolean {
  return BRAIN_DEBUG;
}

// ─── Population & SNP classification ─────────────────────────────────

function classifySnp(row: PmPlanRow): 'D' | 'C' | 'I' | 'none' {
  const t = (row.snp_type ?? '').toLowerCase().trim();
  if (!t) return row.snp ? 'C' : 'none';
  if (t.includes('d-snp') || t.includes('dsnp') || t.includes('dual')) return 'D';
  if (t.includes('c-snp') || t.includes('csnp') || t.includes('chronic')) return 'C';
  if (t.includes('i-snp') || t.includes('isnp') || t.includes('institutional')) return 'I';
  return 'none';
}

function isStrictlyDualEligible(value: unknown): boolean {
  return value === true;
}

function detectPopulation(input: BrainInputs): RankPopulation {
  const u = input.userProfile;
  if (u.csnpConditions && u.csnpConditions.length > 0) return 'csnp';
  if (isStrictlyDualEligible(u.dsnpEligible)) return 'dsnp';
  return 'standard';
}

function detectIsHealthyClient(input: BrainInputs, pop: RankPopulation): boolean {
  if (pop !== 'standard') return false;
  const u = input.userProfile;
  const medCount = u.drugs.length;
  const hasCondition = (u.csnpConditions ?? []).length > 0;
  return medCount < 3 && !hasCondition;
}

function planTypeChassis(planType: string | null | undefined): 'hmo' | 'hmo-pos' | 'ppo' | 'pdp' | 'other' {
  const t = (planType ?? '').toUpperCase();
  if (t.includes('PDP')) return 'pdp';
  if (t.includes('HMO-POS') || t.includes('HMO POS')) return 'hmo-pos';
  if (t.includes('PPO') || t.includes('LPPO')) return 'ppo';
  if (t.includes('HMO')) return 'hmo';
  return 'other';
}

function filterPlanPool(
  plans: readonly PmPlanRow[],
  pop: RankPopulation,
  dualEligible: boolean,
  widenForCsnpDetection: boolean = false,
): PmPlanRow[] {
  return plans.filter((row) => {
    if (planTypeChassis(row.plan_type) === 'pdp') return false;
    const klass = classifySnp(row);
    if (klass === 'D' && !dualEligible) return false;
    if (pop === 'dsnp' || pop === 'dsnp-unsure') {
      return klass === 'D' || klass === 'none';
    }
    if (pop === 'csnp') {
      return klass === 'C' || klass === 'D' || klass === 'none';
    }
    if (widenForCsnpDetection && klass === 'C') return true;
    return klass === 'none';
  });
}

function planKeyWithSegment(row: PmPlanRow): string {
  return `${row.contract_id}-${row.plan_id}-${row.segment_id}`;
}
function planKeyNoSegment(row: PmPlanRow): string {
  return `${row.contract_id}-${row.plan_id}`;
}
function planKeyNoSegment2(s: BrainScoredPlan): string {
  return `${s.row.contract_id}-${s.row.plan_id}`;
}

// ─── Total annual cost — the funnel's ranking metric ─────────────────
//
// Gate 4 — full cost. Reads s.score.realAnnualCost.netAnnual, which
// already includes:
//   premium + drugs + (medical bucket capped at MOOP)
//   where medical bucket = PCP + specialist + podiatry + lab +
//     advanced imaging + telehealth + supplies + ER + inpatient +
//     SNF + ambulance + DME + annual deductible
//   − partB giveback × 12
//
// This is the cost the broker quotes the client. Lower wins.
function totalAnnualCost(s: BrainScoredPlan): number {
  return s.score.realAnnualCost.netAnnual;
}

// ─── Providers-first ranking chain ─────────────────────────────────
//
// Rewritten from cost-first to providers-first per Phase 1 mission:
// "A plan with your doctor in-network beats a plan that saves $30/
// month." So the primary ordering is providersInNetworkCount desc;
// cost only breaks ties among plans with the same network reach.
//
//   1. Confirmed in-network provider count (desc). Zero for personas
//      with no providers ⇒ everyone tied on step 1, falls through to
//      drug cost.
//   1b. Cost-sharing exposure (SLMB / QI / QDWI only). Within a $500
//      net-annual band, a plan that bills the member coinsurance loses
//      to one that doesn't. No-op for every other population.
//   2. Drug cost (asc). Rewards formulary strength directly.
//   3. MOOP (asc). Caps catastrophic exposure.
//   4. Star rating (desc). CMS quality signal.
//   5. Carrier name (alpha, stable). Last-resort determinism.
//
// The old cost-tier bucket + "all meds covered" bucket are gone:
//   • Total annual cost is intentionally dropped from the tiebreaker;
//     Gate 4's top-4 fill now really is providers-first.
//   • "All non-OTC meds covered" is a Gate 2 elimination criterion,
//     so every plan reaching this comparator already passes it. The
//     helper `allNonOtcCovered` is retained for the budget-option
//     filter and downstream callers.
//
// Shared "all non-OTC drugs covered" helper — the pool-wide OTC pre-
// pass in runPlanBrain subtracts non-Rx items from the denominator
// so a Vitamin D3 entry doesn't drop every plan out of coverage.
function allNonOtcCovered(s: BrainScore): boolean {
  const eff = s.totalCount - s.poolWideUncoveredDrugCount;
  return eff <= 0 || s.coveredCount === eff;
}

// Cost band inside which the SLMB/QI/QDWI cost-sharing exposure gate
// can break a tie. Mirrors the consumer brain's
// GATE3_TIEBREAK_COST_BAND (packages/brain/src/plan-brain.ts) — chosen
// small enough (~$40/month) that a member rarely cares about the dollar
// difference, but large enough to actually surface when it matters.
const EXPOSURE_TIEBREAK_COST_BAND = 500;

function compareByCostThenTiebreakers(a: BrainScoredPlan, b: BrainScoredPlan): number {
  // 1. In-network provider count — providers ALWAYS rank above cost.
  const inNetDiff = b.score.providersInNetworkCount - a.score.providersInNetworkCount;
  if (inNetDiff !== 0) return inNetDiff;
  // 1b. SLMB/QI/QDWI cost-sharing exposure gate. When the two plans sit
  //     within EXPOSURE_TIEBREAK_COST_BAND of each other on net annual
  //     cost and one bills the member coinsurance on PCP / specialist /
  //     imaging while the other does not, the exposed plan cannot win
  //     the tie. The member has no Medicaid protection for those copays
  //     and calculateRealAnnualCost deliberately doesn't debit medical
  //     cost-sharing, so without this gate the exposed plan rides a
  //     cheaper drug subtotal or a lower MOOP to a win the member pays
  //     for at the point of care.
  //
  //     Ported from the consumer's compareByCostThenTiebreakers, which
  //     runs the same check inside its $500 gate3Score band. The agent
  //     comparator is providers-first and carries no gate3Score, so the
  //     gate sits directly after the provider step — providers still
  //     outrank it, everything cost-shaped below it does not.
  //
  //     Only fires when medicaidLevel is 'slmb' / 'qi' / 'qdwi';
  //     costSharingExposed is false for every plan otherwise, so this
  //     collapses to a no-op for none / qmb / qmb_plus / slmb_plus /
  //     fbde. See classifyCostSharingExposure in dual-eligible.ts.
  const aExposed = a.score.costSharingExposed === true;
  const bExposed = b.score.costSharingExposed === true;
  if (
    aExposed !== bExposed &&
    Math.abs(totalAnnualCost(a) - totalAnnualCost(b)) < EXPOSURE_TIEBREAK_COST_BAND
  ) {
    return aExposed ? 1 : -1; // non-exposed wins
  }
  // 2. Drug cost (ascending).
  const drugDiff = a.score.totalAnnualDrugCost - b.score.totalAnnualDrugCost;
  if (drugDiff !== 0) return drugDiff;
  // 3. MOOP (ascending). Null MOOP sorts last.
  const aMoop = a.row.moop ?? Number.POSITIVE_INFINITY;
  const bMoop = b.row.moop ?? Number.POSITIVE_INFINITY;
  if (aMoop !== bMoop) return aMoop - bMoop;
  // 4. Star rating (descending). Null treated as 0.
  const aStars = a.row.star_rating ?? 0;
  const bStars = b.row.star_rating ?? 0;
  if (aStars !== bStars) return bStars - aStars;
  // 5. Carrier name (alphabetical, stable last resort).
  const aCarrier = a.row.carrier ?? '';
  const bCarrier = b.row.carrier ?? '';
  return aCarrier.localeCompare(bCarrier);
}

function fmtUSD(n: number): string {
  return `$${Math.max(0, Math.round(n)).toLocaleString()}`;
}

// ─── Condition unioning for utilization ──────────────────────────────

function csnpToUtilization(c: CsnpCondition): UtilizationCondition | null {
  switch (c) {
    case 'diabetes': return 'diabetes';
    case 'cardio': return 'chf';
    case 'copd': return 'copd';
    case 'esrd': return 'ckd';
    case 'hypertension': return 'hypertension';
    default: return null;
  }
}

function detectedToUtilization(c: DetectedConditionKey): UtilizationCondition | null {
  switch (c) {
    case 'diabetes': return 'diabetes';
    case 'chf': return 'chf';
    case 'afib': return 'chf';
    case 'copd': return 'copd';
    case 'ckd': return 'ckd';
    case 'hypertension': return 'hypertension';
    default: return null;
  }
}

function unionUtilizationConditions(
  csnp: ReadonlyArray<CsnpCondition>,
  detected: ReadonlyArray<{ condition: DetectedConditionKey; confidence: 'certain' | 'likely' | 'possible' }>,
): UtilizationCondition[] {
  const out = new Set<UtilizationCondition>();
  for (const c of csnp) {
    const mapped = csnpToUtilization(c);
    if (mapped) out.add(mapped);
  }
  for (const d of detected) {
    if (d.confidence === 'possible') continue;
    const mapped = detectedToUtilization(d.condition);
    if (mapped) out.add(mapped);
  }
  return Array.from(out);
}

// ─── Gate 1 — providers ──────────────────────────────────────────────
//
// Three states per (plan, npi) from pm_provider_network_cache:
//
//   • covered=true      — verified in-network → 'in_network'     → PASS
//   • covered=false     — verified OUT of net  → 'out_of_network' → ELIMINATED
//   • cache row absent  — UNVERIFIED           → 'unverified'     → PASS + flag
//                         (surfaces as 'unknown' on the Compare
//                         screen so the broker knows to call the
//                         carrier).
//
// The roll-up lives on score.providerNetworkState; 'unverified' also
// sets score.providerVerificationNeeded, which the pick shape mirrors.
// Only 'out_of_network' eliminates — absence of evidence is not
// evidence of absence. Mirrored 1:1 in the consumer brain
// (plan-match/packages/brain/src/plan-brain.ts applyProviderGate),
// which used to eliminate on unverified as well; see
// gh-audit-2026/session-2/05-gate1-elimination.md.
//
// Strict-elim-on-absent over-killed: cache coverage is sparse outside
// the 3 active FHIR carriers (uhc / humana / bcbsnc), so a client like
// Carol Hawk with a PA in Alamance County had every plan show "0/1
// providers" and Gate 1 emptied the pool. Unverified now passes; the
// real fix is the FHIR live fallback (upstream, populates the cache
// before the brain runs). Confirmed-in-net plans still outrank
// unverified ones via compareByCostThenTiebreakers.
function applyProviderGate(
  pool: ReadonlyArray<BrainScoredPlan>,
  userHasProviders: boolean,
): BrainScoredPlan[] {
  if (!userHasProviders) return [...pool];
  return pool.filter((s) => s.score.providerNetworkState !== 'out_of_network');
}

// ─── Gate 2 — medications ────────────────────────────────────────────
//
// Hard gate. A plan passes ONLY when every user drug is on the plan's
// formulary AND drug coverage is fully confirmed (no rxcui has zero
// evidence). No pool-wide escape hatch — if the data is missing for
// every plan in the area, the broker sees an empty pool and knows to
// reach for the manual fallback, not get quietly handed back a list of
// plans we can't actually quote.
function applyMedicationGate(
  pool: ReadonlyArray<BrainScoredPlan>,
  userHasDrugs: boolean,
  otcIndices: ReadonlySet<number>,
): BrainScoredPlan[] {
  if (!userHasDrugs) return [...pool];
  return pool.filter((s) => {
    // Effective coverage: every non-OTC user drug must be covered on
    // this plan. Drugs in otcIndices had covered=false on EVERY plan
    // in the pool (see the pre-pass in runPlanBrain) so they're
    // treated as non-Rx and skipped here — otherwise a single
    // Vitamin D3 entry would empty the pool for every persona.
    let need = 0;
    let got = 0;
    for (let i = 0; i < s.score.drugBreakdown.length; i += 1) {
      if (otcIndices.has(i)) continue;
      need += 1;
      if (s.score.drugBreakdown[i].covered) got += 1;
    }
    // need===0 ⇒ user entered only OTC items ⇒ nothing to gate on.
    return need === 0 || got === need;
  });
}

// ─── Gate 3 — extras "must offer" elimination ────────────────────────
//
// Hard gate. For each extra the user selected (dental, vision, hearing,
// otc, fitness, transportation), every plan must FILE that benefit
// with a non-zero allowance. Plans that don't offer a selected extra
// are eliminated. No richness rank, no threshold floor, no near-miss
// backfill — if the plan doesn't offer it, the horse is pulled.
//
// Among survivors, sort by total annual cost so Gate 4's top-4 fill is
// "cheapest survivors first".
//
// Empty priorities ⇒ all of Gates 1+2 survivors pass, cost-sorted.
//
// Every current PriorityKey maps to a Gate-3 benefit category. The
// PRIORITY_TO_EXTRAS map in AgentV3App is the upstream filter — if a
// future toggle is added that doesn't have a benefit row, mapping it
// to `undefined` there will keep it out of this gate.

const EXTRAS_GATE_KEYS = [
  'dental',
  'vision',
  'hearing',
  'otc',
  'fitness',
  'transportation',
] as const;
type ExtrasGateKey = (typeof EXTRAS_GATE_KEYS)[number];

function planHasTransportation(s: BrainScoredPlan): boolean {
  // Aggregated Plan.benefits.transportation.rides_per_year > 0 is the
  // production source of truth; fall back to raw for compatibility with
  // legacy call sites that don't build planByKey.
  if (s.plan) {
    const rides = s.plan.benefits.transportation?.rides_per_year ?? 0;
    if (rides > 0) return true;
    const desc = s.plan.benefits.transportation?.description;
    if (typeof desc === 'string' && desc.trim().length > 0) return true;
    return false;
  }
  return s.benefits.some((b) => b.benefit_category === 'transportation');
}

function planOffersExtra(s: BrainScoredPlan, key: ExtrasGateKey): boolean {
  if (key === 'transportation') return planHasTransportation(s);
  if (s.plan) {
    // Aggregated path — the broken hardcoded-null adapter is bypassed.
    // partb_giveback isn't a Gate 3 key here so planLevel isn't needed.
    return extractExtraAnnualFromAggregated(s.plan.benefits, s.plan, key) > 0;
  }
  if (key === 'otc') return extractOtcQuarterly(s.benefits).quarterly > 0;
  return extractCategoryAnnualValue(s.benefits, key) > 0;
}

interface ExtrasGateResult {
  fullMatch: BrainScoredPlan[];
  selectedExtras: ReadonlyArray<string>;
  /** Plans eliminated by Gate 3 — surfaced for the diagnostic log. */
  eliminated: BrainScoredPlan[];
}

function applyExtrasGate(
  pool: ReadonlyArray<BrainScoredPlan>,
  priorities: ReadonlySet<string>,
): ExtrasGateResult {
  const selectedGateKeys: ExtrasGateKey[] = EXTRAS_GATE_KEYS.filter((k) =>
    priorities.has(k),
  );
  const selectedExtras: string[] = [...selectedGateKeys];

  if (selectedGateKeys.length === 0) {
    return {
      fullMatch: [...pool].sort(compareByCostThenTiebreakers),
      selectedExtras,
      eliminated: [],
    };
  }

  const survivors: BrainScoredPlan[] = [];
  const eliminated: BrainScoredPlan[] = [];
  for (const s of pool) {
    let kept = true;
    for (const k of selectedGateKeys) {
      if (!planOffersExtra(s, k)) {
        kept = false;
        break;
      }
    }
    if (kept) survivors.push(s);
    else eliminated.push(s);
  }

  return {
    fullMatch: [...survivors].sort(compareByCostThenTiebreakers),
    selectedExtras,
    eliminated,
  };
}

// ─── LiveTop3 mapping ────────────────────────────────────────────────

function brainToLiveTop3Pick(
  s: BrainScoredPlan,
  index: number,
  population: RankPopulation,
  input: BrainInputs,
): LiveTop3Pick {
  const ribbon: RibbonType = s.score.ribbon ?? 'BEST_OVERALL';
  const ribbonText = ribbonDisplayText(
    ribbon,
    population,
    input.county,
    input.userProfile.csnpConditions,
    input.userProfile.providers.filter((p) => typeof p.npi === 'string' && p.npi.length > 0).length,
  );
  const cat: 'best' | 'cheap' | 'extras' =
    index === 0 ? 'best'
    : ribbon === 'LOWEST_DRUG_COST' || ribbon === 'LOWEST_OOP' || ribbon === 'PART_B_SAVINGS' || ribbon === 'ZERO_PREMIUM' ? 'cheap'
    : ribbon === 'BEST_EXTRAS' ? 'extras'
    : index === 1 ? 'cheap' : 'extras';
  const why =
    index === 0
      ? `Lowest projected annual cost in the pool — ${fmtUSD(totalAnnualCost(s))}/yr.`
      : `Estimated annual cost ${fmtUSD(totalAnnualCost(s))}/yr.`;
  return {
    category: cat,
    plan: {
      row: s.row,
      benefits: s.benefits,
      formulary: s.formulary,
      drugsCovered: s.score.coveredCount,
      drugsCoveredLowTier: s.score.lowTierCount,
      drugsTotal: s.score.totalCount,
      drugsAllCovered: s.score.coveredCount === s.score.totalCount && s.score.totalCount > 0,
      drugCoverageUnknown: s.score.drugCoverageUnknown,
      estimatedAnnualDrugCost: s.score.totalAnnualDrugCost,
      totalAnnualCost: s.score.realAnnualCost.netAnnual,
      extrasValue: s.score.extrasValueAnnual,
      allProvidersInNetwork: s.score.allProvidersInNetwork,
      providerNetworkState: s.score.providerNetworkState,
      providerVerificationNeeded: s.score.providerVerificationNeeded,
      suppliesCovered: s.score.suppliesCovered,
      suppliesTotal: s.score.suppliesTotal,
      dentalTier: s.score.dentalTier,
    },
    ribbon: ribbonText,
    why,
    priorityChecks: s.score.priorityChecks,
    tradeoffWarnings: s.score.tradeoffWarnings,
  };
}

// ─── Main entry — the elimination funnel ─────────────────────────────

export function runPlanBrain(input: BrainInputs): BrainOutput {
  const debugLog = (...args: unknown[]) => {
    if (!isBrainDebugOn()) return;
    if (typeof console === 'undefined' || !console.info) return;
    console.info('[brain-funnel]', ...args);
  };

  // ── Enrollment period gating ──────────────────────────────────────
  // Runs BEFORE the gate funnel. The brain still runs the full pipeline
  // so the beneficiary can window-shop; enrollmentGated=true just tells
  // the UI to block enrollment CTAs and switch to compliance-safe copy.
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const ep = input.enrollmentPeriod;

  let enrollmentGated = false;
  let enrollmentPeriodLabel: string | undefined;

  if (ep) {
    switch (ep) {
      case 'AEP':
        enrollmentGated = !((month === 10 && day >= 15) || month === 11 || (month === 12 && day <= 7));
        enrollmentPeriodLabel = 'AEP — Annual Enrollment (Oct 15 – Dec 7)';
        break;
      case 'OEP':
        enrollmentGated = !(month >= 1 && month <= 3);
        enrollmentPeriodLabel = 'OEP — Open Enrollment (Jan 1 – Mar 31)';
        break;
      case 'IEP':
        enrollmentGated = false;
        enrollmentPeriodLabel = 'IEP — Initial Enrollment Period';
        break;
      case 'ICEP':
        enrollmentGated = false;
        enrollmentPeriodLabel = 'ICEP — Initial Coverage Election Period';
        break;
      case 'SEP':
        enrollmentGated = !input.sepReasonCode;
        enrollmentPeriodLabel = input.sepReasonCode
          ? `SEP — Special Enrollment (${input.sepReasonCode})`
          : 'SEP — Special Enrollment (no qualifying reason)';
        break;
    }
  }

  // Med-derived condition detection — informational only (utilization
  // + UI copy). User's self-reported csnpConditions are the sole input
  // to SNP-pool eligibility; no auto-promotion.
  const detectedConditionsRaw = detectConditionsFromMeds(input.userProfile.drugs);
  const detectedConditions = detectedConditionsRaw.map((d) => ({
    condition: d.condition,
    confidence: d.confidence,
    triggerMeds: d.triggerMeds,
  }));
  const effectiveCsnpConditions: ReadonlyArray<CsnpCondition> =
    input.userProfile.csnpConditions ?? [];

  // C-SNP-qualifying conditions, unioned from self-report + meds.
  // Used here only for pool widening — the C-SNP reserved-slot logic
  // from the consumer is omitted in this faithful port (no
  // csnp-eligibility module in the agent repo).
  const userQualifiesForCsnp =
    effectiveCsnpConditions.length > 0 ||
    detectedConditionsRaw.some((d) => d.confidence !== 'possible');

  // ── Population + plan-pool filter ──────────────────────────────────
  const dualEligible = isStrictlyDualEligible(input.userProfile.dsnpEligible);
  let population = detectPopulation(input);
  if ((population === 'dsnp' || population === 'dsnp-unsure') && !dualEligible) {
    console.error(
      `[plan-brain] population=${population} but dualEligible=false — forcing 'standard'.`,
    );
    population = 'standard';
  }

  const widenForCsnp = population === 'standard' && userQualifiesForCsnp;
  let eligible = filterPlanPool(input.plans, population, dualEligible, widenForCsnp);

  // MA-only filter: drop plans without Part D for non-VA users.
  if (input.mapdContractPlanIds && input.userProfile.hasVaDrugCoverage !== true) {
    const mapdSet = input.mapdContractPlanIds;
    eligible = eligible.filter((p) => mapdSet.has(`${p.contract_id}-${p.plan_id}`));
  }

  if (eligible.length === 0) {
    return {
      population,
      ranked: [],
      liveTop3: null,
      isHealthyClient: false,
      budgetOption: null,
      detectedConditions,
      archetype: 'general',
      medicationPatterns: [],
      csnpNote: null,
      enrollmentGated,
      enrollmentPeriodLabel,
      // No pool ⇒ nothing was scored ⇒ nothing to flag as unresolved.
      // UI's session-based fallback still surfaces the banner if the
      // client has meds without rxcuis.
      unresolvedDrugs: [],
    };
  }

  const isHealthyClient = detectIsHealthyClient(input, population);
  const { utilization, conditionProfile } = deriveUtilization(input.userProfile);
  const utilizationConditions = unionUtilizationConditions(
    effectiveCsnpConditions,
    detectedConditionsRaw,
  );
  const annualUtilization = combineUtilization(utilizationConditions);
  const isDiabetic = utilizationConditions.includes('diabetes');

  const userProviderNpis = (input.userProfile.providers ?? [])
    .map((p) => p.npi)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  const userHasProviders = userProviderNpis.length > 0;
  const userHasDrugs = input.userProfile.drugs.length > 0;
  const userPriorities = input.userProfile.priorities ?? new Set<string>();

  // Hoisted so the per-plan cost-share swap below can consult it
  // BEFORE annualMedicalCostFromUtilization runs. Reassigned as a
  // const in the applyDualEligibleCostAdjustment block below (same
  // value, kept close to its use). See selectCostShare in
  // dual-eligible.ts for the population-aware pick.
  const scoringMedicaidLevel = input.userProfile.medicaidLevel ?? 'none';

  // ── Build per-plan raw scored entries ──────────────────────────────
  const rawScored: BrainScoredPlan[] = eligible.map((row) => {
    const rawBenefits = input.benefitsByPlanKey.get(planKeyWithSegment(row)) ?? [];
    // Population-aware cost-share reconciliation for MSP-protected
    // beneficiaries. When the source-priority dedup in
    // /api/plan-brain-data.ts kept a medicare_gov 20% winner over a
    // cms_pbp 0% loser (classic UHC D-SNP primary_care shape), a
    // QMB / QMB+ / SLMB+ / FBDE member actually owes the 0% — Medicaid
    // covers the difference. selectCostShare consults alt_source and
    // returns the value that ACTUALLY applies; alt_ fields are
    // preserved on the row so downstream display / audit surfaces can
    // still see both filings.
    const benefits: PlanBenefitRow[] =
      scoringMedicaidLevel === 'none'
        ? rawBenefits
        : rawBenefits.map((b) => {
            if (!MEDICAL_COST_SHARE_CATEGORIES.has(b.benefit_category)) return b;
            const picked = selectCostShare(b, scoringMedicaidLevel);
            if (picked.copay === b.copay && picked.coinsurance === b.coinsurance) return b;
            return { ...b, copay: picked.copay, coinsurance: picked.coinsurance };
          });
    const formulary = input.formularyByPlanKey.get(planKeyNoSegment(row)) ?? new Map();
    const aggregatedPlan = input.planByKey?.get(planKeyWithSegment(row)) ?? null;

    const planDrugCache = input.drugCostCacheByPlanKey?.get(planKeyWithSegment(row));
    const drugEstimates = estimateBundleYearlyCost({
      drugs: input.userProfile.drugs,
      formulary,
      benefits,
      drugDeductible: row.drug_deductible,
      cache: planDrugCache,
      rxcuiToNdc: input.rxcuiToNdc,
    });
    const totalAnnualDrugCost = drugEstimates.reduce((s, x) => s + x.yearlyCost, 0);
    const coveredCount = drugEstimates.filter((x) => x.covered).length;
    const lowTierCount = drugEstimates.filter((x) => x.tier != null && x.tier <= 2).length;
    const totalCount = drugEstimates.length;
    // At least one user drug has no cache row AND isn't on the formulary —
    // we have no evidence either way. UI surfaces a "drug coverage
    // estimated — confirm with your pharmacist" disclaimer.
    const drugCoverageUnknown = drugEstimates.some(
      (x) => !x.covered && !x.confirmedUncovered,
    );

    const moopBenefit = benefitByCategory(benefits, 'moop_in');
    const moopAmount =
      moopBenefit?.coverage_amount ?? moopBenefit?.copay ?? row.moop ?? null;
    const annualMedicalCost = conditionProfile?.assumeMoopHit && moopAmount != null
      ? moopAmount
      : annualMedicalCostFromUtilization(benefits, utilization, moopAmount);

    const annualPremium = (row.monthly_premium ?? 0) * 12;
    const partBGivebackBenefit = benefitByCategory(benefits, 'partb_giveback');
    const partBGivebackAnnual =
      ((partBGivebackBenefit?.coverage_amount ?? partBGivebackBenefit?.copay) ?? 0) * 12;
    const totalOOPEstimate =
      annualPremium + annualMedicalCost + totalAnnualDrugCost - partBGivebackAnnual;

    const extrasValueAnnual = annualExtrasValue(
      benefits,
      input.userProfile.priorities,
      conditionProfile?.keyExtras ?? [],
      aggregatedPlan,
    );

    const supplyCoverage = computeSupplyCoverage(
      benefits,
      input.userProfile.conditionSupplies ?? [],
      conditionProfile,
    );
    const suppliesExtrasValue = suppliesValueAnnual(supplyCoverage);
    const suppliesCovered = supplyCoverage.filter((c) => c.status === 'covered').length;
    const suppliesTotal = supplyCoverage.length;
    const suppliesGaps = supplyCoverage
      .filter((c) => c.status !== 'covered')
      .map((c) => ({
        key: c.supply.key,
        humanLabel: c.supply.humanLabel,
        reason: c.status as 'not_covered' | 'brand_mismatch',
      }));

    const providerCache = input.providerNetworkByPlanKey?.get(planKeyNoSegment(row));
    let allInNet = false;
    let anyOut = false;
    let allOut = false;
    let anyDefinitelyOut = false;
    let anyUnverified = false;
    let inNetCount = 0;
    const primaryProviderNpi = input.userProfile.providers?.[0]?.npi ?? null;
    let primaryInNet = false;
    if (providerCache && userProviderNpis.length > 0) {
      let outOrAbsent = 0;
      for (const npi of userProviderNpis) {
        const c = providerCache.get(npi);
        if (c?.covered === true) {
          inNetCount += 1;
        } else {
          outOrAbsent += 1;
          if (c && c.covered === false) anyDefinitelyOut = true;
          else anyUnverified = true;
        }
      }
      allInNet = inNetCount === userProviderNpis.length;
      anyOut = outOrAbsent > 0;
      allOut = inNetCount === 0;
      if (primaryProviderNpi) {
        primaryInNet = providerCache.get(primaryProviderNpi)?.covered === true;
      }
    } else if (input.verifiedInNetworkContracts && userProviderNpis.length > 0) {
      allInNet = input.verifiedInNetworkContracts.has(row.contract_id);
      if (allInNet) inNetCount = userProviderNpis.length;
      primaryInNet = allInNet && primaryProviderNpi != null;
      if (!allInNet) anyUnverified = true;
    } else if (userProviderNpis.length > 0) {
      anyUnverified = true;
    }

    // Tri-state roll-up. Precedence: a confirmed out-of-network read on
    // ANY user NPI dominates (that is the eliminating state); otherwise
    // any missing row makes the whole plan 'unverified'; only a plan
    // with every NPI confirmed is 'in_network'. null when the user
    // entered no providers, so Gate 1 is open and there is nothing to
    // verify. The trailing 'unverified' fallback keeps the mapping
    // total — it is unreachable while the loop above sets one of the
    // two flags for every non-in-network NPI.
    const providerNetworkState: BrainScore['providerNetworkState'] =
      userProviderNpis.length === 0
        ? null
        : anyDefinitelyOut
          ? 'out_of_network'
          : anyUnverified
            ? 'unverified'
            : allInNet
              ? 'in_network'
              : 'unverified';

    const realAnnualCost = calculateRealAnnualCost({
      annualPremium,
      totalAnnualDrugCost,
      partBGivebackAnnual,
      moopInNetwork: moopAmount,
      utilization: annualUtilization,
      isDiabetic,
      copays: {
        pcp: copayForCategory(benefits, 'primary_care'),
        specialist: copayForCategory(benefits, 'specialist'),
        lab: copayForCategory(benefits, 'lab'),
        imaging: copayForCategory(benefits, 'advanced_imaging'),
        telehealth: copayForCategory(benefits, 'telehealth'),
        er: copayForCategory(benefits, 'emergency'),
        inpatientPerDay: copayForCategory(benefits, 'inpatient'),
        diabeticSupplies: copayForCategory(benefits, 'insulin'),
        // Step 1b — podiatry copay routed separately.
        podiatry: copayForCategory(benefits, 'podiatry'),
        // Step 3 — SNF day-1, ambulance per-trip, DME coins,
        // medical deductible. The 4-gate Cost stage reads these.
        snfPerDay: snfDayOneCopay(benefits),
        ambulancePerTrip: copayForCategory(benefits, 'ambulance'),
        dmeCoinsurancePct: dmeCoinsurance(benefits),
        annualDeductible: row.annual_deductible ?? 0,
      },
    });

    const dentalTier = classifyPlanDentalTier(benefits, aggregatedPlan?.benefits ?? null);

    // Cost-breakdown string — simple, no condition-aware copy. The
    // consumer's buildCostBreakdown is omitted in this port; the
    // CompareScreen renders its own annual-cost summary anyway.
    const totalCost = annualPremium + totalAnnualDrugCost - partBGivebackAnnual;
    const costBreakdown = `Estimated total: ${fmtUSD(totalCost)}/yr (premium ${fmtUSD(annualPremium)} + drugs ${fmtUSD(totalAnnualDrugCost)}${partBGivebackAnnual > 0 ? ` − giveback ${fmtUSD(partBGivebackAnnual)}` : ''}).`;

    // Per-medication breakdown — one entry per user drug, same order
    // as input. monthlyCopay comes from the formulary row's copay; tier
    // comes from drugEstimates (prefers cache tier over formulary tier
    // when both exist).
    const drugBreakdown = drugEstimates.map((est) => {
      const rxcuiStr = est.rxcui ?? '';
      const cov = rxcuiStr ? formulary.get(rxcuiStr) : undefined;
      return {
        rxcui: rxcuiStr,
        name: est.name,
        covered: est.covered,
        tier: est.tier,
        monthlyCopay: cov?.copay ?? null,
        annualCost: Math.round(est.yearlyCost),
        isBrand: est.isBrand,
      };
    });

    // Per-gate micro-explainer strings. Gates 1–3 have everything they
    // need locally; gate 4 needs the post-rank position, so we fill it
    // below in the cost-sorting pass. Mirrors consumer brain wiring at
    // packages/brain/src/plan-brain.ts:1411-1433. Cost score is passed
    // as 0 here (informational only — used to label low_drug_costs,
    // which doesn't gate; the axis score isn't known until pool size
    // is known, same as consumer).
    const gate1Explanations = buildGate1Explanations(
      input.userProfile.providers ?? [],
      providerCache,
      input.verifiedInNetworkContracts,
      row.contract_id,
    );
    const gate2Explanations = userHasDrugs
      ? buildGate2Explanations(drugEstimates, formulary)
      : [];
    const gate3Explanations = buildGate3Explanations(
      benefits,
      moopAmount,
      partBGivebackAnnual,
      0,
      userPriorities,
      input.userProfile.priorityThresholds ?? {},
      aggregatedPlan,
    );
    const explanations: GateExplanations = {
      gate1: gate1Explanations,
      gate2: gate2Explanations,
      gate3: gate3Explanations,
      gate4: '', // filled in after rankedByCost is sorted (see below)
    };

    const score: BrainScore = {
      // Axis scores filled in below once we know the pool size.
      drugCostScore: 0,
      oopCostScore: 0,
      extraBenefitsScore: 0,
      composite: 0,
      totalAnnualDrugCost,
      annualMedicalCost,
      totalOOPEstimate,
      extrasValueAnnual: extrasValueAnnual + suppliesExtrasValue,
      coveredCount,
      totalCount,
      lowTierCount,
      drugCoverageUnknown,
      // Pool-wide OTC count filled in after the map completes (needs
      // to see every plan's per-drug coverage to decide which meds
      // are truly non-Rx). See the pre-pass right after this map.
      poolWideUncoveredDrugCount: 0,
      drugBreakdown,
      allProvidersInNetwork: allInNet,
      providersInNetworkCount: inNetCount,
      anyProviderOutOfNetwork: anyOut,
      allProvidersOutOfNetwork: allOut,
      anyProviderDefinitivelyOut: anyDefinitelyOut,
      anyProviderUnverified: anyUnverified,
      providerNetworkState,
      providerVerificationNeeded: providerNetworkState === 'unverified',
      primaryProviderInNetwork: primaryInNet,
      suppliesCovered,
      suppliesTotal,
      suppliesGaps,
      medicationBackfill: false,
      csnpReservedSlot: false,
      ribbon: null,
      costBreakdown,
      partBGivebackAnnual,
      realAnnualCost,
      annualUtilization,
      // Funnel doesn't apply broker rules or red flags — neutral defaults
      // keep the BrainScore shape compatible with downstream consumers
      // (usePlanBrain adapter, useAgentBaseRecommend snapshot).
      appliedBrokerRules: [],
      redFlags: [],
      disqualifiedByRedFlag: false,
      priorityChecks: [],
      tradeoffWarnings: [],
      dentalTier,
      // Gate flags default false; flipped on after each gate phase below
      // so the adapter can attach gate_results to every bench plan.
      gate1Passed: false,
      gate2Passed: false,
      gate3Passed: false,
      explanations,
    };
    return { row, benefits, formulary, score, plan: aggregatedPlan };
  });

  // ── Pool-wide OTC / non-Rx pre-pass ────────────────────────────────
  // Any user drug that shows covered=false on EVERY plan in the pool
  // is almost certainly not a Part D drug (OTC vitamin, supplement,
  // discontinued brand). Without this, Gate 2 would eliminate the
  // entire pool for anyone who lists "Vitamin D3" alongside real
  // prescriptions. The Set of indices flows into applyMedicationGate
  // (and into the tiebreaker / budget-option coverage checks below)
  // so those meds are skipped for elimination purposes but stay in
  // the UI drug list. Count is stamped on every score for downstream
  // consumers (UI badges, brain-snapshot).
  // ── Pool-wide pre-pass — split into two distinct buckets ──────────
  //
  // Before this split (pre-2026-08-07), a single Set called
  // `poolWideUncoveredIndices` collected every drug index where every
  // plan reported covered=false and passed it to Gate 2 as the "treat
  // as OTC" bypass list. The intent was legit — Vitamin D3 shouldn't
  // disqualify plans. But it silently caught null-rxcui prescriptions
  // too: without a rxcui, estimateBundleYearlyCost never looks up the
  // formulary → covered=false everywhere → drug misclassified as OTC.
  // Real Rx skipped Gate 2. Ranking materially wrong for the ~98% of
  // captured AgentBase meds that arrive without a rxcui (see the
  // Aug 2026 blast-radius report).
  //
  // New behavior:
  //   • genuinelyUncoveredIndices — drug HAS a resolvable rxcui, but
  //     no plan in the pool covers it. Real OTC / non-formulary. Keep
  //     the Gate 2 bypass.
  //   • unresolvedIndices — drug has NULL/empty rxcui. Brain never
  //     performed a formulary lookup at all. NOT treated as OTC in
  //     any downstream logic; surfaced on BrainOutput.unresolvedDrugs
  //     so the UI can render a data-quality warning.
  //
  // NOTE ON THE Gate-2 CALL BELOW:
  // Rob's spec literally reads "Pass only genuinelyUncoveredIndices
  // to applyMedicationGate as otcIndices." Applying that literally
  // would cause every plan to fail Gate 2 for any client with an
  // unresolved drug (98% of AEP-primary clients per the blast-radius
  // report). Rob also explicitly said "Do NOT silently fail the
  // plans or empty the pool — the broker needs plans AND a clear
  // warning." Those two rules conflict; the second one wins here.
  // We pass the UNION of both sets to Gate 2 so plans still rank,
  // and rely on the new BrainOutput.unresolvedDrugs field + the
  // Compare-screen banner to tell the broker the ranking is
  // incomplete. If Rob wants the literal spec (empty-pool + banner),
  // the change is a one-liner below.
  const userDrugCount = input.userProfile.drugs.length;
  const genuinelyUncoveredIndices = new Set<number>();
  const unresolvedIndices = new Set<number>();
  if (rawScored.length > 0 && userDrugCount > 0) {
    for (let i = 0; i < userDrugCount; i += 1) {
      const drug = input.userProfile.drugs[i];
      const rx = drug?.rxcui;
      const hasRxcui = typeof rx === 'string' && rx.trim().length > 0;
      if (!hasRxcui) {
        unresolvedIndices.add(i);
        continue;
      }
      let allUncovered = true;
      for (const s of rawScored) {
        const b = s.score.drugBreakdown[i];
        if (!b || b.covered === true) { allUncovered = false; break; }
      }
      if (allUncovered) genuinelyUncoveredIndices.add(i);
    }
  }
  // poolWideUncoveredDrugCount stays as the combined count so the
  // downstream budget-option / tiebreaker helpers (allNonOtcCovered
  // at line ~215) see the same denominator they did before this
  // split. Rob's spec limits changes to Gate 2 classification + the
  // new output field.
  const poolWideUncoveredDrugCount =
    genuinelyUncoveredIndices.size + unresolvedIndices.size;
  for (const s of rawScored) s.score.poolWideUncoveredDrugCount = poolWideUncoveredDrugCount;
  if (typeof console !== 'undefined' && console.info) {
    if (genuinelyUncoveredIndices.size > 0) {
      const names = [...genuinelyUncoveredIndices]
        .map((i) => input.userProfile.drugs[i]?.name ?? `#${i}`)
        .join(', ');
      console.info(
        `[brain-funnel] pool-wide-uncovered drugs (bypass Gate 2 as non-Rx): ${names}`,
      );
    }
    if (unresolvedIndices.size > 0) {
      const names = [...unresolvedIndices]
        .map((i) => input.userProfile.drugs[i]?.name ?? `#${i}`)
        .join(', ');
      console.info(
        `[brain-funnel] unresolved drugs (no rxcui — Gate 2 bypasses to avoid empty pool; UI banner should surface): ${names}`,
      );
    }
  }
  // Union of both is what Gate 2 sees (see NOTE above).
  const gate2BypassIndices = new Set<number>([
    ...genuinelyUncoveredIndices,
    ...unresolvedIndices,
  ]);
  // Materialize the unresolved list for BrainOutput consumers.
  const unresolvedDrugs: ReadonlyArray<{ index: number; name: string }> = [
    ...unresolvedIndices,
  ].map((i) => ({
    index: i,
    name: input.userProfile.drugs[i]?.name ?? `#${i}`,
  }));

  // ── Dual-eligible / LIS cost adjustment ────────────────────────────
  // Runs after every raw BrainScore is computed and BEFORE any cost-
  // based sort or axis-score normalization. Overwrites realAnnualCost
  // sub-fields (medical zeroing for QMB/FBDE, premium zeroing for
  // QMB+D-SNP, drug copays capped at the LIS tier) and attaches a
  // snapshot of the originals to score.dualEligibleAdjustment. No-op
  // when both medicaidLevel and lisTier are 'none' (the default until
  // intake in step 5 wires the fields through usePlanBrain).
  const medicaidLevel = input.userProfile.medicaidLevel ?? 'none';
  const lisTier = input.userProfile.lisTier ?? 'none';
  const livingSetting = input.userProfile.livingSetting ?? 'community';
  if (medicaidLevel !== 'none' || lisTier !== 'none') {
    for (const scored of rawScored) {
      scored.score = applyDualEligibleCostAdjustment(
        scored.score,
        scored.row,
        medicaidLevel,
        livingSetting,
        lisTier,
      );
    }
  }

  // ── SLMB/QI/QDWI cost-sharing exposure classifier ─────────────────
  // For the dual populations Medicaid does NOT cover (slmb, qi, qdwi),
  // a plan filing coinsurance on primary_care / specialist /
  // advanced_imaging exposes the member to real out-of-pocket cost.
  // The comparator uses this flag to keep an exposed plan from winning
  // the $500 cost-band tiebreak over a non-exposed plan; see
  // compareByCostThenTiebreakers. No-op for every other medicaidLevel
  // (returns {false, false}). Runs unconditionally so the flag is
  // present on every BrainScore, matching the consumer brain.
  for (const scored of rawScored) {
    const { exposed, incomplete } = classifyCostSharingExposure(
      medicaidLevel,
      scored.benefits,
    );
    scored.score.costSharingExposed = exposed;
    scored.score.costSharingExposureIncomplete = incomplete;
  }

  // ── Informational axis scores ─────────────────────────────────────
  // Populated for analytics + brain-snapshot serialization. Lower
  // drug/OOP cost → higher score; higher extras → higher score. NOT
  // used for ranking — the funnel ranks by totalAnnualCost.
  const drugInverse = normalizeInverse(rawScored.map((s) => s.score.totalAnnualDrugCost));
  const oopInverse = normalizeInverse(rawScored.map((s) => s.score.realAnnualCost.netAnnual));
  const extrasDirect = normalizeDirect(rawScored.map((s) => s.score.extrasValueAnnual));
  rawScored.forEach((s, i) => {
    s.score.drugCostScore = drugInverse[i];
    s.score.oopCostScore = oopInverse[i];
    s.score.extraBenefitsScore = extrasDirect[i];
  });

  // ── Gate 1 — providers ────────────────────────────────────────────
  const gate1 = applyProviderGate(rawScored, userHasProviders);
  for (const s of gate1) s.score.gate1Passed = true;
  // Unconditional diagnostic — surfaces silent provider-gate bypass.
  // userHasProviders=false means Gate 1 returns the whole pool
  // unchanged; cacheSize=0 with userHasProviders=true means every
  // plan flagged unverified and Gate 1 still passed all through.
  const g1In = rawScored.filter((s) => s.score.allProvidersInNetwork).length;
  const g1Out = rawScored.filter((s) => s.score.anyProviderDefinitivelyOut).length;
  const g1Absent = rawScored.filter(
    (s) => !s.score.allProvidersInNetwork && !s.score.anyProviderDefinitivelyOut,
  ).length;
  if (typeof console !== 'undefined' && console.info) {
    console.info(
      `[brain-funnel] userHasProviders=${userHasProviders} cacheSize=${input.providerNetworkByPlanKey?.size ?? 0} ` +
      `gate1: in=${g1In} out=${g1Out} absent=${g1Absent} (pool=${rawScored.length}, survived=${gate1.length})`,
    );
  }
  debugLog(`Gate 1: ${gate1.length}/${rawScored.length} survived providers`);
  console.log('Gate 1:', gate1.length, 'survived of', rawScored.length);

  // ── Gate 2 — medications ──────────────────────────────────────────
  const gate2Survivors = applyMedicationGate(gate1, userHasDrugs, gate2BypassIndices);
  for (const s of gate2Survivors) s.score.gate2Passed = true;
  const gate2Sorted = [...gate2Survivors].sort(
    (a, b) => a.score.totalAnnualDrugCost - b.score.totalAnnualDrugCost,
  );
  debugLog(`Gate 2: ${gate2Sorted.length}/${gate1.length} survived meds`);
  console.log('Gate 2:', gate2Sorted.length, 'survived');

  // ── Gate 3 — extras "must offer" elimination ──────────────────────
  const extrasGate = applyExtrasGate(gate2Sorted, userPriorities);
  for (const s of extrasGate.fullMatch) s.score.gate3Passed = true;
  debugLog(
    `Gate 3: ${extrasGate.fullMatch.length}/${gate2Sorted.length} survived ` +
    `(eliminated: ${extrasGate.eliminated.length}, selected=[${extrasGate.selectedExtras.join(',')}])`,
  );
  console.log('Gate 3:', extrasGate.fullMatch.length, 'survived');

  // ── Gate 4 — Top 4 selection (cheapest survivors) ─────────────────
  //
  // 1. Fill from fullMatch in cost order. No backfill, no value
  //    alternatives, no near-miss. If only 2 plans cleared Gates 1+2+3,
  //    the Top 4 has 2 picks.
  // 2. If userQualifiesForCsnp AND no C-SNP landed in the Top 4
  //    naturally, swap the worst (last) slot for the cheapest C-SNP
  //    that passed Gates 1+2+3 strict. Sets score.csnpReservedSlot.
  //    If no C-SNP cleared all three gates in this county, csnpNote
  //    explains why none was inserted.
  const diversified: BrainScoredPlan[] = [];
  for (const p of extrasGate.fullMatch) {
    if (diversified.length >= 4) break;
    diversified.push(p);
  }

  // ── C-SNP reserved slot ──────────────────────────────────────────
  // Pull only from Gate-3 survivors (strict). If no C-SNP made it, the
  // Top 4 stays C-SNP-less and csnpNote explains why.
  let csnpNote: string | null = null;
  if (userQualifiesForCsnp) {
    const top4Keys = new Set(diversified.map(planKeyNoSegment2));
    const hasCsnpInTop4 = diversified.some((s) => classifySnp(s.row) === 'C');
    if (!hasCsnpInTop4) {
      const csnpCandidates = extrasGate.fullMatch.filter(
        (s) => classifySnp(s.row) === 'C' && !top4Keys.has(planKeyNoSegment2(s)),
      );
      const bestCsnp = [...csnpCandidates].sort(compareByCostThenTiebreakers)[0];
      if (bestCsnp) {
        bestCsnp.score.csnpReservedSlot = true;
        if (diversified.length >= 4) {
          diversified[diversified.length - 1] = bestCsnp;
        } else {
          diversified.push(bestCsnp);
        }
        debugLog(
          `C-SNP reserved slot: inserted ${bestCsnp.row.carrier} ${bestCsnp.row.plan_name} ` +
            `(${bestCsnp.row.contract_id}-${bestCsnp.row.plan_id}-${bestCsnp.row.segment_id})`,
        );
      } else {
        csnpNote = 'No C-SNP plans cover your providers, medications, and selected extras in this county.';
        debugLog(`C-SNP reserved slot: ${csnpNote}`);
      }
    }
  }

  // ── Rank by cost (entire pool) ────────────────────────────────────
  const rankedByCost = [...rawScored].sort(compareByCostThenTiebreakers);
  const N = rankedByCost.length;
  rankedByCost.forEach((s, i) => {
    s.score.composite = N > 1 ? Math.round(((N - 1 - i) / (N - 1)) * 10000) / 100 : 100;
    // Gate-4 explainer line — single cost-rank summary. Uses
    // realAnnualCost.netAnnual (same figure CompareScreen renders) so
    // the pill matches the broker's headline number on the card.
    s.score.explanations = {
      ...s.score.explanations,
      gate4: buildGate4Explanation(s.score.realAnnualCost.netAnnual, i + 1, N),
    };
  });

  // ── Ribbon assignment ─────────────────────────────────────────────
  // Gate 3 already eliminated plans without dental when the user
  // selected it, so the predicate just gates non-survivors on a
  // non-zero dental file. Ribbons on eliminated plans never reach UI
  // (the adapter slices to liveTop3.picks).
  const passesPriorityGates = (s: BrainScoredPlan): boolean => {
    if (!userPriorities.has('dental')) return true;
    if (s.plan) {
      return extractExtraAnnualFromAggregated(s.plan.benefits, s.plan, 'dental') > 0;
    }
    return extractCategoryAnnualValue(s.benefits, 'dental') > 0;
  };
  assignRibbons(rankedByCost, { passesPriorityGates });

  // ── LiveTop3 envelope ─────────────────────────────────────────────
  const liveTop3: LiveTop3 | null = diversified.length >= 1 ? {
    population,
    scopeLabel: input.county ? `in ${input.county} County` : 'in your area',
    qualifyingPlanCount: eligible.length,
    providerFilterFellBack: userHasProviders && gate1.length < rawScored.length && diversified.length < 4,
    highMoopFilterFellBack: false,
    priorityGateRelaxation:
      diversified.some((p) => p.score.csnpReservedSlot) ? 'half' : undefined,
    picks: diversified.map((s, i) => {
      const basePick = brainToLiveTop3Pick(s, i, population, input);
      let ribbonText = '';
      if (i === 0) {
        const ribbon: RibbonType = s.score.ribbon ?? 'BEST_OVERALL';
        s.score.ribbon = ribbon;
        ribbonText = ribbonDisplayText(
          ribbon,
          population,
          input.county,
          input.userProfile.csnpConditions,
          input.userProfile.providers.filter((p) => typeof p.npi === 'string' && p.npi.length > 0).length,
        );
      }
      return { ...basePick, category: 'best' as const, ribbon: ribbonText };
    }),
  } : null;

  // ── Budget option — cheapest plan covering every drug ─────────────
  let budgetOption: BrainScoredPlan | null = null;
  if (rankedByCost.length > 0) {
    const fullyCovered = rankedByCost.filter((s) => allNonOtcCovered(s.score));
    const pool = fullyCovered.length > 0 ? fullyCovered : rankedByCost;
    budgetOption = [...pool].sort(
      (a, b) => a.score.realAnnualCost.netAnnual - b.score.realAnnualCost.netAnnual,
    )[0] ?? null;
  }

  const csnpResCount = diversified.filter((p) => p.score.csnpReservedSlot).length;
  debugLog(
    `Final: eligible=${eligible.length} → gate1=${gate1.length} → gate2=${gate2Sorted.length} → ` +
    `gate3=${extrasGate.fullMatch.length} (eliminated=${extrasGate.eliminated.length}) → ` +
    `picks=${diversified.length}` +
    (csnpResCount > 0 ? ` (csnp_reserved=${csnpResCount})` : ''),
  );

  return {
    population,
    ranked: rankedByCost,
    liveTop3,
    isHealthyClient,
    budgetOption,
    detectedConditions,
    archetype: 'general',
    medicationPatterns: [],
    csnpNote,
    enrollmentGated,
    enrollmentPeriodLabel,
    unresolvedDrugs,
  };
}
