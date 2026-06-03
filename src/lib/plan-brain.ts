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

import type { PmPlanRow, CsnpCondition } from './brain-foreign-types';
import {
  type BrainInputs,
  type BrainOutput,
  type BrainScore,
  type BrainScoredPlan,
  type LiveTop3,
  type LiveTop3Pick,
  type RankPopulation,
  type RibbonType,
} from './plan-brain-types';
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

// ─── Cost-tie tiebreaker chain ──────────────────────────────────────
//
// Durham 27713 has 30+ plans tied at $0/yr net cost (zero-premium MAPDs
// + giveback offsetting drug copays). Without a tiebreaker the Top 4
// was determined by database row order — non-deterministic across
// runs. The chain is broker-judgment-driven, not arbitrary:
//
//   1. More providers in-network — closes the same network reach gap
//      Gate 1 catches in extreme cases (definitively-OON eliminations)
//      but not in the partial-match middle ground.
//   2. All meds covered, then cheapest drug subtotal — between two
//      otherwise-equal plans, "all your prescriptions on formulary at
//      lower cost" wins.
//   3. Lower MOOP — caps catastrophic exposure; a $4k MOOP plan beats
//      an $8k one when everything else is identical.
//   4. Higher star rating — CMS quality signal.
//   5. Carrier name alphabetical — pure stability, last resort, so
//      runs are reproducible across DB row-order shuffles.
function compareByCostThenTiebreakers(a: BrainScoredPlan, b: BrainScoredPlan): number {
  // PROVIDER CONFIDENCE TIER — fully-confirmed-in-net plans rank
  // above any plan with an unverified provider, regardless of cost.
  // Surfaced in the Compare screen so brokers don't pick a cheaper
  // plan whose network status is "?" — those carry the 'unknown'
  // badge and sit behind any confirmed match.
  const aConfirmed = a.score.allProvidersInNetwork ? 1 : 0;
  const bConfirmed = b.score.allProvidersInNetwork ? 1 : 0;
  if (aConfirmed !== bConfirmed) return bConfirmed - aConfirmed;
  const costDiff = totalAnnualCost(a) - totalAnnualCost(b);
  if (costDiff !== 0) return costDiff;
  // 1. More providers in-network first.
  const inNetDiff = b.score.providersInNetworkCount - a.score.providersInNetworkCount;
  if (inNetDiff !== 0) return inNetDiff;
  // 2. All meds covered first (true ranks before false), then lowest
  //    drug subtotal among same-coverage plans.
  const aAllMeds = a.score.totalCount === 0 || a.score.coveredCount === a.score.totalCount;
  const bAllMeds = b.score.totalCount === 0 || b.score.coveredCount === b.score.totalCount;
  if (aAllMeds !== bAllMeds) return aAllMeds ? -1 : 1;
  const drugDiff = a.score.totalAnnualDrugCost - b.score.totalAnnualDrugCost;
  if (drugDiff !== 0) return drugDiff;
  // 3. Lower MOOP.
  const aMoop = a.row.moop ?? Number.POSITIVE_INFINITY;
  const bMoop = b.row.moop ?? Number.POSITIVE_INFINITY;
  if (aMoop !== bMoop) return aMoop - bMoop;
  // 4. Higher star rating.
  const aStars = a.row.star_rating ?? 0;
  const bStars = b.row.star_rating ?? 0;
  if (aStars !== bStars) return bStars - aStars;
  // 5. Carrier name alphabetical (stable).
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
//   • covered=true      — verified in-network → PASS, no flag
//   • covered=false     — verified OUT of network → ELIMINATED
//   • cache row absent  — UNVERIFIED → PASS with anyProviderUnverified
//                         flag (surfaces as 'unknown' on the Compare
//                         screen so the broker knows to call the
//                         carrier).
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
  return pool.filter((s) => !s.score.anyProviderDefinitivelyOut);
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
): BrainScoredPlan[] {
  if (!userHasDrugs) return [...pool];
  return pool.filter(
    (s) =>
      s.score.totalCount > 0 &&
      s.score.coveredCount === s.score.totalCount &&
      !s.score.drugCoverageUnknown,
  );
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
// Priorities the user can pick that DON'T map to a Gate-3 benefit
// (low_rx / low_premium / keep_doctor) are filtered out upstream in
// AgentV3App's PRIORITY_TO_EXTRAS map, so they never reach this gate.

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
  return s.benefits.some((b) => b.benefit_category === 'transportation');
}

function planOffersExtra(s: BrainScoredPlan, key: ExtrasGateKey): boolean {
  if (key === 'transportation') return planHasTransportation(s);
  if (key === 'otc') return extractOtcQuarterly(s.benefits).quarterly > 0;
  // dental / vision / hearing / fitness — annualized allowance > 0.
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

  // ── Build per-plan raw scored entries ──────────────────────────────
  const rawScored: BrainScoredPlan[] = eligible.map((row) => {
    const benefits = input.benefitsByPlanKey.get(planKeyWithSegment(row)) ?? [];
    const formulary = input.formularyByPlanKey.get(planKeyNoSegment(row)) ?? new Map();

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
        annualDeductible: row.annual_deductible,
      },
    });

    const dentalTier = classifyPlanDentalTier(benefits);

    // Cost-breakdown string — simple, no condition-aware copy. The
    // consumer's buildCostBreakdown is omitted in this port; the
    // CompareScreen renders its own annual-cost summary anyway.
    const totalCost = annualPremium + totalAnnualDrugCost - partBGivebackAnnual;
    const costBreakdown = `Estimated total: ${fmtUSD(totalCost)}/yr (premium ${fmtUSD(annualPremium)} + drugs ${fmtUSD(totalAnnualDrugCost)}${partBGivebackAnnual > 0 ? ` − giveback ${fmtUSD(partBGivebackAnnual)}` : ''}).`;

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
      allProvidersInNetwork: allInNet,
      providersInNetworkCount: inNetCount,
      anyProviderOutOfNetwork: anyOut,
      allProvidersOutOfNetwork: allOut,
      anyProviderDefinitivelyOut: anyDefinitelyOut,
      anyProviderUnverified: anyUnverified,
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
    };
    return { row, benefits, formulary, score };
  });

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
  const gate2Survivors = applyMedicationGate(gate1, userHasDrugs);
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
  });

  // ── Ribbon assignment ─────────────────────────────────────────────
  // Gate 3 already eliminated plans without dental when the user
  // selected it, so the predicate just gates non-survivors on a
  // non-zero dental file. Ribbons on eliminated plans never reach UI
  // (the adapter slices to liveTop3.picks).
  const passesPriorityGates = (s: BrainScoredPlan): boolean => {
    if (!userPriorities.has('dental')) return true;
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
    const fullyCovered = rankedByCost.filter(
      (s) => s.score.totalCount === 0 || s.score.coveredCount === s.score.totalCount,
    );
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
  };
}
