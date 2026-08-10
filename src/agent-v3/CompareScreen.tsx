// CompareScreen — agent-v3 screen 6, unified workspace.
//
// Two modes the broker toggles between mid-call:
//   • grid (default) — 2×2 board of up to 4 finalist plans with a
//     drag-to-swap bench above. Each card renders the full 37-row
//     benefit ladder by default (no hidden Detail expander) with a
//     delta arrow vs. the baseline plan, plus H2H / Enroll buttons.
//   • h2h — full-bleed head-to-head with the current plan on the
//     left and one challenger on the right, sized for the screen
//     share. Pill switcher lets the broker swap challengers without
//     flipping back to grid.
//
// Props match the prior CompareScreen exactly so AgentV3App's wiring
// doesn't move. Enroll on either mode calls onNext, which advances
// to the existing compliance → enroll funnel.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react';
import type { CostShare, Plan } from '@/types/plans';
import { useSession } from '@/hooks/useSession';
import { useBenchFilters } from './hooks/useBenchFilters';
import { BenchFilterBar } from './components/compare/BenchFilterBar';
import {
  firstTierCopay,
  formatInpatientLadder,
} from '@/lib/inpatient-format';
import { Container, Header, Nav, fmt } from './atoms';
import {
  annualEstimate,
  costShareNumeric,
  formatCostShareWithRange,
  formatPcp,
  formatPremium,
  formatSpecialist,
  planDisplay,
} from './planDisplay';
import {
  classifyExplanation,
  summarizeExplanations,
} from '@/lib/classify-explanation';
import type { LibraryRankPlan } from '@/lib/library-client';
import type { DualEligibleAdjustment } from '@/lib/dual-eligible';
import { useDrugPhases, type DrugPhaseHit } from '@/hooks/useDrugPhases';
// DrugCostCard hidden from the Board in Compare v2 reskin (2026-08-05) —
// component still on disk at ./DrugCostCard.tsx and its type export is
// consumed via the DrugCostCardComparisonPlan re-export used by other
// callers. PartDTimelineOverlay handled the same way; both are wired
// back by restoring their callsites in this file.
import type { DrugCostCardComparisonPlan } from './DrugCostCard';
import { QuoteBuilder } from './QuoteBuilder';
import { TOKENS as T, FONT as F } from './compare-v2/tokens';
// QuickPreviewDrawer no longer rendered from CompareScreen — bench
// "Quick preview" is the pre-slice inline expander on BenchCard
// itself (restored 2026-08-07). The QuickPreviewDrawer.tsx file stays
// on disk because SummaryOfBenefitsDrawer imports its shared
// PreviewDrawerShell + PreviewGrid primitives.
import { BoardComparisonView } from './compare-v2/BoardComparisonView';
import { PoolMetricsBar } from './compare-v2/PoolMetricsBar';
import { formatOtc } from '@/lib/extractBenefitValue';

// Per the current product rule: rows stay visible, but unfiled values
// render as em-dash, not "Not available" (which read as "we can't
// quote this plan" to brokers). The data IS in Supabase for 178K+
// pm_plan_benefits rows; em-dash is reserved for the genuine gaps
// (mostly C-SNP plans whose PBP B-codes aren't in pm_plan_benefits yet).
function safeCostShare(s: string): string {
  return s;
}

// Plan.id ships as "<contract>-<plan>-<segment>" ("H1036-318-000"). The
// segment suffix is a Plan Finder internal detail that brokers never
// say out loud — carriers print the contract-plan pair on member cards
// and Marx/CMS systems quote the same form, so strip the trailing
// segment for any display surface.
function planIdShort(id: string): string {
  const parts = id.split('-');
  if (parts.length < 2) return id;
  return `${parts[0]}-${parts[1]}`;
}

// ── Design tokens ──────────────────────────────────────────────
const NAVY = '#0d2f5e';
const TEAL = '#14b8a6';
const SEAFOAM = '#67e8f9';
const GOLD = '#f59e0b';
const CORAL = '#ef4444';
const GREEN = '#22c55e';
const BORDER = '#e2e8f0';
const PANEL = '#f8fafc';
const MUTED = '#64748b';
const TEXT = '#0f172a';
const FONT_LABEL = "'DM Sans', system-ui, sans-serif";
const FONT_NUM = "'JetBrains Mono', ui-monospace, monospace";

interface Props {
  current: Plan | null;
  /**
   * Full brain-ranked plan list, sorted by composite score descending.
   * The board seeds slot 0 with `current` (or the top scored plan as a
   * fallback when there's no incumbent) and slots 1–3 with the top
   * three plans excluding the baseline. Anything past the 4th slot
   * lands on the bench in brain-rank order.
   */
  scoredPlans: Plan[];
  /** Brain-assigned ribbon per plan id ('LOWEST_DRUG_COST', 'BEST_EXTRAS',
   *  etc.). Plans without an assigned ribbon are null/absent. Drives the
   *  ribbon chip on bench cards. Optional so older callers still
   *  type-check. */
  ribbonByPlanId?: Record<string, string | null>;
  annualDrugByPlanId: Record<string, number | null>;
  /** True when the brain couldn't confirm coverage for ≥1 user drug on
   *  this plan (no pm_drug_cost_cache row AND not on the formulary).
   *  The drug-cost row in the slot card renders an amber disclaimer
   *  ("confirm with your pharmacist") for any plan flagged here.
   *  Optional so older callers still type-check. */
  drugCoverageUnknownByPlanId?: Record<string, boolean>;
  /** Per-plan count of user drugs the brain confirmed are on formulary,
   *  sourced from BrainScore.coveredCount via the adapter. Replaces the
   *  old `plan.formulary[rxcui]` lookup that always returned `{}` in
   *  agent-v3 (plan.formulary is populated lazily via /api/formulary,
   *  and agent-v3 never hydrates back onto the Plan object). Plans not
   *  in the brain's scored list (e.g., the user's current plan when it
   *  failed Gates 1+2) get undefined → UI renders em-dash. */
  drugsCoveredByPlanId?: Record<string, number>;
  /** Companion to drugsCoveredByPlanId — BrainScore.totalCount. */
  drugsTotalByPlanId?: Record<string, number>;
  /** Per-(plan × med) breakdown — drives the per-med row list on
   *  every plan card and the compact bench summary. Comes from
   *  BrainScore.drugBreakdown via the adapter. */
  drugBreakdownByPlanId?: Record<
    string,
    ReadonlyArray<DrugRow>
  >;
  /** Every county plan that didn't make Top 4, sorted by cost ASC.
   *  Rendered below the 4-up grid with an elimination-reason badge
   *  per card so the broker can scroll the full pool without leaving
   *  the screen. */
  benchPlans?: Plan[];
  /** Per-plan gate survivorship for the bench. Used to label why
   *  each bench plan was eliminated. */
  benchGateResultsByPlanId?: Record<
    string,
    { gate1_passed: boolean; gate2_passed: boolean; gate3_passed: boolean }
  >;
  /** Per-plan, per-gate customer-facing micro-explainer strings sourced
   *  from BrainScore.explanations via the AgentV3App adapter. Drives the
   *  collapsible "Why this plan" section on each SlotCell — one row per
   *  provider on gate 1, per drug on gate 2, per priority on gate 3, and
   *  a single cost-rank line on gate 4. Plans not in the brain's scored
   *  list (e.g., the user's current plan when it failed Gates 1+2) get
   *  undefined and the SlotCell renders nothing for that section. */
  explanationsByPlanId?: Record<string, ExplanationsForPlan>;
  /** Per-plan brain composite score sourced from ScoredPlan.composite
   *  via AgentV3App. Compare v2 renders a normalized confidence circle
   *  on each SlotCell (this-plan's composite / best-in-current-pool).
   *  Missing entries fall back to a position-based ordering. */
  compositeByPlanId?: Record<string, number>;
  /** User drugs the brain couldn't score because they arrived without
   *  a resolvable rxcui. Sourced from BrainOutput.unresolvedDrugs via
   *  the usePlanBrain adapter. Non-empty → renders the amber
   *  DATA QUALITY banner at the top of the Compare screen so the
   *  broker knows the ranking is incomplete for these meds. Empty
   *  when every user drug has an rxcui or the user has no drugs. */
  unresolvedDrugs?: ReadonlyArray<{ index: number; name: string }>;
  /** Per-plan dual-eligible / LIS cost adjustment sourced from
   *  BrainScore.dualEligibleAdjustment via AgentV3App's adapter.
   *  When present for a plan, the board slot / bench card / Quick
   *  Preview render subsidy badges and strikethrough the adjusted
   *  premium + drug cost. Empty record when the client has no
   *  Medicaid / LIS on file (adjustment was a no-op in the brain). */
  dualEligibleByPlanId?: Record<string, DualEligibleAdjustment | undefined>;
  /**
   * Fire-and-forget AgentBase write-back. CompareScreen calls this with
   * the picked plan when the broker clicks Enroll on a card or the
   * summary bar. The hook on the shell handles state + retries; this
   * screen never blocks on it.
   */
  /** Returns the sync result so the per-card Enroll button can surface
   *  success or an explicit error inline. Void return kept for
   *  backwards compat with legacy callers (`onRecommend?.(plan)` still
   *  fires-and-forgets when the caller doesn't await). */
  onRecommend?: (plan: Plan) => Promise<{ ok: true } | { ok: false; error: string }> | void;
  onBack: () => void;
  onNext: () => void;
  /** Full ranked list (top + bench) feeding the Send Quote panel. The
   *  panel is the only place that needs the raw library result; passing
   *  it as a flat array keeps CompareScreen's other props focused on
   *  the brain-derived per-plan maps. */
  rankedPlans?: LibraryRankPlan[];
  /** Selected priorities from the Priorities screen. Consumed here to
   *  seed the initial bench-filter state — 'healthy_foods' → "Has Food
   *  Card", 'partb_giveback' → "Part B Giveback". Optional so older
   *  test wrappers / storybook callers don't need to change. */
  priorities?: readonly string[];
}

/** Subset of the brain's GateExplanations rendered on each SlotCell. */
export interface ExplanationsForPlan {
  gate1: ReadonlyArray<string>;
  gate2: ReadonlyArray<string>;
  gate3: ReadonlyArray<string>;
  gate4: string;
}

// H2H sections — used to bucket the 50+ rows into scannable groups.
// Only consumed by H2HView; Grid mode reads metrics flat.
type MetricGroup =
  | 'overview'
  | 'primary_specialty'
  | 'hospital_facility'
  | 'diagnostics_therapy'
  | 'ambulance_other'
  | 'drug_coverage'
  | 'rx_tiers'
  | 'extra_benefits'
  | 'provider_network';

const METRIC_GROUP_ORDER: MetricGroup[] = [
  'overview',
  'primary_specialty',
  'hospital_facility',
  'diagnostics_therapy',
  'ambulance_other',
  'drug_coverage',
  'rx_tiers',
  'extra_benefits',
  'provider_network',
];

const METRIC_GROUP_LABEL: Record<MetricGroup, string> = {
  overview: 'Overview',
  primary_specialty: 'Primary & Specialty Care',
  hospital_facility: 'Hospital & Facility',
  diagnostics_therapy: 'Diagnostics & Therapy',
  ambulance_other: 'Ambulance & Other',
  drug_coverage: 'Drug Coverage',
  rx_tiers: 'Rx Tiers',
  extra_benefits: 'Extra Benefits',
  provider_network: 'Provider Network',
};

interface Metric {
  key: string;
  label: string;
  format: (p: Plan) => string;
  numeric: (p: Plan) => number | null;
  higherIsBetter: boolean;
  /** H2H section this row belongs to. Grid mode ignores this. */
  group: MetricGroup;
}

interface ProviderRow {
  /** Stable id from useSession; used as React key. Falls back to npi. */
  id?: string;
  /** Display name — "Dr. Kombiz Klein, PA" etc. */
  name?: string;
  /** Per-plan network status keyed by plan.id (triple). Library /
   *  cache pipeline writes 'in' / 'out' / 'unknown' here; missing
   *  keys default to 'unknown' at render time. */
  networkStatus?: Record<string, string> | undefined;
}

interface DrugRow {
  rxcui: string;
  name: string;
  covered: boolean;
  tier: number | null;
  monthlyCopay: number | null;
  annualCost: number;
}

// Old per-plan coveredCount(plan, rxcuis) read plan.formulary[rxcui],
// which is always `{}` in agent-v3 (plan.formulary is populated lazily
// via /api/formulary and nothing re-hydrates back onto the Plan object).
// The brain has the right numbers — passed in via drugsCoveredByPlanId.

function providersInNetwork(plan: Plan, providers: ProviderRow[]): number {
  let n = 0;
  for (const p of providers) {
    if (p.networkStatus?.[plan.id] === 'in') n += 1;
  }
  return n;
}

// Cost-share metric factory — keeps the 21 medical / Rx-tier rows from
// dragging the array out to 100+ lines of boilerplate.
//
// Uses the range-aware formatter so ranged copays (advanced imaging,
// outpatient surgery, diagnostic procedures) surface as "$0–$325"
// instead of just "$0". CMS files the minimum in the structured copay
// column with the high end only in the description text; flattening
// to "$0" misleads the broker about real exposure.
function csMetric(
  key: string,
  label: string,
  get: (p: Plan) => CostShare,
  group: MetricGroup,
): Metric {
  return {
    key,
    label,
    format: (p) => safeCostShare(
      formatCostShareWithRange(get(p), { isPdp: p.plan_type === 'PDP' }),
    ),
    numeric: (p) => costShareNumeric(get(p)),
    higherIsBetter: false,
    group,
  };
}

// Inpatient day-tier ladder metric — renders the full ladder
// ("$0/day · days 1-20\n$218/day · days 21-50\n$0/day · days 51-100")
// from benefit_description and uses the day-1 copay for winner math
// (see [[feedback_inpatient_full_ladder]] + lib/inpatient-format.ts).
// Cells using this metric must allow multi-line text (whiteSpace:
// pre-line); other csMetric rows return single-line strings and are
// unaffected.
function ladderMetric(
  key: string,
  label: string,
  get: (p: Plan) => CostShare,
  group: MetricGroup,
): Metric {
  return {
    key,
    label,
    format: (p) => {
      const cs = get(p);
      const formatted = formatInpatientLadder(cs.description, cs.copay, cs.coinsurance);
      return formatted ?? '—';
    },
    numeric: (p) => {
      const cs = get(p);
      return firstTierCopay(cs.description, cs.copay);
    },
    higherIsBetter: false,
    group,
  };
}

function buildMetrics(args: {
  rxcuis: string[];
  providers: ProviderRow[];
  annualDrugByPlanId: Record<string, number | null>;
  drugsCoveredByPlanId: Record<string, number>;
  drugsTotalByPlanId: Record<string, number>;
}): Metric[] {
  const {
    rxcuis,
    providers,
    annualDrugByPlanId,
    drugsCoveredByPlanId,
    drugsTotalByPlanId,
  } = args;
  const drug = (p: Plan) => annualDrugByPlanId[p.id] ?? null;
  const drugsCovered = (p: Plan) => drugsCoveredByPlanId[p.id];
  const drugsTotal = (p: Plan) => drugsTotalByPlanId[p.id];

  return [
    {
      key: 'premium',
      label: 'Premium',
      format: (p) => `${formatPremium(p)}/mo`,
      numeric: (p) => p.premium,
      higherIsBetter: false,
      group: 'overview',
    },
    {
      key: 'moop',
      label: 'MOOP',
      format: (p) => fmt(p.moop_in_network),
      numeric: (p) => p.moop_in_network,
      higherIsBetter: false,
      group: 'overview',
    },
    {
      key: 'drugs',
      label: 'Drug cost / yr',
      // Compact summary. The LIS-adjusted breakdown + strike + savings
      // badge + phase breakdown live in DrugCostCard (rendered below
      // the metric grid inside SlotCell), keeping the metric row a
      // single scannable line.
      format: (p) => {
        const v = drug(p);
        return v == null ? '—' : `${fmt(v)}/yr`;
      },
      numeric: drug,
      higherIsBetter: false,
      group: 'drug_coverage',
    },
    {
      key: 'meds',
      label: 'Meds covered',
      format: (p) => {
        if (rxcuis.length === 0) return '—';
        const c = drugsCovered(p);
        const t = drugsTotal(p);
        if (c == null || t == null) return '—';
        return `${c}/${t}`;
      },
      numeric: (p) => (rxcuis.length === 0 ? null : (drugsCovered(p) ?? null)),
      higherIsBetter: true,
      group: 'drug_coverage',
    },
    {
      key: 'providers',
      label: 'Doctors in-network',
      format: (p) =>
        providers.length === 0
          ? '—'
          : `${providersInNetwork(p, providers)}/${providers.length}`,
      numeric: (p) =>
        providers.length === 0 ? null : providersInNetwork(p, providers),
      higherIsBetter: true,
      group: 'provider_network',
    },
    {
      key: 'dental',
      label: 'Dental',
      format: (p) => planDisplay(p).dentalMax,
      numeric: (p) => p.benefits.dental.annual_max,
      higherIsBetter: true,
      group: 'extra_benefits',
    },
    {
      key: 'vision',
      label: 'Vision',
      format: (p) => planDisplay(p).visionAllowance,
      numeric: (p) => p.benefits.vision.eyewear_allowance_year,
      higherIsBetter: true,
      group: 'extra_benefits',
    },
    {
      key: 'otc',
      label: 'OTC / qtr',
      format: (p) =>
        formatOtc(p.benefits.otc.allowance_per_quarter, p.benefits.otc.description),
      numeric: (p) => p.benefits.otc.allowance_per_quarter,
      higherIsBetter: true,
      group: 'extra_benefits',
    },
    {
      key: 'fitness',
      label: 'Fitness',
      format: (p) => planDisplay(p).fitness,
      numeric: (p) => (p.benefits.fitness.enabled ? 1 : 0),
      higherIsBetter: true,
      group: 'extra_benefits',
    },
    {
      key: 'giveback',
      label: 'Part B giveback',
      format: (p) =>
        p.part_b_giveback > 0 ? `$${p.part_b_giveback}/mo` : '—',
      numeric: (p) => p.part_b_giveback,
      higherIsBetter: true,
      group: 'overview',
    },
    {
      key: 'stars',
      label: 'Star rating',
      // CMS gives "Plan too new to be measured" to MA plans in their
      // first 3 years; pm_plans stores those as null → 0. Show the
      // CMS-style copy instead of misleading "0 ★".
      format: (p) => (p.star_rating > 0 ? `${p.star_rating} ★` : 'Not yet rated'),
      numeric: (p) => p.star_rating,
      higherIsBetter: true,
      group: 'overview',
    },
    // ── Medical copays + Part D deductible ───────────────────────
    {
      key: 'pcp',
      label: 'PCP copay',
      format: (p) => safeCostShare(formatPcp(p)),
      numeric: (p) => costShareNumeric(p.benefits.medical.primary_care),
      higherIsBetter: false,
      group: 'primary_specialty',
    },
    {
      key: 'specialist',
      label: 'Specialist',
      format: (p) => safeCostShare(formatSpecialist(p)),
      numeric: (p) => costShareNumeric(p.benefits.medical.specialist),
      higherIsBetter: false,
      group: 'primary_specialty',
    },
    {
      key: 'partd_ded',
      label: 'Part D Ded.',
      format: (p) =>
        p.drug_deductible == null ? '—' : `$${p.drug_deductible}`,
      numeric: (p) => p.drug_deductible,
      higherIsBetter: false,
      group: 'drug_coverage',
    },
    csMetric('urgent_care', 'Urgent care', (p) => p.benefits.medical.urgent_care, 'primary_specialty'),
    csMetric('emergency', 'Emergency', (p) => p.benefits.medical.emergency, 'primary_specialty'),
    ladderMetric('inpatient', 'Inpatient hospital', (p) => p.benefits.medical.inpatient, 'hospital_facility'),
    ladderMetric(
      'mh_inpatient',
      'Inpatient mental',
      (p) => p.benefits.medical.mental_health_inpatient,
      'hospital_facility',
    ),
    ladderMetric('snf', 'Skilled nursing', (p) => p.benefits.medical.snf, 'hospital_facility'),
    csMetric(
      'out_surg_hosp',
      'Outpatient surg. (hosp)',
      (p) => p.benefits.medical.outpatient_surgery_hospital,
      'hospital_facility',
    ),
    csMetric(
      'out_surg_asc',
      'Outpatient surg. (ASC)',
      (p) => p.benefits.medical.outpatient_surgery_asc,
      'hospital_facility',
    ),
    csMetric(
      'out_obs',
      'Outpatient observation',
      (p) => p.benefits.medical.outpatient_observation,
      'hospital_facility',
    ),
    csMetric('lab', 'Lab services', (p) => p.benefits.medical.lab_services, 'diagnostics_therapy'),
    csMetric(
      'diag_proc',
      'Diagnostic procedures',
      (p) => p.benefits.medical.diagnostic_procedures,
      'diagnostics_therapy',
    ),
    csMetric('xray', 'X-ray', (p) => p.benefits.medical.xray, 'diagnostics_therapy'),
    csMetric('imaging', 'Advanced imaging', (p) => p.benefits.medical.advanced_imaging, 'diagnostics_therapy'),
    csMetric(
      'mh_indiv',
      'Mental health (indiv.)',
      (p) => p.benefits.medical.mental_health_individual,
      'diagnostics_therapy',
    ),
    csMetric(
      'mh_group',
      'Mental health (group)',
      (p) => p.benefits.medical.mental_health_group,
      'diagnostics_therapy',
    ),
    csMetric(
      'pst',
      'Physical / speech therapy',
      (p) => p.benefits.medical.physical_speech_therapy,
      'diagnostics_therapy',
    ),
    csMetric('ot', 'Occupational therapy', (p) => p.benefits.medical.occupational_therapy, 'diagnostics_therapy'),
    csMetric('telehealth', 'Telehealth', (p) => p.benefits.medical.telehealth, 'diagnostics_therapy'),
    // ── Transport ────────────────────────────────────────────────
    csMetric('ambulance', 'Ambulance (ground)', (p) => p.benefits.medical.ambulance, 'ambulance_other'),
    csMetric('air_amb', 'Air ambulance', (p) => p.benefits.medical.air_transportation, 'ambulance_other'),
    // ── Specialty visit copays ───────────────────────────────────
    csMetric('chiro', 'Chiropractic', (p) => p.benefits.medical.chiropractic, 'ambulance_other'),
    csMetric('acu', 'Acupuncture', (p) => p.benefits.medical.acupuncture, 'ambulance_other'),
    csMetric('pod', 'Podiatry', (p) => p.benefits.medical.podiatry, 'ambulance_other'),
    csMetric('sa', 'Substance abuse', (p) => p.benefits.medical.substance_abuse, 'ambulance_other'),
    // ── Equipment / Part B drugs / diabetic ──────────────────────
    csMetric('dme', 'DME / prosthetics', (p) => p.benefits.medical.dme_prosthetics, 'ambulance_other'),
    csMetric('partb_rx', 'Part B drugs', (p) => p.benefits.medical.partb_drugs, 'ambulance_other'),
    csMetric(
      'diab_sup',
      'Diabetic supplies',
      (p) => p.benefits.medical.diabetic_supplies,
      'ambulance_other',
    ),
    csMetric('insulin', 'Part B insulin', (p) => p.benefits.medical.insulin, 'ambulance_other'),
    // ── Long-term / home ─────────────────────────────────────────
    csMetric('hh', 'Home health', (p) => p.benefits.medical.home_health, 'ambulance_other'),
    csMetric('dialysis', 'Renal dialysis', (p) => p.benefits.medical.renal_dialysis, 'ambulance_other'),
    // ── Rx tiers ─────────────────────────────────────────────────
    csMetric('rx_t1', 'Rx Tier 1', (p) => p.benefits.rx_tiers.tier_1, 'rx_tiers'),
    csMetric('rx_t2', 'Rx Tier 2', (p) => p.benefits.rx_tiers.tier_2, 'rx_tiers'),
    csMetric('rx_t3', 'Rx Tier 3', (p) => p.benefits.rx_tiers.tier_3, 'rx_tiers'),
    csMetric('rx_t4', 'Rx Tier 4', (p) => p.benefits.rx_tiers.tier_4, 'rx_tiers'),
    csMetric('rx_t5', 'Rx Tier 5', (p) => p.benefits.rx_tiers.tier_5, 'rx_tiers'),
    // Tier 6 is carrier-specific (Wellcare "Select Care" $0 generics,
    // CSNP buckets). Optional on RxTierCopays; skip the row when the
    // plan didn't file it.
    csMetric(
      'rx_t6',
      'Rx Tier 6',
      (p) => p.benefits.rx_tiers.tier_6 ?? { copay: null, coinsurance: null, description: null },
      'rx_tiers',
    ),
    // ── Supplemental (string output, no winner highlighting) ─────
    {
      key: 'transport',
      label: 'Transportation',
      format: (p) => planDisplay(p).transport,
      numeric: () => null,
      higherIsBetter: true,
      group: 'extra_benefits',
    },
    {
      key: 'food',
      label: 'Food card',
      format: (p) => planDisplay(p).meals,
      numeric: () => null,
      higherIsBetter: true,
      group: 'extra_benefits',
    },
    {
      key: 'hearing',
      label: 'Hearing',
      format: (p) => planDisplay(p).hearing,
      numeric: () => null,
      higherIsBetter: true,
      group: 'extra_benefits',
    },
  ];
}

function bestNumeric(metric: Metric, plans: Plan[]): number | null {
  const vals = plans.map(metric.numeric).filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  return metric.higherIsBetter ? Math.max(...vals) : Math.min(...vals);
}

function deltaVs(
  metric: Metric,
  plan: Plan,
  current: Plan | null,
): 'better' | 'worse' | 'same' | null {
  if (!current) return null;
  const a = metric.numeric(plan);
  const b = metric.numeric(current);
  if (a == null || b == null) return null;
  if (a === b) return 'same';
  if (metric.higherIsBetter) return a > b ? 'better' : 'worse';
  return a < b ? 'better' : 'worse';
}

function deltaText(metric: Metric, plan: Plan, current: Plan | null): string | null {
  if (!current) return null;
  const a = metric.numeric(plan);
  const b = metric.numeric(current);
  if (a == null || b == null) return null;
  if (a === b) return null;
  const diff = Math.abs(a - b);
  if (metric.key === 'premium' || metric.key === 'giveback' || metric.key === 'otc') {
    return `$${diff.toFixed(2)}`;
  }
  if (
    metric.key === 'moop' ||
    metric.key === 'drugs' ||
    metric.key === 'dental' ||
    metric.key === 'vision'
  ) {
    return fmt(diff);
  }
  if (metric.key === 'meds' || metric.key === 'providers') return `${diff}`;
  if (metric.key === 'stars') return `${diff.toFixed(1)}★`;
  return null;
}

// Optional `preferIds` reorders pool so filter-matching plans get
// slotted first — used on mount when the initial bench-filter state
// (dsnpEligible → D-SNP-only, etc.) means the brain's top-4 doesn't
// necessarily overlap with what the agent will actually consider.
// Preserves brain rank within each partition (matched-then-unmatched)
// so a low-cost D-SNP still beats a costlier D-SNP.
function initSlots(pool: Plan[], preferIds?: ReadonlySet<string>): (Plan | null)[] {
  const out: (Plan | null)[] = [null, null, null, null];
  const ordered = preferIds && preferIds.size > 0
    ? [
        ...pool.filter((p) => preferIds.has(p.id)),
        ...pool.filter((p) => !preferIds.has(p.id)),
      ]
    : pool;
  for (let i = 0; i < Math.min(4, ordered.length); i++) {
    out[i] = ordered[i];
  }
  return out;
}

export function CompareScreen({
  current,
  scoredPlans,
  ribbonByPlanId,
  annualDrugByPlanId,
  drugCoverageUnknownByPlanId,
  drugsCoveredByPlanId,
  drugsTotalByPlanId,
  drugBreakdownByPlanId,
  benchPlans,
  benchGateResultsByPlanId,
  explanationsByPlanId,
  compositeByPlanId,
  unresolvedDrugs,
  dualEligibleByPlanId,
  onRecommend,
  onBack,
  onNext,
  rankedPlans,
  priorities,
}: Props) {
  const providers = useSession((s) => s.providers);
  const medications = useSession((s) => s.medications);
  const client = useSession((s) => s.client);
  const setRecommendation = useSession((s) => s.setRecommendation);

  const rxcuis = useMemo(
    () => medications.map((m) => m.rxcui).filter((s): s is string => !!s),
    [medications],
  );

  const metrics = useMemo(
    () =>
      buildMetrics({
        rxcuis,
        providers,
        annualDrugByPlanId,
        drugsCoveredByPlanId: drugsCoveredByPlanId ?? {},
        drugsTotalByPlanId: drugsTotalByPlanId ?? {},
      }),
    [rxcuis, providers, annualDrugByPlanId, drugsCoveredByPlanId, drugsTotalByPlanId],
  );

  // Union of every plan currently on the Compare board (scored + bench)
  // so a single /api/drug-phases call primes both the Top-4 slot cards
  // and the bench cards. useDrugPhases dedupes on the sorted plan+rxcui
  // signature — column re-orders don't refetch.
  const drugPhasesPlans = useMemo(
    () => [...scoredPlans, ...(benchPlans ?? [])],
    [scoredPlans, benchPlans],
  );
  const drugPhases = useDrugPhases(drugPhasesPlans, medications, 'pref', 1);
  // Pre-shape the cross-plan comparison list once; DrugCostCard reads
  // this to render the "same molecule, different classification"
  // callout without recomputing per-plan.
  const drugCostComparisonPlans = useMemo<DrugCostCardComparisonPlan[]>(() => {
    return drugPhasesPlans.map((p) => {
      // Filter the phases map to just this plan's rxcuis (keys are
      // `${planId}::${rxcui}` — cheap prefix scan).
      const prefix = `${p.id}::`;
      const own = new Map<string, DrugPhaseHit>();
      for (const [k, v] of drugPhases.byPlanIdRxcui.entries()) {
        if (k.startsWith(prefix)) own.set(k, v);
      }
      return {
        planId: p.id,
        planName: p.plan_name ?? p.plan_number ?? p.id,
        drugBreakdown: drugBreakdownByPlanId?.[p.id] ?? [],
        drugPhasesByRxcui: own,
      };
    });
  }, [drugPhasesPlans, drugPhases.byPlanIdRxcui, drugBreakdownByPlanId]);

  // Data-quality counts driving the warning banner. When the broker
  // captured meds without RxNorm match (manual entry past autocomplete,
  // photo capture without resolution, AgentBase CRM hydration with
  // null rxcui), the formulary lookup has nothing to match — every
  // plan reports 0 covered. Same for providers without NPI: the
  // pm_provider_network_cache key is the NPI, so no NPI = no network
  // signal anywhere. Surface both as a banner so the broker sees WHY
  // 0/N is showing and can act (re-pick the med, look up NPI on
  // npiregistry.cms.hhs.gov, etc.).
  const unresolvedMedCount = useMemo(
    () => medications.filter((m) => !m.rxcui).length,
    [medications],
  );
  const missingNpiCount = useMemo(
    () => providers.filter((p) => !p.npi).length,
    [providers],
  );
  // Prefer the brain-emitted list (has names + guaranteed to match
  // what actually got scored) when the brain has run; fall back to
  // session-derived names for the pre-brain-ready window so the
  // banner names always align with the count above.
  const unresolvedMedNames = useMemo<string[]>(() => {
    if (unresolvedDrugs && unresolvedDrugs.length > 0) {
      return unresolvedDrugs.map((d) => d.name);
    }
    return medications.filter((m) => !m.rxcui).map((m) => m.name);
  }, [unresolvedDrugs, medications]);

  // Baseline = the plan every slot is compared against. The client's
  // current plan when one is on file; otherwise the brain's #1 pick
  // (an AEP shopper with no incumbent still gets a useful diff column).
  // CURRENT ribbon means "this is the client's current plan"; when
  // we've fallen back to scoredPlans[0] the ribbon flips to TOP PICK.
  const baseline: Plan | null = current ?? scoredPlans[0] ?? null;
  const baselineIsCurrent = current != null;

  // Pool = baseline first (always slot 0), then scoredPlans (Top 4),
  // then benchPlans (every other eligible plan in the county). The
  // existing bench memo (`pool - slotIds`) automatically picks up the
  // non-slot plans as bench items — the drag-to-board / H2H mechanic
  // already operates on whatever's in pool, so widening pool widens
  // the bench's reach to the full pool without touching downstream
  // logic. Pre-c7b5954 the pool was scoredPlans only (Top 4); the
  // bench was the leftover ≤3 items not in slots, which felt
  // truncated against an 80-plan county.
  const pool: Plan[] = useMemo(() => {
    const all: Plan[] = [];
    const seen = new Set<string>();
    for (const p of scoredPlans) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      all.push(p);
    }
    for (const p of benchPlans ?? []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      all.push(p);
    }
    if (!baseline) return all;
    const others = all.filter((p) => p.id !== baseline.id);
    return [baseline, ...others];
  }, [baseline, scoredPlans, benchPlans]);

  // ── Stable pool + rankedPlans latch ────────────────────────────────
  // Every re-run of useRankedPlans() briefly nulls ranked.result (Gate 3
  // dropping to 0 survivors on a re-run wipes it entirely). AgentV3App
  // derives scoredPlans + benchPlans from that result, so pool collapses
  // to [] mid-session — which cascades through poolIds → reconciledSlots
  // and wipes the board too. Latch both signals to their last-non-empty
  // value so transient upstream wipes don't clear the broker's workspace.
  const stablePoolRef = useRef<Plan[]>([]);
  if (pool.length > 0) stablePoolRef.current = pool;
  const stablePool = pool.length > 0 ? pool : stablePoolRef.current;

  const stableRankedRef = useRef<LibraryRankPlan[]>([]);
  if (rankedPlans && rankedPlans.length > 0) stableRankedRef.current = rankedPlans;

  const [mode, setMode] = useState<'grid' | 'h2h'>('grid');
  const [challenger, setChallenger] = useState<Plan | null>(null);

  // Summary of Benefits — per-plan drawer opened from a specific
  // board-slot card. Shows that plan's full 4-col benefit grid + per-
  // drug medication cost breakdown for THAT plan. Presentation-only;
  // slot/bench state underneath is untouched when it closes.
  //
  // Bench "Quick preview" is NOT a drawer — it's an inline expander
  // rendered on the bench card itself (restored 2026-08-07 to the
  // pre-slice behavior; see BenchCard's `expanded` state below).
  // Because there's no drawer state to manage for the bench flow,
  // CompareScreen only tracks summaryPlan here.
  // Board-level scored comparison (feat/four-up-scored-comparison).
  // The "Summary of benefits" button on any SlotCell now opens ONE
  // view containing every plan currently on the board — a single
  // toggle rather than per-plan. The click target's plan argument is
  // preserved (unused) so BoardSlotCard's existing onOpenSummary(plan)
  // signature keeps working.
  const [summaryOpen, setSummaryOpen] = useState(false);
  const openSummary = (_p: Plan) => {
    void _p;
    setSummaryOpen(true);
  };

  // ── Bench filter engine (shared between slots + bench) ─────────────
  // Historically the filter engine lived inside Bench and only touched
  // bench cards. That made the board (Top Pick + slots 1-3) ignore
  // active filters entirely — an agent who chose "D-SNP only" still
  // saw non-D-SNP plans in the top slots, which forced them to reload
  // the workspace and manually re-evaluate. Lift the hook to the
  // CompareScreen level so a single filter state drives BOTH the
  // board (via matchedPlanIds) and the bench (via filters.filtered).
  //
  // Seed the initial filter state from intake data. The intent is
  // "start the agent where they were probably going to end up":
  //   • dsnpEligible === true → SNP filter pre-set to ['D-SNP']
  //   • ≥1 provider on file  → Cost & Quality pre-set to
  //                             ['has_docs_in_net']
  //   • priorities includes 'healthy_foods' → 'has_food_card'
  //   • priorities includes 'partb_giveback' → 'part_b_giveback'
  //   • medicaidLevel = 'qmb'  → 'accepts_qmb'
  //   • medicaidLevel = 'slmb' → 'accepts_slmb'
  //   • medicaidLevel = 'qi'   → 'accepts_partial_duals'
  //   • medicaidLevel = 'fbde' → 'accepts_qmb' + 'full_benefit_only'
  //
  // The Medicaid-derived pills are pulled out of the Cost & Quality
  // dropdown entirely (show: false in useBenchFilters) so they only
  // reach state via this seed. They stay dismissible via the standard
  // activeChips row.
  const initialFilterState = useMemo(() => {
    const snp: string[] = [];
    if (client.dsnpEligible === true) snp.push('D-SNP');
    const costQuality: string[] = [];
    if (providers.length > 0) costQuality.push('has_docs_in_net');
    if (priorities?.includes('healthy_foods')) costQuality.push('has_food_card');
    if (priorities?.includes('partb_giveback')) costQuality.push('part_b_giveback');
    // Medicaid-derived auto-pills. QMB/SLMB/QI map 1:1 to the
    // CMS-filed accepted-populations predicates; FBDE gets both
    // accepts_qmb (QMB+ is a member of the FBDE row) and
    // full_benefit_only so the bench narrows to plans built for
    // full duals.
    switch (client.medicaidLevel) {
      case 'qmb':
        costQuality.push('accepts_qmb');
        break;
      case 'slmb':
        costQuality.push('accepts_slmb');
        break;
      case 'qi':
        costQuality.push('accepts_partial_duals');
        break;
      case 'fbde':
        costQuality.push('accepts_qmb');
        costQuality.push('full_benefit_only');
        break;
      default:
        break;
    }
    return { snp, costQuality };
    // Seed is captured once on hook mount (see useBenchFilters). Later
    // changes to client.dsnpEligible or priorities do NOT retroactively
    // rewrite the agent's active filter state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fingerprint of provider→plan 'in' assignments. useSession.providers
  // returns a fresh array reference on every updateProvider call (no
  // shallow selector, and updateProvider maps to a new array even on
  // single-provider patches). Passing that array as a memo dep would
  // re-normalize the bench on every unrelated provider write and
  // cascade through matchedPlanIds / reconciledSlots — defeating the
  // pool ref-latch (see 2039a9e). The fingerprint is a stable primitive
  // that only changes when an actual (provider, plan)='in' pairing
  // gets added or removed, so the count map identity below stays
  // stable across brain re-runs.
  const networkFingerprint = useMemo(() => {
    const entries: string[] = [];
    for (const p of providers) {
      if (!p.networkStatus) continue;
      for (const [planId, status] of Object.entries(p.networkStatus)) {
        if (status === 'in') entries.push(planId);
      }
    }
    entries.sort();
    return entries.join(',');
  }, [providers]);

  const inNetworkCountByPlanId = useMemo(() => {
    const m = new Map<string, number>();
    for (const plan of stablePool) {
      let count = 0;
      for (const p of providers) {
        if (p.networkStatus?.[plan.id] === 'in') count += 1;
      }
      m.set(plan.id, count);
    }
    return m;
    // providers is intentionally omitted — networkFingerprint captures
    // every provider change that could affect the counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [networkFingerprint, stablePool]);

  const filters = useBenchFilters(stablePool, {
    annualDrugByPlanId,
    selectedProviderCount: providers.length,
    inNetworkCountByPlanId,
    initialState: initialFilterState,
  });

  // Bridge to legacy filters debugging — exposes the hook result on
  // the window so Rob can run `__benchFilters.audit()` from devtools
  // without touching React internals. Cleared when the shell unmounts.
  if (typeof window !== 'undefined') {
    (window as unknown as { __benchFilters?: typeof filters }).__benchFilters = filters;
  }

  // Plan IDs that survived every active predicate. Board slots consult
  // this to decide whether to render a card or fall back to the empty
  // drop-target placeholder — a mismatched slot behaves the same as an
  // agent who explicitly cleared that slot.
  const matchedPlanIds = useMemo(
    () => new Set(filters.filtered.map((p) => p.id)),
    [filters.filtered],
  );

  // Slot state — seeded with filter-matching pool plans first so a
  // D-SNP-eligible client's landing view already has D-SNPs on the
  // board without the agent lifting a finger. Captured on mount only;
  // later filter changes don't clobber the agent's slot placements.
  const [slots, setSlots] = useState<(Plan | null)[]>(() =>
    initSlots(pool, matchedPlanIds),
  );

  // Reconcile: any slot whose plan is no longer in the pool becomes
  // null. Bench = pool minus slot occupants.
  // Reconciliation reads stablePool so a transient pool wipe doesn't
  // null every slot occupant (that cascade is what makes visibleSlotPlans
  // collapse in tandem with pool, defeating the whole latch).
  const poolIds = useMemo(() => new Set(stablePool.map((p) => p.id)), [stablePool]);
  const reconciledSlots = useMemo<(Plan | null)[]>(
    () => slots.map((s) => (s && poolIds.has(s.id) ? s : null)),
    [slots, poolIds],
  );
  const slotIds = useMemo(
    () =>
      new Set(
        reconciledSlots.filter((s): s is Plan => !!s).map((s) => s.id),
      ),
    [reconciledSlots],
  );

  const filteredSlots = useMemo<(Plan | null)[]>(
    () => reconciledSlots.map((s) => (s && matchedPlanIds.has(s.id) ? s : null)),
    [reconciledSlots, matchedPlanIds],
  );

  // ── Dev-only convenience: URL-param autofill + auto-open comparison ─
  //
  // Gated on `import.meta.env.DEV` — Vite compile-time constant, always
  // `false` in `vite build` output; the whole branch (including the
  // query-param read and the setter calls) is dead-code-eliminated from
  // the production bundle. Zero prod bytes, zero prod behavior change.
  //
  //   ?autofill=<N>       fills the first N empty board slots (max 4)
  //                       from `pool` once pool becomes non-empty.
  //                       Purpose: initSlots() only runs at mount; when
  //                       pool arrives via async hydration the slots
  //                       stay null and the broker has to click
  //                       "Add to board" four times just to review the
  //                       comparison view. Dev bypasses that noise.
  //   ?view=comparison    opens the BoardComparisonView drawer on load
  //                       once at least one slot is filled.
  //
  // Both fire once per condition-transition, not on every render.
  const autofillCountRef = useRef<number | null>(
    typeof window === 'undefined'
      ? null
      : (() => {
          if (!import.meta.env.DEV) return null;
          const raw = new URLSearchParams(window.location.search).get('autofill');
          const n = raw == null ? null : parseInt(raw, 10);
          return Number.isFinite(n) && n! > 0 ? Math.min(n!, 4) : null;
        })(),
  );
  const autoViewRef = useRef<string | null>(
    typeof window === 'undefined'
      ? null
      : (() => {
          if (!import.meta.env.DEV) return null;
          return new URLSearchParams(window.location.search).get('view');
        })(),
  );
  const autofillFiredRef = useRef(false);
  const autoOpenFiredRef = useRef(false);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const n = autofillCountRef.current;
    if (n == null || autofillFiredRef.current) return;
    if (stablePool.length === 0) return;
    // Only fill slots that are still null — never clobber a plan the
    // agent already placed by hand.
    const allNull = slots.every((s) => s == null);
    if (!allNull) {
      autofillFiredRef.current = true; // agent's already interacted; don't fight them
      return;
    }
    autofillFiredRef.current = true;
    const nextSlots: (Plan | null)[] = [null, null, null, null];
    const source = stablePool;
    for (let i = 0; i < Math.min(n, 4, source.length); i += 1) {
      nextSlots[i] = source[i];
    }
    setSlots(nextSlots);
    console.info(`[dev] autofill: placed ${nextSlots.filter(Boolean).length} plans into empty slots`);
  }, [stablePool, slots]);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (autoOpenFiredRef.current) return;
    if (autoViewRef.current !== 'comparison') return;
    if (filteredSlots.every((s) => s == null)) return; // wait for autofill
    autoOpenFiredRef.current = true;
    setSummaryOpen(true);
    console.info('[dev] view=comparison: opening BoardComparisonView');
  }, [filteredSlots]);

  const visibleSlotPlans = useMemo(
    () => filteredSlots.filter((p): p is Plan => !!p),
    [filteredSlots],
  );

  const bestByMetric = useMemo<Record<string, number | null>>(() => {
    const out: Record<string, number | null> = {};
    for (const m of metrics) out[m.key] = bestNumeric(m, visibleSlotPlans);
    return out;
  }, [metrics, visibleSlotPlans]);

  // ── Empty state ────────────────────────────────────────────
  // Only bail when there's genuinely nothing on screen. During brain
  // re-runs the library can transiently clear scoredPlans/benchPlans
  // (Gate 3 dropping to 0 survivors on a re-run wipes ranked.result),
  // which empties pool — but the board's slot state persists across
  // re-renders. Keep rendering the workspace so the broker still sees
  // the plans they were working with, and let the QuotePanel below
  // fall through to a slot-based fallback.
  console.log('[QuotePanel-debug]', {
    poolLen: pool.length,
    stablePoolLen: stablePool.length,
    visibleSlotPlansLen: visibleSlotPlans.length,
    rankedPlansLen: rankedPlans?.length ?? 'undefined',
    stableRankedLen: stableRankedRef.current.length,
    scoredPlansLen: scoredPlans.length,
    benchPlansLen: benchPlans?.length ?? 'undefined',
    slotsNonNull: slots.filter(Boolean).length,
  });
  if (stablePool.length === 0 && visibleSlotPlans.length === 0) {
    return (
      <Container wide>
        <Header
          title="Your finalists — workspace"
          sub="Brain ranking hasn't returned any plans yet. Check Meds and Providers."
        />
        <Nav onBack={onBack} />
      </Container>
    );
  }

  // Wrap onNext with the AgentBase write-back. Fire-and-forget — the
  // hook handles state, the screen advances immediately. HealthSherpa
  // is NOT opened here; that lives on EnrollScreen after the broker
  // has walked compliance + disclaimers, so we don't strand a live
  // consumer intake tab in the browser mid-call.
  //
  // Also pins the broker's picked plan into session.recommendation so
  // ComplianceScreen and EnrollScreen save the same plan the broker
  // clicked here.
  //
  // ⚠ Never pin the incumbent (current) into session.recommendation —
  // slot 0 of the grid is the baseline column (equal to current when
  // one is on file); an Enroll click there would otherwise cascade
  // through Compliance/Enroll as a "save the plan you already have,"
  // which the brain excludes from ranking. Skip the recommend + let
  // the screen advance so the broker can pick a real candidate.
  const recommendAndAdvance = (plan: Plan | null) => () => {
    if (plan && plan.id !== current?.id) {
      setRecommendation(plan.id);
      onRecommend?.(plan);
    }
    onNext();
  };

  // Per-SlotCell enrollment — same underlying onRecommend, but await
  // the async result so the button can surface success/failure inline.
  // Does NOT advance the screen — the broker stays on the board so they
  // can enroll another plan (e.g. a shared-plan sibling policy) or
  // review the recommendation before moving on.
  const enrollFromCard = (plan: Plan | null) => async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!plan) return { ok: false, error: 'No plan on this slot' };
    setRecommendation(plan.id);
    const result = onRecommend?.(plan);
    // Fire-and-forget legacy callers return void; treat that as success
    // since we have no signal either way. New async callers return the
    // actual outcome from POST /api/agentbase-recommend.
    if (!result || typeof (result as Promise<unknown>).then !== 'function') {
      return { ok: true };
    }
    try {
      return await result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
      return { ok: false, error: message };
    }
  };

  // ── H2H mode ───────────────────────────────────────────────
  if (mode === 'h2h' && challenger && baseline) {
    return (
      <H2HView
        baseline={baseline}
        baselineIsCurrent={baselineIsCurrent}
        challenger={challenger}
        pool={stablePool.filter((p) => p.id !== baseline.id)}
        metrics={metrics}
        annualDrugByPlanId={annualDrugByPlanId}
        unresolvedMedCount={unresolvedMedCount}
        totalMedCount={medications.length}
        unresolvedMedNames={unresolvedMedNames}
        missingNpiCount={missingNpiCount}
        totalProviderCount={providers.length}
        onPickChallenger={setChallenger}
        onBackToGrid={() => setMode('grid')}
        onEnroll={recommendAndAdvance(challenger)}
        onBack={onBack}
      />
    );
  }

  // ── Grid mode handlers ─────────────────────────────────────
  function handleDrop(targetSlotIdx: number, draggedPlanId: string) {
    setSlots((s) => {
      const next = [...s];
      const fromSlotIdx = next.findIndex((p) => p?.id === draggedPlanId);
      const draggedPlan =
        fromSlotIdx >= 0
          ? next[fromSlotIdx]
          : stablePool.find((p) => p.id === draggedPlanId) ?? null;
      if (!draggedPlan) return s;

      const occupant = next[targetSlotIdx];
      next[targetSlotIdx] = draggedPlan;
      if (fromSlotIdx >= 0 && fromSlotIdx !== targetSlotIdx) {
        // Swap: displaced occupant goes back to where the dragged one
        // came from (could be null — collapses to bench).
        next[fromSlotIdx] = occupant;
      }
      return next;
    });
  }

  function clearSlot(slotIdx: number) {
    setSlots((s) => {
      const next = [...s];
      next[slotIdx] = null;
      return next;
    });
  }

  function fillEmptySlot(slotIdx: number) {
    // Fill from the FILTERED bench so "auto-fill" honors whichever
    // constraints the agent set — filling an empty D-SNP-only board
    // with a non-D-SNP plan would just get filtered out again on the
    // next render.
    const candidate = filters.filtered.find((p) => !slotIds.has(p.id));
    if (!candidate) return;
    setSlots((s) => {
      const next = [...s];
      next[slotIdx] = candidate._raw;
      return next;
    });
  }

  // Bench card "Add to board" — drop the plan into the first empty
  // slot. When every slot is occupied, swap with slot 4 (the least-
  // priority position by convention; the displaced plan returns to
  // the bench automatically because the reconciliation memo recomputes
  // bench = pool − slot occupants).
  function addToBoard(plan: Plan) {
    setSlots((s) => {
      const next = [...s];
      // No-op if already on board.
      if (next.some((x) => x?.id === plan.id)) return s;
      const emptyIdx = next.findIndex((x) => x == null);
      if (emptyIdx >= 0) {
        next[emptyIdx] = plan;
      } else {
        next[3] = plan;
      }
      return next;
    });
  }

  function openH2H(plan: Plan) {
    if (!baseline || plan.id === baseline.id) return;
    setChallenger(plan);
    setMode('h2h');
  }

  // Top challenger = first slot plan that isn't the baseline. Headline
  // savings on the navy summary bar are baseline.annual − challenger.annual
  // (positive when the recommendation costs less than what the client has).
  const topChallenger =
    visibleSlotPlans.find((p) => baseline == null || p.id !== baseline.id) ?? null;
  const headlineSavings =
    topChallenger && baseline
      ? (annualEstimate(baseline, annualDrugByPlanId[baseline.id] ?? null).total ?? 0) -
        (annualEstimate(topChallenger, annualDrugByPlanId[topChallenger.id] ?? null).total ?? 0)
      : 0;

  function enterH2HFromToggle() {
    if (topChallenger) openH2H(topChallenger);
  }

  return (
    <Container wide>
      <Header
        title="Your finalists — workspace"
        sub="Drag plans between the bench and the 4-up board, or flip to Head-to-Head for the screen share."
      />

      <DataQualityBanner
        unresolvedMedCount={unresolvedMedCount}
        totalMedCount={medications.length}
        unresolvedMedNames={unresolvedMedNames}
        missingNpiCount={missingNpiCount}
        totalProviderCount={providers.length}
      />

      <ModeToggle
        mode={mode}
        h2hDisabled={!topChallenger}
        onGrid={() => setMode('grid')}
        onH2H={enterH2HFromToggle}
      />

      {/* Pool intelligence bar — 3-row stat strip above the bench.
          Reads directly off brain output that CompareScreen already
          receives (scoredPlans, benchPlans, benchGateResultsByPlanId,
          drugCoverageUnknownByPlanId). No new fetches. */}
      <PoolMetricsBar
        scoredPlans={scoredPlans}
        benchPlans={benchPlans ?? []}
        benchGateResultsByPlanId={benchGateResultsByPlanId ?? {}}
        drugCoverageUnknownByPlanId={drugCoverageUnknownByPlanId}
      />

      <Bench
        filters={filters}
        slotIds={slotIds}
        baseline={baseline}
        annualDrugByPlanId={annualDrugByPlanId}
        ribbonByPlanId={ribbonByPlanId ?? {}}
        gateResultsByPlanId={benchGateResultsByPlanId ?? {}}
        drugBreakdownByPlanId={drugBreakdownByPlanId ?? {}}
        dualEligibleByPlanId={dualEligibleByPlanId}
        providers={providers}
        onAddToBoard={addToBoard}
        onOpenH2H={openH2H}
      />

      {/* Compare v2 reskin (2026-08-05): Part D timeline overlay hidden
          from the Board per product decision. Component kept on disk
          (see ./PartDTimelineOverlay.tsx) — re-enable by wiring the
          block below into the render tree. Same for DrugCostCard /
          ProviderList / WhyThisPlan inside SlotCell; per-plan detail
          lives in the Quick Preview drawer once that ships. */}

      {/* Compare v2: normalize composite score across the currently-
          filled Board slots so the top-ranked plan reads ~100% and
          weaker plans drop off proportionally. Falls back to null when
          the brain hasn't scored the pool yet, and the SlotCell hides
          the circle. */}
      {(() => {
        const inPoolComposites: number[] = filteredSlots
          .map((p) =>
            p && compositeByPlanId ? compositeByPlanId[p.id] : undefined,
          )
          .filter((v): v is number => typeof v === 'number' && v > 0);
        const bestComposite =
          inPoolComposites.length > 0 ? Math.max(...inPoolComposites) : null;
        const confidenceFor = (plan: Plan | null): number | null => {
          if (!plan || !compositeByPlanId || bestComposite == null) return null;
          const c = compositeByPlanId[plan.id];
          if (typeof c !== 'number' || c <= 0) return null;
          return Math.max(0, Math.min(100, Math.round((c / bestComposite) * 100)));
        };
        // "Best match" — mint border + ribbon on the single card the
        // broker is nudging the client toward. When the client has a
        // Current on file, the top challenger (slot 1) wears it; when
        // the baseline is a Top-Pick fallback (no current), slot 0
        // wears it. Empty slots never claim best-match.
        const bestMatchSlotIdx = baselineIsCurrent ? 1 : 0;
        return (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
              gap: 14,
              margin: '14px 0',
            }}
          >
            {filteredSlots.map((plan, i) => (
              <SlotCell
                key={i}
                slotIdx={i}
                plan={plan}
                isBaseline={plan != null && baseline != null && plan.id === baseline.id}
                baselineIsCurrent={baselineIsCurrent}
                baseline={baseline}
                metrics={metrics}
                bestByMetric={bestByMetric}
                providers={providers}
                drugBreakdown={
                  plan != null && drugBreakdownByPlanId
                    ? drugBreakdownByPlanId[plan.id] ?? null
                    : null
                }
                drugCoverageUnknown={
                  plan != null && drugCoverageUnknownByPlanId
                    ? drugCoverageUnknownByPlanId[plan.id] === true
                    : false
                }
                dualEligible={
                  plan != null && dualEligibleByPlanId
                    ? dualEligibleByPlanId[plan.id]
                    : undefined
                }
                explanations={
                  plan != null && explanationsByPlanId
                    ? explanationsByPlanId[plan.id] ?? null
                    : null
                }
                confidence={confidenceFor(plan)}
                isBestMatch={plan != null && i === bestMatchSlotIdx}
                medications={medications}
                lisTier={client.lisTier ?? 'none'}
                drugPhasesByPlanIdRxcui={drugPhases.byPlanIdRxcui}
                drugCostComparisonPlans={drugCostComparisonPlans}
                onDrop={handleDrop}
                onClear={() => clearSlot(i)}
                onFill={() => fillEmptySlot(i)}
                onOpenH2H={openH2H}
                onOpenSummary={openSummary}
                onEnroll={enrollFromCard(plan)}
              />
            ))}
          </div>
        );
      })()}

      {/* Board-level scored comparison — opens from ANY SlotCell's
          "Summary of benefits" button and renders every plan
          currently on the board (2-4 columns). Green = wins on that
          row, red = worse/absent, ties go green without swaying the
          tally. Leader's Take-to-H2H invokes the existing openH2H —
          H2HView itself is not modified. */}
      {summaryOpen && visibleSlotPlans.length > 0 && (
        <BoardComparisonView
          plans={visibleSlotPlans}
          drugBreakdownByPlanId={drugBreakdownByPlanId}
          annualDrugByPlanId={annualDrugByPlanId}
          drugCoverageUnknownByPlanId={drugCoverageUnknownByPlanId}
          onClose={() => setSummaryOpen(false)}
          onTakeToH2H={(plan) => {
            setSummaryOpen(false);
            openH2H(plan);
          }}
          baselineId={baseline?.id ?? null}
        />
      )}

      <SummaryBar
        headline={topChallenger}
        savings={headlineSavings}
        onEnroll={recommendAndAdvance(topChallenger)}
      />

      {(() => {
        // Quadruple fallback so the quote picker never disappears while
        // plans are on screen:
        //   1. rankedPlans — brain's ordering, preferred.
        //   2. latched rankedPlans — last non-empty library result,
        //                    used when the current re-run has cleared
        //                    ranked.result but a prior run had it.
        //   3. stablePool  — baseline + Top-4 + bench (deduped), also
        //                    latched so a transient scoredPlans/benchPlans
        //                    wipe doesn't collapse the fallback.
        //   4. visibleSlotPlans — board slots the broker manually placed,
        //                    used when nothing else has ever populated.
        const brainReady = !!rankedPlans && rankedPlans.length > 0;
        const latched = stableRankedRef.current;
        const quotePlans: LibraryRankPlan[] = brainReady
          ? (rankedPlans as LibraryRankPlan[])
          : latched.length > 0
            ? latched
            : stablePool.length > 0
              ? stablePool.map(planToLibraryRankPlan)
              : visibleSlotPlans.map(planToLibraryRankPlan);
        if (quotePlans.length === 0) return null;
        return (
          <QuotePanel
            rankedPlans={quotePlans}
            sourceIsFallback={!brainReady}
          />
        );
      })()}

      <Nav onBack={onBack} onNext={onNext} nextLabel="CMS Compliance →" />
    </Container>
  );
}

// ── Send Quote panel ────────────────────────────────────────────────
// Collapsed by default — the agent expands it from CompareScreen when
// the prospect is ready to receive a frozen text-message quote. Lives
// here (not in QuoteBuilder.tsx) so the open/close UI matches the rest
// of the Compare workspace; the actual form is QuoteBuilder.

// Plan → LibraryRankPlan bridge for fallback mode. QuoteBuilder only
// reads plan_id / plan_name / carrier / plan_type / premium / star_rating
// off each row (payload med + provider lists come from useSession, not
// from the plan objects), so the other library-only fields get benign
// empties. Keeps the quote flow unblocked when useRankedPlans hasn't
// returned yet — see gate at CompareScreen render site.
function planToLibraryRankPlan(p: Plan): LibraryRankPlan {
  return {
    plan_id: p.id,
    plan_name: p.plan_name,
    carrier: p.carrier,
    plan_type: p.plan_type,
    premium: p.premium,
    moop: p.moop_in_network,
    star_rating: p.star_rating,
    medications: [],
    total_annual_drug_cost: 0,
    meds_covered: 0,
    meds_total: 0,
    providers: [],
    docs_in_network: 0,
    docs_total: 0,
    benefits: {
      dental: null, vision: null, hearing: null, otc: null, fitness: null,
      transportation: null, meals: null, telehealth: null,
      part_b_giveback: null, pcp_copay: null, specialist: null,
      part_d_deductible: null, urgent_care: null, emergency: null,
      inpatient: null, inpatient_mental: null, skilled_nursing: null,
    },
    total_annual_cost: 0,
    slot: null,
    ribbon: null,
    gate_results: { gate1_passed: true, gate2_passed: true, gate3_passed: true },
  };
}

function QuotePanel({
  rankedPlans,
  sourceIsFallback,
}: {
  rankedPlans: LibraryRankPlan[];
  sourceIsFallback: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <div
        style={{
          marginTop: 16,
          padding: 14,
          background: PANEL,
          border: `1px solid ${BORDER}`,
          borderRadius: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>Send a quote</div>
          <div style={{ marginTop: 2, fontSize: 11, color: MUTED }}>
            Text the prospect a frozen comparison of up to 5 plans they can keep.
          </div>
          {sourceIsFallback && (
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                fontStyle: 'italic',
                color: MUTED,
              }}
            >
              Brain ranking still loading — using current on-screen plans.
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{
            padding: '6px 12px',
            borderRadius: 8,
            border: `1px solid ${NAVY}`,
            background: '#fff',
            color: NAVY,
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Open quote builder
        </button>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 16 }}>
      <div
        style={{
          marginBottom: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>Send a quote</div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          style={{
            background: 'transparent',
            border: 'none',
            color: MUTED,
            fontSize: 12,
            textDecoration: 'underline',
            cursor: 'pointer',
          }}
        >
          Hide
        </button>
      </div>
      <QuoteBuilder rankedPlans={rankedPlans} />
    </div>
  );
}

// ── Bench elimination helper ────────────────────────────────────────
// Consumed by BenchCard to label why each bench plan didn't make Top 4.
// Sequential gate semantics: a plan is labeled by the FIRST gate that
// excluded it. Plans that survived every gate but ranked past slot 4 by
// total cost get the softer "Outside Top 4" label.
function eliminationReason(g: {
  gate1_passed: boolean;
  gate2_passed: boolean;
  gate3_passed: boolean;
}): string {
  if (!g.gate1_passed) return 'Provider OON';
  if (!g.gate2_passed) return 'Meds not covered';
  if (!g.gate3_passed) return 'Missing selected extra';
  return 'Outside Top 4';
}

// ── Data quality warning banner ────────────────────────────────
//
// Renders above the grid + H2H mode contents when the session holds
// meds without rxcui or providers without NPI. Drug-coverage and
// network signals rely on those identifiers; without them the brain
// has nothing to match in pm_formulary / pm_provider_network_cache
// and the "Meds covered" / "Doctors in-network" rows correctly
// (but unhelpfully) show 0/N on every plan. Banner explains why and
// points the broker to the upstream screen to fix.
function DataQualityBanner({
  unresolvedMedCount,
  totalMedCount,
  unresolvedMedNames,
  missingNpiCount,
  totalProviderCount,
}: {
  unresolvedMedCount: number;
  totalMedCount: number;
  /** Optional list of the specific drug names that failed rxcui
   *  resolution. Sourced from BrainOutput.unresolvedDrugs when the
   *  brain has scored; falls back to just the count when the brain
   *  hasn't emitted names yet. Rendered inline so the broker knows
   *  which meds to re-pick, not just how many. */
  unresolvedMedNames?: ReadonlyArray<string>;
  missingNpiCount: number;
  totalProviderCount: number;
}) {
  if (unresolvedMedCount === 0 && missingNpiCount === 0) return null;
  return (
    <div
      style={{
        background: '#fffbeb',
        border: '1px solid #fcd34d',
        borderLeft: `4px solid ${GOLD}`,
        borderRadius: 8,
        padding: '10px 14px',
        marginBottom: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
      role="alert"
    >
      <div
        style={{
          fontFamily: FONT_LABEL,
          fontSize: 9,
          fontWeight: 800,
          color: '#92400e',
          letterSpacing: 0.8,
          textTransform: 'uppercase',
        }}
      >
        Data quality — coverage signals unreliable
      </div>
      {unresolvedMedCount > 0 && (
        <div
          style={{
            fontFamily: FONT_LABEL,
            fontSize: 12,
            fontWeight: 600,
            color: '#78350f',
            lineHeight: 1.45,
          }}
        >
          ⚠ {unresolvedMedCount} of {totalMedCount} medication
          {totalMedCount === 1 ? '' : 's'} could not be matched to a drug
          code — <strong>plan rankings do not account for these</strong>.
          Re-select them from the <strong>Meds</strong> tab to include
          them.
          {unresolvedMedNames && unresolvedMedNames.length > 0 && (
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                fontWeight: 500,
                color: '#78350f',
              }}
            >
              Unmatched: {unresolvedMedNames.join(', ')}
            </div>
          )}
        </div>
      )}
      {missingNpiCount > 0 && (
        <div
          style={{
            fontFamily: FONT_LABEL,
            fontSize: 12,
            fontWeight: 600,
            color: '#78350f',
          }}
        >
          ⚠ {missingNpiCount} of {totalProviderCount} provider
          {totalProviderCount === 1 ? '' : 's'} missing NPI — network
          status unavailable. Open the <strong>Providers</strong> screen
          and re-pick from the NPPES search to attach an NPI.
        </div>
      )}
    </div>
  );
}

// ── Mode toggle pill (rendered in grid mode header) ────────────
function ModeToggle({
  mode,
  h2hDisabled,
  onGrid,
  onH2H,
}: {
  mode: 'grid' | 'h2h';
  h2hDisabled: boolean;
  onGrid: () => void;
  onH2H: () => void;
}) {
  const pill = (active: boolean, disabled: boolean): CSSProperties => ({
    background: active ? NAVY : 'white',
    color: active ? 'white' : NAVY,
    border: `1px solid ${active ? NAVY : BORDER}`,
    borderRadius: 18,
    padding: '6px 16px',
    fontFamily: FONT_LABEL,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.4 : 1,
  });
  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        justifyContent: 'center',
        marginBottom: 12,
      }}
    >
      <button type="button" onClick={onGrid} style={pill(mode === 'grid', false)}>
        4-up grid
      </button>
      <button
        type="button"
        onClick={onH2H}
        disabled={h2hDisabled}
        style={pill(mode === 'h2h', h2hDisabled)}
      >
        Head-to-head
      </button>
    </div>
  );
}

// ── Bench (horizontal scrollable pills) ────────────────────────
// Brain ribbon → chip styling. The brain's ribbon pass decorates
// category leaders only; most plans return null. Unknown ribbon
// strings render with the default seafoam treatment so a future brain
// ribbon doesn't blank-render here.
// Compact D-SNP accepted-Medicaid-population chip row for the header
// block of BenchCard / SlotCell. Renders one small badge per entry in
// plan.dsnp_accepted_populations (populated by CMS SNP Comprehensive
// Report ingest); green for full-benefit-dual codes (FBDE / QMB+ /
// SLMB+), amber for partial-benefit codes (QMB / SLMB / QI / QDWI).
// No-op on non-D-SNP plans so the same JSX slot can render every card
// unconditionally.
const FULL_BENEFIT_POPULATIONS = new Set(['FBDE', 'QMB+', 'SLMB+']);
function DsnpPopulationBadges({ plan }: { plan: Plan }) {
  if (plan.snp_type !== 'D-SNP') return null;
  const pops = plan.dsnp_accepted_populations;
  if (!pops || pops.length === 0) return null;
  return (
    <div
      title="Accepted Medicaid populations (CMS SNP Comprehensive Report)"
      style={{
        display: 'flex',
        gap: 4,
        flexWrap: 'wrap',
      }}
    >
      {pops.map((pop) => {
        const full = FULL_BENEFIT_POPULATIONS.has(pop);
        return (
          <span
            key={pop}
            style={{
              // Compare v2: light-fill chip on the new white card.
              // Full-benefit codes (FBDE / QMB+ / SLMB+) get the mint
              // palette; partial-benefit codes (QMB / SLMB / QI / QDWI)
              // get amber to signal "narrower coverage."
              background: full ? T.mint100 : T.amber100,
              color: full ? T.mint700 : T.amber700,
              border: `1px solid ${
                full ? 'rgba(15,158,119,0.35)' : 'rgba(154,91,10,0.30)'
              }`,
              fontFamily: F.label,
              fontSize: 9,
              fontWeight: 700,
              padding: '2px 6px',
              borderRadius: 4,
              letterSpacing: 0.4,
              whiteSpace: 'nowrap',
            }}
          >
            {pop}
          </span>
        );
      })}
    </div>
  );
}

/** Dual-eligible / LIS chip row rendered under DsnpPopulationBadges on
 *  each BenchCard. Reuses the same tiny-chip visual (font, padding,
 *  radius, letter-spacing) with three semantic colors:
 *    green — Medicaid $0 cost-sharing (QMB or FBDE), or partial MSP
 *    blue  — LIS drug cap (shows actual $/$ from lisCopaysApplied)
 *    gold  — Premium paid by Medicaid
 *  Returns null when no adjustment applies. */
function DualEligibleBadges({ adj }: { adj?: DualEligibleAdjustment }) {
  if (!adj) return null;
  const { context, premiumPaidByMedicaid, medicalCostSharingZeroed, lisCopaysApplied } = adj;

  let medicaidLabel: string | null = null;
  if (medicalCostSharingZeroed) {
    medicaidLabel = context.medicaidLevel === 'fbde' ? 'FBDE $0 copays' : 'QMB $0 copays';
  } else if (context.medicaidLevel === 'slmb') {
    medicaidLabel = 'SLMB Part B';
  } else if (context.medicaidLevel === 'qi') {
    medicaidLabel = 'QI Part B';
  }

  let lisLabel: string | null = null;
  if (lisCopaysApplied) {
    if (lisCopaysApplied.generic === 0 && lisCopaysApplied.brand === 0) {
      lisLabel = 'Full LIS $0';
    } else {
      lisLabel = `LIS $${lisCopaysApplied.generic.toFixed(2)}/$${lisCopaysApplied.brand.toFixed(2)}`;
    }
  }

  if (!medicaidLabel && !lisLabel && !premiumPaidByMedicaid) return null;

  const CHIP_BASE: React.CSSProperties = {
    fontFamily: FONT_LABEL,
    fontSize: 8,
    fontWeight: 800,
    padding: '2px 5px',
    borderRadius: 3,
    letterSpacing: 0.4,
    whiteSpace: 'nowrap',
  };
  const GREEN_CHIP: React.CSSProperties = {
    ...CHIP_BASE,
    background: 'rgba(34,197,94,0.22)',
    color: '#a7f3d0',
  };
  const BLUE_CHIP: React.CSSProperties = {
    ...CHIP_BASE,
    background: 'rgba(59,130,246,0.22)',
    color: '#bfdbfe',
  };
  const GOLD_CHIP: React.CSSProperties = {
    ...CHIP_BASE,
    background: 'rgba(245,158,11,0.22)',
    color: '#fde68a',
  };

  return (
    <div
      title="Medicaid / LIS cost adjustment active — costs reflect what the beneficiary actually pays"
      style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 4 }}
    >
      {medicaidLabel && <span style={GREEN_CHIP}>{medicaidLabel}</span>}
      {lisLabel && <span style={BLUE_CHIP}>{lisLabel}</span>}
      {premiumPaidByMedicaid && <span style={GOLD_CHIP}>Premium paid by Medicaid</span>}
    </div>
  );
}

const RIBBON_STYLE: Record<string, { label: string; bg: string; color: string }> = {
  BEST_OVERALL: { label: '★ Top Pick', bg: '#a78bfa', color: 'white' },
  LOWEST_DRUG_COST: { label: 'Lowest Rx', bg: TEAL, color: 'white' },
  LOWEST_OOP: { label: 'Lowest OOP', bg: GOLD, color: 'white' },
  BEST_EXTRAS: { label: 'Best Extras', bg: GREEN, color: 'white' },
  PART_B_SAVINGS: { label: 'Giveback', bg: SEAFOAM, color: NAVY },
  ZERO_PREMIUM: { label: '$0 Premium', bg: '#93c5fd', color: NAVY },
  ALL_MEDS_COVERED: { label: 'All Meds', bg: '#86efac', color: '#14532d' },
  ALL_DOCS_IN_NETWORK: { label: 'All Docs', bg: '#5eead4', color: '#134e4a' },
};

function Bench({
  filters,
  slotIds,
  baseline,
  annualDrugByPlanId,
  ribbonByPlanId,
  gateResultsByPlanId,
  drugBreakdownByPlanId,
  dualEligibleByPlanId,
  providers,
  onAddToBoard,
  onOpenH2H,
}: {
  /** Lifted from CompareScreen so board slots and bench cards apply
   *  the same predicate chain. Bench renders filters.filtered minus
   *  whatever slots currently occupy the board. */
  filters: ReturnType<typeof useBenchFilters>;
  /** Set of plan ids currently on the board. Bench cards are the pool
   *  minus these — same "pool minus slots" partition the CompareScreen
   *  shell has always used, just recomputed from the shared filter
   *  result rather than a separately-filtered bench array. */
  slotIds: Set<string>;
  baseline: Plan | null;
  annualDrugByPlanId: Record<string, number | null>;
  ribbonByPlanId: Record<string, string | null>;
  gateResultsByPlanId: Record<
    string,
    { gate1_passed: boolean; gate2_passed: boolean; gate3_passed: boolean }
  >;
  drugBreakdownByPlanId: Record<string, ReadonlyArray<DrugRow>>;
  dualEligibleByPlanId?: Record<string, DualEligibleAdjustment | undefined>;
  providers: ProviderRow[];
  onAddToBoard: (plan: Plan) => void;
  onOpenH2H: (plan: Plan) => void;
}) {
  // Bench items = filter-matched pool minus whatever's on the board.
  // Bench filter counts still cover the FULL pool (both slot + bench
  // plans) because filters is seeded with the pool in CompareScreen —
  // the count on each chip is more useful when it reflects total
  // supply, not "what's left after slot allocation".
  const benchCards = useMemo(
    () => filters.filtered.filter((p) => !slotIds.has(p.id)),
    [filters.filtered, slotIds],
  );

  const totalBenchInPool = filters.totalCount - slotIds.size;
  if (totalBenchInPool <= 0) {
    return (
      <div
        style={{
          background: PANEL,
          border: `1px dashed ${BORDER}`,
          borderRadius: 10,
          padding: '10px 14px',
          fontFamily: FONT_LABEL,
          fontSize: 11,
          color: MUTED,
        }}
      >
        Bench is empty — every brain-ranked plan is on the board.
      </div>
    );
  }

  return (
    <div>
      <BenchFilterBar filters={filters} />

      <div
        style={{
          display: 'flex',
          gap: 12,
          overflowX: 'auto',
          padding: '12px 2px 12px',
          scrollSnapType: 'x mandatory',
        }}
      >
        {benchCards.length === 0 ? (
          <div
            style={{
              fontFamily: FONT_LABEL,
              fontSize: 11,
              color: MUTED,
              padding: '12px 14px',
              background: PANEL,
              border: `1px dashed ${BORDER}`,
              borderRadius: 10,
              flex: 1,
            }}
          >
            No bench plans match these filters.
          </div>
        ) : (
          benchCards.map((p) => (
            <BenchCard
              key={p.id}
              plan={p._raw}
              baseline={baseline}
              annualDrugByPlanId={annualDrugByPlanId}
              ribbon={ribbonByPlanId[p.id] ?? null}
              gateResults={gateResultsByPlanId[p.id] ?? null}
              drugBreakdown={drugBreakdownByPlanId[p.id] ?? null}
              dualEligible={dualEligibleByPlanId?.[p.id]}
              providers={providers}
              onAddToBoard={onAddToBoard}
              onOpenH2H={onOpenH2H}
            />
          ))
        )}
      </div>
    </div>
  );
}

function BenchCard({
  plan,
  baseline,
  annualDrugByPlanId,
  ribbon,
  gateResults,
  drugBreakdown,
  dualEligible,
  providers,
  onAddToBoard,
  onOpenH2H,
}: {
  plan: Plan;
  baseline: Plan | null;
  annualDrugByPlanId: Record<string, number | null>;
  ribbon: string | null;
  gateResults: { gate1_passed: boolean; gate2_passed: boolean; gate3_passed: boolean } | null;
  drugBreakdown: ReadonlyArray<DrugRow> | null;
  dualEligible?: DualEligibleAdjustment;
  providers: ProviderRow[];
  onAddToBoard: (plan: Plan) => void;
  onOpenH2H: (plan: Plan) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [hover, setHover] = useState(false);

  const drug = annualDrugByPlanId[plan.id] ?? null;
  const baseDrug = baseline ? annualDrugByPlanId[baseline.id] ?? null : null;

  // "Wins vs baseline" — lower-is-better numeric comparison. Used to
  // tint each metric green when this bench plan beats the client's
  // current plan (or fallback top pick).
  const winsLower = (a: number | null, b: number | null) =>
    baseline != null && a != null && b != null && a < b;
  const winsHigher = (a: number | null, b: number | null) =>
    baseline != null && a != null && b != null && a > b;

  const premiumWins = baseline != null && plan.premium < baseline.premium;
  const moopWins = baseline != null && plan.moop_in_network < baseline.moop_in_network;
  const drugWins = winsLower(drug, baseDrug);
  const starsWins = winsHigher(plan.star_rating, baseline?.star_rating ?? null);
  const dentalWins =
    baseline != null &&
    plan.benefits.dental.annual_max > baseline.benefits.dental.annual_max;

  // 6th cell — Doctors in-network when the broker entered providers,
  // otherwise Part B giveback. "Whichever is more notable" per spec.
  const inNetCount = providers.filter(
    (p) => p.networkStatus?.[plan.id] === 'in',
  ).length;
  const showGiveback = providers.length === 0;
  const sixthLabel = showGiveback ? 'Part B back' : 'Docs in-net';
  const sixthValue = showGiveback
    ? plan.part_b_giveback > 0
      ? `$${plan.part_b_giveback}/mo`
      : '—'
    : `${inNetCount}/${providers.length}`;
  const sixthWins = showGiveback
    ? baseline != null && plan.part_b_giveback > baseline.part_b_giveback
    : providers.length > 0 && inNetCount === providers.length;

  const isBaseline = baseline != null && plan.id === baseline.id;
  const ribbonChip = ribbon ? RIBBON_STYLE[ribbon] : null;
  // Elimination chip — labels why this plan didn't make Top 4. Sequential
  // gate semantics: a plan is labeled by the FIRST gate that excluded
  // it. Plans on the bench that passed every gate (the Gate-4 cost
  // ranking pushed them past slot 4) get the softer blue chip.
  const elim = gateResults ? eliminationReason(gateResults) : null;
  const elimSurvived = elim === 'Outside Top 4';
  const showElimChip = elim != null && !isBaseline;

  // Duplicate-carrier suppression for drag tooltip — same fix as
  // SlotCell (Wellcare plan_name filed with carrier prefix would read
  // "Wellcare Wellcare Simple (HMO-POS)" otherwise).
  const carrierStr = plan.carrier ?? '';
  const nameStr = plan.plan_name ?? '';
  const dragDisplayName =
    carrierStr && nameStr.toLowerCase().startsWith(carrierStr.toLowerCase())
      ? nameStr
      : `${carrierStr} ${nameStr}`.trim();

  return (
    <div
      draggable
      onDragStart={(e: DragEvent<HTMLDivElement>) => {
        e.dataTransfer.setData('text/plan-id', plan.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flexShrink: 0,
        minWidth: 216,
        width: 216,
        scrollSnapAlign: 'start',
        background: T.card,
        border: `1px solid ${hover ? T.mint600 : T.line}`,
        borderRadius: 10,
        cursor: 'grab',
        display: 'flex',
        flexDirection: 'column',
      }}
      title={`${dragDisplayName} — drag to a slot`}
    >
      {/* Pre-slice NAVY header band — restored 2026-08-05 (Rob diff'd
          0250c7d and confirmed uniform navy on every carrier; no
          per-carrier palette exists in this repo). Holds elim chip +
          identity + SBF badge; DSNP badges, metric grid, and actions
          continue on the white body below. */}
      <div
        style={{
          background: T.navy950,
          padding: 12,
          borderTopLeftRadius: 9,
          borderTopRightRadius: 9,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        {showElimChip && (
          <span
            style={{
              display: 'inline-block',
              alignSelf: 'flex-start',
              background: elimSurvived ? T.mint100 : T.amber100,
              color: elimSurvived ? T.mint700 : T.amber700,
              fontFamily: F.label,
              fontSize: 8.5,
              fontWeight: 700,
              letterSpacing: 0.6,
              padding: '2px 7px',
              borderRadius: 4,
              textTransform: 'uppercase',
              minWidth: 96,
              textAlign: 'center',
              marginBottom: 2,
            }}
            title={
              elimSurvived
                ? 'Survived every gate — ranked below Top 4 by total cost.'
                : `Eliminated at ${elim?.toLowerCase()}.`
            }
          >
            {elim}
          </span>
        )}

        <p
          style={{
            margin: 0,
            fontFamily: F.label,
            fontSize: 10,
            fontWeight: 700,
            color: T.mintOnDark,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
          }}
        >
          {plan.carrier}
        </p>
        <p
          style={{
            margin: '2px 0 0',
            fontFamily: F.label,
            fontSize: 12,
            fontWeight: 700,
            color: '#FFFFFF',
            lineHeight: 1.25,
            minHeight: 30,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            wordBreak: 'break-word',
          }}
          title={plan.plan_name ?? ''}
        >
          {plan.plan_name}
        </p>
        <p
          style={{
            margin: '2px 0 0',
            fontFamily: F.num,
            fontSize: 9.5,
            color: 'rgba(255,255,255,0.55)',
            letterSpacing: 0.5,
          }}
        >
          {planIdShort(plan.id)}
        </p>
        {plan.sbf_url && (
          <a
            href={plan.sbf_url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{
              display: 'inline-block',
              alignSelf: 'flex-start',
              marginTop: 5,
              background: 'rgba(127,224,196,0.18)',
              color: T.mintOnDark,
              fontFamily: F.label,
              fontSize: 9,
              fontWeight: 700,
              padding: '2px 6px',
              borderRadius: 3,
              textDecoration: 'none',
              letterSpacing: 0.3,
            }}
            title="Summary of Benefits (source PDF)"
          >
            📄 SBF ↗
          </a>
        )}
      </div>

      <div
        style={{
          padding: 13,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {/* D-SNP accepted-population chips — light-fill (mint / amber)
            on the white body. Returns null on non-D-SNP so bench
            spacing collapses cleanly. Restored 2026-08-05. */}
        <DsnpPopulationBadges plan={plan} />

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '6px 10px',
            borderTop: `1px solid ${T.line}`,
            paddingTop: 8,
          }}
        >
        <BMetric
          label="Premium"
          value={
            dualEligible?.premiumPaidByMedicaid && plan.premium > 0
              ? '$0/mo'
              : `$${plan.premium}/mo`
          }
          strike={
            dualEligible?.premiumPaidByMedicaid && plan.premium > 0
              ? `$${plan.premium}/mo`
              : null
          }
        />
        <BMetric label="MOOP" value={fmt(plan.moop_in_network)} />
        <BMetric label="Drug/yr" value={drug == null ? '—' : fmt(drug)} />
        <BMetric
          label="Stars"
          value={plan.star_rating > 0 ? `${plan.star_rating}` : '—'}
        />
        <BMetric label="Dental" value={planDisplay(plan).dentalMax} />
        <BMetric
          label="Part B back"
          value={plan.part_b_giveback > 0 ? `$${plan.part_b_giveback}/mo` : '—'}
        />
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
        {/* Restored 2026-08-07: original pre-slice Quick preview
            behavior — inline expander on the bench card, NOT a
            drawer. Same handler as the pre-a528de6 version at
            CompareScreen.tsx:1989-2010 on commit 0250c7d:
            `onClick={() => setExpanded((v) => !v)}` with the label
            flipping between "Quick preview" and "Hide preview". */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          title="Expand benefit snapshot for this plan"
          style={{
            flex: 1,
            textAlign: 'center',
            fontSize: 10.5,
            fontWeight: 600,
            padding: 7,
            borderRadius: 6,
            border: `1px solid ${T.mint100}`,
            background: T.mint100,
            color: T.mint700,
            cursor: 'pointer',
            fontFamily: F.label,
          }}
        >
          {expanded ? 'Hide preview' : 'Quick preview'}
        </button>
        <button
          type="button"
          onClick={() => onAddToBoard(plan)}
          style={{
            flex: 1,
            textAlign: 'center',
            fontSize: 10.5,
            fontWeight: 600,
            padding: 7,
            borderRadius: 6,
            border: `1px solid ${T.navy950}`,
            background: T.navy950,
            color: '#FFFFFF',
            cursor: 'pointer',
            fontFamily: F.label,
          }}
        >
          Add to board
        </button>
      </div>

      {/* Original pre-slice inline expander body — verbatim 12-row
          list from CompareScreen.tsx:2011-2054 on commit 0250c7d,
          in the same visual order. PreviewRow + InpatientPreviewRow
          were kept on disk in the slice-1+2 void keep-alive; both
          now render inline again with v2 fonts. Inpatient / MH
          inpatient / Skilled nursing use the FULL day-tier ladder
          (per [[feedback_inpatient_full_ladder]] — never collapse).
          Full metric list is intentionally omitted here; this is the
          summary snapshot the pre-slice UI showed, not the H2H view. */}
      {expanded && (
        <div
          style={{
            marginTop: 8,
            borderTop: `1px solid ${T.line}`,
            paddingTop: 8,
          }}
        >
          <PreviewRow label="PCP" value={formatPcp(plan)} />
          <PreviewRow label="Specialist" value={formatSpecialist(plan)} />
          <PreviewRow
            label="Urgent care"
            value={formatCostShareWithRange(plan.benefits.medical.urgent_care, {
              isPdp: plan.plan_type === 'PDP',
            })}
          />
          <PreviewRow
            label="Emergency"
            value={formatCostShareWithRange(plan.benefits.medical.emergency, {
              isPdp: plan.plan_type === 'PDP',
            })}
          />
          <InpatientPreviewRow
            label="Inpatient"
            cs={plan.benefits.medical.inpatient}
          />
          <InpatientPreviewRow
            label="MH inpatient"
            cs={plan.benefits.medical.mental_health_inpatient}
          />
          <InpatientPreviewRow
            label="Skilled nursing"
            cs={plan.benefits.medical.snf}
          />
          <PreviewRow
            label="OTC / qtr"
            value={
              plan.benefits.otc.allowance_per_quarter > 0
                ? `$${plan.benefits.otc.allowance_per_quarter}`
                : '—'
            }
          />
          <PreviewRow label="Vision" value={planDisplay(plan).visionAllowance} />
          <PreviewRow label="Fitness" value={planDisplay(plan).fitness} />
          <PreviewRow
            label="Part B back"
            value={plan.part_b_giveback > 0 ? `$${plan.part_b_giveback}/mo` : '—'}
          />
          <PreviewRow
            label="Part D ded."
            value={plan.drug_deductible == null ? '—' : `$${plan.drug_deductible}`}
          />
        </div>
      )}

      {/* Lint-only reference for props/vars supplied by the callsite
          but not rendered on the card. Shrunk after restoring the
          expander: expanded / setExpanded / drugBreakdown are now
          used above; providers still isn't (bench card has no per-
          provider list). */}
      <span
        style={{ display: 'none' }}
        data-h2h={typeof onOpenH2H}
        data-baseline={String(isBaseline)}
        data-providers={providers.length}
        data-drug-breakdown-len={drugBreakdown?.length ?? 0}
        data-wins={`${premiumWins ? 1 : 0}${moopWins ? 1 : 0}${drugWins ? 1 : 0}${starsWins ? 1 : 0}${dentalWins ? 1 : 0}${sixthWins ? 1 : 0}`}
        data-sixth={`${sixthLabel}:${sixthValue}`}
        data-ribbon-chip={ribbonChip ? '1' : '0'}
      />
      </div>
    </div>
  );
}

// Compact key/value tile for the v2 bench card 2-column metric grid.
function BMetric({
  label,
  value,
  strike,
}: {
  label: string;
  value: string;
  /** Optional pre-adjustment value shown inline in parens with a
   *  strikethrough. Same dual-eligible premium treatment as
   *  MetricLine — kept parenthesized so it reads as an aside on a
   *  216px-wide bench card. */
  strike?: string | null;
}) {
  return (
    <div>
      <span
        style={{
          display: 'block',
          fontSize: 9.5,
          color: T.muted2,
          textTransform: 'uppercase',
          letterSpacing: 0.3,
          fontFamily: F.label,
        }}
      >
        {label}
      </span>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: 4,
          fontSize: 11.5,
          fontWeight: 600,
          fontFamily: F.num,
          color: T.ink,
        }}
      >
        <span>{value}</span>
        {strike && (
          <span
            aria-label={`Original ${label} ${strike} — paid by Medicaid`}
            style={{
              fontSize: 10,
              fontWeight: 500,
              color: T.muted2,
              textDecoration: 'line-through',
              textDecorationColor: T.muted2,
            }}
          >
            ({strike})
          </span>
        )}
      </span>
    </div>
  );
}

function MetricMini({
  label,
  value,
  winning,
  strike,
}: {
  label: string;
  value: string;
  winning: boolean;
  /** Optional pre-adjustment value rendered above `value` with a
   *  strikethrough. Used for the LIS / Medicaid drug + premium
   *  strikethroughs when the client has a dual-eligible adjustment. */
  strike?: string | null;
}) {
  return (
    <div
      style={{
        background: winning ? 'rgba(34,197,94,0.08)' : PANEL,
        borderRadius: 6,
        padding: '5px 7px',
        border: `1px solid ${winning ? 'rgba(34,197,94,0.25)' : BORDER}`,
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontFamily: FONT_LABEL,
          fontSize: 8,
          fontWeight: 700,
          color: MUTED,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {label}
      </div>
      {strike && (
        <div
          style={{
            fontFamily: FONT_NUM,
            fontSize: 9,
            color: MUTED,
            textDecoration: 'line-through',
            fontWeight: 500,
            marginTop: 1,
          }}
        >
          {strike}
        </div>
      )}
      <div
        style={{
          fontFamily: FONT_NUM,
          fontSize: 11,
          fontWeight: 700,
          color: winning ? '#15803d' : TEXT,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </div>
    </div>
  );
}

// Restyled 2026-08-07 for v2 fonts (Inter + IBM Plex Mono via F.label
// / F.num). Colors already matched between old and v2 palettes — MUTED
// and TEXT map to T.muted and T.ink at the same hex values — so the
// row visually integrates with the white v2 bench-card body once it
// renders inline again via the restored Quick preview expander.
function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        padding: '3px 0',
        fontFamily: F.label,
        fontSize: 10,
      }}
    >
      <span style={{ color: T.muted }}>{label}</span>
      <span
        style={{
          fontFamily: F.num,
          fontWeight: 600,
          color: T.ink,
          textAlign: 'right',
          whiteSpace: 'pre-line',
        }}
      >
        {value}
      </span>
    </div>
  );
}

// Inpatient ladder variant — renders the full day-tier breakdown
// (CMS disclosure per [[feedback_inpatient_full_ladder]]). Returns
// null when no description / copay / coinsurance is filed so the row
// disappears instead of showing "—".
function InpatientPreviewRow({ label, cs }: { label: string; cs: CostShare }) {
  const v = formatInpatientLadder(cs.description, cs.copay, cs.coinsurance);
  if (!v) return null;
  return <PreviewRow label={label} value={v} />;
}

// ── Per-provider network list ───────────────────────────────────
// Replaces the old aggregate "Docs in-net: 1/3" cell with a one-line
// summary plus a row per provider. Status badge per row:
//   'in'      → ✓ green   (FHIR/cache confirmed in-network)
//   'out'     → ✗ red     (FHIR/cache confirmed out-of-network)
//   'unknown' → ⚠ amber   (no resolution — broker should call carrier)
// Renders nothing when the broker entered no providers (the rest of
// the card layout already handles that case via the Part-B-giveback
// fallback in the metric grid).
function ProviderList({
  plan,
  providers,
  variant = 'full',
}: {
  plan: Plan;
  providers: ProviderRow[];
  /** 'full' for slot cards (signature + per-row pill); 'compact' for
   *  the 220px bench cards (abbreviated names, smaller pills). */
  variant?: 'full' | 'compact';
}) {
  if (providers.length === 0) return null;
  let inCount = 0;
  let outCount = 0;
  let unknownCount = 0;
  for (const p of providers) {
    const s = p.networkStatus?.[plan.id] ?? 'unknown';
    if (s === 'in') inCount += 1;
    else if (s === 'out') outCount += 1;
    else unknownCount += 1;
  }
  const isCompact = variant === 'compact';
  return (
    <div
      style={{
        padding: isCompact ? '6px 10px 8px' : '8px 10px',
        borderTop: `1px solid ${BORDER}`,
        background: 'white',
        fontFamily: FONT_LABEL,
      }}
    >
      <div
        style={{
          fontSize: isCompact ? 9 : 10,
          fontWeight: 700,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          color: MUTED,
          marginBottom: isCompact ? 4 : 6,
          display: 'flex',
          justifyContent: 'space-between',
          gap: 6,
        }}
      >
        <span>Doctors</span>
        <span style={{ color: inCount === providers.length ? '#15803d' : MUTED }}>
          {inCount}/{providers.length} In-Network
          {outCount > 0 ? ` · ${outCount} out` : ''}
          {unknownCount > 0 ? ` · ${unknownCount} ?` : ''}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: isCompact ? 3 : 4 }}>
        {providers.map((p, i) => {
          const status = (p.networkStatus?.[plan.id] ?? 'unknown') as
            | 'in'
            | 'out'
            | 'unknown';
          const meta =
            status === 'in'
              ? { bg: '#dcfce7', fg: '#15803d', icon: '✓', label: 'In-Network' }
              : status === 'out'
                ? { bg: '#fee2e2', fg: '#991b1b', icon: '✗', label: 'Out-of-Network' }
                : { bg: '#fef3c7', fg: '#92400e', icon: '⚠', label: 'Unverified' };
          return (
            <div
              key={p.id ?? p.name ?? i}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 6,
                fontSize: isCompact ? 10 : 11,
              }}
            >
              <span
                style={{
                  color: TEXT,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {p.name ?? 'Provider'}
              </span>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 3,
                  background: meta.bg,
                  color: meta.fg,
                  fontWeight: 700,
                  fontSize: isCompact ? 9 : 10,
                  padding: isCompact ? '1px 5px' : '2px 6px',
                  borderRadius: 3,
                  whiteSpace: 'nowrap',
                }}
                title={meta.label}
              >
                <span aria-hidden="true">{meta.icon}</span>
                {isCompact ? null : <span>{meta.label}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Per-medication cost breakdown ───────────────────────────────
// Renders the broker-facing answer to "what will the client actually
// pay at the pharmacy for each of their drugs on this plan?". One
// row per user drug with tier + monthly copay + annual cost, ending
// in a TOTAL line. The aggregate "Drug cost / yr" metric row stays
// for fast scanning; this block adds the per-med detail the broker
// quotes from. Renders nothing when the user has no drugs.
function DrugBreakdown({
  breakdown,
  variant = 'full',
}: {
  breakdown: ReadonlyArray<DrugRow>;
  /** 'full' for slot cards (per-med rows + total); 'compact' for
   *  the 220px bench cards (single-line summary). */
  variant?: 'full' | 'compact';
}) {
  if (breakdown.length === 0) return null;
  const covered = breakdown.filter((d) => d.covered).length;
  const total = breakdown.reduce((sum, d) => sum + d.annualCost, 0);
  const isCompact = variant === 'compact';

  if (isCompact) {
    return (
      <div
        style={{
          padding: '6px 10px 8px',
          borderTop: `1px solid ${BORDER}`,
          background: 'white',
          fontFamily: FONT_LABEL,
          fontSize: 10,
          color: MUTED,
          display: 'flex',
          justifyContent: 'space-between',
          gap: 6,
        }}
      >
        <span style={{ fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>
          Drugs
        </span>
        <span
          style={{
            fontFamily: FONT_NUM,
            fontWeight: 700,
            color: covered === breakdown.length ? '#15803d' : TEXT,
          }}
        >
          {fmt(total)}/yr ({covered}/{breakdown.length} covered)
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: '8px 10px',
        borderTop: `1px solid ${BORDER}`,
        background: 'white',
        fontFamily: FONT_LABEL,
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          color: MUTED,
          marginBottom: 6,
          display: 'flex',
          justifyContent: 'space-between',
          gap: 6,
        }}
      >
        <span>Drug costs</span>
        <span style={{ color: covered === breakdown.length ? '#15803d' : MUTED }}>
          {covered}/{breakdown.length} covered
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {breakdown.map((d) => {
          const tierLabel = d.tier != null ? `Tier ${d.tier}` : 'Not covered';
          const copayLabel =
            d.monthlyCopay != null ? `$${d.monthlyCopay}/mo` : '—';
          const annualLabel = `${fmt(d.annualCost)}/yr`;
          return (
            <div
              key={d.rxcui || d.name}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) 60px 70px 70px',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                color: d.covered ? TEXT : '#991b1b',
              }}
            >
              <span
                style={{
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  minWidth: 0,
                }}
                title={d.name}
              >
                {d.name}
              </span>
              <span style={{ color: d.covered ? MUTED : '#991b1b', fontSize: 10 }}>
                {tierLabel}
              </span>
              <span style={{ fontFamily: FONT_NUM, fontSize: 10, textAlign: 'right' }}>
                {copayLabel}
              </span>
              <span
                style={{
                  fontFamily: FONT_NUM,
                  fontSize: 10,
                  fontWeight: 700,
                  textAlign: 'right',
                }}
              >
                {annualLabel}
              </span>
            </div>
          );
        })}
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 6,
          paddingTop: 6,
          borderTop: `1px dashed ${BORDER}`,
          fontSize: 11,
          fontWeight: 700,
          color: TEXT,
        }}
      >
        <span>Total drug cost</span>
        <span style={{ fontFamily: FONT_NUM }}>{fmt(total)}/yr</span>
      </div>
    </div>
  );
}

// ── Slot cell ──────────────────────────────────────────────────
function SlotCell({
  slotIdx,
  plan,
  isBaseline,
  baselineIsCurrent,
  baseline,
  metrics,
  bestByMetric,
  providers,
  drugBreakdown,
  drugCoverageUnknown,
  dualEligible,
  explanations,
  confidence,
  isBestMatch,
  medications,
  lisTier,
  drugPhasesByPlanIdRxcui,
  drugCostComparisonPlans,
  onDrop,
  onClear,
  onFill,
  onOpenH2H,
  onOpenSummary,
  onEnroll,
}: {
  slotIdx: number;
  plan: Plan | null;
  /** True when this slot holds the baseline plan (slot 0). */
  isBaseline: boolean;
  /** True when the baseline is the client's actual current plan (vs.
   *  fallen back to scoredPlans[0] because no current was on file). */
  baselineIsCurrent: boolean;
  /** The plan all challengers are compared against — used for deltas. */
  baseline: Plan | null;
  metrics: Metric[];
  bestByMetric: Record<string, number | null>;
  /** Broker-entered providers + per-plan networkStatus map. Drives the
   *  per-provider list rendered below the metric grid. */
  providers: ProviderRow[];
  /** Per-medication breakdown for this plan. Null when missing — the
   *  DrugBreakdown component renders nothing in that case. */
  drugBreakdown: ReadonlyArray<DrugRow> | null;
  /** Brain flag (mirrored from BrainScore.drugCoverageUnknown) — when
   *  true, the drug-cost row in this slot card renders an amber
   *  "confirm with your pharmacist" disclaimer. */
  drugCoverageUnknown: boolean;
  /** Dual-eligible / LIS cost adjustment for this plan. When present,
   *  the slot header renders DualEligibleBadges under the contract-ID
   *  line to signal the beneficiary's Medicaid / LIS coverage on
   *  every board slot. Absent when the client has no adjustment. */
  dualEligible?: DualEligibleAdjustment;
  /** Per-gate micro-explainer strings for this plan. Null when the
   *  parent didn't supply explanationsByPlanId for this plan id — the
   *  "Why this plan" expander is skipped entirely in that case. */
  explanations: ExplanationsForPlan | null;
  /** Normalized confidence % 0-100 computed at callsite (composite /
   *  best-in-current-Board pool). Null when unavailable — the header's
   *  confidence circle is hidden. */
  confidence: number | null;
  /** True for the single card meant to wear the mint border + "Best
   *  match" / "Top Pick" ribbon. Computed at the callsite so slot
   *  meaning (baseline is Current vs Top-Pick fallback) stays in one
   *  place. */
  isBestMatch: boolean;
  /** Client's medications — DrugCostCard reads dose from these. */
  medications: ReadonlyArray<import('@/types/session').Medication>;
  /** Client's LIS tier. Drives the DrugCostCard banner + per-drug LIS
   *  cap math + totals-row strikethrough. */
  lisTier: import('@/lib/dual-eligible').LisTier;
  /** Phase breakdown map from useDrugPhases (keyed on `${planId}::${rxcui}`). */
  drugPhasesByPlanIdRxcui: ReadonlyMap<string, DrugPhaseHit>;
  /** All plans currently on the Compare board — passed to DrugCostCard
   *  so it can render the "same molecule, different classification"
   *  cross-plan callout without recomputing. */
  drugCostComparisonPlans: ReadonlyArray<DrugCostCardComparisonPlan>;
  onDrop: (slotIdx: number, draggedPlanId: string) => void;
  onClear: () => void;
  onFill: () => void;
  onOpenH2H: (p: Plan) => void;
  /** Opens the per-plan Summary of Benefits drawer at the
   *  CompareScreen level for the plan currently in this slot. Only
   *  wired for filled slots; empty-slot placeholder ignores it. */
  onOpenSummary: (p: Plan) => void;
  /** Async enroll for THIS specific card. Returns the POST result so
   *  the button can surface success ("Sent to AgentBase") or the
   *  server error inline instead of failing silently. Does not advance
   *  the screen — the broker stays on the board. */
  onEnroll: () => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [dragOver, setDragOver] = useState(false);
  // Per-card enrollment status. Auto-resets to idle after 4s on
  // success, 8s on error (longer read time for the message).
  const [enrollStatus, setEnrollStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'sending' }
    | { kind: 'success' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  function onDragOverHandler(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dragOver) setDragOver(true);
  }
  function onDragLeaveHandler() {
    setDragOver(false);
  }
  function onDropHandler(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const id = e.dataTransfer.getData('text/plan-id');
    if (id) onDrop(slotIdx, id);
  }

  // ─── Empty-slot placeholder (Compare v2) ────────────────────────────
  if (!plan) {
    return (
      <div
        onDragOver={onDragOverHandler}
        onDragLeave={onDragLeaveHandler}
        onDrop={onDropHandler}
        onClick={onFill}
        style={{
          background: dragOver ? T.mint100 : T.paper,
          border: `2px dashed ${dragOver ? T.mint600 : T.lineStrong}`,
          borderRadius: 12,
          minHeight: 260,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          fontFamily: F.label,
          fontSize: 12,
          fontWeight: 600,
          color: T.muted,
          textAlign: 'center',
          padding: 16,
        }}
      >
        Drop a plan here · click to auto-fill from bench
      </div>
    );
  }

  // ─── Filled-slot render (Compare v2) ────────────────────────────────
  //
  // Compact white card matching the mockup:
  //   [rank ribbon (best-match only)]
  //   [carrier / plan_name / contract]      [confidence circle]
  //   [why strip — mint (good) or amber (warn)]
  //   [5 summary metrics]
  //   [Quick preview]  [Head-to-head]
  //
  // Removed in this pass (kept on disk, wire back if reversed):
  //   • Navy header block
  //   • DsnpPopulationBadges, DualEligibleBadges
  //   • Full 50-row metric list (see H2HView for the exhaustive view)
  //   • ProviderList, DrugCostCard, WhyThisPlan
  //   • SBF external link
  //   • Enroll button (still available on SummaryBar below the grid)

  const highlight = isBestMatch;
  const rankLabel = isBaseline
    ? baselineIsCurrent
      ? 'CURRENT'
      : 'TOP PICK'
    : isBestMatch
      ? 'BEST MATCH'
      : null;
  const ribbonBg = isBaseline
    ? baselineIsCurrent
      ? '#EF4444' // coral — Current
      : '#F59E0B' // gold — Top Pick fallback
    : T.mint600;
  const ribbonColor = isBaseline ? '#FFFFFF' : T.mintOnMint;

  // Confidence pill styling. Below 75 or null → amber "pending" dots.
  const confidencePending = confidence == null || confidence < 60;
  const confidenceBg = confidencePending ? T.amber100 : T.mint100;
  const confidenceFg = confidencePending ? T.amber700 : T.mint700;
  const confidenceLabel = confidence == null ? '···' : `${confidence}%`;

  // "Why" strip — first hit off the brain's per-gate explanations, in
  // priority order (gate 3 = benefits, gate 2 = drug coverage, gate 1 =
  // provider match). Falls back to a neutral summary when the brain
  // hasn't scored the plan yet.
  const whyText: { text: string; tone: 'good' | 'warn' } = (() => {
    if (drugCoverageUnknown) {
      return { text: 'Drug coverage pending formulary verification', tone: 'warn' };
    }
    if (explanations) {
      if (explanations.gate3?.[0]) return { text: explanations.gate3[0], tone: 'good' };
      if (explanations.gate2?.[0]) return { text: explanations.gate2[0], tone: 'good' };
      if (explanations.gate1?.[0]) return { text: explanations.gate1[0], tone: 'good' };
      if (explanations.gate4) return { text: explanations.gate4, tone: 'good' };
    }
    return { text: 'Ranked by brain score', tone: 'good' };
  })();

  // Est. annual cost — premium × 12 + total drug cost from breakdown.
  // Not LIS-adjusted here (mockup doesn't distinguish); DrugCostCard,
  // if re-enabled, retains the strikethrough treatment.
  const annualDrugSum =
    drugBreakdown != null
      ? drugBreakdown.reduce((s, d) => s + (d.annualCost ?? 0), 0)
      : null;
  const annualEst = annualEstimate(plan, annualDrugSum).total;

  // "Cost pending" gate — when the client has captured meds but the
  // brain's drug-cost pipeline emitted $0 for every drug on this plan
  // AND the plan is a $0-premium D-SNP, annualEst mathematically
  // resolves to $0. That reads as "this plan is free" when the truth
  // is "we don't have data for this drug on this plan" (missing
  // pm_drug_ndc row + missing pm_formulary row — see Part-3 report on
  // fix/preview-extras-and-sbs-comparison for the underlying cause).
  // Consumer approval to display as pending: 2026-08-06.
  const costPending =
    medications.length > 0 &&
    plan.premium <= 0 &&
    (annualDrugSum == null || annualDrugSum <= 0) &&
    annualEst != null &&
    annualEst <= 0;

  // Pull display-formatted metric values from the shared Metric[] so
  // this card stays in sync with H2H formatting (safeCostShare, dental
  // formatter, etc.).
  const findMetric = (key: string) => metrics.find((m) => m.key === key);
  const premiumMetric = findMetric('premium');
  const moopMetric = findMetric('moop');
  const dentalMetric = findMetric('dental');
  const visionMetric = findMetric('vision');
  const starsMetric = findMetric('stars');

  // Duplicate-carrier suppression for the drag tooltip — some CMS
  // filings put the carrier at the start of plan_name (e.g. Wellcare
  // plans file as "Wellcare Simple (HMO-POS)"), so `${carrier} ${name}`
  // reads as "Wellcare Wellcare Simple". Drop the prefix when it's
  // already there. Fixes the 2026-08-05 bug Rob flagged.
  const carrierStr = plan.carrier ?? '';
  const nameStr = plan.plan_name ?? '';
  const dragDisplayName =
    carrierStr && nameStr.toLowerCase().startsWith(carrierStr.toLowerCase())
      ? nameStr
      : `${carrierStr} ${nameStr}`.trim();

  return (
    <div
      draggable
      onDragStart={(e: DragEvent<HTMLDivElement>) => {
        e.dataTransfer.setData('text/plan-id', plan.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={onDragOverHandler}
      onDragLeave={onDragLeaveHandler}
      onDrop={onDropHandler}
      style={{
        position: 'relative',
        // Drop-target tint edges out the base white when the broker
        // is holding a bench plan over the slot.
        background: dragOver && !highlight ? T.mint100 : T.card,
        border: highlight
          ? `2px solid ${T.mint600}`
          : `1px solid ${dragOver ? T.mint600 : T.line}`,
        borderRadius: 12,
        display: 'flex',
        flexDirection: 'column',
        cursor: 'grab',
      }}
      title={`${dragDisplayName} — drag to swap slots`}
    >
      {rankLabel && (
        <span
          style={{
            position: 'absolute',
            top: -9,
            left: 14,
            zIndex: 2,
            background: ribbonBg,
            color: ribbonColor,
            fontFamily: F.label,
            fontSize: 10,
            fontWeight: 700,
            padding: '3px 9px',
            borderRadius: 20,
            letterSpacing: 0.3,
            whiteSpace: 'nowrap',
          }}
        >
          {rankLabel}
        </span>
      )}

      {/* Pre-slice NAVY header band — restored 2026-08-05 after Rob
          diffed 0250c7d and confirmed the pre-slice card had a solid
          navy strip at top (uniform across carriers — no per-carrier
          palette exists in this repo). Holds identity + SBF badge +
          confidence circle + X clear button. All slice-1+2 white-body
          content (why-strip, DSNP, metric list, actions) continues
          unchanged below. */}
      <div
        style={{
          background: T.navy950,
          padding: '12px 14px',
          position: 'relative',
          borderTopLeftRadius: 11,
          borderTopRightRadius: 11,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 8,
        }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          aria-label="Remove plan from board"
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            background: 'rgba(255,255,255,0.12)',
            border: 'none',
            color: '#FFFFFF',
            borderRadius: 5,
            width: 22,
            height: 22,
            cursor: 'pointer',
            fontSize: 13,
            lineHeight: 1,
            padding: 0,
            zIndex: 1,
          }}
        >
          ✕
        </button>

        <div style={{ minWidth: 0, flex: 1, paddingRight: 28 }}>
          <p
            style={{
              margin: '0 0 3px',
              fontFamily: F.label,
              fontSize: 10.5,
              fontWeight: 700,
              color: T.mintOnDark,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
            }}
          >
            {plan.carrier}
          </p>
          <p
            style={{
              margin: 0,
              fontFamily: F.label,
              fontSize: 13,
              fontWeight: 700,
              color: '#FFFFFF',
              lineHeight: 1.25,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              wordBreak: 'break-word',
            }}
            title={plan.plan_name ?? ''}
          >
            {plan.plan_name}
          </p>
          <p
            style={{
              margin: '3px 0 0',
              fontFamily: F.num,
              fontSize: 10,
              color: 'rgba(255,255,255,0.55)',
              letterSpacing: 0.5,
            }}
          >
            {planIdShort(plan.id)}
          </p>
          {plan.sbf_url && (
            <a
              href={plan.sbf_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{
                display: 'inline-block',
                marginTop: 6,
                background: 'rgba(127,224,196,0.18)',
                color: T.mintOnDark,
                fontFamily: F.label,
                fontSize: 9,
                fontWeight: 700,
                padding: '2px 6px',
                borderRadius: 3,
                textDecoration: 'none',
                letterSpacing: 0.3,
              }}
              title="Summary of Benefits (source PDF)"
            >
              📄 SBF ↗
            </a>
          )}
        </div>
        <div
          aria-label={confidence == null ? 'Confidence pending' : `Confidence ${confidence}%`}
          style={{
            width: 34,
            height: 34,
            borderRadius: '50%',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: F.label,
            fontSize: 10,
            fontWeight: 700,
            background: confidenceBg,
            color: confidenceFg,
            marginTop: 2,
          }}
        >
          {confidenceLabel}
        </div>
      </div>

      <div
        style={{
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div
          style={{
            fontSize: 11.5,
            padding: '7px 10px',
            borderRadius: 7,
            lineHeight: 1.4,
            background: whyText.tone === 'good' ? T.mint100 : T.amber100,
            color: whyText.tone === 'good' ? T.mint700 : T.amber700,
            cursor: 'default',
          }}
        >
          {whyText.text}
        </div>

        {/* D-SNP accepted-population badges — mint chips for full-benefit
            codes (FBDE / QMB+ / SLMB+), amber for partial-benefit codes
            (QMB / SLMB / QI / QDWI). Returns null on non-D-SNP so the
            slot spacing collapses cleanly. Restored 2026-08-05 after the
            v2 header rewrite dropped the render site. */}
        <DsnpPopulationBadges plan={plan} />

        <div
          style={{
            borderTop: `1px solid ${T.line}`,
            paddingTop: 9,
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
          }}
        >
        <MetricLine
          label="Premium"
          value={
            dualEligible?.premiumPaidByMedicaid && plan.premium > 0
              ? '$0/mo'
              : premiumMetric
                ? premiumMetric.format(plan)
                : '—'
          }
          strike={
            dualEligible?.premiumPaidByMedicaid && plan.premium > 0
              ? `$${plan.premium}/mo`
              : null
          }
        />
        <MetricLine
          label="Est. annual cost"
          value={
            annualEst != null
              ? `$${Math.round(annualEst).toLocaleString('en-US')}`
              : '—'
          }
          pending={costPending || annualEst == null}
          pendingLabel={costPending ? 'Cost pending' : undefined}
        />
        <MetricLine
          label="MOOP"
          value={moopMetric ? moopMetric.format(plan) : '—'}
        />
        <MetricLine
          label="Dental / vision"
          value={`${dentalMetric ? dentalMetric.format(plan) : '—'} / ${
            visionMetric ? visionMetric.format(plan) : '—'
          }`}
        />
        <MetricLine
          label="Star rating"
          value={starsMetric ? starsMetric.format(plan) : '—'}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenSummary(plan);
          }}
          title="Open the full Summary of Benefits drawer for this plan, including per-drug cost breakdown"
          style={{
            flex: 1,
            textAlign: 'center',
            fontSize: 11.5,
            fontWeight: 600,
            padding: 8,
            borderRadius: 7,
            border: `1px solid ${T.lineStrong}`,
            color: T.ink,
            background: T.card,
            cursor: 'pointer',
            fontFamily: F.label,
          }}
        >
          Summary of benefits
        </button>
        <button
          type="button"
          onClick={() => onOpenH2H(plan)}
          disabled={isBaseline || !baseline}
          style={{
            flex: 1,
            textAlign: 'center',
            fontSize: 11.5,
            fontWeight: 600,
            padding: 8,
            borderRadius: 7,
            border: `1px solid ${T.navy950}`,
            color: '#FFFFFF',
            background: T.navy950,
            cursor: isBaseline || !baseline ? 'not-allowed' : 'pointer',
            opacity: isBaseline || !baseline ? 0.4 : 1,
            fontFamily: F.label,
          }}
          title={isBaseline ? 'This is the baseline plan' : 'Open head-to-head'}
        >
          Head-to-head
        </button>
        <EnrollCardButton
          status={enrollStatus}
          disabled={isBaseline && baselineIsCurrent}
          disabledTitle={
            isBaseline && baselineIsCurrent
              ? "This is the client's current plan — no re-enrollment needed"
              : undefined
          }
          onClick={async (e) => {
            e.stopPropagation();
            setEnrollStatus({ kind: 'sending' });
            const result = await onEnroll();
            if (result.ok) {
              setEnrollStatus({ kind: 'success' });
              window.setTimeout(() => setEnrollStatus({ kind: 'idle' }), 4000);
            } else {
              setEnrollStatus({ kind: 'error', message: result.error });
              window.setTimeout(() => setEnrollStatus({ kind: 'idle' }), 8000);
            }
          }}
        />
      </div>

      {/* Compare v2: the params below are still supplied by the
          callsite even though the reskin doesn't render them (Enroll
          moved to SummaryBar; ProviderList / DrugCostCard / WhyThisPlan
          hidden pending the Quick Preview drawer). Reference them here
          so noUnusedLocals stays happy — cheap and reversible. */}
        <span
          style={{ display: 'none' }}
          data-enroll-handler={typeof onEnroll}
          data-providers={providers.length}
          data-medications={medications.length}
          data-lis-tier={String(lisTier)}
          data-drug-phases={drugPhasesByPlanIdRxcui.size}
          data-drug-comparison={drugCostComparisonPlans.length}
          data-best-by-metric={Object.keys(bestByMetric).length}
        />
      </div>
    </div>
  );
}

// Per-SlotCell Enroll button. Secondary styling (transparent, mint
// outline) so it doesn't dominate the card — Summary of benefits and
// Head-to-head are the primary reads. Renders 4 states inline:
//   • idle    — "Enroll" (mint outline)
//   • sending — "Sending…" (mint outline, disabled, italic)
//   • success — "Sent to AgentBase ✓" (mint filled)
//   • error   — "Enroll failed" + message on hover title (red outline)
//
// Auto-reset to idle after 4s (success) / 8s (error) handled by the
// callsite. Disabled when the plan IS the client's current plan — no
// re-enrollment needed there.
type EnrollStatus =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'success' }
  | { kind: 'error'; message: string };
function EnrollCardButton({
  status,
  disabled,
  disabledTitle,
  onClick,
}: {
  status: EnrollStatus;
  disabled: boolean;
  disabledTitle?: string;
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const isBusy = status.kind === 'sending';
  const isSuccess = status.kind === 'success';
  const isError = status.kind === 'error';
  const label =
    status.kind === 'sending'
      ? 'Sending…'
      : status.kind === 'success'
        ? 'Sent to AgentBase ✓'
        : status.kind === 'error'
          ? 'Enroll failed — retry'
          : 'Enroll';
  const bg = isSuccess ? T.mint600 : 'transparent';
  const color = isSuccess ? T.mintOnMint : isError ? '#B91C1C' : T.mint600;
  const border = isError ? '#B91C1C' : T.mint600;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || isBusy}
      title={
        isError
          ? `Enroll failed: ${status.message} — click to retry`
          : disabled
            ? disabledTitle
            : 'Enroll this plan for the client — writes to AgentBase clients + queues the session in the ⚡ PlanMatch approval list'
      }
      style={{
        flex: 1,
        textAlign: 'center',
        fontSize: 11.5,
        fontWeight: 600,
        padding: 8,
        borderRadius: 7,
        border: `1px solid ${border}`,
        color,
        background: bg,
        cursor: disabled || isBusy ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        fontStyle: isBusy ? 'italic' : 'normal',
        fontFamily: F.label,
        transition: 'background 120ms, border-color 120ms, color 120ms',
      }}
    >
      {label}
    </button>
  );
}

// Compact key/value row used by the v2 SlotCell metric list. Kept
// local (not exported) — H2H and Bench have their own row primitives
// with different typography.
function MetricLine({
  label,
  value,
  pending,
  pendingLabel,
  strike,
}: {
  label: string;
  value: string;
  pending?: boolean;
  /** Text shown in place of `value` when `pending` is true. Defaults
   *  to 'Cost pending' — unified across surfaces so the async-load and
   *  data-missing states read the same way on board cards + the
   *  comparison view. */
  pendingLabel?: string;
  /** Optional pre-adjustment value shown inline in parens with a
   *  strikethrough. Used for dual-eligible premium ($0 vs original
   *  $68) so brokers can point at "Medicaid pays this" during a
   *  screen-share without hiding what CMS filed. */
  strike?: string | null;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        fontSize: 12,
        fontFamily: F.label,
        gap: 6,
      }}
    >
      <span style={{ color: T.muted }}>{label}</span>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: 5,
          minWidth: 0,
        }}
      >
        {strike && (
          <span
            aria-label={`Original ${label} ${strike} — paid by Medicaid`}
            style={{
              fontFamily: F.num,
              fontSize: 10.5,
              fontWeight: 500,
              color: T.muted2,
              textDecoration: 'line-through',
              textDecorationColor: T.muted2,
            }}
          >
            ({strike})
          </span>
        )}
        <span
          style={{
            fontFamily: F.num,
            fontWeight: pending ? 500 : 600,
            fontStyle: pending ? 'italic' : 'normal',
            color: pending ? T.muted2 : T.ink,
          }}
        >
          {pending ? (pendingLabel ?? 'Cost pending') : value}
        </span>
      </span>
    </div>
  );
}

// ── Per-gate micro-explainer ───────────────────────────────────
//
// Collapsible "Why this plan" section that sits inside each SlotCell
// below the metrics + provider list + drug breakdown. Strings come
// from BrainScore.explanations (built by plan-brain-explanations.ts);
// each row gets a green ✓ / red ✗ / amber ⚠ chip via
// classifyExplanation. Gate 4 (cost rank) is a single line at the
// bottom of the expanded panel with no icon.
//
// Independent of the SlotCell's own state — broker can open the
// "Why this plan" panel without expanding any other section.
function WhyThisPlan({ explanations }: { explanations: ExplanationsForPlan }) {
  const [open, setOpen] = useState(false);

  const hasGateItems =
    explanations.gate1.length + explanations.gate2.length + explanations.gate3.length > 0;
  const hasGate4 = typeof explanations.gate4 === 'string' && explanations.gate4.length > 0;
  if (!hasGateItems && !hasGate4) return null;

  const summary = summarizeExplanations(explanations.gate1, explanations.gate2);
  const headerSummary = summary || (hasGate4 ? explanations.gate4 : 'Gate-by-gate detail');

  const colorsForState = (state: 'pass' | 'fail' | 'unverified') => {
    if (state === 'pass') return { bg: 'rgba(34,197,94,0.12)', fg: GREEN, icon: '✓' };
    if (state === 'fail') return { bg: 'rgba(239,68,68,0.12)', fg: CORAL, icon: '✗' };
    return { bg: 'rgba(245,158,11,0.14)', fg: GOLD, icon: '⚠' };
  };

  const renderRow = (text: string, key: string) => {
    const c = colorsForState(classifyExplanation(text));
    return (
      <li
        key={key}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          marginBottom: 6,
          fontSize: 12,
          lineHeight: 1.4,
          color: TEXT,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            flex: '0 0 16px',
            width: 16,
            height: 16,
            borderRadius: 8,
            background: c.bg,
            color: c.fg,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 10,
            fontWeight: 700,
            marginTop: 1,
          }}
        >
          {c.icon}
        </span>
        <span style={{ flex: 1 }}>{text}</span>
      </li>
    );
  };

  const renderSection = (
    label: string,
    items: ReadonlyArray<string>,
    keyPrefix: string,
  ) => {
    if (items.length === 0) return null;
    return (
      <div style={{ marginBottom: 10 }}>
        <div
          style={{
            fontFamily: FONT_LABEL,
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: MUTED,
            marginBottom: 5,
          }}
        >
          {label}
        </div>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {items.map((t, i) => renderRow(t, `${keyPrefix}-${i}`))}
        </ul>
      </div>
    );
  };

  return (
    <div
      style={{
        padding: '8px 12px 10px',
        borderTop: `1px solid ${BORDER}`,
        background: 'white',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 0',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          color: TEXT,
          fontFamily: FONT_LABEL,
        }}
      >
        <span style={{ flex: 1, fontSize: 12, lineHeight: 1.35 }}>
          <span style={{ fontWeight: 700, marginRight: 6 }}>Why this plan</span>
          <span style={{ color: MUTED, fontWeight: 400 }}>· {headerSummary}</span>
        </span>
        <span
          aria-hidden="true"
          style={{
            fontSize: 11,
            color: MUTED,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.2s ease',
            flexShrink: 0,
          }}
        >
          ▾
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${BORDER}` }}>
          {renderSection('Providers', explanations.gate1, 'g1')}
          {renderSection('Medications', explanations.gate2, 'g2')}
          {renderSection('Benefit priorities', explanations.gate3, 'g3')}
          {hasGate4 && (
            <div>
              <div
                style={{
                  fontFamily: FONT_LABEL,
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: MUTED,
                  marginBottom: 5,
                }}
              >
                Cost rank
              </div>
              <div style={{ fontSize: 12, color: TEXT, lineHeight: 1.4 }}>
                {explanations.gate4}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function cardBtn(variant: 'primary' | 'outline' | 'ghost'): CSSProperties {
  const base: CSSProperties = {
    fontFamily: FONT_LABEL,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    border: 'none',
    borderRadius: 7,
    padding: '8px 0',
    cursor: 'pointer',
  };
  if (variant === 'primary') {
    return { ...base, background: NAVY, color: 'white' };
  }
  if (variant === 'outline') {
    return {
      ...base,
      background: 'white',
      color: NAVY,
      border: `1px solid ${BORDER}`,
    };
  }
  return { ...base, background: 'transparent', color: MUTED };
}

// ── Metric row inside a slot ───────────────────────────────────
function MetricRow({
  metric,
  plan,
  baseline,
  isBaseline,
  best,
  drugCoverageUnknown,
}: {
  metric: Metric;
  plan: Plan;
  baseline: Plan | null;
  /** True when this row is in the baseline slot — suppresses the
   *  delta-vs-self arrow (always 0). */
  isBaseline: boolean;
  best: number | null;
  /** True only on the 'drugs' row, only when the brain flagged this
   *  plan with drugCoverageUnknown. Renders an amber inline disclaimer
   *  below the value. */
  drugCoverageUnknown?: boolean;
}) {
  const num = metric.numeric(plan);
  const isBest = best != null && num != null && num === best;
  const dir = isBaseline ? null : deltaVs(metric, plan, baseline);
  const deltaLabel = isBaseline ? null : deltaText(metric, plan, baseline);

  const arrow = dir === 'better' ? '▲' : dir === 'worse' ? '▼' : null;
  const arrowColor = dir === 'better' ? GREEN : dir === 'worse' ? CORAL : MUTED;

  return (
    <div
      style={{
        padding: '5px 6px',
        background: isBest ? 'rgba(34,197,94,0.08)' : 'transparent',
        borderRadius: 6,
        marginBottom: 2,
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto',
          gap: 8,
          alignItems: 'center',
        }}
      >
        <div
          style={{
            fontFamily: FONT_LABEL,
            fontSize: 10,
            fontWeight: 600,
            color: MUTED,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
          }}
        >
          {metric.label}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
          <span
            style={{
              fontFamily: FONT_NUM,
              fontSize: 12,
              fontWeight: 700,
              color: isBest ? '#15803d' : TEXT,
              whiteSpace: 'pre-line',
              textAlign: 'right',
            }}
          >
            {metric.format(plan)}
          </span>
          {arrow && deltaLabel && (
            <span
              style={{
                fontFamily: FONT_NUM,
                fontSize: 9,
                fontWeight: 700,
                color: arrowColor,
                background:
                  dir === 'better'
                    ? 'rgba(34,197,94,0.1)'
                    : dir === 'worse'
                      ? 'rgba(239,68,68,0.1)'
                      : 'transparent',
                padding: '1px 5px',
                borderRadius: 4,
                whiteSpace: 'nowrap',
              }}
            >
              {arrow} {deltaLabel}
            </span>
          )}
        </div>
      </div>
      {drugCoverageUnknown && (
        <div
          role="note"
          style={{
            marginTop: 4,
            padding: '5px 8px',
            background: 'rgba(245,158,11,0.12)',
            border: '1px solid rgba(245,158,11,0.45)',
            borderRadius: 5,
            fontFamily: FONT_LABEL,
            fontSize: 9.5,
            fontWeight: 600,
            color: '#92400e',
            lineHeight: 1.3,
          }}
        >
          Drug coverage estimated — confirm with your pharmacist before enrolling
        </div>
      )}
    </div>
  );
}

// ── Summary bar (grid mode footer) ─────────────────────────────
function SummaryBar({
  headline,
  savings,
  onEnroll,
}: {
  headline: Plan | null;
  savings: number;
  onEnroll: () => void;
}) {
  if (!headline) return null;
  return (
    <div
      style={{
        background: NAVY,
        color: 'white',
        borderRadius: 12,
        padding: '14px 18px',
        display: 'flex',
        gap: 16,
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: FONT_LABEL,
            fontSize: 9,
            fontWeight: 700,
            color: SEAFOAM,
            textTransform: 'uppercase',
            letterSpacing: 0.8,
          }}
        >
          Recommended
        </div>
        <div
          style={{
            fontFamily: FONT_LABEL,
            fontSize: 16,
            fontWeight: 700,
          }}
        >
          {headline.carrier} · {headline.plan_name}
        </div>
      </div>
      {savings > 0 && (
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              fontFamily: FONT_LABEL,
              fontSize: 9,
              fontWeight: 700,
              color: SEAFOAM,
              textTransform: 'uppercase',
              letterSpacing: 0.8,
            }}
          >
            Annual savings
          </div>
          <div
            style={{
              fontFamily: FONT_NUM,
              fontSize: 22,
              fontWeight: 700,
              color: GREEN,
            }}
          >
            {fmt(savings)}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={onEnroll}
        style={{
          background: GREEN,
          color: 'white',
          border: 'none',
          borderRadius: 10,
          padding: '12px 22px',
          fontFamily: FONT_LABEL,
          fontSize: 13,
          fontWeight: 800,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          cursor: 'pointer',
        }}
      >
        Enroll →
      </button>
    </div>
  );
}

// ── H2H mode view ──────────────────────────────────────────────
function H2HView({
  baseline,
  baselineIsCurrent,
  challenger,
  pool,
  metrics,
  annualDrugByPlanId,
  unresolvedMedCount,
  totalMedCount,
  unresolvedMedNames,
  missingNpiCount,
  totalProviderCount,
  onPickChallenger,
  onBackToGrid,
  onEnroll,
  onBack,
}: {
  baseline: Plan;
  baselineIsCurrent: boolean;
  challenger: Plan;
  pool: Plan[];
  metrics: Metric[];
  annualDrugByPlanId: Record<string, number | null>;
  unresolvedMedCount: number;
  totalMedCount: number;
  unresolvedMedNames: ReadonlyArray<string>;
  missingNpiCount: number;
  totalProviderCount: number;
  onPickChallenger: (p: Plan) => void;
  onBackToGrid: () => void;
  onEnroll: () => void;
  onBack: () => void;
}) {
  const baseAnnual = annualEstimate(baseline, annualDrugByPlanId[baseline.id] ?? null).total ?? 0;
  const chAnnual = annualEstimate(challenger, annualDrugByPlanId[challenger.id] ?? null).total ?? 0;
  const savings = baseAnnual - chAnnual;

  let wins = 0;
  let losses = 0;
  for (const m of metrics) {
    const d = deltaVs(m, challenger, baseline);
    if (d === 'better') wins += 1;
    else if (d === 'worse') losses += 1;
  }
  const baselineLabel = baselineIsCurrent ? 'Current' : 'Top Pick';
  const baselineColor = baselineIsCurrent ? CORAL : GOLD;

  return (
    <Container wide>
      <Header
        title="Head to Head"
        sub="Side-by-side view tuned for the screen share."
      />

      <DataQualityBanner
        unresolvedMedCount={unresolvedMedCount}
        totalMedCount={totalMedCount}
        unresolvedMedNames={unresolvedMedNames}
        missingNpiCount={missingNpiCount}
        totalProviderCount={totalProviderCount}
      />

      <div
        style={{
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          marginBottom: 14,
          alignItems: 'center',
        }}
      >
        <span
          style={{
            fontFamily: FONT_LABEL,
            fontSize: 9,
            fontWeight: 700,
            color: MUTED,
            textTransform: 'uppercase',
            letterSpacing: 0.6,
            marginRight: 4,
          }}
        >
          Challenger
        </span>
        {pool.map((p) => {
          const active = p.id === challenger.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onPickChallenger(p)}
              style={{
                background: active ? NAVY : 'white',
                color: active ? 'white' : NAVY,
                border: `1px solid ${active ? NAVY : BORDER}`,
                borderRadius: 16,
                padding: '5px 12px',
                fontFamily: FONT_LABEL,
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
                letterSpacing: 0.3,
              }}
            >
              {p.carrier}
            </button>
          );
        })}
      </div>

      <div
        style={{
          background: 'white',
          border: `1px solid ${BORDER}`,
          borderRadius: 12,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 110px 1fr',
            background: NAVY,
            color: 'white',
            padding: '14px 18px',
            alignItems: 'center',
          }}
        >
          <div style={{ textAlign: 'right' }}>
            <div
              style={{
                fontFamily: FONT_LABEL,
                fontSize: 9,
                fontWeight: 700,
                color: baselineColor,
                textTransform: 'uppercase',
                letterSpacing: 0.8,
              }}
            >
              {baselineLabel}
            </div>
            <div
              style={{
                fontFamily: FONT_LABEL,
                fontSize: 14,
                fontWeight: 700,
              }}
            >
              {baseline.carrier}
            </div>
            <div
              style={{
                fontFamily: FONT_LABEL,
                fontSize: 11,
                color: 'rgba(255,255,255,0.7)',
              }}
            >
              {baseline.plan_name}
            </div>
            <a
              href={baseline.sbf_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{
                display: 'inline-block',
                marginTop: 4,
                background: 'rgba(131,240,249,0.15)',
                color: SEAFOAM,
                fontSize: 9,
                fontWeight: 700,
                padding: '2px 6px',
                borderRadius: 3,
                textDecoration: 'none',
                letterSpacing: 0.3,
              }}
            >
              📄 SBF ↗
            </a>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: '50%',
                background: NAVY,
                color: SEAFOAM,
                border: `2px solid ${SEAFOAM}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: FONT_LABEL,
                fontWeight: 800,
                fontSize: 18,
                letterSpacing: 1,
              }}
            >
              VS
            </div>
          </div>
          <div style={{ textAlign: 'left' }}>
            <div
              style={{
                fontFamily: FONT_LABEL,
                fontSize: 9,
                fontWeight: 700,
                color: SEAFOAM,
                textTransform: 'uppercase',
                letterSpacing: 0.8,
              }}
            >
              Recommended
            </div>
            <div
              style={{
                fontFamily: FONT_LABEL,
                fontSize: 14,
                fontWeight: 700,
              }}
            >
              {challenger.carrier}
            </div>
            <div
              style={{
                fontFamily: FONT_LABEL,
                fontSize: 11,
                color: 'rgba(255,255,255,0.7)',
              }}
            >
              {challenger.plan_name}
            </div>
            <a
              href={challenger.sbf_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{
                display: 'inline-block',
                marginTop: 4,
                background: 'rgba(131,240,249,0.15)',
                color: SEAFOAM,
                fontSize: 9,
                fontWeight: 700,
                padding: '2px 6px',
                borderRadius: 3,
                textDecoration: 'none',
                letterSpacing: 0.3,
              }}
            >
              📄 SBF ↗
            </a>
          </div>
        </div>

        {(() => {
          // Bucket metrics by their group so a single header row precedes
          // each section. Group order is fixed by METRIC_GROUP_ORDER;
          // within a group, metric order is preserved from buildMetrics().
          const byGroup = new Map<MetricGroup, Metric[]>();
          for (const m of metrics) {
            const arr = byGroup.get(m.group) ?? [];
            arr.push(m);
            byGroup.set(m.group, arr);
          }
          let zebra = 0;
          const chunks: ReactElement[] = [];
          for (const g of METRIC_GROUP_ORDER) {
            const groupMetrics = byGroup.get(g);
            if (!groupMetrics || groupMetrics.length === 0) continue;
            chunks.push(
              <div
                key={`group-${g}`}
                style={{
                  padding: '10px 18px 6px',
                  background: '#f1f5f9',
                  borderTop: `1px solid ${BORDER}`,
                  fontFamily: FONT_LABEL,
                  fontSize: 10,
                  fontWeight: 800,
                  color: NAVY,
                  textTransform: 'uppercase',
                  letterSpacing: 0.8,
                }}
              >
                {METRIC_GROUP_LABEL[g]}
              </div>,
            );
            for (const m of groupMetrics) {
              const dir = deltaVs(m, challenger, baseline);
              const deltaLabel = deltaText(m, challenger, baseline);
              const arrow = dir === 'better' ? '▲' : dir === 'worse' ? '▼' : null;
              const winBg =
                dir === 'better'
                  ? 'rgba(34,197,94,0.08)'
                  : dir === 'worse'
                    ? 'rgba(239,68,68,0.06)'
                    : 'transparent';
              const rowIdx = zebra++;
              chunks.push(
                <div
                  key={m.key}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 110px 1fr',
                    background: rowIdx % 2 === 0 ? 'white' : '#fcfcfd',
                    borderTop: `1px solid ${BORDER}`,
                  }}
                >
                  <div
                    style={{
                      padding: '12px 18px',
                      textAlign: 'right',
                      fontFamily: FONT_NUM,
                      fontSize: 14,
                      fontWeight: 600,
                      color: TEXT,
                      whiteSpace: 'pre-line',
                    }}
                  >
                    {m.format(baseline)}
                  </div>
                  <div
                    style={{
                      padding: '12px 8px',
                      textAlign: 'center',
                      background: '#fafafa',
                      fontFamily: FONT_LABEL,
                      fontSize: 10,
                      fontWeight: 700,
                      color: MUTED,
                      textTransform: 'uppercase',
                      letterSpacing: 0.6,
                      borderLeft: `1px solid ${BORDER}`,
                      borderRight: `1px solid ${BORDER}`,
                    }}
                  >
                    {m.label}
                  </div>
                  <div
                    style={{
                      padding: '12px 18px',
                      textAlign: 'left',
                      fontFamily: FONT_NUM,
                      fontSize: 14,
                      fontWeight: 600,
                      color: TEXT,
                      background: winBg,
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span style={{ whiteSpace: 'pre-line' }}>{m.format(challenger)}</span>
                    {arrow && deltaLabel && (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 3,
                          fontFamily: FONT_NUM,
                          fontSize: 10,
                          fontWeight: 800,
                          color: dir === 'better' ? '#0a5c3a' : '#991b1b',
                          background:
                            dir === 'better'
                              ? 'rgba(34,197,94,0.18)'
                              : 'rgba(239,68,68,0.15)',
                          border: `1px solid ${
                            dir === 'better'
                              ? 'rgba(34,197,94,0.45)'
                              : 'rgba(239,68,68,0.35)'
                          }`,
                          padding: '2px 8px',
                          borderRadius: 999,
                          letterSpacing: 0.3,
                          whiteSpace: 'nowrap',
                          alignSelf: 'flex-start',
                        }}
                      >
                        {arrow} {deltaLabel}
                      </span>
                    )}
                  </div>
                </div>,
              );
            }
          }
          return chunks;
        })()}
      </div>

      <div
        style={{
          marginTop: 14,
          background: NAVY,
          color: 'white',
          borderRadius: 12,
          padding: '14px 18px',
          display: 'flex',
          gap: 16,
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <div
            style={{
              fontFamily: FONT_LABEL,
              fontSize: 9,
              fontWeight: 700,
              color: SEAFOAM,
              textTransform: 'uppercase',
              letterSpacing: 0.8,
              marginBottom: 4,
            }}
          >
            Verdict
          </div>
          <div style={{ display: 'flex', gap: 3 }}>
            {Array.from({ length: wins }).map((_, i) => (
              <span
                key={`w${i}`}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: GREEN,
                  display: 'inline-block',
                }}
              />
            ))}
            {Array.from({ length: losses }).map((_, i) => (
              <span
                key={`l${i}`}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: CORAL,
                  display: 'inline-block',
                }}
              />
            ))}
          </div>
          <div
            style={{
              fontFamily: FONT_LABEL,
              fontSize: 11,
              color: 'rgba(255,255,255,0.75)',
              marginTop: 4,
            }}
          >
            {challenger.carrier} wins {wins}, {baselineLabel.toLowerCase()} wins {losses}
          </div>
        </div>
        {savings > 0 && (
          <div style={{ textAlign: 'center' }}>
            <div
              style={{
                fontFamily: FONT_LABEL,
                fontSize: 9,
                fontWeight: 700,
                color: SEAFOAM,
                textTransform: 'uppercase',
                letterSpacing: 0.8,
              }}
            >
              Annual savings
            </div>
            <div
              style={{
                fontFamily: FONT_NUM,
                fontSize: 24,
                fontWeight: 700,
                color: GREEN,
              }}
            >
              {fmt(savings)}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={onBackToGrid}
            style={{
              background: 'rgba(255,255,255,0.12)',
              color: 'white',
              border: '1px solid rgba(255,255,255,0.25)',
              borderRadius: 10,
              padding: '12px 18px',
              fontFamily: FONT_LABEL,
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              letterSpacing: 0.5,
              textTransform: 'uppercase',
            }}
          >
            Keep {baselineLabel}
          </button>
          <button
            type="button"
            onClick={onEnroll}
            style={{
              background: GREEN,
              color: 'white',
              border: 'none',
              borderRadius: 10,
              padding: '12px 22px',
              fontFamily: FONT_LABEL,
              fontSize: 13,
              fontWeight: 800,
              letterSpacing: 0.6,
              textTransform: 'uppercase',
              cursor: 'pointer',
            }}
          >
            Enroll →
          </button>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 16,
        }}
      >
        <button
          type="button"
          onClick={onBack}
          style={{
            background: 'transparent',
            color: NAVY,
            border: `1.5px solid rgba(13,47,94,0.15)`,
            borderRadius: 9,
            padding: '10px 18px',
            fontFamily: FONT_LABEL,
            fontSize: 12,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={onBackToGrid}
          style={{
            background: 'transparent',
            color: NAVY,
            border: `1.5px solid rgba(13,47,94,0.15)`,
            borderRadius: 9,
            padding: '10px 18px',
            fontFamily: FONT_LABEL,
            fontSize: 12,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          4-up grid →
        </button>
      </div>
    </Container>
  );
}

// ─── Compare v2 keep-alive ─────────────────────────────────────────────
// The reskin dropped several file-local render helpers from the current
// render tree — DualEligibleBadges, MetricMini, InpatientPreviewRow,
// ProviderList, DrugBreakdown, WhyThisPlan, cardBtn, MetricRow. All
// still valuable (Quick Preview drawer + rollback path) so they stay
// defined above. `noUnusedLocals` would otherwise error; this single
// void reference satisfies it without exporting them or scattering
// pragma comments across the file. DsnpPopulationBadges was restored
// to SlotCell + BenchCard on 2026-08-05 and is not listed here.
void [
  DualEligibleBadges,
  MetricMini,
  ProviderList,
  DrugBreakdown,
  WhyThisPlan,
  cardBtn,
  MetricRow,
];
