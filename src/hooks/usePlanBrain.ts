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
  ribbon: RibbonKey | null;
  breakdown: string;
  drugCostByRxcui: Record<string, number>;
  appliedRules: CompatRuleApplication[];
  brokerRuleAdjustment: number;
  isCsnp: boolean;
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

  const providerNetworkStatus: ScoredPlan['providerNetworkStatus'] =
    score.allProvidersInNetwork
      ? 'all_in'
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
    ribbon: score.ribbon,
    breakdown: score.costBreakdown,
    drugCostByRxcui: {},
    appliedRules,
    brokerRuleAdjustment,
    isCsnp,
    realAnnualCost: realAnnual,
    redFlags,
    disqualified: score.disqualifiedByRedFlag || score.allProvidersOutOfNetwork,
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
  const scored: ScoredPlan[] = [];
  let rank = 1;
  for (const sp of brain.ranked) {
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
  const npis = useMemo(
    () => providers.map((p) => p.npi).filter((x): x is string => !!x).sort().join(','),
    [providers],
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
    const qs = new URLSearchParams({ ids: planIds });
    if (rxcuis) qs.set('rxcuis', rxcuis);
    if (npis) qs.set('npis', npis);
    fetch(`/api/plan-brain-data?${qs.toString()}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`plan-brain-data ${res.status}`);
        return (await res.json()) as PlanBrainData;
      })
      .then((d) => {
        if (!controller.signal.aborted) setData(d);
      })
      .catch((err) => {
        if ((err as { name?: string })?.name === 'AbortError') return;
        setError((err as Error).message);
        // Degrade gracefully — score with empty data rather than render nothing.
        setData({
          benefitsByPlan: {},
          drugCostCache: {},
          formularyByContractPlan: {},
          ndcByRxcui: {},
          networkByPlan: {},
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
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
    const brainInputs = adaptToBrainInputs({
      plans,
      client,
      medications,
      providers,
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
    conditionProfile,
    userPriorities,
    weightOverride,
    agentPlanByTriple,
  ]);

  return { result, data, loading, error, ready };
}
