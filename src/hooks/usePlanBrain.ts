// usePlanBrain — React hook that fetches the aggregated Brain data
// payload and runs runPlanBrain() over the supplied plan list.
//
// Stays inside the agent quote screen — no global state. Re-runs when
// the plan ids, medications, providers, or condition profile change.
// Exposes a loading flag and the full PlanBrainResult.
//
// ─── Brain transplant adapter (agent v3 → consumer brain) ────────────
//
// The brain library was replaced with the consumer's source-of-truth
// version. Its inputs/outputs use different names + shapes than the
// agent app expects. To avoid touching the entire agent UI, this file:
//
//   1. Loads the same /api/plan-brain-data payload as before (the
//      agent's PlanBrainData shape — preserved as PlanBrainData
//      below for lookupDrugCost in QuoteDeliveryV4).
//   2. adaptToBrainInputs() converts that payload + the agent's
//      Plan / Client / Medication / Provider records into BrainInputs
//      (the new consumer shape: PmPlanRow[], Maps keyed by
//      contract-plan-segment, etc.).
//   3. runPlanBrain returns BrainOutput; adaptBrainOutput() massages
//      it back into a "compat" PlanBrainResult that mirrors the
//      pre-transplant shape the agent UI was written against.
//
// The compat types are exported below (ScoredPlan, PlanBrainResult,
// WeightProfile, RibbonKey, ConditionKey, Population, PlanBrainData)
// so the 4 dependent caller files don't need their own redefinitions.

import { useEffect, useMemo, useState } from 'react';
import type { Plan } from '@/types/plans';
import type { Client, Medication, Provider } from '@/types/session';
import { runPlanBrain } from '@/lib/plan-brain';
import type {
  BrainInputs,
  BrainOutput,
  BrainScoredPlan,
  BrainWeights,
  RankPopulation,
  RibbonType,
  UserProfile,
} from '@/lib/plan-brain-types';
import type {
  PmPlanRow,
  PlanBenefitRow,
  FormularyCoverage,
  CsnpCondition,
} from '@/lib/brain-foreign-types';
import type { DetectedConditionKey } from '@/lib/condition-detector';
import { BROKER_IMPLICATIONS } from '@/lib/condition-detector';
import { ARCHETYPE_RULES } from '@/lib/broker-playbook';
import type {
  AnnualCostEstimate,
  AnnualUtilization,
} from '@/lib/utilization-model';

// ─── Compat type re-exports ──────────────────────────────────────────
// These mirror the pre-transplant agent shape so callers (QuoteDeliveryV4,
// useAgentBaseRecommend, quotePdf, AgentV3App) keep their existing
// field-access patterns.

export type RibbonKey = RibbonType;
export type WeightProfile = BrainWeights;
export type Population = 'mapd' | 'csnp' | 'dsnp';
export type ConditionKey = DetectedConditionKey;

// Subset of agent ConditionKey + DetectedConditionKey overlap used by
// the agent app's CONDITION_LABEL map. (Old type was named `Condition`
// — kept under the same name here so the existing QuoteDeliveryV4
// import resolves.) Identical to DetectedConditionKey today.

// PlanBrainData — agent /api/plan-brain-data payload. Lookup helpers
// (lookupDrugCost in QuoteDeliveryV4) read this verbatim, so its shape
// can't shift.
export interface BenefitRow {
  benefit_type: string;
  tier_id: string | null;
  copay: number | null;
  coinsurance: number | null;
  description: string | null;
  source: string;
}
export interface DrugCostCacheRow {
  plan_id: string;
  segment_id: string;
  ndc: string;
  tier: number | null;
  full_cost: number | null;
  covered: boolean | null;
  estimated_yearly_total: number | null;
}
export interface FormularyRow {
  contract_id: string;
  plan_id: string;
  rxcui: string;
  tier: number | null;
  copay: number | null;
  coinsurance: number | null;
  prior_auth: boolean | null;
  step_therapy: boolean | null;
}
export interface NdcRow {
  rxcui: string;
  ndc: string;
  default_quantity_30: number | null;
  default_quantity_90: number | null;
}
export interface ProviderNetworkRow {
  plan_id: string;
  segment_id: string;
  npi: string;
  covered: boolean | null;
}
export interface PlanBrainData {
  benefitsByPlan: Record<string, BenefitRow[]>;
  drugCostCache: Record<string, Record<string, DrugCostCacheRow>>;
  formularyByContractPlan: Record<string, Record<string, FormularyRow>>;
  ndcByRxcui: Record<string, NdcRow>;
  networkByPlan: Record<string, Record<string, ProviderNetworkRow>>;
}

// Compat applied-rule shape — agent UI reads `action`/`reason`/`points`/`ruleId`.
// Maps from broker-rules.AppliedRule (which has no `action` field — every
// rule is a numeric `points` adjustment with sign). We reconstruct
// `action` from points sign so the UI's filter on "penalize" still works.
export interface CompatRuleApplication {
  ruleId: string;
  action: 'boost' | 'penalize' | 'flag';
  points: number;
  reason: string;
}

// Compat red-flag shape — agent UI reads `id`, `severity`, `message`,
// and filters for severity 'critical' || 'disqualify'. New brain emits
// `id` (RedFlagFamily), `severity`, `action`, `message`. We expose a
// pseudo-severity 'disqualify' when action === 'disqualify' so the
// agent's filter still triggers without rewriting it.
export interface CompatRedFlag {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'disqualify';
  action: 'disqualify' | 'penalize' | 'warn' | 'flag';
  message: string;
}

// Compat real-annual-cost shape. Maps from new AnnualCostEstimate
// (premium/drugCost/medicalCost/suppliesCost/erExpected/hospitalExpected/
// partBGivebackSavings/cappedMedicalBucket/netAnnual) to the old name
// scheme expected by quotePdf and useAgentBaseRecommend.
export interface CompatRealAnnualCost {
  premium: number;
  drugs: number;
  medicalVisits: number;
  supplies: number;
  erExpected: number;
  hospitalExpected: number;
  givebackSavings: number;
  medicalGross: number;
  medicalCapped: number;
  cappedAtMoop: boolean;
  netAnnual: number;
}

// Compat utilization profile shape used by quotePdf for the assumption
// block. Maps AnnualUtilization → the old keys (pcp/specialist/labs/
// erProbability/hospitalProbability/monthlySupplies/hospitalDays).
export interface CompatUtilizationProfile {
  pcp: number;
  specialist: number;
  labs: number;
  erProbability: number;
  hospitalProbability: number;
  hospitalDays: number;
  monthlySupplies: number;
}

// Compat detected-condition. Mirrors the old shape that included
// brokerImplications + a typed condition key.
export interface CompatDetectedCondition {
  condition: DetectedConditionKey;
  confidence: 'certain' | 'likely' | 'possible';
  triggerMeds: ReadonlyArray<string>;
  brokerImplications: ReadonlyArray<string>;
}

// Compat medication pattern — agent UI reads p.id + p.severity + p.summary.
// Maps from new MedicationPattern (id/variant/implication).
export interface CompatMedicationPattern {
  id: string;
  variant: string;
  severity: 'low';
  summary: string;
}

export interface CompatArchetype {
  archetype: string;
  label: string;
  description: string;
}

export interface ScoredPlan {
  plan: Plan;
  rank: number;
  composite: number;
  drugScore: number;
  oopScore: number;
  extrasScore: number;
  totalAnnualDrugCost: number;
  annualMedicalCost: number;
  totalOOPEstimate: number;
  extrasValue: number;
  providerBoost: number;
  providerNetworkStatus: 'all_in' | 'partial' | 'all_out' | 'unknown';
  uncoveredDrugRxcuis: string[];
  /** Mirror of BrainScore.drugCoverageUnknown — true when at least one
   *  user drug has no pm_drug_cost_cache row AND isn't on the plan's
   *  formulary. UI surfaces the "drug coverage estimated — confirm
   *  with your pharmacist" disclaimer on affected plan columns. */
  drugCoverageUnknown: boolean;
  ribbon: RibbonKey | null;
  breakdown: string;
  drugCostByRxcui: Record<string, number>;
  appliedRules: CompatRuleApplication[];
  brokerRuleAdjustment: number;
  isCsnp: boolean;
  /** True when force-inserted into the Top 4 by the C-SNP reserved-
   *  slot pass (see plan-brain.ts). UI badges this as "Recommended
   *  for your condition." */
  csnpReservedSlot: boolean;
  /** DEPRECATED — always false after the strict-gates rewrite. Gate 2
   *  now hard-eliminates any plan missing a user drug; no medication
   *  backfill ever fires. Field kept for caller compat. */
  medicationBackfill: boolean;
  realAnnualCost: CompatRealAnnualCost | null;
  redFlags: CompatRedFlag[];
  disqualified: boolean;
  whySwitchCopy: string;
  /** Underlying combined utilization for this plan (same per run). */
  annualUtilization: AnnualUtilization;
}

export interface PlanBrainResult {
  population: Population;
  weights: WeightProfile;
  utilization: 'low' | 'moderate' | 'high';
  utilizationProfile: CompatUtilizationProfile;
  scored: ScoredPlan[];
  filteredOut: { plan: Plan; reason: string }[];
  detectedConditions: CompatDetectedCondition[];
  medicationPatterns: CompatMedicationPattern[];
  archetype: CompatArchetype;
  /** Set when the user qualifies for a C-SNP but no C-SNP plan in
   *  this county passed Gates 1+2. UI surfaces this as a context
   *  note explaining why the Top 4 contains zero C-SNPs. Null when
   *  the user did not qualify or a C-SNP is in the Top 4. */
  csnpNote: string | null;
}

// ─── Adapter input ──────────────────────────────────────────────────

interface Args {
  plans: Plan[];
  client: Client;
  medications: Medication[];
  providers: Provider[];
  conditionProfile?: ConditionKey | null;
  userPriorities?: string[];
  populationOverride?: Population | null;
  weightOverride?: Partial<WeightProfile> | null;
}

interface State {
  result: PlanBrainResult | null;
  /** Raw aggregated Brain data — exposes per-drug, per-medical, and
   *  per-network rows so a consumer (e.g. the v4 quote table) can
   *  render exact dollar values instead of just the composite score.
   *  Null until the first fetch lands. */
  data: PlanBrainData | null;
  loading: boolean;
  error: string | null;
  /** True when (a) plans, (b) /api/plan-brain-data has returned, and
   *  (c) we're not currently fetching. The brain runs ONCE per stable
   *  input set after this is true; consumers should show a loading
   *  state until then to avoid rendering a partial scoring pass that
   *  flickers as provider-network rows arrive late. */
  ready: boolean;
  /** Names of providers entered without an NPI that NPPES could not
   *  resolve. Consumers MUST surface this — when non-empty, Gate 1 had
   *  no NPI to check for those providers, so the ranking does not
   *  reflect their network status. */
  unresolvedProviderNames: string[];
}

// ─── PmPlanRow synthesis from agent's Plan ──────────────────────────
// The agent's Plan record is the source-of-truth for premium / MOOP /
// star / formulary etc. The brain wants a PmPlanRow (a flatter,
// CMS-style record). We build one synthetic PmPlanRow per Plan; fields
// the agent doesn't carry (county_fips, snp_type, sanctioned, enrollment_*)
// get sensible defaults — those drive a few brain heuristics but never
// any cost/extras output, so safe to stub.
function planToPmRow(plan: Plan, county: string, idx: number): PmPlanRow {
  // Plan.id is the canonical "<contract>-<plan>-<segment>" triple
  // (e.g. "H1036-308-0"). Split it back out for the row.
  const parts = plan.id.split('-');
  const contract = parts[0] ?? plan.contract_id;
  const planNum = parts[1] ?? plan.plan_number;
  const segRaw = parts[2] ?? '0';
  // pm_plans stores the segment as 0/1/2/etc (no zero padding) — keep
  // that representation so brain key generation matches the agent's
  // existing triple ids verbatim.
  const segment = segRaw.replace(/^0+/, '') || '0';
  // SNP type is carried through the agent's PlanType enum. classifySnp
  // in plan-brain.ts substring-matches on snp_type, so stamp the canonical
  // hyphenated form ("C-SNP" / "D-SNP" / "I-SNP") rather than the enum
  // value so the brain bucketing matches the pm_plans schema.
  const snpKind: 'C-SNP' | 'D-SNP' | 'I-SNP' | null =
    plan.plan_type === 'DSNP' ? 'D-SNP'
    : plan.plan_type === 'CSNP' ? 'C-SNP'
    : plan.plan_type === 'ISNP' ? 'I-SNP'
    : null;
  const isSnp = snpKind != null;
  return {
    id: idx,
    contract_id: contract,
    plan_id: planNum,
    segment_id: segment,
    plan_name: plan.plan_name,
    carrier: plan.carrier,
    parent_organization: null,
    plan_type: plan.plan_type,
    state: plan.state,
    county_name: county,
    county_fips: null,
    monthly_premium: plan.premium,
    annual_deductible: plan.annual_deductible,
    moop: plan.moop_in_network,
    drug_deductible: plan.drug_deductible,
    star_rating: plan.star_rating,
    snp: isSnp,
    snp_type: snpKind,
    sanctioned: false,
    enrollment_count: null,
    enrollment_as_of: null,
  };
}

// ─── BenefitRow → PlanBenefitRow translation ────────────────────────
// Agent's benefit row uses (benefit_type, tier_id, description, source)
// while consumer's PlanBenefitRow uses (benefit_category, benefit_description,
// coverage_amount, max_coverage). Map field-by-field; missing data
// becomes null. tier_id is encoded into the synthetic id so React
// keys stay unique when the brain rebuilds the list.
function benefitToBrain(
  contract: string,
  planNum: string,
  segment: string,
  row: BenefitRow,
  i: number,
): PlanBenefitRow {
  const allowedSource =
    row.source === 'medicare_gov' || row.source === 'pbp_federal'
      ? 'pbp'
      : row.source === 'sb_ocr' || row.source === 'manual'
        ? row.source
        : 'pbp';
  return {
    id: `agent:${contract}-${planNum}-${segment}:${row.benefit_type}:${row.tier_id ?? i}`,
    contract_id: contract,
    plan_id: planNum,
    segment_id: segment,
    benefit_category: row.tier_id
      ? `${row.benefit_type}_${row.tier_id}`
      : row.benefit_type,
    benefit_description: row.description,
    coverage_amount: null,
    copay: row.copay,
    coinsurance: row.coinsurance,
    max_coverage: null,
    source: allowedSource as 'pbp' | 'sb_ocr' | 'manual',
  };
}

// ─── FormularyRow → FormularyCoverage translation ───────────────────
function formularyToBrain(row: FormularyRow): FormularyCoverage {
  return {
    rxcui: row.rxcui,
    drug_name: null,
    tier: row.tier,
    copay: row.copay,
    coinsurance: row.coinsurance,
    prior_auth: row.prior_auth === true,
    step_therapy: row.step_therapy === true,
    quantity_limit: false,
    quantity_limit_amount: null,
    quantity_limit_days: null,
    match_type: 'rxcui',
  };
}

// Map agent ConditionKey → CsnpCondition where overlap exists. The
// brain's csnpConditions is consumed for SNP plan-pool filtering and
// utilization; agent's ConditionKey covers a similar domain with
// minor name mismatches.
function conditionToCsnp(c: ConditionKey | null | undefined): CsnpCondition | null {
  switch (c) {
    case 'diabetes':
      return 'diabetes';
    case 'chf':
      return 'cardio';
    case 'copd':
      return 'copd';
    case 'hypertension':
      return 'hypertension';
    case 'ckd':
      return 'esrd';
    default:
      return null;
  }
}

interface AdapterArgs {
  plans: Plan[];
  client: Client;
  medications: Medication[];
  providers: Provider[];
  data: PlanBrainData;
  conditionProfile?: ConditionKey | null;
  userPriorities?: string[];
  weightsOverride?: BrainWeights | null;
}

function adaptToBrainInputs(args: AdapterArgs): BrainInputs {
  const { plans, client, medications, providers, data } = args;
  const county = client.county || '';
  const planRows: PmPlanRow[] = plans.map((p, i) => planToPmRow(p, county, i + 1));

  // ── benefitsByPlanKey ─────────────────────────────────────────────
  // agent payload: `${contract}-${plan}-${segment}` (one zero-padded
  // segment form) → BenefitRow[]. Brain expects the same triple key.
  const benefitsByPlanKey = new Map<string, PlanBenefitRow[]>();
  for (const [tripleId, rows] of Object.entries(data.benefitsByPlan)) {
    const parts = tripleId.split('-');
    const contract = parts[0] ?? '';
    const planNum = parts[1] ?? '';
    const segRaw = (parts[2] ?? '0').replace(/^0+/, '') || '0';
    // Brain keying convention: `${contract}-${plan}-${segment}` (no zero pad).
    const key = `${contract}-${planNum}-${segRaw}`;
    benefitsByPlanKey.set(
      key,
      rows.map((r, i) => benefitToBrain(contract, planNum, segRaw, r, i)),
    );
  }

  // ── formularyByPlanKey (no segment) ───────────────────────────────
  const formularyByPlanKey = new Map<string, Map<string, FormularyCoverage>>();
  for (const [contractPlan, rxMap] of Object.entries(data.formularyByContractPlan)) {
    const inner = new Map<string, FormularyCoverage>();
    for (const [rxcui, row] of Object.entries(rxMap)) {
      inner.set(rxcui, formularyToBrain(row));
    }
    formularyByPlanKey.set(contractPlan, inner);
  }

  // ── mapdContractPlanIds ──────────────────────────────────────────
  // INTENTIONALLY UNSET. The brain's MA-only filter (plan-brain.ts:841)
  // drops any plan not in this set when the user has no VA coverage —
  // designed for the consumer flow, where the pool is mixed MA/MAPD.
  //
  // Why we can't derive it here: /api/plan-brain-data scopes the
  // pm_formulary query to the user's specific rxcuis (expandedRxcuiList).
  // So `data.formularyByContractPlan` only contains plans that cover
  // the user's exact meds — NOT the full set of MAPDs. Building
  // mapdContractPlanIds from it under-reports MAPD coverage and the
  // brain ends up filtering the pool down to whatever 2-3 plans
  // happen to list the user's drugs (Durham NC 27713 went from 50+
  // candidates to 2 — the bug this comment exists for).
  //
  // Why it's safe to skip: the agent's /api/plans already applies a
  // planType=MAPD filter at query time via mapPlanType(plan_type, snp,
  // snp_type). MA-only plans never enter the agent pool in the first
  // place, so the brain's redundant filter has nothing to do. If a
  // future caller passes planType=null and needs MA-only suppression,
  // the right fix is to add a dedicated /api/plan-brain-data field
  // populated by SELECT DISTINCT (contract_id, plan_id) FROM
  // pm_formulary WHERE contract_id IN (...) AND plan_id IN (...) —
  // not to revive the rxcui-scoped derivation below.
  const mapdContractPlanIds: ReadonlySet<string> | undefined = undefined;

  // ── providerNetworkByPlanKey (keyed contract-plan, no segment) ───
  const providerNetworkByPlanKey = new Map<
    string,
    Map<string, { npi: string; covered: boolean }>
  >();
  for (const [tripleId, npiMap] of Object.entries(data.networkByPlan)) {
    const parts = tripleId.split('-');
    const contract = parts[0] ?? '';
    const planNum = parts[1] ?? '';
    const cpKey = `${contract}-${planNum}`;
    const inner = providerNetworkByPlanKey.get(cpKey) ?? new Map();
    for (const [npi, row] of Object.entries(npiMap)) {
      inner.set(npi, { npi, covered: row.covered === true });
    }
    providerNetworkByPlanKey.set(cpKey, inner);
  }

  // ── drugCostCacheByPlanKey (triple-id → ndc → entry) ──────────────
  const drugCostCacheByPlanKey = new Map<
    string,
    Map<
      string,
      {
        ndc: string;
        tier: number | null;
        full_cost: number | null;
        estimated_yearly_total: number | null;
        covered: boolean;
      }
    >
  >();
  for (const [tripleId, ndcMap] of Object.entries(data.drugCostCache)) {
    const parts = tripleId.split('-');
    const contract = parts[0] ?? '';
    const planNum = parts[1] ?? '';
    const segRaw = (parts[2] ?? '0').replace(/^0+/, '') || '0';
    const key = `${contract}-${planNum}-${segRaw}`;
    const inner = new Map<
      string,
      {
        ndc: string;
        tier: number | null;
        full_cost: number | null;
        estimated_yearly_total: number | null;
        covered: boolean;
      }
    >();
    for (const [ndc, row] of Object.entries(ndcMap)) {
      inner.set(ndc, {
        ndc,
        tier: row.tier,
        full_cost: row.full_cost,
        estimated_yearly_total: row.estimated_yearly_total,
        covered: row.covered === true,
      });
    }
    drugCostCacheByPlanKey.set(key, inner);
  }

  // ── rxcuiToNdc bridge ─────────────────────────────────────────────
  const rxcuiToNdc = new Map<string, string>();
  for (const [rxcui, row] of Object.entries(data.ndcByRxcui)) {
    rxcuiToNdc.set(rxcui, row.ndc);
  }

  // ── userProfile ───────────────────────────────────────────────────
  const conditionCsnp = conditionToCsnp(args.conditionProfile);
  const userProfile: UserProfile = {
    drugs: medications.map((m) => ({ rxcui: m.rxcui, name: m.name })),
    providers: providers.map((p) => ({ npi: p.npi, name: p.name })),
    priorities: new Set(args.userPriorities ?? []),
    dsnpEligible: client.medicaidConfirmed === true ? true : null,
    csnpConditions: conditionCsnp ? [conditionCsnp] : [],
    age: ageFromDob(client.dob),
    hasVaDrugCoverage: false,
  };

  return {
    plans: planRows,
    benefitsByPlanKey,
    formularyByPlanKey,
    userProfile,
    county: county || null,
    drugCostCacheByPlanKey,
    rxcuiToNdc,
    providerNetworkByPlanKey,
    mapdContractPlanIds,
    weightsOverride: args.weightsOverride ?? undefined,
  };
}

function ageFromDob(dob: string | null | undefined): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a -= 1;
  return a;
}

// ─── BrainOutput → compat PlanBrainResult ───────────────────────────

function pmRowToPlanId(row: PmPlanRow): string {
  // Match Plan.id format: "<contract>-<plan>-<segment>" with NO zero pad.
  return `${row.contract_id}-${row.plan_id}-${row.segment_id}`;
}

function adaptScored(
  brain: BrainScoredPlan,
  rank: number,
  agentPlanByTriple: Map<string, Plan>,
): ScoredPlan | null {
  const planId = pmRowToPlanId(brain.row);
  const plan = agentPlanByTriple.get(planId);
  if (!plan) return null;

  const score = brain.score;
  const realAnnual: CompatRealAnnualCost | null = score.realAnnualCost
    ? mapRealAnnualCost(score.realAnnualCost)
    : null;

  // After Gate 1's relaxation, plans with any unverified provider pass
  // through with score.allProvidersOutOfNetwork=true (when inNetCount
  // is 0). Map unverified BEFORE all_out so the UI badges 'unknown' and
  // the broker knows to call the carrier — not 'all_out' which reads
  // as "we confirmed your doctor is out of network."
  const providerNetworkStatus: ScoredPlan['providerNetworkStatus'] =
    score.allProvidersInNetwork
      ? 'all_in'
      : score.anyProviderUnverified
        ? 'unknown'
        : score.allProvidersOutOfNetwork
          ? 'all_out'
          : score.anyProviderOutOfNetwork
            ? 'partial'
            : 'unknown';

  const appliedRules: CompatRuleApplication[] = score.appliedBrokerRules.map((r) => ({
    ruleId: r.ruleId,
    action: r.points > 0 ? 'boost' : r.points < 0 ? 'penalize' : 'flag',
    points: Math.abs(r.points),
    reason: r.reason,
  }));

  const brokerRuleAdjustment = score.appliedBrokerRules.reduce(
    (sum, r) => sum + r.points,
    0,
  );

  const redFlags: CompatRedFlag[] = score.redFlags.map((f) => ({
    id: f.id,
    severity: f.action === 'disqualify' ? 'disqualify' : f.severity,
    action: f.action,
    message: f.message,
  }));

  const isCsnp = (() => {
    const t = (brain.row.snp_type ?? brain.row.plan_type ?? '').toLowerCase();
    return t.includes('c-snp') || t.includes('csnp') || t.includes('chronic');
  })();

  const uncoveredDrugRxcuis: string[] = [];
  // Brain doesn't surface a per-rxcui uncovered list directly; derive
  // from coveredCount vs totalCount when the user has drugs.
  // (Empty when totalCount === 0 — nothing to mark uncovered.)

  return {
    plan,
    rank,
    composite: score.composite,
    drugScore: score.drugCostScore,
    oopScore: score.oopCostScore,
    extrasScore: score.extraBenefitsScore,
    totalAnnualDrugCost: score.totalAnnualDrugCost,
    annualMedicalCost: score.annualMedicalCost,
    totalOOPEstimate: score.totalOOPEstimate,
    extrasValue: score.extrasValueAnnual,
    providerBoost: score.allProvidersInNetwork
      ? 5
      : score.anyProviderOutOfNetwork
        ? -10
        : 0,
    providerNetworkStatus,
    uncoveredDrugRxcuis,
    drugCoverageUnknown: score.drugCoverageUnknown,
    ribbon: score.ribbon,
    breakdown: score.costBreakdown,
    drugCostByRxcui: {},
    appliedRules,
    brokerRuleAdjustment,
    isCsnp,
    csnpReservedSlot: score.csnpReservedSlot,
    medicationBackfill: score.medicationBackfill,
    realAnnualCost: realAnnual,
    redFlags,
    // No longer treats unverified-network plans as disqualified — Gate 1
    // passes Unknown with a flag, and QuoteDeliveryV4 filters on this
    // term to hide plans from the audit columns.
    disqualified: score.disqualifiedByRedFlag,
    whySwitchCopy: score.costBreakdown,
    annualUtilization: score.annualUtilization,
  };
}

function mapRealAnnualCost(c: AnnualCostEstimate): CompatRealAnnualCost {
  // Old shape splits drug + medical visits + supplies + ER + hospital
  // separately; new shape collapses ER/hospital probability into
  // erExpected/hospitalExpected and "medicalCost" into a single
  // pre-cap bucket. Map field-by-field:
  return {
    premium: Math.round(c.premium),
    drugs: Math.round(c.drugCost),
    medicalVisits: Math.round(c.medicalCost),
    supplies: Math.round(c.suppliesCost),
    erExpected: Math.round(c.erExpected),
    hospitalExpected: Math.round(c.hospitalExpected),
    givebackSavings: Math.round(c.partBGivebackSavings),
    medicalGross: Math.round(
      c.medicalCost + c.suppliesCost + c.erExpected + c.hospitalExpected,
    ),
    medicalCapped: Math.round(c.cappedMedicalBucket),
    cappedAtMoop:
      c.cappedMedicalBucket <
      c.medicalCost + c.suppliesCost + c.erExpected + c.hospitalExpected,
    netAnnual: Math.round(c.netAnnual),
  };
}

function adaptUtilization(u: AnnualUtilization): CompatUtilizationProfile {
  return {
    pcp: u.pcpVisits,
    specialist: u.specialistVisits,
    labs: u.labDraws,
    erProbability: u.erProbability,
    hospitalProbability: u.hospitalProbability,
    hospitalDays: u.hospitalDays,
    monthlySupplies: u.diabeticSuppliesMonths,
  };
}

function adaptPopulation(p: RankPopulation): Population {
  switch (p) {
    case 'csnp':
      return 'csnp';
    case 'dsnp':
    case 'dsnp-unsure':
      return 'dsnp';
    case 'standard':
    default:
      return 'mapd';
  }
}

function adaptDetectedConditions(
  list: BrainOutput['detectedConditions'],
): CompatDetectedCondition[] {
  return list.map((d) => {
    const key = d.condition as DetectedConditionKey;
    return {
      condition: key,
      confidence: d.confidence,
      triggerMeds: d.triggerMeds,
      brokerImplications: BROKER_IMPLICATIONS[key] ?? [],
    };
  });
}

const ARCHETYPE_LABEL: Record<string, { label: string; description: string }> = {
  specialty_drug: {
    label: 'Specialty drug user',
    description:
      'Tier-5 specialty drug economics dominate plan choice. MOOP and coinsurance % drive total cost.',
  },
  dual_eligible: {
    label: 'Dual eligible',
    description:
      'Medicare + Medicaid — D-SNP plans dominate. Extras (transportation, OTC, meals) are the tiebreaker.',
  },
  insulin_dependent: {
    label: 'Insulin-dependent',
    description:
      'IRA $35/mo insulin cap is mandatory; supplies coverage is the next biggest lever.',
  },
  complex_polypharmacy: {
    label: 'Polypharmacy (5+ meds)',
    description:
      'Drug coverage trumps everything else — one missing drug can flip the cheapest plan to the most expensive.',
  },
  multi_chronic: {
    label: 'Multiple chronic conditions',
    description:
      'MOOP is king — these patients WILL hit MOOP through hospitalization.',
  },
  single_chronic: {
    label: 'Single chronic condition',
    description:
      'Drug + OOP equally important. C-SNP if available — usually $0 copays on condition meds.',
  },
  provider_locked: {
    label: 'Provider-locked',
    description:
      'Multiple providers to keep — PPO or strong HMO network is required.',
  },
  healthy_newly_eligible: {
    label: 'Healthy / newly eligible',
    description:
      'Year-one extras dominate. Giveback, OTC, dental, vision, fitness.',
  },
  healthy_established: {
    label: 'Healthy / established',
    description:
      'Same shape as newly-eligible but with slightly more weight on OOP.',
  },
  general: {
    label: 'General Medicare beneficiary',
    description: 'Drug + OOP + extras balanced — no specific archetype detected.',
  },
};

function adaptArchetype(a: BrainOutput['archetype']): CompatArchetype {
  const meta = ARCHETYPE_LABEL[a] ?? ARCHETYPE_LABEL.general;
  return { archetype: a, label: meta.label, description: meta.description };
}

function adaptMedicationPatterns(
  list: BrainOutput['medicationPatterns'],
): CompatMedicationPattern[] {
  return list.map((p) => ({
    id: p.id,
    variant: p.variant,
    severity: 'low',
    summary: `${p.id.replace(/_/g, ' ')}: ${p.implication}`,
  }));
}

function adaptBrainOutput(
  brain: BrainOutput,
  agentPlanByTriple: Map<string, Plan>,
): PlanBrainResult {
  // brain.ranked is the FULL rawScored pool sorted by cost — it still
  // contains plans Gate 1 (provider OON / unverified) and Gate 2 (any
  // user drug not on formulary) eliminated. Mapping all of it into
  // `scored` is what surfaced plans with "0/1 doctors in-network" and
  // "Not available" drug costs as Top Pick. Match the consumer brain's
  // Results.tsx contract: iterate liveTop3.picks (the diversified
  // Gate-survivors in slot order — full_match → near_miss → C-SNP
  // reserved swap) and adapt only those. No backfill, no value
  // alternatives — if liveTop3 is null or has 2 picks, scored has 0
  // or 2 entries and CompareScreen renders that many.
  const scoredByKey = new Map<string, BrainScoredPlan>();
  for (const sp of brain.ranked) {
    scoredByKey.set(
      `${sp.row.contract_id}-${sp.row.plan_id}-${sp.row.segment_id}`,
      sp,
    );
  }
  const scored: ScoredPlan[] = [];
  let rank = 1;
  for (const pick of brain.liveTop3?.picks ?? []) {
    const key = `${pick.plan.row.contract_id}-${pick.plan.row.plan_id}-${pick.plan.row.segment_id}`;
    const sp = scoredByKey.get(key);
    if (!sp) continue;
    const adapted = adaptScored(sp, rank, agentPlanByTriple);
    if (adapted) {
      scored.push(adapted);
      rank += 1;
    }
  }

  // Pull weights from the archetype rule (the brain doesn't return its
  // resolved weights on BrainOutput today). When user passes a
  // weightsOverride, runPlanBrain uses that — fall through to it via
  // the args supplied by the hook caller (passed in separately below).
  const archetypeRule = ARCHETYPE_RULES[brain.archetype] ?? ARCHETYPE_RULES.general;
  const weights: WeightProfile = archetypeRule.weights;

  // Utilization profile — pull from the first scored plan (utilization
  // is patient-level, identical across plans within a single run).
  const firstAU = brain.ranked[0]?.score.annualUtilization;
  const utilizationProfile: CompatUtilizationProfile = firstAU
    ? adaptUtilization(firstAU)
    : { pcp: 2, specialist: 0, labs: 1, erProbability: 0.05, hospitalProbability: 0.02, hospitalDays: 3, monthlySupplies: 0 };

  // Map utilization category from PCP visit count (rough heuristic;
  // matches the old buckets — healthy ~2, moderate ~4, high 5+).
  const utilization: 'low' | 'moderate' | 'high' =
    utilizationProfile.pcp >= 5
      ? 'high'
      : utilizationProfile.pcp >= 4
        ? 'moderate'
        : 'low';

  return {
    population: adaptPopulation(brain.population),
    weights,
    utilization,
    utilizationProfile,
    scored,
    filteredOut: [],
    detectedConditions: adaptDetectedConditions(brain.detectedConditions),
    medicationPatterns: adaptMedicationPatterns(brain.medicationPatterns),
    archetype: adaptArchetype(brain.archetype),
    csnpNote: brain.csnpNote,
  };
}

// ─── The hook ────────────────────────────────────────────────────────

export function usePlanBrain(args: Args): State {
  const {
    plans,
    client,
    medications,
    providers,
    conditionProfile,
    userPriorities,
    weightOverride,
  } = args;

  const planIds = useMemo(() => plans.map((p) => p.id).sort().join(','), [plans]);
  const rxcuis = useMemo(
    () => medications.map((m) => m.rxcui).filter((x): x is string => !!x).sort().join(','),
    [medications],
  );

  // ── NPPES resolution for providers entered without an NPI ─────────
  // History: any provider lacking an NPI (CapturePanel-extracted, manual
  // typing, hydration with missing field) was silently dropped by the
  // `npis` filter below — Gate 1 ran with `userHasProviders=false` and
  // returned the whole pool unchanged, letting OON plans win on cost
  // alone. We now resolve the missing NPI via NPPES before the brain
  // run; unresolved providers surface as `unresolvedProviderNames` so
  // the UI can warn the user that network status is unknown.
  const [resolvedNpiById, setResolvedNpiById] = useState<Record<string, string>>({});
  const [unresolvedProviderNames, setUnresolvedProviderNames] = useState<string[]>([]);

  // Stable key for the resolution effect: any provider lacking an
  // intrinsic NPI gets keyed by id+name+state so re-renders don't
  // refire NPPES unless the unresolved set itself changes.
  const missingNpiKey = useMemo(() => {
    const missing = providers.filter((p) => !p.npi);
    return missing.map((p) => `${p.id}|${p.name}`).sort().join(',') + `|${client.state ?? ''}`;
  }, [providers, client.state]);

  useEffect(() => {
    const missing = providers.filter(
      (p) => !p.npi && !resolvedNpiById[p.id],
    );
    if (missing.length === 0) {
      // Recompute the unresolved-names list against current providers.
      const stillUnresolved = providers
        .filter((p) => !p.npi && !resolvedNpiById[p.id])
        .map((p) => p.name);
      setUnresolvedProviderNames((prev) =>
        prev.length === stillUnresolved.length &&
        prev.every((n, i) => n === stillUnresolved[i])
          ? prev
          : stillUnresolved,
      );
      return;
    }
    const controller = new AbortController();
    (async () => {
      const newlyResolved: Record<string, string> = {};
      const stillUnresolved: string[] = [];
      for (const p of missing) {
        try {
          const qs = new URLSearchParams({ name: p.name, limit: '1' });
          if (client.state) qs.set('state', client.state);
          const r = await fetch(`/api/npi-search?${qs.toString()}`, {
            signal: controller.signal,
          });
          if (!r.ok) {
            stillUnresolved.push(p.name);
            continue;
          }
          const body = (await r.json()) as { results?: Array<{ number?: string | number }> };
          const first = body.results?.[0]?.number;
          if (first != null) {
            newlyResolved[p.id] = String(first);
          } else {
            stillUnresolved.push(p.name);
          }
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') return;
          stillUnresolved.push(p.name);
        }
      }
      if (controller.signal.aborted) return;
      if (Object.keys(newlyResolved).length > 0) {
        setResolvedNpiById((prev) => ({ ...prev, ...newlyResolved }));
      }
      setUnresolvedProviderNames(stillUnresolved);
    })();
    return () => controller.abort();
    // missingNpiKey changes when the set of unresolved providers
    // changes; that's the only thing that should refire NPPES.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingNpiKey]);

  // Effective NPI list: union of intrinsic + NPPES-resolved.
  const npis = useMemo(
    () =>
      providers
        .map((p) => p.npi ?? resolvedNpiById[p.id])
        .filter((x): x is string => !!x)
        .sort()
        .join(','),
    [providers, resolvedNpiById],
  );

  const [data, setData] = useState<PlanBrainData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!planIds) {
      setData(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    void (async () => {
      // ── FHIR live fallback (best-effort, non-fatal) ─────────────────
      // /api/provider-network-status hits pm_provider_network_cache, then
      // falls back to the carrier FHIR endpoints (UHC / Humana / BCBS NC /
      // Devoted) for any (plan, npi) pair with no cache row, then upserts
      // resolved rows back into the cache. The downstream
      // /api/plan-brain-data read picks up the freshly-populated rows so
      // Gate 1 ranks confirmed in-network plans above plans still showing
      // "?" — which now means "no FHIR carrier could resolve it" not
      // "we never tried."
      //
      // Failures here are intentionally swallowed. The brain still runs
      // against whatever's in cache; Gate 1 passes Unknown (see
      // plan-brain.ts:applyProviderGate) so the user always sees plans,
      // just with the unverified badge.
      if (npis) {
        // /api/provider-network-status keys on the COMBINED plan_id
        // ("H5253-189"), not the triple ("H5253-189-0"). Collapse.
        const planIdsCombined = Array.from(
          new Set(
            planIds.split(',').map((id) => {
              const parts = id.split('-');
              return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : id;
            }),
          ),
        ).join(',');
        try {
          const fhirQs = new URLSearchParams({
            plan_ids: planIdsCombined,
            npis,
          });
          await fetch(`/api/provider-network-status?${fhirQs.toString()}`, {
            signal: controller.signal,
          });
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') return;
          console.warn('[plan-brain] FHIR fallback non-fatal failure:', err);
        }
      }
      if (controller.signal.aborted) return;

      // ── Cache read ─────────────────────────────────────────────────
      try {
        const qs = new URLSearchParams({ ids: planIds });
        if (rxcuis) qs.set('rxcuis', rxcuis);
        if (npis) qs.set('npis', npis);
        const res = await fetch(`/api/plan-brain-data?${qs.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`plan-brain-data ${res.status}`);
        const d = (await res.json()) as PlanBrainData;
        if (!controller.signal.aborted) setData(d);
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        // No silent degradation — empty `networkByPlan` would let every
        // OON plan compete on cost alone (Mode B in the brain-funnel
        // diagnostic). Surface the error and clear `data` so consumers
        // render a banner instead of a misleading ranking.
        setError((err as Error).message);
        setData(null);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [planIds, rxcuis, npis]);

  const ready = !loading && data !== null && plans.length > 0;

  // Build a lookup so adaptScored can resolve PmPlanRow → original Plan.
  const agentPlanByTriple = useMemo(() => {
    const m = new Map<string, Plan>();
    for (const p of plans) m.set(p.id, p);
    return m;
  }, [plans]);

  const result = useMemo<PlanBrainResult | null>(() => {
    if (!ready || !data) return null;
    // Build BrainInputs.
    const weightsOverride: BrainWeights | null =
      weightOverride && weightOverride.drug != null && weightOverride.oop != null && weightOverride.extras != null
        ? {
            drug: weightOverride.drug,
            oop: weightOverride.oop,
            extras: weightOverride.extras,
          }
        : null;
    // Substitute NPPES-resolved NPIs into providers without one so the
    // brain's Gate 1 actually runs against a populated NPI list.
    const effectiveProviders: Provider[] = providers.map((p) =>
      p.npi || !resolvedNpiById[p.id] ? p : { ...p, npi: resolvedNpiById[p.id] },
    );
    const brainInputs = adaptToBrainInputs({
      plans,
      client,
      medications,
      providers: effectiveProviders,
      data,
      conditionProfile,
      userPriorities,
      weightsOverride,
    });
    const out = runPlanBrain(brainInputs);
    const compat = adaptBrainOutput(out, agentPlanByTriple);
    // When the user supplied a weightsOverride, the brain ran with
    // those weights — surface them on the compat result so the UI's
    // weight readout reflects what actually scored.
    if (weightsOverride) compat.weights = weightsOverride;
    return compat;
  }, [
    ready,
    data,
    plans,
    client,
    medications,
    providers,
    resolvedNpiById,
    conditionProfile,
    userPriorities,
    weightOverride,
    agentPlanByTriple,
  ]);

  return { result, data, loading, error, ready, unresolvedProviderNames };
}
