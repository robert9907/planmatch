// useBenchFilters — filter / sort / audit engine for the Compare bench.
//
// Replaces the single-axis chip row (`All | HMO | PPO | $0 | D-SNP | C-SNP | VA`)
// in CompareScreen's Bench with a compound multi-select bar:
//   • Plan Type (MA / MAPD)        OR within dimension
//   • Network (HMO / PPO / …)      OR
//   • SNP (D-SNP / C-SNP / I-SNP / VA)  OR
//   • Carrier                      OR
//   • Cost & Quality predicates    AND within dimension (every box must pass)
//   • Search (carrier / plan_name / contract / PBP)  OR
// Cross-dimension is always AND.
//
// Each Plan is normalized once into a NormalizedPlan with stable
// machine-readable fields the predicates can read directly. The
// original Plan is preserved as `_raw` so existing card rendering
// (BenchCard, ribbon, gate results) stays untouched.

import { useCallback, useMemo, useState } from 'react';
import type { Plan } from '@/types/plans';

// ── Network shape lookup ───────────────────────────────────────────
// pm_plans.plan_shape carries the raw landscape plan_type string. The
// brain's plan_type column is the app-level bucket (MA / MAPD / DSNP /
// CSNP / ...) and never holds the network shape, so plan_shape is the
// only source of truth for HMO vs PPO partitioning. Anything not in
// this map falls back to a plan_name regex; anything that still misses
// becomes 'OTHER' and the audit flags it so the broker doesn't silently
// lose plans behind the Network dropdown.
const PLAN_SHAPE_TO_NETWORK: Record<string, string> = {
  HMO: 'HMO',
  'Local PPO': 'PPO',
  'Regional PPO': 'RPPO',
  HMOPOS: 'HMO-POS',
  PFFS: 'PFFS',
  MSA: 'MSA',
  Cost: 'Cost',
  PDP: 'PDP',
};

const NETWORK_LABELS: Record<string, string> = {
  HMO: 'HMO',
  PPO: 'PPO',
  RPPO: 'Regional PPO',
  'HMO-POS': 'HMO-POS',
  PFFS: 'PFFS',
  MSA: 'MSA',
  Cost: 'Cost',
  PDP: 'PDP',
  OTHER: 'Other',
};

function inferNetwork(plan: Plan): string {
  const shape = plan.plan_shape;
  if (shape && PLAN_SHAPE_TO_NETWORK[shape]) {
    return PLAN_SHAPE_TO_NETWORK[shape];
  }
  // Fallback — plan_shape is null for older seed rows / static fallback
  // plans. Sniff the plan name; landscape rows put the network shape in
  // the marketing name ("Humana Choice PPO H5216-179", "Aetna Medicare
  // Eagle HMO H8649-013").
  const name = (plan.plan_name ?? '').toUpperCase();
  if (/\bHMO[-\s]POS\b/.test(name)) return 'HMO-POS';
  if (/\bRPPO\b|REGIONAL\s+PPO/.test(name)) return 'RPPO';
  if (/\bPPO\b/.test(name)) return 'PPO';
  if (/\bHMO\b/.test(name)) return 'HMO';
  if (/\bPFFS\b/.test(name)) return 'PFFS';
  if (/\bMSA\b/.test(name)) return 'MSA';
  if (/\bPDP\b/.test(name)) return 'PDP';
  return 'OTHER';
}

// ── Cost & Quality predicates ─────────────────────────────────────
// Each predicate evaluates a single positive criterion ("plan beats
// threshold X on metric Y"). They AND within the dimension — selecting
// both "$0 Premium" and "4+ Stars" yields plans meeting both, which is
// the right default for predicate-style filtering.
export interface CostQualityDef {
  key: string;
  label: string;
  predicate: (p: NormalizedPlan) => boolean;
  /** Hide this predicate from the dropdown when false (e.g., docs-in-net
   *  is meaningless when the broker didn't enter any providers). */
  show?: boolean;
}

function buildCostQualityDefs(selectedProviderCount: number): CostQualityDef[] {
  return [
    { key: 'zero_premium', label: '$0 Premium', predicate: (p) => p.consumerPremium === 0 },
    {
      key: 'zero_drug_ded',
      label: '$0 Drug Deductible',
      predicate: (p) => p.drugDeductible === 0,
    },
    {
      key: 'moop_under_5k',
      label: 'MOOP < $5,000',
      predicate: (p) => p.moopInNetwork < 5000,
    },
    { key: 'four_plus_stars', label: '4+ Stars', predicate: (p) => p.starRating >= 4 },
    {
      key: 'has_food_card',
      label: 'Has Food Card',
      predicate: (p) => p.foodCardMonthly > 0,
    },
    {
      key: 'has_docs_in_net',
      label: 'Has Docs In-Net',
      predicate: (p) => p.inNetworkNpiCount > 0,
      show: selectedProviderCount > 0,
    },
    {
      key: 'part_b_giveback',
      label: 'Part B Giveback',
      predicate: (p) => p.partBGiveback > 0,
    },
    {
      key: 'comprehensive_dental',
      label: 'Comprehensive Dental',
      predicate: (p) => p.dentalComprehensive,
    },
    {
      key: 'has_drug_coverage',
      label: 'Has Drug Coverage',
      predicate: (p) => p.hasDrugCoverage,
    },
    // Landscape's zero-dollar cost-sharing D-SNP flag — the sub-slice
    // of D-SNPs where QMB+ / full-benefit duals pay nothing at POS.
    // Only surfaces when at least one bench plan qualifies (avoids a
    // permanently 0-count checkbox for non-SNP counties).
    {
      key: 'zero_cost_sharing',
      label: 'Zero-Cost Sharing',
      predicate: (p) => p.zeroCostSharing,
    },
    // CMS-SNP-report accepted-populations predicates. All read the
    // dsnpAcceptedPopulations array populated by migration 015. Non-
    // D-SNP plans have a null array and therefore fail every check
    // — which is what we want, since these predicates only make
    // sense for D-SNPs.
    //
    // "Accepts QMB / SLMB" match on either the plus or standalone
    // variant so brokers looking at partial-dual clients get the
    // full set. "Full-Benefit Only" is exact-match on the three-
    // element array; "Accepts Partial Duals" mirrors the Partial
    // Dual = Yes filing.
    // The four accepted-population predicates below are hidden from
    // the Cost & Quality dropdown (show: false) and instead auto-
    // activated from client.medicaidLevel in CompareScreen's
    // initialFilterState. They still function as normal filters when
    // present in state.costQuality — the auto-populated chip stays
    // dismissible via the standard activeChips row.
    {
      key: 'accepts_qmb',
      label: 'Accepts QMB',
      predicate: (p) =>
        (p.dsnpAcceptedPopulations ?? []).some((v) => v === 'QMB' || v === 'QMB+'),
      show: false,
    },
    {
      key: 'accepts_slmb',
      label: 'Accepts SLMB',
      predicate: (p) =>
        (p.dsnpAcceptedPopulations ?? []).some((v) => v === 'SLMB' || v === 'SLMB+'),
      show: false,
    },
    {
      key: 'full_benefit_only',
      label: 'Full-Benefit Duals Only',
      predicate: (p) => {
        const pops = p.dsnpAcceptedPopulations;
        if (!pops || pops.length === 0) return false;
        // CMS files this as Partial Dual = No; ingest expands to the
        // exact three-element set. Compare-as-set instead of exact-
        // order so a future CMS ordering change doesn't break the
        // predicate silently.
        const set = new Set(pops);
        return set.size === 3 && set.has('FBDE') && set.has('QMB+') && set.has('SLMB+');
      },
      show: false,
    },
    {
      key: 'accepts_partial_duals',
      label: 'Accepts Partial Duals',
      predicate: (p) =>
        (p.dsnpAcceptedPopulations ?? []).some(
          (v) => v === 'QMB' || v === 'SLMB' || v === 'QI',
        ),
      show: false,
    },
    // Bonus signal from the same SNP report: the plan's contract is
    // exclusively D-SNP (no mixed MA/D-SNP under the same contract).
    // Steer members to carriers built ground-up for dual populations.
    {
      key: 'dsnp_only_contract',
      label: 'D-SNP-Only Contract',
      predicate: (p) => p.dsnpOnlyContract === true,
    },
  ];
}

// ── Sort options ──────────────────────────────────────────────────
export type SortKey =
  | 'cost_asc'
  | 'premium_asc'
  | 'premium_desc'
  | 'moop_asc'
  | 'stars_desc'
  | 'docs_in_net_desc'
  | 'drug_ded_asc'
  | 'carrier_asc';

export const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'cost_asc', label: 'Est. Annual Cost ↑' },
  { value: 'premium_asc', label: 'Premium Low → High' },
  { value: 'premium_desc', label: 'Premium High → Low' },
  { value: 'moop_asc', label: 'MOOP Low → High' },
  { value: 'stars_desc', label: 'Stars High → Low' },
  { value: 'docs_in_net_desc', label: 'Docs In-Net Most' },
  { value: 'drug_ded_asc', label: 'Drug Deductible Low → High' },
  { value: 'carrier_asc', label: 'Carrier A → Z' },
];

// ── Normalized plan ───────────────────────────────────────────────
export interface NormalizedPlan {
  id: string;
  contractId: string;
  planNumber: string;
  carrier: string;
  planName: string;
  planType: 'MA' | 'MAPD';
  network: string;
  snpType: string | null; // 'D-SNP' | 'C-SNP' | 'I-SNP' | null
  /** Landscape D-SNP integration status ('FIDE' | 'HIDE' |
   *  'Coordination Only' | 'AIP'). Null unless snpType === 'D-SNP'. */
  dsnpIntegration: string | null;
  /** Landscape "Medicare Zero-Dollar Cost Sharing D-SNP Plan" flag.
   *  Sub-slice of D-SNPs where QMB+ / full-benefit duals pay nothing.
   *  Surfaces as its own Cost & Quality predicate. */
  zeroCostSharing: boolean;
  /** Landscape C-SNP condition type — CMS's CamelCase / comma-separated
   *  raw string (e.g. "CardiovascularDisorders,DiabetesMellitus").
   *  Kept raw so filter equality holds; humanizeCsnpCondition() below
   *  is responsible for the display label. */
  csnpCondition: string | null;
  /** CMS SNP Comprehensive Report accepted-populations set. Non-null
   *  only on D-SNPs. Either ['FBDE','QMB+','SLMB+'] (full-benefit
   *  only) or ['FBDE','QMB+','QMB','SLMB+','SLMB','QI'] (accepts every
   *  subgroup). Predicates below read this. */
  dsnpAcceptedPopulations: string[] | null;
  /** True when the plan's CMS contract is D-SNP-only. */
  dsnpOnlyContract: boolean | null;
  isVa: boolean; // MA-only (no Part D bundled)
  consumerPremium: number;
  premium: number;
  annualDeductible: number;
  drugDeductible: number;
  moopInNetwork: number;
  starRating: number;
  partBGiveback: number;
  hasDrugCoverage: boolean;
  foodCardMonthly: number;
  dentalComprehensive: boolean;
  inNetworkNpiCount: number;
  /** consumer_premium * 12 + brain-scored annual drug cost. Null when
   *  the brain didn't score this plan (no drug entry in the map). */
  annualCostEstimate: number | null;
  _raw: Plan;
}

function normalizeAnnualDrugMap(
  map: Map<string, number | null> | Record<string, number | null>,
): Map<string, number | null> {
  if (map instanceof Map) return map;
  return new Map(Object.entries(map));
}

function normalizePlan(
  plan: Plan,
  annualDrug: Map<string, number | null>,
): NormalizedPlan {
  const consumerPremium = plan.consumer_premium ?? plan.premium ?? 0;
  const drugCost = annualDrug.get(plan.id);
  const annualCostEstimate =
    drugCost != null ? consumerPremium * 12 + drugCost : null;

  return {
    id: plan.id,
    contractId: plan.contract_id ?? '',
    planNumber: plan.plan_number ?? '',
    carrier: plan.carrier || 'Unknown',
    planName: plan.plan_name ?? '',
    planType: plan.has_drug_coverage ? 'MAPD' : 'MA',
    network: inferNetwork(plan),
    snpType: plan.snp_type ?? null,
    dsnpIntegration: plan.dsnp_integration_status || null,
    zeroCostSharing: Boolean(plan.zero_cost_sharing),
    csnpCondition: plan.csnp_condition_type || null,
    dsnpAcceptedPopulations: plan.dsnp_accepted_populations ?? null,
    dsnpOnlyContract: plan.dsnp_only_contract ?? null,
    isVa: !plan.has_drug_coverage,
    consumerPremium,
    premium: plan.premium ?? 0,
    annualDeductible: plan.annual_deductible ?? 0,
    drugDeductible: plan.drug_deductible ?? 0,
    moopInNetwork: plan.moop_in_network ?? 0,
    starRating: plan.star_rating ?? 0,
    partBGiveback: plan.part_b_giveback ?? 0,
    hasDrugCoverage: plan.has_drug_coverage === true,
    foodCardMonthly: plan.benefits?.food_card?.allowance_per_month ?? 0,
    dentalComprehensive: plan.benefits?.dental?.comprehensive === true,
    inNetworkNpiCount: plan.in_network_npis?.length ?? 0,
    annualCostEstimate,
    _raw: plan,
  };
}

// ── Filter state ──────────────────────────────────────────────────
export interface BenchFilterState {
  planType: string[]; // MA / MAPD
  network: string[];
  snp: string[]; // 'D-SNP' | 'C-SNP' | 'I-SNP' | 'VA'
  carrier: string[];
  costQuality: string[]; // CostQualityDef.key list
  search: string;
  sort: SortKey;
}

const EMPTY_STATE: BenchFilterState = {
  planType: [],
  network: [],
  snp: [],
  carrier: [],
  costQuality: [],
  search: '',
  sort: 'cost_asc',
};

export interface BenchFilterSetters {
  setPlanType: (next: string[]) => void;
  setNetwork: (next: string[]) => void;
  setSnp: (next: string[]) => void;
  setCarrier: (next: string[]) => void;
  setCostQuality: (next: string[]) => void;
  setSearch: (next: string) => void;
  setSort: (next: SortKey) => void;
}

export interface FilterOption {
  value: string;
  label: string;
  count: number;
}

export interface FilterOptions {
  planType: FilterOption[];
  network: FilterOption[];
  snp: FilterOption[];
  carrier: FilterOption[];
  costQuality: FilterOption[];
}

export interface ActiveChip {
  id: string;
  label: string;
  onRemove: () => void;
}

export interface AuditIssue {
  planId: string;
  issue:
    | 'unknown_network'
    | 'unknown_carrier'
    | 'missing_plan_type'
    | 'missing_dsnp_integration'
    | 'missing_csnp_condition'
    | 'missing_dsnp_populations';
  detail: string;
}

export interface AuditResult {
  pass: boolean;
  issues: AuditIssue[];
  report: string;
}

export interface UseBenchFiltersOptions {
  annualDrugByPlanId:
    | Map<string, number | null>
    | Record<string, number | null>;
  selectedProviderCount: number;
  /** Optional partial seed for the filter state on first render. The
   *  CompareScreen shell derives this from intake data (dsnpEligible →
   *  ['D-SNP'] on snp; providers.length > 0 → ['has_docs_in_net']; etc.)
   *  so the agent lands on Compare with the bench already narrowed to
   *  plans that match the client's situation. Only reads on mount — the
   *  agent's later toggles win and aren't reverted when this prop
   *  changes. Missing keys fall back to EMPTY_STATE values. */
  initialState?: Partial<BenchFilterState>;
}

export interface UseBenchFiltersResult {
  filtered: NormalizedPlan[];
  totalCount: number;
  filterState: BenchFilterState;
  setters: BenchFilterSetters;
  filterOptions: FilterOptions;
  activeFilterCount: number;
  activeChips: ActiveChip[];
  clearAll: () => void;
  audit: () => AuditResult;
}

const PLAN_TYPE_LABELS: Record<string, string> = {
  MA: 'MA (Medical only)',
  MAPD: 'MAPD (Medical + Rx)',
};

// Top-level SNP bucket labels. Sub-filter labels (FIDE / HIDE /
// Coordination Only / a humanized C-SNP condition) are computed
// dynamically inside the filterOptions memo below because their set
// depends on which values Landscape files for the plans in the bench.
const SNP_LABELS: Record<string, string> = {
  'D-SNP': 'D-SNP (dual-eligible)',
  'C-SNP': 'C-SNP (chronic)',
  'I-SNP': 'I-SNP (institutional)',
  VA: 'VA / MA-only',
};

// ── SNP filter value encoding ─────────────────────────────────────
// The SNP dropdown mixes top-level buckets (D-SNP, C-SNP, I-SNP, VA)
// with per-plan sub-filters (D-SNP:FIDE, C-SNP:Diabetes, ...). We
// encode both as strings in the same array to reuse FilterDropdown's
// multi-select shape.
//
//   Top-level:  "D-SNP"
//   Sub-filter: "D-SNP:FIDE"                          (integration status)
//               "C-SNP:CardiovascularDisorders,DiabetesMellitus"
//                                                     (raw condition string)
//
// Selecting a top-level bucket matches every plan in that bucket
// (superset semantics). Selecting a sub-filter matches only plans
// whose Landscape field equals the sub value. If both are selected,
// the top-level's OR-in-dimension semantics still catch every plan.
const SNP_SUB_SEP = ':';

function parseSnpFilter(value: string): { top: string; sub: string | null } {
  const idx = value.indexOf(SNP_SUB_SEP);
  if (idx < 0) return { top: value, sub: null };
  return { top: value.slice(0, idx), sub: value.slice(idx + 1) };
}

// CMS files C-SNP condition types as CamelCase, comma-joined for multi-
// condition plans ("CardiovascularDisorders,DiabetesMellitus"). Split
// on the comma and pull the CamelCase apart so the dropdown shows
// "Cardiovascular Disorders, Diabetes Mellitus" — actionable when
// scanning a long list. Known shorthands ("HIV_AIDS") get their own
// entry; anything unknown falls back to the naive CamelCase split.
const CSNP_CONDITION_LABEL: Record<string, string> = {
  HIV_AIDS: 'HIV / AIDS',
  ESRD: 'ESRD',
};

function splitCamelCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

export function humanizeCsnpCondition(raw: string): string {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => CSNP_CONDITION_LABEL[part] ?? splitCamelCase(part))
    .join(', ');
}

// ── The hook ──────────────────────────────────────────────────────
export function useBenchFilters(
  benchPlans: Plan[],
  opts: UseBenchFiltersOptions,
): UseBenchFiltersResult {
  const { annualDrugByPlanId, selectedProviderCount, initialState } = opts;

  // initialState is applied once on mount only. Subsequent renders
  // that pass a different initialState do NOT reset — a re-render
  // triggered by intake data changes shouldn't clobber the agent's
  // in-flight filter tweaks. React's useState lazy initializer runs
  // once; that's exactly the semantic we want here.
  const [state, setState] = useState<BenchFilterState>(() => ({
    ...EMPTY_STATE,
    ...(initialState ?? {}),
  }));

  const annualDrugMap = useMemo(
    () => normalizeAnnualDrugMap(annualDrugByPlanId),
    [annualDrugByPlanId],
  );

  // One-time per (bench, drug-map) normalization. Every downstream
  // filter / sort / option-derivation reads off these objects so the
  // raw Plan shape only crosses one boundary.
  const normalized = useMemo<NormalizedPlan[]>(
    () => benchPlans.map((p) => normalizePlan(p, annualDrugMap)),
    [benchPlans, annualDrugMap],
  );

  const costQualityDefs = useMemo(
    () => buildCostQualityDefs(selectedProviderCount),
    [selectedProviderCount],
  );

  // Dynamic options — only surface values that actually exist in the
  // bench. Avoids dead checkboxes that filter to zero ("C-SNP" in a
  // county with no C-SNP plans).
  const filterOptions = useMemo<FilterOptions>(() => {
    const planTypeCounts: Record<string, number> = { MA: 0, MAPD: 0 };
    const networkCounts: Record<string, number> = {};
    const snpCounts: Record<string, number> = {};
    // Sub-filter counts, one map per parent bucket. Keyed by the raw
    // Landscape value (integration status for D-SNPs; CamelCase
    // condition string for C-SNPs) so filter equality is exact.
    const dsnpIntegrationCounts: Record<string, number> = {};
    const csnpConditionCounts: Record<string, number> = {};
    const carrierCounts: Record<string, number> = {};

    for (const p of normalized) {
      planTypeCounts[p.planType] = (planTypeCounts[p.planType] ?? 0) + 1;
      networkCounts[p.network] = (networkCounts[p.network] ?? 0) + 1;
      if (p.snpType) snpCounts[p.snpType] = (snpCounts[p.snpType] ?? 0) + 1;
      if (p.snpType === 'D-SNP' && p.dsnpIntegration) {
        dsnpIntegrationCounts[p.dsnpIntegration] =
          (dsnpIntegrationCounts[p.dsnpIntegration] ?? 0) + 1;
      }
      if (p.snpType === 'C-SNP' && p.csnpCondition) {
        csnpConditionCounts[p.csnpCondition] =
          (csnpConditionCounts[p.csnpCondition] ?? 0) + 1;
      }
      if (p.isVa) snpCounts.VA = (snpCounts.VA ?? 0) + 1;
      carrierCounts[p.carrier] = (carrierCounts[p.carrier] ?? 0) + 1;
    }

    const planType: FilterOption[] = (['MA', 'MAPD'] as const)
      .filter((k) => planTypeCounts[k] > 0)
      .map((k) => ({ value: k, label: PLAN_TYPE_LABELS[k], count: planTypeCounts[k] }));

    const networkOrder = ['HMO', 'PPO', 'RPPO', 'HMO-POS', 'PFFS', 'MSA', 'Cost', 'PDP', 'OTHER'];
    const network: FilterOption[] = networkOrder
      .filter((k) => (networkCounts[k] ?? 0) > 0)
      .map((k) => ({
        value: k,
        label: NETWORK_LABELS[k] ?? k,
        count: networkCounts[k],
      }));

    // SNP dropdown — nested layout. Each top-level bucket that exists
    // in the bench emits one row; if that bucket has sub-filter values
    // (D-SNP integration status, C-SNP condition type) each distinct
    // value emits one indented row underneath. Integration statuses
    // display in a stable order (FIDE > HIDE > Coordination Only > AIP
    // > anything else). C-SNP conditions display in descending count
    // order so the most common shows first.
    const snp: FilterOption[] = [];
    const dsnpIntegrationOrder = ['FIDE', 'HIDE', 'Coordination Only', 'AIP'];
    const orderedDsnpKeys = [
      ...dsnpIntegrationOrder.filter((k) => dsnpIntegrationCounts[k] > 0),
      ...Object.keys(dsnpIntegrationCounts)
        .filter((k) => !dsnpIntegrationOrder.includes(k))
        .sort(),
    ];
    const orderedCsnpKeys = Object.entries(csnpConditionCounts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k]) => k);

    // Indented label prefix for sub-filter rows. FilterDropdown just
    // renders opt.label verbatim, so the two leading spaces + arrow
    // are the entire indentation mechanism. Keep short — the popover
    // panel is 220px wide and long C-SNP condition names wrap awkwardly.
    const subPrefix = '  ↳ ';

    if (snpCounts['D-SNP'] > 0) {
      snp.push({
        value: 'D-SNP',
        label: SNP_LABELS['D-SNP'],
        count: snpCounts['D-SNP'],
      });
      for (const k of orderedDsnpKeys) {
        snp.push({
          value: `D-SNP${SNP_SUB_SEP}${k}`,
          label: `${subPrefix}${k}`,
          count: dsnpIntegrationCounts[k],
        });
      }
    }
    if (snpCounts['C-SNP'] > 0) {
      snp.push({
        value: 'C-SNP',
        label: SNP_LABELS['C-SNP'],
        count: snpCounts['C-SNP'],
      });
      for (const k of orderedCsnpKeys) {
        snp.push({
          value: `C-SNP${SNP_SUB_SEP}${k}`,
          label: `${subPrefix}${humanizeCsnpCondition(k)}`,
          count: csnpConditionCounts[k],
        });
      }
    }
    if (snpCounts['I-SNP'] > 0) {
      snp.push({
        value: 'I-SNP',
        label: SNP_LABELS['I-SNP'],
        count: snpCounts['I-SNP'],
      });
    }
    if (snpCounts.VA > 0) {
      snp.push({
        value: 'VA',
        label: SNP_LABELS.VA,
        count: snpCounts.VA,
      });
    }

    const carrier: FilterOption[] = Object.entries(carrierCounts)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, label: value, count }));

    const costQuality: FilterOption[] = costQualityDefs
      .filter((d) => d.show !== false)
      .map((d) => ({
        value: d.key,
        label: d.label,
        count: normalized.filter((p) => d.predicate(p)).length,
      }))
      .filter((opt) => opt.count > 0);

    return { planType, network, snp, carrier, costQuality };
  }, [normalized, costQualityDefs]);

  // Apply filters. OR within each multi-select dimension, AND across
  // dimensions; Cost & Quality is AND within (every checked predicate
  // must pass).
  const filtered = useMemo<NormalizedPlan[]>(() => {
    const planTypeSet = new Set(state.planType);
    const networkSet = new Set(state.network);
    const snpSet = new Set(state.snp);
    const carrierSet = new Set(state.carrier);
    const cqByKey = new Map(costQualityDefs.map((d) => [d.key, d.predicate]));
    const search = state.search.trim().toLowerCase();

    const passDimension = <T,>(set: Set<T>, value: T) =>
      set.size === 0 || set.has(value);

    let out = normalized.filter((p) => {
      if (!passDimension(planTypeSet, p.planType)) return false;
      if (!passDimension(networkSet, p.network)) return false;
      if (snpSet.size > 0) {
        // OR across every selected token. Top-level ("D-SNP") passes
        // any plan in that bucket. Sub-filter ("D-SNP:FIDE") passes
        // only plans whose Landscape sub-value equals the token. See
        // parseSnpFilter above for encoding.
        let matches = false;
        for (const token of snpSet) {
          const { top, sub } = parseSnpFilter(token);
          if (top === 'VA') {
            if (p.isVa) { matches = true; break; }
            continue;
          }
          if (p.snpType !== top) continue;
          if (sub == null) { matches = true; break; }
          if (top === 'D-SNP' && p.dsnpIntegration === sub) { matches = true; break; }
          if (top === 'C-SNP' && p.csnpCondition === sub) { matches = true; break; }
        }
        if (!matches) return false;
      }
      if (!passDimension(carrierSet, p.carrier)) return false;

      for (const key of state.costQuality) {
        const pred = cqByKey.get(key);
        if (pred && !pred(p)) return false;
      }

      if (search) {
        const hay =
          `${p.carrier} ${p.planName} ${p.contractId} ${p.planNumber}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    // Sort. Plans with null annualCostEstimate always sink to the
    // bottom on cost_asc so the broker never sees a "—" plan above a
    // priced one — same convention the existing UI uses for unscored.
    const cmp: Record<SortKey, (a: NormalizedPlan, b: NormalizedPlan) => number> = {
      cost_asc: (a, b) => {
        const av = a.annualCostEstimate;
        const bv = b.annualCostEstimate;
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return av - bv;
      },
      premium_asc: (a, b) => a.consumerPremium - b.consumerPremium,
      premium_desc: (a, b) => b.consumerPremium - a.consumerPremium,
      moop_asc: (a, b) => a.moopInNetwork - b.moopInNetwork,
      stars_desc: (a, b) => b.starRating - a.starRating,
      docs_in_net_desc: (a, b) => b.inNetworkNpiCount - a.inNetworkNpiCount,
      drug_ded_asc: (a, b) => a.drugDeductible - b.drugDeductible,
      carrier_asc: (a, b) => a.carrier.localeCompare(b.carrier),
    };
    out = [...out].sort(cmp[state.sort]);
    return out;
  }, [normalized, state, costQualityDefs]);

  const setters = useMemo<BenchFilterSetters>(
    () => ({
      setPlanType: (next) => setState((s) => ({ ...s, planType: next })),
      setNetwork: (next) => setState((s) => ({ ...s, network: next })),
      setSnp: (next) => setState((s) => ({ ...s, snp: next })),
      setCarrier: (next) => setState((s) => ({ ...s, carrier: next })),
      setCostQuality: (next) => setState((s) => ({ ...s, costQuality: next })),
      setSearch: (next) => setState((s) => ({ ...s, search: next })),
      setSort: (next) => setState((s) => ({ ...s, sort: next })),
    }),
    [],
  );

  const activeFilterCount =
    state.planType.length +
    state.network.length +
    state.snp.length +
    state.carrier.length +
    state.costQuality.length +
    (state.search.trim() ? 1 : 0);

  // Build dismissible chips for the active-filter row below the bar.
  // Each chip removes a single value when clicked — clearAll exists
  // separately for the "Clear all" button.
  const activeChips = useMemo<ActiveChip[]>(() => {
    const chips: ActiveChip[] = [];
    const buildChips = <T extends string>(
      dim: string,
      values: T[],
      labelFn: (v: T) => string,
      setter: (next: T[]) => void,
    ) => {
      for (const v of values) {
        chips.push({
          id: `${dim}:${v}`,
          label: labelFn(v),
          onRemove: () => setter(values.filter((x) => x !== v)),
        });
      }
    };
    buildChips(
      'planType',
      state.planType,
      (v) => PLAN_TYPE_LABELS[v] ?? v,
      setters.setPlanType,
    );
    buildChips(
      'network',
      state.network,
      (v) => NETWORK_LABELS[v] ?? v,
      setters.setNetwork,
    );
    buildChips(
      'snp',
      state.snp,
      (v) => {
        const { top, sub } = parseSnpFilter(v);
        if (sub == null) return SNP_LABELS[top] ?? top;
        if (top === 'C-SNP') return `C-SNP: ${humanizeCsnpCondition(sub)}`;
        return `${top}: ${sub}`;
      },
      setters.setSnp,
    );
    buildChips('carrier', state.carrier, (v) => v, setters.setCarrier);
    buildChips(
      'costQuality',
      state.costQuality,
      (v) => costQualityDefs.find((d) => d.key === v)?.label ?? v,
      setters.setCostQuality,
    );
    if (state.search.trim()) {
      chips.push({
        id: 'search',
        label: `Search: "${state.search.trim()}"`,
        onRemove: () => setters.setSearch(''),
      });
    }
    return chips;
  }, [state, setters, costQualityDefs]);

  const clearAll = useCallback(() => {
    setState((s) => ({ ...EMPTY_STATE, sort: s.sort }));
  }, []);

  // Audit — every plan must resolve to a known carrier + network so
  // the broker never silently loses a plan behind a filter that has
  // no checkbox for it. Surfaces through filters.audit() so Rob can
  // run it from the browser console after rendering.
  const audit = useCallback<() => AuditResult>(() => {
    const issues: AuditIssue[] = [];
    for (const p of normalized) {
      if (p.network === 'OTHER') {
        issues.push({
          planId: p.id,
          issue: 'unknown_network',
          detail: `plan_shape=${p._raw.plan_shape ?? 'null'} plan_name=${p.planName}`,
        });
      }
      if (!p._raw.carrier || p._raw.carrier === 'Unknown') {
        issues.push({
          planId: p.id,
          issue: 'unknown_carrier',
          detail: `carrier missing on ${p.planName}`,
        });
      }
      if (p._raw.has_drug_coverage !== true && p._raw.has_drug_coverage !== false) {
        issues.push({
          planId: p.id,
          issue: 'missing_plan_type',
          detail: `has_drug_coverage=${String(p._raw.has_drug_coverage)}`,
        });
      }
      // SNP-detail completeness (migration 014). Landscape files
      // integration status on every D-SNP and condition type on every
      // C-SNP; a null on the bench points at either a pre-migration
      // static-fallback plan or a stale pm_plans row that missed the
      // last landscape refresh. zero_cost_sharing has a NOT NULL DEFAULT
      // false on the column so nothing to flag there.
      if (p.snpType === 'D-SNP' && !p.dsnpIntegration) {
        issues.push({
          planId: p.id,
          issue: 'missing_dsnp_integration',
          detail: `snp_type=D-SNP but dsnp_integration_status=null on ${p.planName}`,
        });
      }
      if (p.snpType === 'C-SNP' && !p.csnpCondition) {
        issues.push({
          planId: p.id,
          issue: 'missing_csnp_condition',
          detail: `snp_type=C-SNP but csnp_condition_type=null on ${p.planName}`,
        });
      }
      if (
        p.snpType === 'D-SNP' &&
        (!p.dsnpAcceptedPopulations || p.dsnpAcceptedPopulations.length === 0)
      ) {
        issues.push({
          planId: p.id,
          issue: 'missing_dsnp_populations',
          detail: `snp_type=D-SNP but dsnp_accepted_populations empty on ${p.planName} — rerun scripts/import-snp-comprehensive-report.ts`,
        });
      }
    }
    const pass = issues.length === 0;
    const summary = pass
      ? `[bench-filter audit] PASS — ${normalized.length} plans, every plan resolved.`
      : `[bench-filter audit] FAIL — ${issues.length} issue(s) across ${normalized.length} plans`;
    const lines = [summary];
    for (const i of issues) lines.push(`  • ${i.planId} → ${i.issue}: ${i.detail}`);
    return { pass, issues, report: lines.join('\n') };
  }, [normalized]);

  return {
    filtered,
    totalCount: normalized.length,
    filterState: state,
    setters,
    filterOptions,
    activeFilterCount,
    activeChips,
    clearAll,
    audit,
  };
}
