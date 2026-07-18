// Plan Brain — type definitions.
//
// The Brain replaces the multi-axis-pick model in rankTop3Live with a
// composite-score model:
//   1. Filter plans by SNP population (D-SNP / C-SNP / standard MAPD)
//   2. Score each plan on three axes (drug cost / OOP / extras)
//   3. Combine via weighted sum into a composite score
//   4. Rank, then assign ribbons to highlight per-axis leaders
//
// Output stays compatible with the original LiveTop3 shape so the
// existing Results.tsx + Carrier Buildings consumers don't change.
// (The legacy rankTop3Live.ts module was removed; its surface types
// — RankPopulation, LiveTop3, LiveTop3Pick — now live in this file.)

import type {
  CsnpCondition,
  DsnpEligibility,
  TieredPriorityKey,
} from './brain-foreign-types';
import type { PmPlanRow } from './brain-foreign-types';
import type { PlanBenefitRow } from './brain-foreign-types';
import type { FormularyCoverage } from './brain-foreign-types';
import type { AnnualCostEstimate, AnnualUtilization } from './utilization-model';
import type {
  DualEligibleAdjustment,
  LisTier,
  LivingSetting,
  MedicaidLevel,
} from './dual-eligible';

/** Which ranking population the user falls into. Determines weight
 *  profile, ribbon labels, and SNP-type plan filtering. */
export type RankPopulation = 'standard' | 'dsnp' | 'dsnp-unsure' | 'csnp';

/** Top-3 pick category (display order). 'value' is emitted only by the
 *  diversified-Top-4 selector; the original brain produced just the
 *  first three. */
export type LiveTopCategory = 'best' | 'cheap' | 'extras' | 'value';
import type {
  ClientArchetype,
  MedicationPattern,
  RedFlagInstance,
} from './broker-playbook';

export type RibbonType =
  | 'BEST_OVERALL'
  | 'LOWEST_DRUG_COST'
  | 'LOWEST_OOP'
  | 'BEST_EXTRAS'
  | 'PART_B_SAVINGS'
  | 'ZERO_PREMIUM'
  | 'ALL_MEDS_COVERED'
  | 'ALL_DOCS_IN_NETWORK';

export type UtilizationProfile = 'low' | 'moderate' | 'high';

// Fixed annual visit counts per profile (from spec). Matches a
// healthy / typical / chronic Medicare-age beneficiary respectively.
export interface Utilization {
  pcp_visits: number;
  specialist_visits: number;
  lab_visits: number;
  imaging_visits: number;
  er_visits: number; // fractional — ER ~50% probability for moderate, ~100% for high
  inpatient_days: number;
}

export interface BrainWeights {
  drug: number;   // 0..1
  oop: number;    // 0..1
  extras: number; // 0..1 ; sum should == 1
}

/**
 * Per-gate, customer-facing micro-explainer strings carried on every
 * scored plan. Mirrors the consumer brain's GateExplanations 1:1
 * (packages/brain/src/plan-brain-types.ts) so the agent CompareScreen
 * renders the same per-provider / per-drug / per-priority pills the
 * consumer Results screen shows. Each gates 1–3 entry is one string per
 * user-supplied input (one per provider, one per drug, one per
 * priority); gate 4 is a single cost-rank summary line. Empty arrays
 * mean the gate didn't apply (e.g., user entered no providers →
 * gate1 = []).
 */
export interface GateExplanations {
  /** Provider gate, one entry per user-supplied provider. */
  gate1: ReadonlyArray<string>;
  /** Medication gate, one entry per user-supplied drug. */
  gate2: ReadonlyArray<string>;
  /** Extras / preferences gate, one entry per user-selected priority. */
  gate3: ReadonlyArray<string>;
  /** Cost-ranking summary — e.g. "Estimated annual cost: $2,340 (rank #1 of 38)". */
  gate4: string;
}

export interface BrainScore {
  drugCostScore: number;       // 0..100
  oopCostScore: number;        // 0..100
  extraBenefitsScore: number;  // 0..100
  composite: number;           // 0..100, weighted
  // Underlying raw figures (for the agent dashboard table)
  totalAnnualDrugCost: number;
  annualMedicalCost: number;   // sum of utilization × copay (capped at MOOP)
  totalOOPEstimate: number;    // medical + drug, minus Part B giveback
  extrasValueAnnual: number;   // sum of dollarized extras
  coveredCount: number;
  totalCount: number;
  lowTierCount: number;        // tier 1 or 2
  /** True when at least one user drug has covered=false AND
   *  confirmedUncovered=false (i.e., we have no evidence either way —
   *  no pm_drug_cost_cache row AND no formulary entry). Surfaced on
   *  LiveTop3PickPlan.drugCoverageUnknown so the UI can display
   *  "drug coverage estimated — confirm with your pharmacist". */
  drugCoverageUnknown: boolean;
  /** Count of user drugs that had zero coverage evidence (no
   *  formulary row, no cache hit) on EVERY plan in the pool — i.e.,
   *  almost certainly OTC / vitamin / discontinued. Gate 2 excludes
   *  these from the coverage check so a "Vitamin D3" entry alongside
   *  real Rx doesn't wipe out the pool. Same value for every plan in
   *  a single brain run. 0 when the user has no drugs, no drugs are
   *  pool-wide-unknown, or the pool itself is empty. */
  poolWideUncoveredDrugCount: number;
  // Provider integration — soft adjuster, not an axis
  allProvidersInNetwork: boolean;
  /** Count of user-listed providers confirmed in-network on this plan
   *  via pm_provider_network_cache. 0 when the user has no providers
   *  or the cache had no rows for any of them. Drives the cost-tie
   *  tiebreaker so plans with stronger network coverage win ties. */
  providersInNetworkCount: number;
  anyProviderOutOfNetwork: boolean;
  // Hard disqualifier: every provider the user entered is
  // out-of-network on this plan (or absent from the cache, which per
  // commit 540aece means out-of-network — pm_provider_network_cache
  // is the exhaustive scrape result for NC). Plans with this flag
  // are excluded from Top 3 selection unless the filter would empty
  // the list, in which case they fall back into the picks alongside
  // a UI warning. False when the user entered no providers.
  allProvidersOutOfNetwork: boolean;
  // ── Hard-filter / penalty signals ──────────────────────────────────
  // Distinct from anyProviderOutOfNetwork (which conflates "definitively
  // out" with "no row in cache"). These two split the signal so the
  // brain can apply a strict-HMO hard exclusion only on definitive
  // out-of-network reads, and surface "Network status unverified — call
  // to confirm" as a tradeoff-only flag when the cache has no row.
  // False when the user entered no providers.
  anyProviderDefinitivelyOut: boolean;
  anyProviderUnverified: boolean;
  // True when the user's *primary* provider (first entry in their
  // providers array) is confirmed in-network on this plan via the
  // per-NPI provider cache. False when there is no primary, no NPI,
  // or the cache says out-of-network. Drives the MOOP-penalty
  // override (see broker-rules: moop_penalty).
  primaryProviderInNetwork: boolean;
  // Supply coverage — how many of the user's picked condition
  // supplies (test_strips, cgm, etc.) are covered by this plan.
  // Drives the "Supplies: 2 of 3 ⚠" line on Top 3 cards and the
  // gap-aware Plan Detail supply section. coverage > 0 also boosts
  // the extras axis dollar value.
  suppliesCovered: number;
  suppliesTotal: number;
  suppliesGaps: ReadonlyArray<{
    key: string;
    humanLabel: string;
    reason: 'not_covered' | 'brand_mismatch';
  }>;
  // DEPRECATED (always false). Previously flagged Tier-B backfill
  // picks — plans that failed Gate 2 (missing user drugs) but were
  // pulled into the Top 4 to fill the count. After the strict-gates
  // rewrite, Gate 2 is a hard elimination: no medication backfill
  // ever fires. The field is retained for compat with the
  // usePlanBrain adapter + ScoredPlan shape (callers like
  // QuoteDeliveryV4 still read `medicationBackfill`).
  medicationBackfill: boolean;
  // True when this plan was force-inserted into the Top 4 by the
  // C-SNP reserved-slot pass — the user qualifies for a Chronic
  // Special Needs Plan (self-reported conditions or med-detected
  // diabetes/CHF/COPD/CKD/etc) but no C-SNP made the natural Top 4,
  // and this plan is the best C-SNP that passed Gates 1+2. The UI
  // can badge it "Recommended for your condition." False on every
  // C-SNP that landed in the Top 4 naturally on cost, and on every
  // standard MAPD.
  csnpReservedSlot: boolean;
  // Ribbon assignment (filled in by ribbon pass — null until then)
  ribbon: RibbonType | null;
  // Plain-English summary of the year on this plan, condition-aware
  // when a profile applies. Rendered as the quote callout on Top 3
  // cards and as a footer on Plan Detail. Empty string when there's
  // not enough data to write a useful sentence.
  costBreakdown: string;
  // Annual Part B giveback in dollars. Surfaced separately from the
  // medical cost line so Plan Detail can render it as a savings row.
  // 0 when the plan has no giveback benefit.
  partBGivebackAnnual: number;
  // Real annual cost — premium + drugs + medical + supplies + expected
  // ER + expected hospital − Part B giveback, with the medical bucket
  // capped at MOOP. Driven by the condition-aware utilization model
  // (utilization-model.ts) so a diabetic on Ozempic + Metformin sees a
  // realistic four-figure number on the card instead of just the
  // premium net of giveback. .netAnnual is the surface number; the
  // other fields let the cards render a "where this comes from" line.
  // Drives the OOP scoring axis (replaced totalOOPEstimate which
  // omitted ER/hospital risk and supplies).
  realAnnualCost: AnnualCostEstimate;
  // Combined utilization profile used for realAnnualCost on this plan.
  // Same shape across every plan in a single brain run (utilization is
  // patient-driven, not plan-driven) — stored per-plan only so the UI
  // can render "you'll see specialists 4 times this year" in card
  // detail without threading the profile through separately.
  annualUtilization: AnnualUtilization;
  // Broker-rule trail — every rule that fired on this plan, with its
  // human-readable reason + score adjustment. Empty when no rules
  // fired. The strongest rule's reason is used by ribbonWhyText so the
  // consumer card surfaces broker reasoning instead of generic copy.
  appliedBrokerRules: ReadonlyArray<{
    ruleId: string;
    ruleName: string;
    points: number;
    reason: string;
  }>;
  // Red-flag trail — every flag from broker-playbook.ts that fired
  // for this plan + this archetype. Penalize flags' points are
  // already folded into composite; warn/flag/disqualify are surface-
  // only here. UI can render these as warning chips on the plan card
  // and as the "watch out for" footer on Plan Detail.
  redFlags: ReadonlyArray<RedFlagInstance>;
  // True when at least one red flag with action='disqualify' fired.
  // The Top 3 selection filters these out the same way it filters
  // allProvidersOutOfNetwork — a hard exclusion that the user
  // shouldn't have to scroll past.
  disqualifiedByRedFlag: boolean;
  // Per-priority threshold check (one entry per user-selected
  // priority). Drives the ✓/✗ badge row on Top 3 cards. Empty when
  // the user picked no priorities.
  priorityChecks: ReadonlyArray<PriorityCheckResult>;
  // Broker-style tradeoff callouts triggered when the plan's picks
  // conflict (e.g. great giveback paired with a high MOOP). Empty
  // when no conflict was detected. Surface on the report card.
  tradeoffWarnings: ReadonlyArray<TradeoffWarning>;
  // Semantic dental tier — preventive (every plan has this; ~$50/yr
  // retail value), basic (fillings/extractions), or comprehensive
  // (crowns/dentures/implants with a real ≥$1,000 allowance). Computed
  // from the plan's dental benefit_description + filed allowance via
  // classifyPlanDentalTier — same call the Report Card uses so the
  // displayed tier always matches the tier the brain scored on. Drives
  // the Tier-1 -10 composite penalty when the user picked dental as a
  // priority and the curated-set ≥2-Tier-3 enforcement.
  dentalTier: 'preventive' | 'basic' | 'comprehensive';
  // ── Per-gate survivorship (Bench display) ──────────────────────
  // True when this plan was still in the pool after the named gate
  // ran. Populated by runPlanBrain after each gate phase. The
  // CompareScreen bench reads these so each eliminated plan card
  // carries its elimination reason ("Provider OON" / "Meds not
  // covered" / "Missing dental benefit") instead of just disappearing.
  gate1Passed: boolean;
  gate2Passed: boolean;
  gate3Passed: boolean;
  // ── Per-medication breakdown (Library + CompareScreen) ─────────
  // One entry per user-listed drug, in the same order the user
  // supplied them. Populated alongside the aggregate coveredCount /
  // totalAnnualDrugCost so the agent UI can render a per-med row on
  // each plan card: "Synthroid · Tier 1 · $3/mo · $36/yr". Mirrors
  // the consumer brain extension shipped in 65eec8c. Empty when the
  // user has no drugs.
  drugBreakdown: ReadonlyArray<{
    rxcui: string;
    name: string;
    covered: boolean;
    tier: number | null;
    monthlyCopay: number | null;
    annualCost: number;
    // Brand vs. generic — mirrors Medication.isBrand from session.
    // Enables Generic/Brand chips on cards and the LIS L3+ copay
    // override in dual-eligible.ts.
    isBrand: boolean;
  }>;
  /** Present ONLY when applyDualEligibleCostAdjustment ran (i.e.
   *  userProfile.medicaidLevel !== 'none' OR lisTier !== 'none').
   *  When present, realAnnualCost, annualMedicalCost,
   *  totalAnnualDrugCost, and drugBreakdown above are already
   *  ADJUSTED — the pre-adjustment snapshot lives on
   *  dualEligibleAdjustment.original for strikethrough rendering. */
  dualEligibleAdjustment?: DualEligibleAdjustment;
  // Per-gate customer-facing micro-explainer strings. One entry per
  // user-supplied provider / drug / priority for gates 1–3; a single
  // line for gate 4 (cost rank). Empty array when the user didn't
  // enter anything for that gate (no providers → gate1: []). Used by
  // CompareScreen's "Why this plan" expander. Mirrors consumer brain
  // (packages/brain/src/plan-brain-types.ts:265).
  explanations: GateExplanations;
}

/** Flattened plan shape consumed by the Results card UI. Created by
 *  brainToLiveTop3Pick — the brain synthesizes the flat fields from
 *  the underlying BrainScore so card-rendering code reads
 *  `pick.plan.drugsCovered` instead of `pick.plan.score.coveredCount`. */
export interface LiveTop3PickPlan {
  row: BrainScoredPlan['row'];
  benefits: BrainScoredPlan['benefits'];
  formulary: BrainScoredPlan['formulary'];
  drugsCovered: number;
  drugsCoveredLowTier: number;
  drugsTotal: number;
  drugsAllCovered: boolean;
  /** Mirror of BrainScore.drugCoverageUnknown — true when at least one
   *  user drug has no cache row AND isn't on the plan's formulary. UI
   *  reads this to render the "drug coverage estimated — confirm with
   *  your pharmacist" disclaimer on affected plans. */
  drugCoverageUnknown: boolean;
  estimatedAnnualDrugCost: number;
  totalAnnualCost: number;
  extrasValue: number;
  allProvidersInNetwork: boolean;
  suppliesCovered: number;
  suppliesTotal: number;
  /** Semantic dental tier — see BrainScore.dentalTier. Surfaced on the
   *  Report Card row label ("Comprehensive — $2,000/yr" vs the
   *  undifferentiated "Dental ✓"). */
  dentalTier: 'preventive' | 'basic' | 'comprehensive';
}

/** Top-3 pick wrapper consumed by Results.tsx + Carrier Buildings. */
export interface LiveTop3Pick {
  category: LiveTopCategory;
  plan: LiveTop3PickPlan;
  /** CMS-compliant scoped ribbon label (e.g. "STRONGEST MATCH IN DURHAM COUNTY"). */
  ribbon: string;
  /** One-line "why" string referencing the user's actual data. */
  why: string;
  /** Per-priority threshold check results — drives the ✓/✗ priority
   *  badges on each Results card. Empty when the user picked no
   *  priorities. Optional so older callers keep working. */
  priorityChecks?: ReadonlyArray<{
    priority: string;
    label: string;
    meets: boolean;
    partial: boolean;
  }>;
  /** Broker-style tradeoff callouts (giveback vs MOOP, dental vs MOOP,
   *  etc.). Empty when no conflict was detected. Surfaces in the
   *  report card "Bottom Line" section. */
  tradeoffWarnings?: ReadonlyArray<{ type: string; message: string }>;
}

/** Top-3 result envelope consumed by the UI. */
export interface LiveTop3 {
  /** Ordered: best, cheap, extras, (value). */
  picks: LiveTop3Pick[];
  /** "in Durham County" — appended after ribbon labels. */
  scopeLabel: string;
  /** Which ranking population the picks were chosen for. */
  population: RankPopulation;
  /** Plan count that survived the premium gate — shown in
   *  "View all N qualifying plans". */
  qualifyingPlanCount: number;
  /** True when the all-providers-out-of-network filter would have
   *  left fewer than 3 plans, forcing the brain to fall back to the
   *  unfiltered ranking. UI surfaces a "broaden your search" warning.
   *  Always false when the user entered no providers. */
  providerFilterFellBack?: boolean;
  /** True when the high-MOOP hard exclusion (any plan with MOOP
   *  > $6,500 is dropped from the Top 4) would have left fewer than
   *  4 candidates, forcing the brain to fold those high-exposure
   *  plans back in to fill the slate. Always false when at least 4
   *  qualifying plans sit at or below $6,500 MOOP — the normal path. */
  highMoopFilterFellBack?: boolean;
  /** How far the priority gates were relaxed to produce 3 picks.
   *  'strict'   — every priority threshold honored (the happy path)
   *  'half'     — tiered thresholds halved to expand the pool
   *  'any'      — tiered thresholds dropped, "has the benefit" only
   *  'disabled' — gates dropped entirely; UI shows a warning banner.
   *  Undefined when no priority gates were active. */
  priorityGateRelaxation?: 'strict' | 'half' | 'any' | 'disabled';
}

export interface BrainScoredPlan {
  row: PmPlanRow;
  benefits: PlanBenefitRow[];
  formulary: Map<string, FormularyCoverage>;
  score: BrainScore;
}

// Tradeoff warnings — broker-style "you asked for X but this plan
// trades Y" callouts surfaced on Top 3 cards + the report card's
// "Bottom Line" section. Generated AFTER threshold scoring so the
// detection sees the user's actual picks vs the plan's actual numbers.
export interface TradeoffWarning {
  /** Stable id for analytics + UI keying. */
  type:
    | 'giveback_vs_moop'
    | 'dental_vs_moop'
    | 'extras_vs_premium'
    | 'provider_out_of_network'
    | 'provider_network_unverified';
  /** Customer-facing copy. Includes plan-specific dollar amounts. */
  message: string;
}

// Per-priority threshold check result, surfaced on Results cards as
// ✓/✗ badges. One entry per priority the user selected.
export interface PriorityCheckResult {
  /** PriorityKey that the user picked (e.g. 'dental', 'low_moop'). */
  priority: string;
  /** Customer-facing label, e.g. 'Dental $1,500 (meets your $1,000+ pick)'. */
  label: string;
  /** True when the plan met the user's threshold (or the toggle was on). */
  meets: boolean;
  /** True when the plan has the benefit but below the threshold. */
  partial: boolean;
}

// User profile for SNP detection + utilization derivation.
export interface UserProfile {
  drugs: ReadonlyArray<{
    rxcui?: string;
    name: string;
    dose?: string;
    /** Brand vs. generic flag from pm_drugs.is_brand (via drug-search).
     *  Consumed by the LIS override in dual-eligible.ts to pick the
     *  correct generic vs. brand copay cap. Defaults to false when
     *  omitted — LIS generic copay is lower so undercharging is the
     *  safer failure mode. */
    isBrand?: boolean;
  }>;
  /** Medicaid category. Drives medical cost-sharing zeroing (QMB or
   *  FBDE) and Part C premium payment (QMB+ on D-SNP). Defaults to
   *  'none' when omitted. Orthogonal to dsnpEligible — a QMB
   *  beneficiary can be enrolled in a non-D-SNP MAPD. */
  medicaidLevel?: MedicaidLevel;
  /** LIS (Extra Help) copay tier. Usually derived by intake via
   *  deemLisTier(medicaidLevel, livingSetting) but can be set
   *  explicitly for beneficiaries who applied for LIS directly
   *  without Medicaid. Defaults to 'none' when omitted. */
  lisTier?: LisTier;
  /** Living setting — only affects LIS tier for FBDE (community →
   *  full_low, institutional/HCBS → full_institutional). Defaults
   *  to 'community' when omitted. */
  livingSetting?: LivingSetting;
  providers: ReadonlyArray<{ npi?: string; name: string }>;
  priorities: ReadonlySet<string>;     // user-selected extras preferences
  /** Per-tiered-priority dollar threshold (dental/vision/otc/giveback). */
  priorityThresholds?: Partial<Record<TieredPriorityKey, number>>;
  dsnpEligible?: DsnpEligibility;
  csnpConditions?: ReadonlyArray<CsnpCondition>;
  // User-selected condition supplies (test_strips, cgm, home_oxygen,
  // bp_monitor, etc.). Empty when no condition has supplies or the
  // user picked "None of these". Brain matches each key against the
  // dominant condition profile's supplies[] array.
  conditionSupplies?: ReadonlyArray<string>;
  // Inferred age band — currently just used for utilization profile
  // when explicit age isn't on file. Future: drive Brain weights.
  ageBand?: 'under65' | '65to74' | '75to84' | '85plus';
  // Numeric age (computed from FlowState.dob upstream via ageFromDob).
  // Drives age-gated broker rules (R8 newly_eligible_extras requires
  // exactly 65; future age-band rules will key off this). null when
  // the DOB hasn't been entered yet.
  age?: number | null;
  /**
   * True when the user is a veteran with VA / TRICARE prescription
   * drug coverage. When true, MA-only plans (no Part D) are valid
   * candidates — the user already has creditable drug coverage so
   * they avoid the Part D late-enrollment penalty. When false (every
   * other Medicare beneficiary), MA-only plans are filtered out of
   * the eligible pool. Defaults to false at the brain layer when
   * unspecified.
   */
  hasVaDrugCoverage?: boolean;
}

// Optional per-plan drug cost cache (plan_id+segment_id → ndc → row).
// When provided, Brain uses estimated_yearly_total from the cache for
// the user's drugs. When absent, falls back to formulary tier × an
// approximate annual cost. The shape matches a future hook that
// loads pm_drug_cost_cache in bulk for the candidate plan list.
export interface DrugCostCacheEntry {
  ndc: string;
  tier: number | null;
  full_cost: number | null;
  estimated_yearly_total: number | null;
  covered: boolean;
}

// Optional rxcui→NDC bridge so the Brain can join user drugs to the
// cost cache. Comes from pm_drug_ndc.
export interface RxcuiNdcMap {
  rxcui: string;
  ndc: string;
}

// Optional provider network cache hit (plan_id → npi → covered).
export interface ProviderNetworkCacheEntry {
  npi: string;
  covered: boolean;
}

export interface BrainInputs {
  plans: readonly PmPlanRow[];
  benefitsByPlanKey: Map<string, PlanBenefitRow[]>;       // `${contract_id}-${plan_id}-${segment_id}`
  formularyByPlanKey: Map<string, Map<string, FormularyCoverage>>; // `${contract_id}-${plan_id}` (no segment)
  userProfile: UserProfile;
  county: string | null;
  // Optional: when provided, cost axis uses cache; when absent, falls
  // back to a tier-based heuristic.
  drugCostCacheByPlanKey?: Map<string, Map<string, DrugCostCacheEntry>>;
  rxcuiToNdc?: Map<string, string>;
  // Optional: per-plan provider coverage, keyed on
  // `${contract_id}-${plan_id}` (no segment, mirrors formulary keying).
  providerNetworkByPlanKey?: Map<string, Map<string, ProviderNetworkCacheEntry>>;
  // Pre-computed Set of contract_ids whose verified provider list is
  // 100% in-network. Comes from session-level provider_verifications
  // joined by contract — Brain trusts this when the per-plan
  // providerNetworkByPlanKey isn't provided.
  verifiedInNetworkContracts?: ReadonlySet<string>;
  /**
   * Set of `${contract_id}-${plan_id}` keys for plans that have ≥1 row
   * in pm_formulary — i.e. plans with Part D (MAPD) coverage. When
   * provided, the brain treats plans NOT in this set as MA-only and
   * filters them out of the eligible pool unless the user has VA /
   * TRICARE drug coverage (UserProfile.hasVaDrugCoverage). Without
   * this signal, MA-only plans look like normal MAPDs to the brain
   * because pm_plans.plan_type doesn't carry the distinction. When
   * omitted, no MA-only filtering happens (legacy behavior).
   */
  mapdContractPlanIds?: ReadonlySet<string>;
  // Weight overrides — agent dashboard will eventually wire sliders.
  weightsOverride?: BrainWeights;
  /** Enrollment period the beneficiary is using. When provided, the brain
   *  attaches it to the output for compliance documentation and sets the
   *  enrollmentGated flag when enrollment is not currently permitted. */
  enrollmentPeriod?: 'IEP' | 'ICEP' | 'SEP' | 'OEP' | 'AEP';
  /** CMS SEP reason code (auto-derived from life event selection upstream).
   *  Only meaningful when enrollmentPeriod === 'SEP'. */
  sepReasonCode?: string;
}

export interface BrainOutput {
  population: RankPopulation;
  // Composite-sorted full list. Top 3 = ranked[0..2].
  ranked: BrainScoredPlan[];
  // Backward-compat with the existing UI that consumes LiveTop3.
  // Same picks[] order = composite descending.
  liveTop3: LiveTop3 | null;
  // True when the user looks "healthy" — fewer than 3 meds, no
  // chronic condition, no SNP eligibility. Drives:
  //   - WEIGHTS_HEALTHY (40/20/40) instead of WEIGHTS_STANDARD
  //   - composite-score boost for plans with a Part B giveback so
  //     a giveback plan reliably surfaces in Top 3
  //   - Margaret-mode "your biggest savings is the giveback" copy
  //     on Plan Detail
  isHealthyClient: boolean;
  // Cheapest plan that still covers every medication on the user's list,
  // provider network ignored. Drives the "Budget Option" column on the
  // Compare + SideBySide screens. When no plan covers every drug, falls
  // back to the plan with the highest coveredCount (then cheapest among
  // those) so users with a hard-to-cover drug still see a #-meds-cheap
  // option. null only when the candidate pool is empty.
  budgetOption: BrainScoredPlan | null;
  // Med-derived condition detections — the broker-instinct layer.
  // UNION with userProfile.csnpConditions feeds the broker rules and
  // (eventually) Plan Detail "your X care" copy. Empty when the user
  // entered no medications or none matched a rule.
  detectedConditions: ReadonlyArray<{
    condition: string;
    confidence: 'certain' | 'likely' | 'possible';
    triggerMeds: ReadonlyArray<string>;
  }>;
  // Single-label classification of WHO this user is (healthy newly-
  // eligible / single chronic / multi chronic / insulin-dependent /
  // specialty drug / provider locked / general). Drives the brain's
  // weight selection upstream of scoring and the red-flag families
  // that get evaluated per plan.
  archetype: ClientArchetype;
  // Pattern-detection layer over the medication list — what a broker
  // spots instantly (Metformin + Ozempic = "diabetes escalation",
  // Entresto = "confirmed CHF, hospital risk dominant"). Surfaced in
  // the agent dashboard and console diagnostics; the Report Card
  // copy reads them when generating archetype-aware narratives.
  medicationPatterns: ReadonlyArray<MedicationPattern>;
  // C-SNP reserved-slot status. Three states:
  //   • null   — user did not qualify (no conditions, no med signal),
  //              reservation logic did not run.
  //   • ''     — empty/no note (C-SNP either landed naturally OR was
  //              force-inserted via reserved slot; check
  //              score.csnpReservedSlot on each pick to tell which).
  //   • <msg>  — user qualified, but no C-SNP passed Gates 1+2 in this
  //              county, so the Top 4 contains zero C-SNPs. Surfaced
  //              on the UI as a context note.
  csnpNote: string | null;
  /** True when the beneficiary's enrollment period does NOT permit
   *  enrollment right now. The UI should block enrollment CTAs and
   *  show "window shopping" messaging. False or undefined means
   *  enrollment is permitted (or enrollment period wasn't provided). */
  enrollmentGated?: boolean;
  /** Human-readable enrollment period context for compliance display. */
  enrollmentPeriodLabel?: string;
}
