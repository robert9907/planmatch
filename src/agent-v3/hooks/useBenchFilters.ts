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
  issue: 'unknown_network' | 'unknown_carrier' | 'missing_plan_type';
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

const SNP_LABELS: Record<string, string> = {
  'D-SNP': 'D-SNP (dual-eligible)',
  'C-SNP': 'C-SNP (chronic)',
  'I-SNP': 'I-SNP (institutional)',
  VA: 'VA / MA-only',
};

// ── The hook ──────────────────────────────────────────────────────
export function useBenchFilters(
  benchPlans: Plan[],
  opts: UseBenchFiltersOptions,
): UseBenchFiltersResult {
  const { annualDrugByPlanId, selectedProviderCount } = opts;

  const [state, setState] = useState<BenchFilterState>(EMPTY_STATE);

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
    const carrierCounts: Record<string, number> = {};

    for (const p of normalized) {
      planTypeCounts[p.planType] = (planTypeCounts[p.planType] ?? 0) + 1;
      networkCounts[p.network] = (networkCounts[p.network] ?? 0) + 1;
      if (p.snpType) snpCounts[p.snpType] = (snpCounts[p.snpType] ?? 0) + 1;
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

    const snpOrder = ['D-SNP', 'C-SNP', 'I-SNP', 'VA'];
    const snp: FilterOption[] = snpOrder
      .filter((k) => (snpCounts[k] ?? 0) > 0)
      .map((k) => ({
        value: k,
        label: SNP_LABELS[k] ?? k,
        count: snpCounts[k],
      }));

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
        const matches =
          (p.snpType != null && snpSet.has(p.snpType)) ||
          (p.isVa && snpSet.has('VA'));
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
    buildChips('snp', state.snp, (v) => SNP_LABELS[v] ?? v, setters.setSnp);
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
