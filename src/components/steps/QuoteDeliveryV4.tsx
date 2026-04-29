// QuoteDeliveryV4 — column-per-plan side-by-side comparison table.
//
// Layout: pixel-perfect rebuild from e812a28 (no <colgroup>, fixed
// pixel widths inline on the <thead> row, every body cell carries
// its column's background inline). Layout/CSS unchanged from the
// static commit — this commit wires real data sources behind the
// existing visual.
//
// Data sources:
//   • Plan Brain (usePlanBrain) — composite ranking + ribbons.
//     Drives column-variant assignment:
//       LOWEST_DRUG_COST / BEST_OVERALL → 'best_rx' (navy)
//       LOWEST_OOP                       → 'lowest_oop' (teal)
//       PART_B_SAVINGS                   → 'giveback' (leaf)
//   • useDrugCosts — primes /api/drug-costs and writes through to
//     pm_drug_cost_cache. Used for the Total Rx Cost row.
//   • PlanBrainData.drugCostCache + ndcByRxcui + formularyByContractPlan
//     — per-drug per-plan cost lookup (lookupDrugCost helper).
//   • Plan.benefits.medical — per-plan medical copays.
//   • Plan.benefits.{dental,vision,hearing,otc,food_card,fitness} +
//     part_b_giveback — extras + plan costs rows.
//   • Provider.networkStatus + manualOverrides — per-(provider,plan)
//     network status with the agent's override layer winning.
//   • useManufacturerAssistance — PAP help section under the table.
//
// Baseline for delta badges:
//   • If session.currentPlanId is set → that's column 1, gray.
//   • Otherwise the first plan column (Best Rx) is the baseline; its
//     delta vs itself is 0 so no badge renders, every other column
//     compares against it.
//
// Layout rules preserved verbatim from the rebuild brief:
//   • <div style={{ overflowX: 'auto' }}> wrapping a <table> with
//     borderCollapse + tableLayout: 'fixed' + minWidth = 200 + N×180.
//   • NO <colgroup>, no percentages. Column widths set inline on
//     the first <th>/<td>s of <thead>; with table-layout: fixed those
//     widths apply to every row.
//   • Every <tr> emits exactly 1 <th> + columns.length <td>s
//     (section headers use colspan).
//   • Background colors INLINE on every <td> — not via class.
//   • Header cells navy / teal / leaf with white text.
//   • Fonts: Fraunces serif for plan names + section titles,
//     JetBrains Mono for dollar amounts, Inter for body.
//   • Delta badges inline on every cell that differs from baseline.
//   • Total Annual Value navy strip with green dollar amounts.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Plan } from '@/types/plans';
import type { Client, Medication, Provider } from '@/types/session';
import { useSession } from '@/hooks/useSession';
import { usePlanBrain } from '@/hooks/usePlanBrain';
import { useDrugCosts, lookupPlanCost } from '@/hooks/useDrugCosts';
import {
  useManufacturerAssistance,
  type AssistanceRow,
} from '@/hooks/useManufacturerAssistance';
import { findPlan } from '@/lib/cmsPlans';
import { CurrentPlanPicker } from '@/components/picker/CurrentPlanPicker';
import {
  formatDental,
  formatVision,
  formatHearing,
  formatOtc,
  formatFoodCard,
} from '@/lib/extractBenefitValue';
import type {
  PlanBrainData,
  RibbonKey,
  ScoredPlan,
  WeightProfile,
} from '@/lib/plan-brain-types';
import type { Condition, DetectedCondition } from '@/lib/condition-detector';
import { hasRedFlag, leadingReason } from '@/lib/broker-rules';
import { formatRealAnnualCostBreakdown } from '@/lib/utilization-model';
import { usePrintableQuote } from '@/hooks/usePrintableQuote';
import type { PrintableQuote } from '@/lib/quotePdf';
import { useAgentBaseRecommend } from '@/hooks/useAgentBaseRecommend';
import { useAgentBaseSyncSnapshot } from '@/hooks/useAgentBaseSyncSnapshot';
import { BROKER } from '@/lib/constants';
import { buildSunfireRecommendationText } from '@/lib/clipboardFormat';

// Single source of truth for the SunFire workspace URL — see
// src/lib/constants.ts BROKER.sunfire. The previous in-file constant
// pointed to the wrong path (/yourmedicare/) and had drifted from the
// licensed-broker URL (/medicareadvocates/).
const SUNFIRE_URL = BROKER.sunfire;
const MAX_FINALIST_COLUMNS = 4;
const DEFAULT_INPATIENT_DAYS = 5;
const BRAIN_VERSION = 'v4.1';

// Weight preset buttons — drive `weightOverride` into usePlanBrain.
// Spec: 5 buttons. Click → recompute composite for each finalist →
// re-sort comparison columns by composite descending → re-emit
// `[quote-v4]` console snapshot. Custom is the neutral 33/34/33 fallback;
// the rest map directly to the preset table in the v4 brief.
type WeightPresetKey = 'balanced' | 'drug' | 'low_medical' | 'extras' | 'custom';

const WEIGHT_PRESETS: Record<WeightPresetKey, { label: string; weights: WeightProfile }> = {
  balanced:    { label: 'Balanced',    weights: { drug: 0.50, oop: 0.30, extras: 0.20 } },
  drug:        { label: 'Drug focused', weights: { drug: 0.70, oop: 0.20, extras: 0.10 } },
  low_medical: { label: 'Low medical', weights: { drug: 0.20, oop: 0.60, extras: 0.20 } },
  extras:      { label: 'Extras heavy', weights: { drug: 0.15, oop: 0.15, extras: 0.70 } },
  custom:      { label: 'Custom',      weights: { drug: 0.33, oop: 0.34, extras: 0.33 } },
};
const PRESET_ORDER: WeightPresetKey[] = ['balanced', 'drug', 'low_medical', 'extras', 'custom'];

type PharmacyFill = 'retail_30' | 'mail_90';

// ─── Color tokens ──────────────────────────────────────────────────
const COL = {
  navyHeader: '#0c447c',
  navyBody:   '#e6f1fb',
  tealHeader: '#0f6e56',
  tealBody:   '#e1f5ee',
  leafHeader: '#3b6d11',
  leafBody:   '#eaf3de',
  currentHeader: '#e5e7eb',
  currentBody:   '#f5f4f0',
  summaryNavy:   '#1a2744',
  summaryGreen:  '#5dca5a',
  saveBg: '#eaf3de', saveText: '#3b6d11',
  moreBg: '#fcebeb', moreText: '#a32d2d',
  white: '#fff',
  ink:   '#1f2937',
  inkSub:'#4b5563',
  rule:  '#e5e7eb',
  ruleStrong: '#374151',
  panelBg: '#fafaf7',
};

const FONT = {
  serif: "'Fraunces', Georgia, serif",
  body:  "'Inter', system-ui, -apple-system, sans-serif",
  mono:  "'JetBrains Mono', monospace",
};

// V4 spec color tokens — used by the new client-context bar, weight
// presets, weight readout, and footer per the QuoteDeliveryV4 brief.
// Distinct from COL above (which is the legacy column-variant palette
// for the table itself); kept side-by-side rather than merged so a
// future visual refresh can swap one without disturbing the other.
const V4 = {
  navy:        '#0d2f5e',
  navyLight:   '#1e4a7a',
  teal:        '#14b8a6',
  seafoam:     '#67e8f9',
  green:       '#22c55e',
  gold:        '#f59e0b',
  coral:       '#ef4444',
  bgGray:      '#f1f5f9',
  border:      '#e2e8f0',
  textPrimary: '#0f172a',
  textMuted:   '#64748b',
};

// ─── Tier badge palette (V4 spec) ──────────────────────────────────
const TIER_BADGE: Record<number, { bg: string; fg: string }> = {
  1: { bg: '#eaf3de', fg: '#3b6d11' },   // green
  2: { bg: '#e1f5ee', fg: '#0f6e56' },   // teal
  3: { bg: '#e6f1fb', fg: '#0c447c' },   // blue
  4: { bg: '#faeeda', fg: '#854f0b' },   // amber
  5: { bg: '#faece7', fg: '#993c1d' },   // coral
  6: { bg: '#fcebeb', fg: '#a32d2d' },   // red
};

// ─── Column variants ───────────────────────────────────────────────
type ColumnVariant = 'current' | 'best_rx' | 'lowest_oop' | 'giveback' | 'normal';

interface ColumnDef {
  id: string;
  variant: ColumnVariant;
  ribbon: string | null;
  carrier: string;
  planName: string;
  hNumber: string;
  star: number;
  starColor?: string;
  /** Real Plan reference — added when wiring data so subsequent
   *  per-row computations (med costs, copays, etc.) can pull from
   *  plan.benefits + lookup tables. */
  plan: Plan;
  scored: ScoredPlan | null;
}

interface ColumnStyle {
  headerBg: string;
  headerFg: string;
  bodyBg: string | undefined;     // undefined = no inline bg (white)
  bodyFg: string;
}

function styleFor(variant: ColumnVariant): ColumnStyle {
  switch (variant) {
    case 'current':
      return { headerBg: COL.currentHeader, headerFg: COL.ink, bodyBg: COL.currentBody, bodyFg: COL.ink };
    case 'best_rx':
      return { headerBg: COL.navyHeader, headerFg: COL.white, bodyBg: COL.navyBody, bodyFg: COL.ink };
    case 'lowest_oop':
      return { headerBg: COL.tealHeader, headerFg: COL.white, bodyBg: COL.tealBody, bodyFg: COL.ink };
    case 'giveback':
      return { headerBg: COL.leafHeader, headerFg: COL.white, bodyBg: COL.leafBody, bodyFg: COL.ink };
    case 'normal':
      return { headerBg: '#f3f4f6', headerFg: COL.ink, bodyBg: undefined, bodyFg: COL.ink };
  }
}

const CONDITION_LABEL: Record<Condition, string> = {
  diabetes: 'diabetes',
  chf: 'CHF (heart failure)',
  copd: 'COPD',
  ckd: 'CKD (kidney)',
  hypertension: 'high blood pressure',
  afib: 'AFib',
};

const CONFIDENCE_BG: Record<DetectedCondition['confidence'], { bg: string; fg: string; border: string }> = {
  certain:  { bg: '#fcebeb', fg: '#a32d2d', border: '#f3c5c5' },
  likely:   { bg: '#faeeda', fg: '#854f0b', border: '#ecd2a2' },
  possible: { bg: '#f3f4f6', fg: '#4b5563', border: '#d1d5db' },
};

const RIBBON_LABEL: Record<string, string> = {
  BEST_OVERALL:        '⭐ Best Overall',
  LOWEST_DRUG_COST:    '⭐ Best Rx Match',
  LOWEST_OOP:          '⭐ Lowest OOP',
  BEST_EXTRAS:         '⭐ Best Extras',
  ALL_DOCS_IN_NETWORK: '✓ All in-network',
  PART_B_SAVINGS:      '⭐ Part B Giveback',
  ZERO_PREMIUM:        '$0 Premium',
  ALL_MEDS_COVERED:    '✓ All meds covered',
};

// ─── Per-render row shapes ─────────────────────────────────────────
// Each row's arrays are length === columns.length (1..MAX_FINALIST_COLUMNS).

interface MedRow {
  id: string;
  name: string;
  fillNote: string;
  tiers: (number | null)[];
  values: string[];
  monthly: (number | null)[];
  /** Per-cell provenance — drives the rendering between actual,
   *  estimate (with asterisk + tooltip), unavailable (em dash),
   *  and excluded. Length matches columns.length. */
  sources: ('cache' | 'formulary' | 'tier_estimate' | 'unavailable' | 'excluded' | 'no_rxcui')[];
  paStFlags: Array<{ pa?: boolean; st?: boolean } | null>;
}

interface ProviderRow {
  id: string;
  name: string;
  specialty: string;
  status: Array<'in' | 'out' | 'unknown'>;
}

interface CopayRow {
  label: string;
  values: string[];
  numbers: (number | null)[];
  suffix?: string;
  betterIsHigher?: boolean;
}

// ─── Component ─────────────────────────────────────────────────────

interface Props {
  finalists: Plan[];
  client: Client;
  medications: Medication[];
  providers: Provider[];
  recommendation?: string | null;
  onRecommend?: (id: string | null) => void;
}

export function QuoteDeliveryV4({
  finalists,
  client,
  medications,
  providers,
  recommendation,
  onRecommend,
}: Props) {
  const currentPlanId = useSession((s) => s.currentPlanId);
  const isAnnualReview = useSession((s) => s.isAnnualReview);
  const [pharmacyFill, setPharmacyFill] = useState<PharmacyFill>('retail_30');
  const [pickerOpen, setPickerOpen] = useState(false);
  // Weight preset — drives weightOverride for usePlanBrain. null lets
  // the archetype-derived weights win (default behavior). Clicking a
  // preset overrides; "Custom" returns to the neutral 33/34/33.
  const [presetKey, setPresetKey] = useState<WeightPresetKey | null>(null);

  // Annual Review (AEP) prompt: when the broker has flipped into AEP
  // mode but the session has no current plan pinned, the benchmark
  // column is missing and the comparison is meaningless. Auto-open
  // the CurrentPlanPicker so the broker can resolve immediately.
  // Drives the prominent prompt rendered above the pharmacy toggle.
  useEffect(() => {
    if (isAnnualReview && !currentPlanId) {
      setPickerOpen(true);
    }
  }, [isAnnualReview, currentPlanId]);

  // Plan Brain — composite ranking + per-axis scores + ribbons.
  // weightOverride lets the broker swap presets at quote time without
  // redoing intake. null → archetype-derived defaults win.
  const weightOverride = useMemo<WeightProfile | null>(
    () => (presetKey ? WEIGHT_PRESETS[presetKey].weights : null),
    [presetKey],
  );
  const { result, data: brainData, loading } = usePlanBrain({
    plans: finalists,
    client,
    medications,
    providers,
    weightOverride,
  });

  // Live drug-cost prime — hits /api/drug-costs and writes back to
  // pm_drug_cost_cache. byPlanId.<plan.id>.annual_cost is the
  // authoritative Total Rx Cost for the client's full prescription set.
  const drugCosts = useDrugCosts(
    finalists,
    medications,
    pharmacyFill === 'mail_90' ? 'mail' : 'retail',
  );

  // Manufacturer assistance — drives the help section under the table.
  const assistance = useManufacturerAssistance(medications);

  const currentPlan = useMemo<Plan | null>(
    () => (currentPlanId ? findPlan(currentPlanId) : null),
    [currentPlanId],
  );

  // ── Column selection: ribbon-driven, coverage-filtered ────────────
  // 1. Current plan (if session has one) → 'current' (gray).
  //    Always rendered — it's the benchmark, even if no formulary data.
  // 2. LOWEST_DRUG_COST or BEST_OVERALL ribbon → 'best_rx' (navy)
  // 3. LOWEST_OOP ribbon → 'lowest_oop' (teal)
  // 4. PART_B_SAVINGS ribbon → 'giveback' (leaf)
  // 5. Backfill remaining slots up to MAX_FINALIST_COLUMNS=4 with
  //    'normal' variant by composite descending.
  //
  // Comparison columns 2-5 are pre-filtered to plans whose formulary
  // has coverage for at least one of the client's medications. A
  // column where every drug row would render '—' is useless for
  // comparison — drop it and pick the next-best Plan Brain result.
  // Wellcare H1914-011 is the canonical case: present in pm_plans
  // and pm_plan_benefits but missing from pm_formulary entirely.
  const columns = useMemo<ColumnDef[]>(() => {
    const cols: ColumnDef[] = [];
    const used = new Set<string>();

    if (currentPlan) {
      const inFinalist = result?.scored.find((s) => s.plan.id === currentPlan.id) ?? null;
      cols.push(makeCol(currentPlan, inFinalist, 'current'));
      used.add(currentPlan.id);
    }

    // Coverage check — does the plan have ANY pm_formulary rows for
    // ANY of the medications (after expansion)? When meds are empty
    // OR brainData hasn't loaded yet, default to "yes" so the
    // initial render isn't blank.
    const planHasCoverage = (plan: Plan): boolean => {
      if (medications.length === 0) return true;
      if (!brainData) return true;
      const cp = `${plan.contract_id}-${plan.plan_number}`;
      const slot = brainData.formularyByContractPlan[cp];
      if (!slot) return false;
      return medications.some((m) => !!m.rxcui && !!slot[m.rxcui]);
    };

    // Disqualified plans (e.g. all-providers-out from the red-flag
    // engine) are excluded from comparison columns. They stay on the
    // result.scored list — the broker can still see them in audit
    // mode — but they're not eligible for the navy/teal/leaf slots.
    const allRanked = result
      ? [...result.scored].filter((s) => !s.disqualified).sort((a, b) => b.composite - a.composite)
      : [];
    // Prefer covered plans for comparison columns. If NONE are
    // covered (data gap across the entire finalist set) fall back
    // to the unfiltered list so the table doesn't render with zero
    // comparison columns.
    const coveredRanked = allRanked.filter((s) => planHasCoverage(s.plan));
    const ranked = coveredRanked.length > 0 ? coveredRanked : allRanked;

    const pickByRibbon = (...ribbons: RibbonKey[]): ScoredPlan | null => {
      for (const r of ribbons) {
        const hit = ranked.find((s) => s.ribbon === r && !used.has(s.plan.id));
        if (hit) return hit;
      }
      return null;
    };

    // Best Rx
    const bestRx =
      pickByRibbon('LOWEST_DRUG_COST', 'BEST_OVERALL') ??
      ranked.find((s) => !used.has(s.plan.id)) ??
      null;
    if (bestRx && cols.length < MAX_FINALIST_COLUMNS) {
      cols.push(makeCol(bestRx.plan, bestRx, 'best_rx'));
      used.add(bestRx.plan.id);
    }

    // Lowest OOP
    let lowestOop = pickByRibbon('LOWEST_OOP');
    if (!lowestOop) {
      lowestOop = ranked
        .filter((s) => !used.has(s.plan.id))
        .reduce<ScoredPlan | null>(
          (best, s) =>
            best == null || s.totalOOPEstimate < best.totalOOPEstimate ? s : best,
          null,
        );
    }
    if (lowestOop && cols.length < MAX_FINALIST_COLUMNS) {
      cols.push(makeCol(lowestOop.plan, lowestOop, 'lowest_oop'));
      used.add(lowestOop.plan.id);
    }

    // Part B Giveback
    let giveback = pickByRibbon('PART_B_SAVINGS');
    if (!giveback) {
      giveback = ranked
        .filter((s) => !used.has(s.plan.id) && (s.plan.part_b_giveback ?? 0) > 0)
        .reduce<ScoredPlan | null>(
          (best, s) =>
            best == null || (s.plan.part_b_giveback ?? 0) > (best.plan.part_b_giveback ?? 0) ? s : best,
          null,
        );
    }
    if (giveback && cols.length < MAX_FINALIST_COLUMNS) {
      cols.push(makeCol(giveback.plan, giveback, 'giveback'));
      used.add(giveback.plan.id);
    }

    // Backfill normal columns
    for (const s of ranked) {
      if (cols.length >= MAX_FINALIST_COLUMNS) break;
      if (used.has(s.plan.id)) continue;
      cols.push(makeCol(s.plan, s, 'normal'));
      used.add(s.plan.id);
    }
    return cols;
  }, [currentPlan, result, brainData, medications]);

  // ── Per-row data (computed once per render) ───────────────────────
  // Baseline column for delta badges:
  //   • If session has a current plan → that's the leftmost column.
  //   • Otherwise the first plan column (typically Best Rx) is the
  //     baseline; its delta vs itself is 0 so it shows no badge.
  const baseIdx = 0;

  const medRows = useMemo<MedRow[]>(() => {
    const built = medications.map((med) => {
      const lookups = columns.map((c) => lookupDrugCost(c.plan, med, brainData, pharmacyFill));
      return {
        id: med.id,
        name: med.name,
        fillNote: pharmacyFill === 'mail_90' ? '90-day mail' : '30-day retail',
        tiers: lookups.map((d) => d?.tier ?? null),
        values: lookups.map((d) => d?.label ?? '—'),
        monthly: lookups.map((d) => (d ? (typeof d.monthly === 'number' ? d.monthly : null) : null)),
        sources: lookups.map((d) =>
          !d ? 'no_rxcui' : d.source,
        ),
        paStFlags: lookups.map((d) => (d ? { pa: d.pa, st: d.st } : null)),
      };
    });
    // Sort by total monthly cost across all comparison columns,
    // descending. Highest-cost drugs surface first so the broker sees
    // the cost driver (Ozempic before atorvastatin) without scrolling.
    // Rows with no cost data anywhere fall to the bottom; stable order
    // preserves the broker's input sequence for ties.
    const costScore = (r: MedRow): number =>
      r.monthly.reduce((sum: number, m) => sum + (typeof m === 'number' ? m : 0), 0);
    return built
      .map((row, idx) => ({ row, idx, score: costScore(row) }))
      .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
      .map(({ row }) => row);
  }, [medications, columns, brainData, pharmacyFill]);

  const providerRows = useMemo<ProviderRow[]>(() => {
    return providers.map((pr) => ({
      id: pr.id,
      name: pr.name,
      specialty: pr.specialty ?? '',
      status: columns.map((c) => providerStatusFor(pr, c.plan)),
    }));
  }, [providers, columns]);

  const copayRows = useMemo<CopayRow[]>(() => {
    return MEDICAL_DEFS.slice(0, MEDICAL_DEFS.length - 1).map((def) => ({
      label: def.label,
      values: columns.map((c) => formatCostShare(def.pick(c.plan))),
      numbers: columns.map((c) => copayCash(def.pick(c.plan))),
    }));
  }, [columns]);

  // Inpatient row (separate so we can render Total Inpatient Cost
  // immediately after).
  const inpatientRow = useMemo<CopayRow>(() => {
    const def = MEDICAL_DEFS[MEDICAL_DEFS.length - 1];
    return {
      label: def.label,
      values: columns.map((c) => {
        const cash = copayCash(def.pick(c.plan));
        return cash != null ? `$${cash}/day` : formatCostShare(def.pick(c.plan));
      }),
      numbers: columns.map((c) => copayCash(def.pick(c.plan))),
      suffix: '/day',
    };
  }, [columns]);

  const inpatientTotal = useMemo<(number | null)[]>(
    () => inpatientRow.numbers.map((n) => (n != null ? n * DEFAULT_INPATIENT_DAYS : null)),
    [inpatientRow],
  );

  const planCostRows = useMemo<CopayRow[]>(() => [
    {
      label: 'Premium',
      values: columns.map((c) => `$${c.plan.premium}/mo`),
      numbers: columns.map((c) => c.plan.premium),
    },
    {
      label: 'MOOP',
      values: columns.map((c) => `$${c.plan.moop_in_network.toLocaleString()}`),
      numbers: columns.map((c) => c.plan.moop_in_network),
    },
    {
      label: 'Rx Deductible',
      values: columns.map((c) =>
        c.plan.drug_deductible == null ? '—' : `$${c.plan.drug_deductible}`,
      ),
      numbers: columns.map((c) => c.plan.drug_deductible),
    },
    {
      label: 'Part B Giveback',
      values: columns.map((c) =>
        (c.plan.part_b_giveback ?? 0) > 0 ? `$${c.plan.part_b_giveback}/mo` : '—',
      ),
      numbers: columns.map((c) => c.plan.part_b_giveback ?? 0),
      betterIsHigher: true,
    },
  ], [columns]);

  const extraRows = useMemo<CopayRow[]>(() => [
    {
      label: 'Dental',
      values: columns.map((c) =>
        formatDental(c.plan.benefits.dental.annual_max, c.plan.benefits.dental.description),
      ),
      numbers: columns.map((c) => c.plan.benefits.dental.annual_max),
      betterIsHigher: true,
    },
    {
      label: 'Vision',
      values: columns.map((c) =>
        formatVision(
          c.plan.benefits.vision.eyewear_allowance_year,
          c.plan.benefits.vision.exam,
          c.plan.benefits.vision.description,
        ),
      ),
      numbers: columns.map((c) => c.plan.benefits.vision.eyewear_allowance_year),
      betterIsHigher: true,
    },
    {
      label: 'Hearing',
      values: columns.map((c) =>
        formatHearing(
          c.plan.benefits.hearing.aid_allowance_year,
          c.plan.benefits.hearing.exam,
          c.plan.benefits.hearing.description,
        ),
      ),
      numbers: columns.map((c) => c.plan.benefits.hearing.aid_allowance_year),
      betterIsHigher: true,
    },
    {
      label: 'OTC',
      values: columns.map((c) =>
        formatOtc(c.plan.benefits.otc.allowance_per_quarter, c.plan.benefits.otc.description),
      ),
      numbers: columns.map((c) => c.plan.benefits.otc.allowance_per_quarter),
      betterIsHigher: true,
    },
    {
      label: 'Food Card',
      values: columns.map((c) =>
        formatFoodCard(c.plan.benefits.food_card.allowance_per_month, c.plan.benefits.food_card.description),
      ),
      numbers: columns.map((c) => c.plan.benefits.food_card.allowance_per_month),
      betterIsHigher: true,
    },
    {
      label: 'Fitness',
      values: columns.map((c) =>
        c.plan.benefits.fitness.enabled
          ? c.plan.benefits.fitness.program ?? 'Included'
          : '—',
      ),
      numbers: columns.map((c) => (c.plan.benefits.fitness.enabled ? 1 : 0)),
    },
  ], [columns]);

  // Total Rx Cost — prefer live /api/drug-costs total when available.
  const rxTotalAnnual = useMemo<(number | null)[]>(() => {
    return columns.map((c) => {
      // Path 1 — live /api/drug-costs total. Authoritative.
      const live = lookupPlanCost(drugCosts, c.plan);
      if (live?.annual_cost != null) return Math.round(live.annual_cost);

      // Path 2 — sum per-drug cells, but ONLY if every drug has a
      // computable annual. If any drug is 'unavailable' or returns
      // null, we can't honestly produce a total — return null and
      // let the cell render '—'. Per the compliance directive:
      // never silently treat missing data as $0.
      let sum = 0;
      let usable = true;
      for (const med of medications) {
        if (!med.rxcui) {
          usable = false;
          break;
        }
        const d = lookupDrugCost(c.plan, med, brainData, pharmacyFill);
        if (!d || d.source === 'unavailable' || d.annual == null) {
          usable = false;
          break;
        }
        sum += d.annual;
      }
      if (!usable) return null;
      return medications.length === 0 ? 0 : sum;
    });
  }, [columns, drugCosts, medications, brainData, pharmacyFill]);

  const rxTotalMonthly = useMemo<(number | null)[]>(
    () => rxTotalAnnual.map((a) => (a != null ? Math.round(a / 12) : null)),
    [rxTotalAnnual],
  );

  // ── Total Annual Value — accurate component breakdown ────────────
  //
  // Per the V4 spec, the total renders as:
  //   total = Rx + Premium − Giveback − Dental − Vision − Hearing
  //                       − OTC − Food − Fitness
  //
  // Negative total = net annual cost (the broker's intuitive "this
  // plan costs $X/yr"); positive would mean extras exceed costs.
  // Each component is parsed from the plan benefits via
  // extractBenefitValue so descriptions like "$2,500/yr · comprehensive"
  // contribute their dollar value rather than registering as 0.
  //
  // Stored as a structured breakdown so the UI tooltip can show the
  // math: "Rx $564 + Premium $0 − Giveback $1,212 + Dental $0 +
  //        OTC $480 + Food $600 = −$432/yr".
  interface ValueBreakdown {
    total: number;        // signed: negative = net cost, positive = net savings
    rx: number;           // annual
    premium: number;      // annual
    giveback: number;     // annual credit (positive number, subtracted)
    dental: number;
    vision: number;
    hearing: number;
    otc: number;
    food: number;
  }

  const annualBreakdown = useMemo<ValueBreakdown[]>(() => {
    return columns.map((c, i) => {
      const rx = rxTotalAnnual[i] ?? 0;
      const premium = (c.plan.premium ?? 0) * 12;
      const giveback = (c.plan.part_b_giveback ?? 0) * 12;
      // Dental — annual_max if positive, else 0 (no annual cap).
      // Description-based values aren't summed here (a $45 copay
      // isn't an annualized benefit value).
      const dental = c.plan.benefits.dental.annual_max > 0 ? c.plan.benefits.dental.annual_max : 0;
      const vision = c.plan.benefits.vision.eyewear_allowance_year > 0 ? c.plan.benefits.vision.eyewear_allowance_year : 0;
      const hearing = c.plan.benefits.hearing.aid_allowance_year > 0 ? c.plan.benefits.hearing.aid_allowance_year : 0;
      const otc = c.plan.benefits.otc.allowance_per_quarter > 0 ? c.plan.benefits.otc.allowance_per_quarter * 4 : 0;
      const food = c.plan.benefits.food_card.allowance_per_month > 0 ? c.plan.benefits.food_card.allowance_per_month * 12 : 0;
      // total: cost − value. Negative number = net annual cost.
      const cost = rx + premium;
      const value = giveback + dental + vision + hearing + otc + food;
      const total = -(cost - value);
      return { total, rx, premium, giveback, dental, vision, hearing, otc, food };
    });
  }, [columns, rxTotalAnnual]);

  // Backwards-compat surface for the existing render: array of total
  // numbers keyed by column index.
  const annualNet = useMemo<(number | null)[]>(
    () => annualBreakdown.map((b) => b.total),
    [annualBreakdown],
  );

  const savingsVsBaseline = useMemo<(number | null)[]>(() => {
    const base = annualNet[baseIdx];
    if (base == null) return columns.map(() => null);
    return annualNet.map((v, i) =>
      i === baseIdx || v == null ? null : base - v,
    );
  }, [annualNet, columns]);

  // ── Annual Review (AEP) verdict ─────────────────────────────────
  // When isAnnualReview && a current plan is pinned, compute:
  //   • netDeltaVsCurrent — per-column annual net cost delta. Positive
  //     means the alternative SAVES money relative to the current plan.
  //   • verdict — 'stay' when the best alternative saves < $200/yr
  //     (within noise threshold; sticking with the known plan is
  //     usually the broker's recommendation); 'switch' when at least
  //     one alternative meaningfully beats current.
  //   • givebackDrop — when the recommended plan has lower Part B
  //     giveback than the current plan, surface as a "your client's
  //     monthly cash-back is dropping" warning the broker should
  //     proactively explain.
  // Declared above whySwitch (which reads it) so the binding order is
  // explicit rather than relying on useMemo's lazy capture.
  const aepVerdict = useMemo(() => {
    if (!isAnnualReview || !currentPlan || !result) {
      return { active: false as const };
    }
    const currentCol = columns.find((c) => c.variant === 'current');
    const currentNet = currentCol?.scored?.realAnnualCost?.netAnnual ?? null;
    const netDeltaVsCurrent: (number | null)[] = columns.map((c) => {
      if (c.variant === 'current') return null;
      const altNet = c.scored?.realAnnualCost?.netAnnual ?? null;
      if (currentNet == null || altNet == null) return null;
      return currentNet - altNet; // positive = alt saves money
    });
    const bestSavings = netDeltaVsCurrent.reduce<number | null>(
      (acc, v) => (v != null && (acc == null || v > acc) ? v : acc),
      null,
    );
    // Stay threshold: $200/yr is roughly under-noise for the playbook's
    // utilization estimates; switching for less than that doesn't
    // justify the disruption of plan changes mid-care.
    const verdict: 'stay' | 'switch' | null = bestSavings == null
      ? null
      : bestSavings < 200 ? 'stay' : 'switch';
    const recommendedCol = recommendation
      ? columns.find((c) => c.id === recommendation)
      : null;
    const recPlan = recommendedCol?.plan ?? null;
    const currentGiveback = currentPlan.part_b_giveback ?? 0;
    const recGiveback = recPlan?.part_b_giveback ?? 0;
    const givebackDrop = currentGiveback > 0 && recGiveback < currentGiveback
      ? { current: currentGiveback, recommended: recGiveback, delta: currentGiveback - recGiveback }
      : null;
    return {
      active: true as const,
      verdict,
      bestSavings,
      netDeltaVsCurrent,
      givebackDrop,
    };
  }, [isAnnualReview, currentPlan, result, columns, recommendation]);

  const whySwitch = useMemo<string[]>(() => {
    const baselinePlan = columns[baseIdx]?.plan ?? null;
    const baseTotal = annualBreakdown[baseIdx]?.total ?? null;
    return columns.map((c, i) => {
      if (i === baseIdx) {
        if (c.variant === 'current') {
          return isAnnualReview ? 'Current plan · 2026 baseline' : 'Current plan';
        }
        return 'Lead column · benchmark';
      }
      // Annual Review framing: when the current plan is pinned, lead
      // every alternative column with vs-current dollar delta plus a
      // year-over-year hint, then fall through to the playbook copy.
      // The playbook copy already names the right tradeoff (extras,
      // MOOP, network); we just want the AEP "saves $X vs current"
      // line to come first so the broker has the headline number.
      if (isAnnualReview && currentPlan) {
        const arDelta = aepVerdict.active ? aepVerdict.netDeltaVsCurrent[i] : null;
        const playbookCopy = c.scored?.whySwitchCopy ?? '';
        const headline =
          arDelta != null && arDelta >= 200
            ? `Saves $${Math.round(arDelta).toLocaleString()}/yr vs current plan`
            : arDelta != null && arDelta <= -200
              ? `Costs $${Math.round(-arDelta).toLocaleString()} more/yr than current`
              : arDelta != null && Math.abs(arDelta) < 200
                ? 'Within $200/yr of current — minor difference'
                : null;
        const bits = [headline, playbookCopy].filter((s): s is string => Boolean(s && s.trim()));
        if (bits.length > 0) return bits.join(' · ');
      }
      // Priority order: archetype-specific copy from the playbook >
      // broker-rule reason > generic cost/MOOP/extras deltas. The
      // playbook copy already factors in archetype context so we
      // prefer it; the rule reason still surfaces when archetype
      // copy is empty (rare — only happens with no savings + no
      // network signal).
      if (c.scored?.whySwitchCopy) return c.scored.whySwitchCopy;
      const ruleReason = c.scored?.appliedRules?.length
        ? leadingReason(c.scored.appliedRules)
        : null;
      if (ruleReason) return ruleReason;
      const bits: string[] = [];
      const savings =
        baseTotal != null && annualBreakdown[i]?.total != null
          ? annualBreakdown[i].total - baseTotal
          : null;
      if (savings != null && savings > 50) {
        bits.push(`Saves $${Math.round(savings).toLocaleString()}/yr vs current plan`);
      } else if (savings != null && savings < -50) {
        bits.push(`Costs $${Math.round(-savings).toLocaleString()} more/yr`);
      }
      if (baselinePlan) {
        const moopDiff = baselinePlan.moop_in_network - c.plan.moop_in_network;
        if (moopDiff > 500) bits.push(`$${(moopDiff / 1000).toFixed(1)}K lower MOOP`);
        const otcDiff = c.plan.benefits.otc.allowance_per_quarter - baselinePlan.benefits.otc.allowance_per_quarter;
        if (otcDiff > 0) bits.push(`+$${otcDiff * 4}/yr OTC`);
        const foodDiff = c.plan.benefits.food_card.allowance_per_month - baselinePlan.benefits.food_card.allowance_per_month;
        if (foodDiff > 0) bits.push(`+$${foodDiff * 12}/yr food`);
        const dentalDiff = c.plan.benefits.dental.annual_max - baselinePlan.benefits.dental.annual_max;
        if (dentalDiff > 500) bits.push(`+$${dentalDiff} dental`);
      }
      if (c.scored?.providerNetworkStatus === 'all_in') bits.push('in-network');
      return bits.filter(Boolean).join(' · ') || '—';
    });
  }, [columns, annualBreakdown, isAnnualReview, currentPlan, aepVerdict]);

  // C-SNP-in-top-3 banner — surfaces the chronic-care plan opportunity
  // when one is competitive. Top-3 by composite (post-broker-rules
  // adjustment), not necessarily a column slot — that way the banner
  // fires even if the C-SNP didn't win a ribbon column.
  const csnpInTop3 = useMemo<{ plan: Plan; conditionLabel: string } | null>(() => {
    if (!result) return null;
    const top3 = [...result.scored].sort((a, b) => b.composite - a.composite).slice(0, 3);
    const csnp = top3.find((s) => s.isCsnp);
    if (!csnp) return null;
    // Pick the most-confident detected condition for the badge label.
    const cert = result.detectedConditions.find((d) => d.confidence === 'certain')
      ?? result.detectedConditions.find((d) => d.confidence === 'likely')
      ?? result.detectedConditions[0];
    const label = cert ? CONDITION_LABEL[cert.condition] : 'chronic care';
    return { plan: csnp.plan, conditionLabel: label };
  }, [result]);

  // Per-column red-flag map — combines two layers:
  //   1. broker-rules ≥25-point penalty (Rule 9 today)
  //   2. broker-playbook red-flag engine (critical / disqualify)
  // Either signal lights the warning chip; tooltip merges every
  // reason so the broker sees the full picture on hover.
  const redFlagByColumnId = useMemo<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {};
    for (const c of columns) {
      if (!c.scored) { out[c.id] = false; continue; }
      const rulesFlag = hasRedFlag(c.scored.appliedRules);
      const playbookFlag = c.scored.redFlags.some(
        (f) => f.severity === 'critical' || f.severity === 'disqualify',
      );
      out[c.id] = rulesFlag || playbookFlag;
    }
    return out;
  }, [columns]);

  // Medications needing assistance — used to gate the help section.
  const medsNeedingAssistance = useMemo(() => {
    const out = new Set<string>();
    for (const r of medRows) {
      // Excluded on every plan column → manufacturer assistance is
      // the agent's only path. Don't trigger on 'unavailable' (data
      // gap) — that's a different problem and we shouldn't surface
      // PAP options for a drug we don't actually know is uncovered.
      const allExcluded =
        r.sources.length > 0 && r.sources.every((s) => s === 'excluded');
      const allExpensive =
        r.tiers.length > 0 &&
        r.tiers.every((t, i) => t != null && t >= 4 && (r.monthly[i] ?? 0) > 100);
      if (allExcluded || allExpensive) out.add(r.id);
    }
    return out;
  }, [medRows]);

  // ── Publish PrintableQuote snapshot for the QuotePage Print button ─
  // QuotePage (one component up) reads this snapshot and feeds it to
  // generateQuotePdf when the broker clicks Print. Centralizing the
  // snapshot here keeps the PDF generator decoupled from React render
  // and avoids prop-drilling 12 separate arrays up to the bbar.
  const setPrintableSnapshot = usePrintableQuote((s) => s.setSnapshot);
  useEffect(() => {
    if (!result) {
      setPrintableSnapshot(null);
      return;
    }
    const snapshot: PrintableQuote = {
      client,
      age: ageFromDob(client.dob),
      medications,
      providers,
      result,
      columns: columns.map((c) => ({
        id: c.id,
        variant: c.variant,
        ribbon: c.ribbon,
        carrier: c.carrier,
        planName: c.planName,
        hNumber: c.hNumber,
        star: c.star,
        plan: c.plan,
        scored: c.scored,
      })),
      medRows,
      providerRows,
      copayRows,
      inpatientRow,
      inpatientTotal,
      planCostRows,
      extraRows,
      rxTotalMonthly,
      rxTotalAnnual,
      whySwitch,
      recommendation: recommendation ?? null,
      pharmacyLabel: pharmacyFill === 'mail_90' ? '90-day mail' : '30-day retail',
      isAnnualReview,
    };
    setPrintableSnapshot(snapshot);
    // Cleanup clears the snapshot so a stale Print click after
    // QuoteDeliveryV4 unmounts (broker navigated away) can't fire.
    return () => setPrintableSnapshot(null);
  }, [
    setPrintableSnapshot, client, medications, providers, result,
    columns, medRows, providerRows, copayRows, inpatientRow, inpatientTotal,
    planCostRows, extraRows, rxTotalMonthly, rxTotalAnnual, whySwitch,
    recommendation, pharmacyFill, isAnnualReview,
  ]);

  // ── AgentBase sync on Recommend ────────────────────────────────────
  // The Recommend button writes session.recommendation immediately
  // (via the onRecommend prop); we additionally fire a sync to
  // /api/agentbase-recommend so the AgentBase CRM picks up the
  // recommended plan + brain snapshot. Sync runs alongside the click —
  // never blocks the UI. Status renders next to the Recommended chip.
  const sessionId = useSession((s) => s.sessionId);
  const startedAt = useSession((s) => s.startedAt);
  const agentbaseSync = useAgentBaseRecommend();

  // ── AgentBase structured-sync snapshot ────────────────────────────
  // Publish a SyncInput keyed to the recommended column so
  // SaveSessionButton can fire the same /api/agentbase-recommend
  // direct write that the per-column Recommend button does. Without
  // this snapshot, Save Session would only post to /api/agentbase-sync
  // (the pending-webhook path) and meds/providers would stay in JSONB
  // until manual broker approval. Plan selection mirrors the
  // Enroll-in-SunFire button: explicit recommendation > gold-badge
  // column > first non-current finalist.
  const setSyncSnapshot = useAgentBaseSyncSnapshot((s) => s.setSnapshot);
  useEffect(() => {
    if (!result || columns.length === 0) {
      setSyncSnapshot(null);
      return;
    }
    const goldId = (() => {
      const cands = columns.filter((c) => c.variant !== 'current');
      if (cands.length === 0) return null;
      let best = cands[0];
      let bestNet = best.scored?.realAnnualCost?.netAnnual ?? Infinity;
      for (const c of cands.slice(1)) {
        const net = c.scored?.realAnnualCost?.netAnnual ?? Infinity;
        if (net < bestNet) { best = c; bestNet = net; }
      }
      return best.id;
    })();
    const targetId = recommendation ?? goldId ?? null;
    if (!targetId) {
      setSyncSnapshot(null);
      return;
    }
    const input = buildSyncInput(targetId);
    setSyncSnapshot(input);
    return () => setSyncSnapshot(null);
    // buildSyncInput is a stable function-declaration closing over the
    // same deps already listed below; re-including it would re-fire the
    // effect every render and republish the same snapshot wastefully.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    setSyncSnapshot, result, columns, recommendation,
    medRows, providerRows, medications, providers, client,
    sessionId, startedAt,
  ]);

  // SunFire-handoff state per plan column. SunFire has no documented
  // deep-link API for plan pre-selection, so we use the clipboard
  // pattern: copy the structured plan-handoff text, then open the
  // broker's SunFire workspace in a new tab. The broker pastes once
  // into SunFire's plan search.
  // Status values: 'copying' (during clipboard write) | 'copied' (3s
  // success indicator) | 'error' (clipboard denied/failed). null = the
  // default "Open SunFire →" idle state.
  const [sunfireStatus, setSunfireStatus] = useState<Record<string, 'copying' | 'copied' | 'error'>>({});
  async function handleOpenSunFire(planId: string) {
    const col = columns.find((c) => c.id === planId);
    if (!col) return;
    const text = buildSunfireRecommendationText({
      client,
      plan: col.plan,
      brokerName: BROKER.name,
      brokerNpn: BROKER.npn,
      brokerPhone: BROKER.phone,
    });
    setSunfireStatus((prev) => ({ ...prev, [planId]: 'copying' }));
    let copied = false;
    try {
      // Clipboard write must run inside the user-gesture window before
      // window.open — Chromium pauses pending writes when the focus
      // shifts to a new tab and they silently fail.
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (err) {
      console.warn('[sunfire] clipboard write failed:', (err as Error).message);
    }
    // Open the new tab regardless of clipboard success — the broker
    // can paste manually from their session log if the clipboard API
    // was denied (HTTP context, permission policy, etc.).
    window.open(SUNFIRE_URL, '_blank', 'noopener,noreferrer');
    setSunfireStatus((prev) => ({ ...prev, [planId]: copied ? 'copied' : 'error' }));
    // Auto-clear the status pill so the action row returns to the
    // idle "Open SunFire →" label after a few seconds.
    window.setTimeout(() => {
      setSunfireStatus((prev) => {
        const next = { ...prev };
        delete next[planId];
        return next;
      });
    }, copied ? 4000 : 6000);
  }

  function buildSyncInput(planId: string) {
    if (!result) return null;
    const colIdx = columns.findIndex((c) => c.id === planId);
    if (colIdx < 0) return null;
    const col = columns[colIdx];
    if (!col.scored) return null;

    const medContext = medRows.map((m) => {
      // Pull dose + frequency from the session Medication record. The
      // session type uses `strength` / `dosageInstructions`; the
      // AgentBase API contract uses `dose` / `frequency`. Map them so
      // client_medications gets the dosing detail instead of inserting
      // null. Without this mapping the broker sees meds in AgentBase
      // with empty Dose / Frequency columns even though the session
      // captured them.
      const med = medications.find((x) => x.id === m.id);
      return {
        name: m.name,
        rxcui: med?.rxcui ?? null,
        dose: med?.strength ?? null,
        frequency: med?.dosageInstructions ?? null,
        tier_on_recommended_plan: m.tiers[colIdx] ?? null,
        monthly_cost: m.monthly[colIdx] ?? null,
        pa_required: Boolean(m.paStFlags[colIdx]?.pa),
        st_required: Boolean(m.paStFlags[colIdx]?.st),
      };
    });
    const providerContext = providerRows.map((p) => {
      const provRecord = providers.find((pp) => pp.id === p.id);
      return {
        name: p.name,
        npi: provRecord?.npi ?? '',
        specialty: p.specialty || null,
        network_status: (p.status[colIdx] ?? 'unknown') as 'in' | 'out' | 'unknown',
      };
    });
    return {
      client,
      sessionId,
      startedAt,
      brokerNpn: BROKER.npn,
      brokerId: BROKER.name,
      recommendedPlan: col.plan,
      recommendedScored: col.scored,
      medications,
      providers,
      brainResult: result,
      medContext,
      providerContext,
    };
  }

  // ── Console debug — `[quote-v4]` snapshot per spec ─────────────────
  // Two emissions: the full render snapshot every time columns
  // settle, and a CHANGED line whenever the broker flips presets.
  // Logged via console.info so it stays out of production-error
  // surfaces but is grep-able from the dev console.
  const lastPresetRef = useRef<WeightPresetKey | null>(presetKey);
  useEffect(() => {
    if (!result) return;
    const top3 = [...result.scored]
      .filter((s) => !s.disqualified)
      .slice(0, 3)
      .map((s) => `${s.plan.contract_id}-${s.plan.plan_number}`);
    const w = result.weights;
    const wInt = {
      drug: Math.round(w.drug * 100),
      oop: Math.round(w.oop * 100),
      extras: Math.round(w.extras * 100),
    };
    const prev = lastPresetRef.current;
    if (prev !== presetKey) {
      console.info(
        `[quote-v4] weights CHANGED to {drug:${wInt.drug},oop:${wInt.oop},extras:${wInt.extras}} — recalculating`,
      );
      console.info(`[quote-v4] new top3=[${top3.join(', ')}]`);
      lastPresetRef.current = presetKey;
    }
    console.info(
      `[quote-v4] weights={drug:${wInt.drug},oop:${wInt.oop},extras:${wInt.extras}} plans=${result.scored.length} top3=[${top3.join(', ')}]`,
    );
    console.info('[quote-v4] sort=composite dir=desc');
  }, [result, presetKey]);

  // ── Early returns (after every hook, per Rules of Hooks) ──────────
  if (loading && !result) {
    return (
      <div style={{ padding: 28, textAlign: 'center', color: COL.inkSub, fontSize: 13, background: '#fff', border: `1px dashed ${COL.rule}`, borderRadius: 12 }}>
        Plan Brain scoring plans…
      </div>
    );
  }
  if (columns.length === 0) {
    return (
      <div style={{ padding: 28, textAlign: 'center', color: COL.inkSub, fontSize: 13, background: '#fff', border: `1px dashed ${COL.rule}`, borderRadius: 12 }}>
        No plans to compare yet. Complete steps 2–5 so Plan Brain has finalists to rank.
      </div>
    );
  }

  const N = columns.length;
  // Label column 180px (down from 200) gives plan columns 190px each
  // (up from 180) — extras like "Exam + $50 eyewear" no longer
  // truncate. LABEL_W / PLAN_W are module-level (see below the
  // component) so the style atoms reference the same numbers.
  const minWidth = LABEL_W + N * PLAN_W;
  const colSpanFull = 1 + N;

  // Recommended column for the gold "RECOMMENDED" badge — pick the
  // non-current finalist with the lowest realAnnualCost.netAnnual
  // (= highest annual value to the client). Falls back to the first
  // non-current column when realAnnualCost hasn't populated yet.
  const recommendedColId = (() => {
    const candidates = columns.filter((c) => c.variant !== 'current');
    if (candidates.length === 0) return null;
    let best = candidates[0];
    let bestNet = best.scored?.realAnnualCost?.netAnnual ?? Infinity;
    for (const c of candidates.slice(1)) {
      const net = c.scored?.realAnnualCost?.netAnnual ?? Infinity;
      if (net < bestNet) {
        best = c;
        bestNet = net;
      }
    }
    return best.id;
  })();

  // Active weights for the readout — prefer the live brain output
  // (which reflects whatever weightOverride flowed through this run);
  // fall back to the preset's nominal weights while the brain is
  // still spinning up after a preset flip.
  const liveWeights: WeightProfile = result?.weights
    ?? (presetKey ? WEIGHT_PRESETS[presetKey].weights : { drug: 0.5, oop: 0.3, extras: 0.2 });
  const wPct = {
    drug: Math.round(liveWeights.drug * 100),
    oop: Math.round(liveWeights.oop * 100),
    extras: Math.round(liveWeights.extras * 100),
  };

  // Client context fields. age/city/zip are computed inline; LIS,
  // D-SNP, and C-SNP eligibility come from the session + plan-brain
  // result. medicaidConfirmed is the proxy for D-SNP eligibility;
  // detected conditions drive C-SNP.
  const ctxAge = ageFromDob(client.dob);
  const ctxCityState = [client.county, client.state].filter(Boolean).join(', ');
  const ctxLocation = [ctxCityState, client.zip].filter(Boolean).join(' ').trim();
  const csnpConditions = result?.detectedConditions
    .filter((d) => d.confidence === 'certain' || d.confidence === 'likely')
    .map((d) => CONDITION_LABEL[d.condition])
    ?? [];
  const csnpEligible = csnpConditions.length > 0;

  return (
    <div style={{ fontFamily: FONT.body, color: COL.ink }}>
      {/* Current-plan picker — small link when no current plan; opens
          an inline panel with CurrentPlanPicker. Once a plan is set,
          the picker shows the selected plan with a Change button and
          the gray benchmark column appears in the table below. */}
      {/* AEP-mode prompt — when isAnnualReview is on but no current
          plan is pinned, the comparison has no benchmark and the
          deltas are meaningless. Surface a prominent prompt and
          auto-open the picker (see useEffect above). */}
      {isAnnualReview && !currentPlan && (
        <div
          style={{
            marginBottom: 12,
            padding: '10px 12px',
            background: '#fcebeb',
            border: '1px solid #f3c5c5',
            borderRadius: 8,
            color: '#a32d2d',
            fontSize: 12,
            fontWeight: 600,
            fontFamily: FONT.body,
          }}
        >
          ⚠ Annual review needs a current plan pinned as the benchmark.
          Pick the client&apos;s 2026 plan in the picker below to enable
          year-over-year deltas.
        </div>
      )}
      {!currentPlan && !pickerOpen && (
        <div style={{ marginBottom: 12, fontSize: 12, color: COL.inkSub }}>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              color: COL.navyHeader,
              fontWeight: 600,
              fontSize: 12,
              cursor: 'pointer',
              fontFamily: FONT.body,
              textDecoration: 'underline',
              textUnderlineOffset: 2,
            }}
          >
            + Add current plan to compare
          </button>
          <span style={{ marginLeft: 8, fontSize: 11, color: COL.inkSub }}>
            sets the gray benchmark column · deltas calculate against it
          </span>
        </div>
      )}
      {(currentPlan || pickerOpen) && (
        <div style={{ marginBottom: 12, padding: 10, border: `1px solid ${COL.rule}`, borderRadius: 8, background: '#fff' }}>
          <CurrentPlanPicker
            autoFocus={pickerOpen && !currentPlan}
            onSelected={() => setPickerOpen(false)}
            hint="Once selected, the leftmost gray column anchors all delta badges."
          />
        </div>
      )}

      {/* Detected-condition pills — auto-detected from the medication
          list. Drives broker-rules boosts/penalties and tells the
          agent at a glance what conditions Plan Brain inferred. */}
      {result && result.detectedConditions.length > 0 && (
        <div style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <strong
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: COL.inkSub,
              marginRight: 4,
            }}
          >
            Detected
          </strong>
          {result.detectedConditions.map((d) => {
            const c = CONFIDENCE_BG[d.confidence];
            return (
              <span
                key={d.condition}
                title={d.brokerImplications.join(' · ')}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '3px 8px',
                  borderRadius: 999,
                  background: c.bg,
                  color: c.fg,
                  border: `1px solid ${c.border}`,
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: FONT.body,
                }}
              >
                {CONDITION_LABEL[d.condition]}
                <span style={{ fontSize: 9, fontWeight: 500, opacity: 0.85 }}>({d.confidence})</span>
              </span>
            );
          })}
        </div>
      )}

      {/* Archetype badge — single primary classification that drives
          the weights, plan-type preferences, and Why-switch copy.
          Hover for the full broker-voice description. */}
      {result?.archetype && (
        <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: COL.inkSub,
            }}
          >
            Archetype
          </strong>
          <span
            title={result.archetype.description}
            style={{
              padding: '4px 10px',
              borderRadius: 999,
              background: COL.navyBody,
              color: COL.navyHeader,
              border: `1px solid ${COL.navyHeader}`,
              fontSize: 11,
              fontWeight: 700,
              cursor: 'help',
              fontFamily: FONT.body,
            }}
          >
            {result.archetype.label}
          </span>
          <span style={{ fontSize: 10, color: COL.inkSub, fontFamily: FONT.mono }}>
            weights: drug {Math.round(result.weights.drug * 100)} / oop {Math.round(result.weights.oop * 100)} / extras {Math.round(result.weights.extras * 100)}
          </span>
        </div>
      )}

      {/* Medication patterns — escalation/combination signatures
          beyond per-condition flags. Renders one line per pattern. */}
      {result && result.medicationPatterns.length > 0 && (
        <div style={{ marginBottom: 12, padding: 8, background: '#f5f4f0', borderRadius: 6, border: `1px solid ${COL.rule}` }}>
          {result.medicationPatterns.map((p) => (
            <div key={p.id} style={{ fontSize: 11, color: COL.ink, fontFamily: FONT.body, lineHeight: 1.5 }}>
              <strong style={{ color: COL.navyHeader }}>{p.summary.split(':')[0]}:</strong>
              {p.summary.includes(':') ? p.summary.slice(p.summary.indexOf(':') + 1) : ''}
            </div>
          ))}
        </div>
      )}

      {/* C-SNP-in-top-3 banner — only renders when a Chronic Care
          Special Needs Plan landed in the top 3 by composite score
          after broker rules. Tells the broker "this exists for this
          condition — consider it before quoting MAPD." */}
      {/* AEP "Stay" verdict — fires when the broker has flipped into
          Annual Review and no alternative beats the current plan by
          more than $200/yr in net annual cost. Sticking with the
          known plan is usually the right call when savings are
          under-noise; the playbook still surfaces real switch
          opportunities through the per-column Why-switch copy. */}
      {aepVerdict.active && aepVerdict.verdict === 'stay' && (
        <div
          style={{
            marginBottom: 12,
            padding: '10px 12px',
            background: '#eaf3de',
            border: '1px solid #c6dca0',
            borderRadius: 8,
            color: '#3b6d11',
            fontSize: 12,
            fontWeight: 600,
            fontFamily: FONT.body,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span>✓</span>
          <span>
            Stay recommended — your client&apos;s current plan is still competitive.
            Best alternative saves only ${Math.round(aepVerdict.bestSavings ?? 0).toLocaleString()}/yr,
            below the $200 noise threshold.
          </span>
        </div>
      )}

      {/* Giveback drop — when the broker has recommended a plan whose
          Part B giveback is lower than the current plan's, the
          client's monthly Social Security cash-back drops on switch.
          Surface so the broker explains it before the client notices. */}
      {aepVerdict.active && aepVerdict.givebackDrop && (
        <div
          style={{
            marginBottom: 12,
            padding: '10px 12px',
            background: '#faeeda',
            border: '1px solid #ecd2a2',
            borderRadius: 8,
            color: '#854f0b',
            fontSize: 12,
            fontWeight: 600,
            fontFamily: FONT.body,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span>⚠</span>
          <span>
            Giveback drop on switch — current plan pays ${aepVerdict.givebackDrop.current}/mo back
            to the client; recommended plan pays ${aepVerdict.givebackDrop.recommended}/mo.
            That&apos;s ${aepVerdict.givebackDrop.delta * 12}/yr less in their Social Security check.
          </span>
        </div>
      )}

      {csnpInTop3 && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            borderRadius: 8,
            background: '#eaf3de',
            border: '1px solid #c6dca0',
            color: '#3b6d11',
            fontSize: 12,
            fontWeight: 600,
            fontFamily: FONT.body,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span>⊕</span>
          <span>
            Chronic Care Plan available — <strong>{csnpInTop3.plan.carrier} {csnpInTop3.plan.plan_name}</strong>
            {' '}is designed for {csnpInTop3.conditionLabel}
          </span>
        </div>
      )}

      {/* Client context bar — gray rounded summary the broker reads
          off during the call: name, age, location, med count, provider
          count, LIS / D-SNP / C-SNP eligibility. medicaidConfirmed is
          the proxy for D-SNP; detected conditions (certain/likely)
          drive C-SNP. LIS isn't tracked in session, so it falls
          through as "—" when unknown. */}
      <div
        style={{
          marginBottom: 12,
          padding: '10px 14px',
          background: V4.bgGray,
          border: `1px solid ${V4.border}`,
          borderRadius: 10,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 14,
          alignItems: 'center',
          fontSize: 12,
          fontFamily: FONT.body,
          color: V4.textPrimary,
        }}
      >
        <ContextField label="Client" value={client.name || '—'} bold />
        <ContextField label="Age" value={ctxAge != null ? String(ctxAge) : '—'} />
        <ContextField label="Location" value={ctxLocation || '—'} />
        <ContextField label="Meds" value={`${medications.length}`} mono />
        <ContextField label="Providers" value={`${providers.length}`} mono />
        <ContextField label="LIS" value="—" />
        <ContextField label="D-SNP" value={client.medicaidConfirmed ? 'Yes' : 'No'} />
        {csnpEligible && (
          <ContextField label="C-SNP eligible" value={csnpConditions.join(' · ')} highlight />
        )}
      </div>

      {/* Weight presets — recompute composite + re-sort comparison
          columns. Active button = navy filled. Click → state →
          weightOverride → usePlanBrain → re-rank → effect emits the
          `[quote-v4]` snapshot. */}
      <div
        style={{
          marginBottom: 8,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          alignItems: 'center',
        }}
      >
        <strong
          style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: V4.textMuted,
            marginRight: 4,
          }}
        >
          Weight preset
        </strong>
        {PRESET_ORDER.map((key) => {
          const p = WEIGHT_PRESETS[key];
          const active = presetKey === key;
          const pct = {
            drug: Math.round(p.weights.drug * 100),
            oop: Math.round(p.weights.oop * 100),
            extras: Math.round(p.weights.extras * 100),
          };
          return (
            <button
              key={key}
              type="button"
              onClick={() => setPresetKey(active ? null : key)}
              title={`Rx ${pct.drug}% / Medical ${pct.oop}% / Extras ${pct.extras}%`}
              style={presetBtnStyle(active)}
            >
              {p.label}
              <span style={{ marginLeft: 6, fontSize: 9, opacity: 0.7, fontFamily: FONT.mono }}>
                {pct.drug}/{pct.oop}/{pct.extras}
              </span>
            </button>
          );
        })}
        {presetKey && (
          <button
            type="button"
            onClick={() => setPresetKey(null)}
            style={{
              background: 'transparent',
              border: 'none',
              padding: '4px 8px',
              color: V4.textMuted,
              fontSize: 11,
              fontFamily: FONT.body,
              cursor: 'pointer',
              textDecoration: 'underline',
              textUnderlineOffset: 2,
            }}
          >
            Reset to archetype
          </button>
        )}
      </div>

      {/* Weight readout — current Rx/Medical/Extras % and per-plan
          composite scores. Mono so the alignment reads as data, not
          prose. Updates whenever weights change. */}
      <div
        style={{
          marginBottom: 12,
          padding: '6px 10px',
          background: '#fff',
          border: `1px dashed ${V4.border}`,
          borderRadius: 6,
          fontSize: 10,
          fontFamily: FONT.mono,
          color: V4.textMuted,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 14,
          alignItems: 'center',
        }}
      >
        <span>
          Rx <strong style={{ color: V4.navy }}>{wPct.drug}%</strong>
          {' / '}
          Medical <strong style={{ color: V4.teal }}>{wPct.oop}%</strong>
          {' / '}
          Extras <strong style={{ color: V4.green }}>{wPct.extras}%</strong>
        </span>
        {result && (
          <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 10 }}>
            <span style={{ color: V4.textMuted }}>composite:</span>
            {[...result.scored]
              .filter((s) => !s.disqualified)
              .slice(0, 3)
              .map((s) => (
                <span key={s.plan.id}>
                  {s.plan.contract_id}-{s.plan.plan_number}
                  {' '}
                  <strong style={{ color: V4.textPrimary }}>{s.composite.toFixed(1)}</strong>
                </span>
              ))}
          </span>
        )}
      </div>

      <div style={{ marginBottom: 12, fontSize: 12, color: COL.inkSub }}>
        <strong style={{ marginRight: 8, fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Pharmacy</strong>
        <button type="button" onClick={() => setPharmacyFill('retail_30')} style={pharmBtnStyle(pharmacyFill === 'retail_30')}>30-day retail</button>
        <button type="button" onClick={() => setPharmacyFill('mail_90')} style={pharmBtnStyle(pharmacyFill === 'mail_90')}>90-day mail</button>
        {drugCosts.loading && <span style={{ marginLeft: 8, fontSize: 10, color: COL.inkSub }}>fetching live costs…</span>}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table
          style={{
            borderCollapse: 'collapse',
            tableLayout: 'fixed',
            minWidth,
            width: '100%',
          }}
        >
          {/* ── Column header row ─────────────────────────────────── */}
          <thead>
            <tr>
              <th
                style={{
                  width: LABEL_W,
                  minWidth: LABEL_W,
                  padding: 14,
                  textAlign: 'left',
                  fontFamily: FONT.serif,
                  fontSize: 16,
                  fontWeight: 700,
                  color: COL.navyHeader,
                  background: COL.panelBg,
                  borderBottom: `1px solid ${COL.rule}`,
                }}
              >
                Quote Comparison
              </th>
              {columns.map((col) => {
                const s = styleFor(col.variant);
                return (
                  <th
                    key={col.id}
                    style={{
                      width: PLAN_W,
                      minWidth: PLAN_W,
                      padding: 14,
                      textAlign: 'left',
                      verticalAlign: 'top',
                      background: s.headerBg,
                      color: s.headerFg,
                      borderBottom: `1px solid ${COL.rule}`,
                      fontWeight: 400,
                    }}
                  >
                    {col.ribbon && (
                      <div
                        style={{
                          fontSize: 9,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                          color: col.variant === 'current' ? COL.inkSub : 'rgba(255,255,255,0.85)',
                          marginBottom: 3,
                        }}
                      >
                        {col.ribbon}
                      </div>
                    )}
                    {col.id === recommendedColId && (
                      <div
                        style={{
                          display: 'inline-block',
                          fontSize: 9,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                          padding: '2px 6px',
                          borderRadius: 3,
                          background: V4.gold,
                          color: '#1f1300',
                          marginBottom: 4,
                        }}
                      >
                        ★ Recommended
                      </div>
                    )}
                    {col.variant === 'current' && (
                      <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: COL.inkSub, marginBottom: 3 }}>
                        Current Plan
                      </div>
                    )}
                    {/* Red flag — Rule 9 (chronic + MOOP at CMS
                        ceiling) or any future ≥25-point penalty. The
                        broker should not quote this plan without a
                        compelling reason. tooltip carries every rule
                        reason that fired. */}
                    {redFlagByColumnId[col.id] && col.scored && (
                      <div
                        title={[
                          ...col.scored.appliedRules
                            .filter((r) => r.action === 'penalize')
                            .map((r) => r.reason),
                          ...col.scored.redFlags
                            .filter((f) => f.severity === 'critical' || f.severity === 'disqualify')
                            .map((f) => f.message),
                        ].join(' · ')}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: '#fcebeb',
                          color: '#a32d2d',
                          fontSize: 10,
                          fontWeight: 700,
                          marginBottom: 4,
                        }}
                      >
                        ⚠ Red flag
                      </div>
                    )}
                    <div style={{ fontSize: 10, opacity: 0.75 }}>{col.carrier}</div>
                    <div
                      style={{
                        fontFamily: FONT.serif,
                        fontSize: 13,
                        fontWeight: 600,
                        marginTop: 1,
                        lineHeight: 1.2,
                      }}
                    >
                      {col.planName}
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
                      <span style={{ fontFamily: FONT.mono, fontSize: 9, opacity: 0.7 }}>{col.hNumber}</span>
                      <span style={{ fontSize: 9, fontWeight: 600, color: col.starColor ?? (col.variant === 'current' ? '#d97706' : '#fef3c7') }}>
                        {col.star}★
                      </span>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>

          {/* ── Body ─────────────────────────────────────────────── */}
          <tbody>
            <SectionHeader colSpan={colSpanFull} label="Your Medications" />

            {medRows.map((m, mi) => (
              <tr key={`med-${mi}`}>
                <th style={labelCellStyle}>
                  <div>{m.name}</div>
                  <div style={{ fontSize: 10, color: COL.inkSub, fontWeight: 400 }}>{m.fillNote}</div>
                </th>
                {columns.map((col, ci) => {
                  const s = styleFor(col.variant);
                  const tier = m.tiers[ci];
                  const flags = m.paStFlags?.[ci];
                  const source = m.sources[ci];
                  const monthlyHere = m.monthly[ci];
                  const monthlyBase = m.monthly[0];
                  // Only compute delta when BOTH cells carry real
                  // data. Comparing an estimate against a real number
                  // would mislead — the cells are not commensurate.
                  const sourceBase = m.sources[0];
                  const isRealHere = source === 'cache' || source === 'formulary';
                  const isRealBase = sourceBase === 'cache' || sourceBase === 'formulary';
                  const delta =
                    ci === 0 || !isRealHere || !isRealBase || monthlyHere == null || monthlyBase == null || monthlyHere === monthlyBase
                      ? null
                      : monthlyHere - monthlyBase;
                  const tooltipFor = (src: typeof source): string => {
                    switch (src) {
                      case 'unavailable':
                        return 'Cost data not available for this plan. Verify with the carrier before quoting.';
                      case 'tier_estimate':
                        return 'Estimated from formulary tier — actual copay may differ. Verify with the carrier.';
                      case 'no_rxcui':
                        return 'Drug RxNorm code not resolved — re-add the medication from the search.';
                      case 'excluded':
                        return 'Tier 6 / excluded — drug is not covered by this plan.';
                      case 'cache':
                        return 'Actual price from Medicare.gov Plan Finder cache.';
                      case 'formulary':
                        return 'Actual cost from plan formulary file.';
                    }
                  };
                  return (
                    <td key={col.id} style={cellStyle(s.bodyBg)}>
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}
                        title={tooltipFor(source)}
                      >
                        {tier != null && source !== 'unavailable' && <TierBadge tier={tier} />}
                        <span
                          style={{
                            fontFamily: FONT.mono,
                            fontSize: 12,
                            color: source === 'unavailable' ? COL.inkSub : source === 'tier_estimate' ? '#6b7280' : s.bodyFg,
                            fontStyle: source === 'tier_estimate' ? 'italic' : 'normal',
                          }}
                        >
                          {m.values[ci]}
                        </span>
                        {delta != null && <DeltaBadge value={delta} />}
                        {flags?.pa && <Flag>PA</Flag>}
                        {flags?.st && <Flag>ST</Flag>}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}

            {/* Total Rx Cost — honest about gaps. Per-column counts
                of unavailable / estimated drugs are shown beside the
                total so the broker knows which numbers are firm. */}
            <tr>
              <th style={{ ...labelCellStyle, fontWeight: 700, borderTop: `1.5px solid ${COL.rule}` }}>
                Total Rx Cost
              </th>
              {columns.map((col, ci) => {
                const s = styleFor(col.variant);
                const annualRaw = rxTotalAnnual[ci];
                const monthlyRaw = rxTotalMonthly[ci];
                const baseAnnual = rxTotalAnnual[baseIdx];

                // Per-cell flags: how many drugs in this plan column
                // are estimates vs unavailable?
                let unavailable = 0;
                let estimates = 0;
                for (const row of medRows) {
                  const src = row.sources[ci];
                  if (src === 'unavailable' || src === 'no_rxcui') unavailable += 1;
                  else if (src === 'tier_estimate') estimates += 1;
                }

                const isComplete = unavailable === 0 && annualRaw != null;
                const realBase = baseAnnual != null && (medRows.every((r) => {
                  const sb = r.sources[baseIdx];
                  return sb !== 'unavailable' && sb !== 'no_rxcui';
                }));
                const delta =
                  ci === 0 || !isComplete || !realBase || annualRaw == null || baseAnnual == null
                    ? null
                    : annualRaw - baseAnnual;

                return (
                  <td key={col.id} style={{ ...cellStyle(s.bodyBg), fontWeight: 700, borderTop: `1.5px solid ${COL.rule}` }}>
                    {annualRaw == null ? (
                      <span style={{ fontFamily: FONT.mono, fontSize: 12, color: COL.inkSub }} title="Not enough data to compute a total — see per-drug rows.">
                        —
                      </span>
                    ) : (
                      <>
                        <span style={{ fontFamily: FONT.mono, fontSize: 12 }}>
                          ${monthlyRaw ?? 0}/mo · ${annualRaw.toLocaleString()}/yr
                        </span>
                        {delta != null && delta !== 0 && <DeltaBadge value={delta} />}
                      </>
                    )}
                    {(unavailable > 0 || estimates > 0) && (
                      <div
                        style={{ fontSize: 9, color: COL.inkSub, fontWeight: 500, marginTop: 2, fontFamily: FONT.body }}
                        title="Some drug costs are estimated from tier or unavailable. Verify with the carrier before quoting."
                      >
                        {unavailable > 0 && `${unavailable} unavailable`}
                        {unavailable > 0 && estimates > 0 && ' · '}
                        {estimates > 0 && `${estimates} est.`}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>

            <SectionHeader colSpan={colSpanFull} label="Providers" />

            {providerRows.map((pr, pi) => (
              <tr key={`prov-${pi}`}>
                <th style={labelCellStyle}>
                  <div style={{ fontWeight: 600 }}>{pr.name}</div>
                  <div style={{ fontSize: 10, color: COL.inkSub, fontWeight: 400 }}>{pr.specialty}</div>
                </th>
                {columns.map((col, ci) => {
                  const s = styleFor(col.variant);
                  const status = pr.status[ci];
                  const dot = status === 'in' ? '●' : status === 'out' ? '●' : '●';
                  const text = status === 'in' ? 'In-Net' : status === 'out' ? 'Out' : 'Unknown';
                  const color = status === 'in' ? '#3b6d11' : status === 'out' ? '#a32d2d' : '#6b7280';
                  return (
                    <td key={col.id} style={cellStyle(s.bodyBg)}>
                      <span style={{ color, fontWeight: 700, fontSize: 11 }}>
                        {dot} {text}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}

            <SectionHeader colSpan={colSpanFull} label="Medical Copays" />

            {copayRows.map((row, ri) => (
              <CopayRowEl key={`cp-${ri}`} row={row} columns={columns} />
            ))}

            {/* Total inpatient cost — bold subtotal directly under Inpatient/day */}
            <tr>
              <th style={{ ...labelCellStyle, fontWeight: 700, borderBottom: `1.5px solid ${COL.ruleStrong}` }}>
                <div>Total inpatient cost</div>
                <div style={{ fontSize: 10, color: COL.inkSub, fontWeight: 400 }}>{DEFAULT_INPATIENT_DAYS}-day hospital stay</div>
              </th>
              {columns.map((col, ci) => {
                const s = styleFor(col.variant);
                const total = inpatientTotal[ci] ?? 0;
                const base = inpatientTotal[baseIdx] ?? 0;
                const delta = ci === 0 ? null : total - base;
                return (
                  <td
                    key={col.id}
                    style={{
                      ...cellStyle(s.bodyBg),
                      fontWeight: 700,
                      borderBottom: `1.5px solid ${COL.ruleStrong}`,
                    }}
                  >
                    <span style={{ fontFamily: FONT.mono, fontSize: 12 }}>${total.toLocaleString()}</span>
                    {delta != null && delta !== 0 && <DeltaBadge value={delta} />}
                  </td>
                );
              })}
            </tr>

            <SectionHeader colSpan={colSpanFull} label="Plan Costs" />

            {planCostRows.map((row, ri) => (
              <CopayRowEl key={`pc-${ri}`} row={row} columns={columns} />
            ))}

            <SectionHeader colSpan={colSpanFull} label="Extra Benefits" />

            {extraRows.map((row, ri) => (
              <CopayRowEl key={`ex-${ri}`} row={row} columns={columns} betterIsHigher={row.betterIsHigher} />
            ))}

            {/* Total Annual Value navy bar */}
            <tr>
              <th
                style={{
                  width: LABEL_W,
                  padding: '12px 14px',
                  textAlign: 'left',
                  background: COL.summaryNavy,
                  color: COL.white,
                  fontFamily: FONT.serif,
                  fontSize: 13,
                  fontWeight: 700,
                  borderBottom: 'none',
                }}
              >
                Total Annual Value
              </th>
              {columns.map((col, ci) => {
                const isCurrent = col.variant === 'current';
                // Prefer the playbook's realAnnualCost (premium + drugs +
                // medical visits + supplies + ER risk + hospital risk,
                // capped at MOOP, − giveback). Falls back to the older
                // "extras − cost" annualNet when realAnnualCost hasn't
                // populated yet (initial render before brain ready).
                const real = col.scored?.realAnnualCost ?? null;
                const annual = real ? real.netAnnual : (annualNet[ci] ?? 0);
                const baselineReal = columns[baseIdx]?.scored?.realAnnualCost?.netAnnual ?? null;
                const savings = real && baselineReal != null
                  ? baselineReal - annual
                  : (savingsVsBaseline[ci] ?? 0);
                const tooltip = real
                  ? formatRealAnnualCostBreakdown(real)
                  : (() => {
                      const b = annualBreakdown[ci];
                      if (!b) return '';
                      const parts: string[] = [];
                      parts.push(`Rx $${b.rx.toLocaleString()}`);
                      parts.push(`+ Premium $${b.premium.toLocaleString()}`);
                      if (b.giveback > 0) parts.push(`− Giveback $${b.giveback.toLocaleString()}`);
                      if (b.dental > 0)   parts.push(`− Dental $${b.dental.toLocaleString()}`);
                      if (b.otc > 0)      parts.push(`− OTC $${b.otc.toLocaleString()}`);
                      if (b.food > 0)     parts.push(`− Food $${b.food.toLocaleString()}`);
                      const annualVal = annualNet[ci] ?? 0;
                      parts.push(`= $${Math.abs(annualVal).toLocaleString()}/yr ${annualVal < 0 ? 'cost' : 'value'}`);
                      return parts.join(' ');
                    })();
                return (
                  <td
                    key={col.id}
                    title={tooltip}
                    style={{
                      width: PLAN_W,
                      padding: '12px 14px',
                      background: COL.summaryNavy,
                      color: isCurrent ? COL.white : COL.summaryGreen,
                      fontFamily: FONT.mono,
                      fontSize: 15,
                      fontWeight: 700,
                      borderBottom: 'none',
                      cursor: tooltip ? 'help' : 'default',
                    }}
                  >
                    {real
                      ? `$${annual.toLocaleString()}/yr`
                      : `${annual < 0 ? '−' : ''}$${Math.abs(annual).toLocaleString()}/yr`}
                    {!isCurrent && savings > 0 && (
                      <span style={{ fontSize: 9, marginLeft: 6, opacity: 0.85 }}>saves ${Math.round(savings).toLocaleString()}</span>
                    )}
                    {real?.cappedAtMoop && (
                      <span style={{ fontSize: 9, marginLeft: 6, opacity: 0.85, color: '#ffd166' }}>capped @ MOOP</span>
                    )}
                  </td>
                );
              })}
            </tr>

            {/* Why switch? subtitle row */}
            <tr>
              <th
                style={{
                  padding: '0 14px 10px',
                  textAlign: 'left',
                  background: COL.summaryNavy,
                  color: 'rgba(255,255,255,0.55)',
                  fontSize: 10,
                  fontWeight: 400,
                  borderBottom: 'none',
                }}
              >
                Why switch?
              </th>
              {columns.map((col, ci) => (
                <td
                  key={col.id}
                  style={{
                    padding: '0 14px 10px',
                    background: COL.summaryNavy,
                    color: 'rgba(255,255,255,0.7)',
                    fontFamily: FONT.body,
                    fontSize: 10,
                    borderBottom: 'none',
                    whiteSpace: 'normal',
                  }}
                >
                  {whySwitch[ci]}
                </td>
              ))}
            </tr>

            {/* Action row — Recommend + Open SunFire */}
            <tr>
              <th style={{ width: LABEL_W, padding: 12, background: COL.panelBg, borderBottom: 'none' }}></th>
              {columns.map((col) => {
                const isCurrent = col.variant === 'current';
                const isRec = recommendation === col.id;
                return (
                  <td
                    key={col.id}
                    style={{
                      width: PLAN_W,
                      padding: 12,
                      background: COL.panelBg,
                      verticalAlign: 'top',
                      borderBottom: 'none',
                    }}
                  >
                    {isCurrent ? (
                      <button type="button" style={btnSecondaryStyle}>Keep Current</button>
                    ) : (
                      <button
                        type="button"
                        style={isRec ? btnRecOnStyle : btnRecStyle}
                        onClick={() => {
                          const next = isRec ? null : col.id;
                          onRecommend?.(next);
                          if (next) {
                            const input = buildSyncInput(next);
                            if (input) void agentbaseSync.sync(input);
                          } else {
                            agentbaseSync.reset();
                          }
                        }}
                      >
                        {isRec ? '✓ Recommended' : 'Recommend'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => { void handleOpenSunFire(col.id); }}
                      style={{ ...btnSunfireStyle, cursor: 'pointer' }}
                    >
                      {sunfireStatus[col.id] === 'copying'
                        ? 'Copying…'
                        : sunfireStatus[col.id] === 'copied'
                          ? '✓ Plan copied · open SunFire'
                          : sunfireStatus[col.id] === 'error'
                            ? '⚠ Copy failed · open SunFire'
                            : 'Open SunFire →'}
                    </button>
                    {sunfireStatus[col.id] === 'copied' && (
                      <div
                        style={{
                          marginTop: 4,
                          fontSize: 10,
                          fontWeight: 500,
                          color: COL.inkSub,
                          fontFamily: FONT.body,
                          lineHeight: 1.3,
                        }}
                      >
                        Paste into SunFire plan search
                      </div>
                    )}
                    {sunfireStatus[col.id] === 'error' && (
                      <div
                        style={{
                          marginTop: 4,
                          fontSize: 10,
                          fontWeight: 500,
                          color: '#a32d2d',
                          fontFamily: FONT.body,
                          lineHeight: 1.3,
                        }}
                      >
                        Clipboard denied · open dev console for details
                      </div>
                    )}
                    {isRec && (
                      <SyncStatusPill
                        state={agentbaseSync.state}
                        error={agentbaseSync.error}
                        url={agentbaseSync.result?.agentbase_url ?? null}
                        givebackFlagged={agentbaseSync.result?.giveback_flagged ?? false}
                        onRetry={() => {
                          const input = buildSyncInput(col.id);
                          if (input) void agentbaseSync.sync(input);
                        }}
                      />
                    )}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>

      {medsNeedingAssistance.size > 0 && (
        <AssistanceHelpSection
          medications={medications.filter((m) => medsNeedingAssistance.has(m.id))}
          assistanceByMedId={assistance.byMedicationId}
        />
      )}

      {/* Cost-data provenance footnote. Surfaces "*" when any drug
          cell is a tier estimate, so the broker knows which numbers
          are firm vs derived. Compliance: a $47 estimate is not the
          same as a $47 actual price. */}
      {medRows.some((r) => r.sources.some((s) => s === 'tier_estimate')) && (
        <div style={{ padding: '6px 0 0', fontSize: 10, color: COL.inkSub, fontStyle: 'italic' }}>
          * <strong>est.</strong> = estimated from formulary tier · actual copay may differ · verify with the carrier before quoting
        </div>
      )}
      {medRows.some((r) => r.sources.some((s) => s === 'unavailable' || s === 'no_rxcui')) && (
        <div style={{ padding: '4px 0 0', fontSize: 10, color: COL.inkSub }}>
          <strong>—</strong> = cost data not available for this (plan, drug) pair · verify with the carrier before quoting
        </div>
      )}

      {result && client.county && (
        <div style={{ padding: '6px 0 0', fontSize: 10, color: COL.inkSub }}>
          Plan Brain · population {result.population.toUpperCase()} · utilization {result.utilization} · {client.county}, {client.state}
        </div>
      )}

      {/* Global action button row — Print quote, Side-by-side PDF,
          Enroll in SunFire. Per-column Recommend / Open SunFire buttons
          live in the table action row above; these are the workflow-
          level actions the broker hits once they've picked a plan. */}
      <div
        style={{
          marginTop: 14,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <button
          type="button"
          onClick={() => window.print()}
          style={v4ActionBtnStyle(false)}
        >
          🖨 Print quote
        </button>
        <button
          type="button"
          onClick={() => window.print()}
          style={v4ActionBtnStyle(false)}
          title="Use the printable snapshot from usePrintableQuote → quotePdf"
        >
          📄 Side-by-side PDF
        </button>
        <button
          type="button"
          onClick={() => {
            // Fire-and-forget the structured AgentBase sync so the
            // CRM's client detail surfaces medications + providers
            // before the broker finishes enrolling. We do NOT block
            // the SunFire tab on sync completion — Chromium pauses
            // pending fetches across navigations and the broker is
            // about to switch focus to a different tab anyway.
            //
            // Plan selection priority:
            //   1. session.recommendation (broker's explicit pick)
            //   2. recommendedColId (highest-value finalist — the
            //      gold-badge column)
            //   3. first non-current finalist column
            const targetPlanId =
              recommendation
              ?? recommendedColId
              ?? columns.find((c) => c.variant !== 'current')?.id
              ?? null;
            if (targetPlanId) {
              const input = buildSyncInput(targetPlanId);
              if (input) {
                // The hook swallows errors into its own state; the
                // .catch is belt-and-suspenders for unexpected
                // rejection paths (e.g. buildBody throwing on bad
                // input shape).
                void agentbaseSync.sync(input).catch((err) => {
                  console.error('[enroll-sunfire] sync kickoff failed:', err);
                });
              }
            }
            const url = (typeof window !== 'undefined' && (window as { ENV?: { SUNFIRE_AGENT_URL?: string } }).ENV?.SUNFIRE_AGENT_URL)
              || SUNFIRE_URL;
            window.open(url, '_blank', 'noopener,noreferrer');
          }}
          style={v4ActionBtnStyle(true)}
        >
          ✓ Enroll in SunFire
        </button>
      </div>

      {/* Footer — PlanMatch brain version + data sources + NPN. */}
      <div
        style={{
          marginTop: 16,
          paddingTop: 10,
          borderTop: `1px solid ${V4.border}`,
          fontSize: 10,
          fontFamily: FONT.body,
          color: V4.textMuted,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontFamily: FONT.mono }}>
          PlanMatch brain {BRAIN_VERSION}
        </span>
        <span>
          Sources: pm_plans · pbp_benefits · pm_drug_cost_cache · pm_formulary · pm_provider_cache_coverage
        </span>
        <span>
          {BROKER.name} · NPN {BROKER.npn}
        </span>
      </div>
    </div>
  );
}

// ─── Subcomponents + helpers ───────────────────────────────────────

// ─── Data helpers ──────────────────────────────────────────────────

function makeCol(plan: Plan, scored: ScoredPlan | null, variant: ColumnVariant): ColumnDef {
  const ribbon = scored?.ribbon ? RIBBON_LABEL[scored.ribbon] ?? null : null;
  const star = plan.star_rating ?? 0;
  return {
    id: plan.id,
    variant,
    ribbon,
    carrier: plan.carrier ?? '—',
    planName: plan.plan_name ?? '—',
    hNumber: `${plan.contract_id}-${plan.plan_number}`,
    star,
    starColor: star >= 4.5 ? '#3b6d11' : undefined,
    plan,
    scored,
  };
}

// Compliance-critical: drug-cost data must be honest. NEVER default
// to $0 when data is missing — a $0 display means "this plan charges
// nothing", and showing it for a drug that actually costs $47/mo
// could trigger a CMS complaint against the broker's NPN.
//
// Three display states:
//   • cache         — actual price from pm_drug_cost_cache. Display
//                     "$X" normally.
//   • formulary     — actual per-fill copay/coinsurance from
//                     pm_formulary, OR the plan's tier copay from
//                     pbp_benefits.rx_tiers (the structured PBP
//                     extract). Both are real numbers, just not
//                     drug-NDC-specific. Display "$X" normally.
//   • tier_estimate — formulary row exists with a tier but no copay,
//                     and no plan-level tier copay either. Fall back
//                     to industry-typical tier copays so the agent
//                     gets a number, but flag is_estimate so the UI
//                     renders "est. $X" with an asterisk.
//   • excluded      — Tier 6 OR seed formulary marker 'excluded'.
//                     Display "Not covered".
//   • unavailable   — no rxcui, no NDC bridge, no formulary row, no
//                     tier hint. Display "—" with a tooltip
//                     explaining the data gap. Drug-cost totals
//                     ignore unavailable rows AND surface a count so
//                     the broker knows how much of the total was
//                     unknowable.

type CostSource = 'cache' | 'formulary' | 'tier_estimate' | 'unavailable' | 'excluded';

interface DrugInfo {
  tier: number | null;
  label: string;
  monthly: number | null;
  annual: number | null;
  source: CostSource;
  is_estimate: boolean;
  pa: boolean;
  st: boolean;
}

// Industry-typical tier copays for MAPD plans, used only as the very
// last fallback when neither cache nor formulary nor plan tier copay
// is populated. These come from CMS landscape averages 2025-2026
// (preferred mail/retail, 30-day fill).
//
// Tier 6 is intentionally NOT in the estimate map — its meaning is
// carrier-specific (Wellcare uses "Select Care · $0", others use
// "Excluded Generics", others use "Specialty Tier 2"). Without a
// universal default the tier-6 path falls through to the plan-level
// rx_tiers.tier_6 copay (which IS populated from pm_plan_benefits),
// which is the only honest source.
const TIER_ESTIMATE_USD: Record<number, number | null> = {
  1: 5,    // generic preferred
  2: 20,   // generic non-preferred
  3: 47,   // brand preferred
  4: null, // coinsurance tier — handled separately
  5: null, // coinsurance tier
};

function lookupDrugCost(
  plan: Plan,
  med: Medication,
  data: PlanBrainData | null,
  pharmacyFill: PharmacyFill,
): DrugInfo | null {
  if (!med.rxcui) return null;
  const tripleId = plan.id;
  const contractPlan = `${plan.contract_id}-${plan.plan_number}`;

  const ndc = data?.ndcByRxcui[med.rxcui]?.ndc;
  const cached = ndc ? data?.drugCostCache[tripleId]?.[ndc] : undefined;
  const formulary = data?.formularyByContractPlan[contractPlan]?.[med.rxcui];

  let tier: number | null = cached?.tier ?? formulary?.tier ?? null;
  if (tier == null) {
    const seedTier = plan.formulary[med.rxcui];
    if (typeof seedTier === 'number') tier = seedTier;
    else if (seedTier === 'excluded') {
      return notCovered();
    }
  }
  // NOTE: tier 6 is NOT excluded by default. Wellcare (and several
  // other carriers) file preferred generics at tier 6 with $0 copay
  // and quantity limits — the previous `if (tier === 6) return
  // notCovered()` here actively misrepresented real coverage. The
  // only path to "Not covered" is the seed formulary marker
  // 'excluded' (handled above) — every numeric tier 1-8 falls
  // through to the cost-share lookup below.

  // Path 1 — cache hit. Real per-NDC, per-plan annual price.
  if (cached?.estimated_yearly_total != null) {
    const annual = Math.round(cached.estimated_yearly_total);
    const monthlyBase = Math.round(annual / 12);
    const monthly = pharmacyFill === 'mail_90' ? monthlyBase * 3 : monthlyBase;
    return {
      tier,
      label: `$${monthly}`,
      monthly,
      annual,
      source: 'cache',
      is_estimate: false,
      pa: formulary?.prior_auth === true,
      st: formulary?.step_therapy === true,
    };
  }

  // Path 2 — pm_formulary copay populated. Real per-fill cost.
  if (formulary?.copay != null) {
    const monthlyBase = formulary.copay;
    const monthly = pharmacyFill === 'mail_90' ? monthlyBase * 3 : monthlyBase;
    return {
      tier,
      label: `$${monthly}`,
      monthly,
      annual: monthlyBase * 12,
      source: 'formulary',
      is_estimate: false,
      pa: formulary.prior_auth === true,
      st: formulary.step_therapy === true,
    };
  }

  // Path 3 — pm_formulary coinsurance populated. Real percentage.
  if (formulary?.coinsurance != null) {
    return {
      tier,
      label: `${formulary.coinsurance}%`,
      monthly: null,
      annual: null,
      source: 'formulary',
      is_estimate: false,
      pa: formulary.prior_auth === true,
      st: formulary.step_therapy === true,
    };
  }

  // Path 4 — plan-level tier copay from pbp_benefits.rx_tiers. Real
  // dollar amount even when the per-drug formulary row didn't carry it.
  if (tier != null) {
    const tierCash = tierCopay(plan, tier);
    if (tierCash != null) {
      const monthlyBase = tierCash;
      const monthly = pharmacyFill === 'mail_90' ? monthlyBase * 3 : monthlyBase;
      return {
        tier,
        label: `$${monthly}`,
        monthly,
        annual: monthlyBase * 12,
        source: 'formulary',
        is_estimate: false,
        pa: formulary?.prior_auth === true,
        st: formulary?.step_therapy === true,
      };
    }

    // Path 5 — tier-only estimate from industry averages.
    const tierUsd = TIER_ESTIMATE_USD[tier];
    if (tierUsd != null) {
      const monthly = pharmacyFill === 'mail_90' ? tierUsd * 3 : tierUsd;
      return {
        tier,
        label: `est. $${monthly}*`,
        monthly,
        annual: tierUsd * 12,
        source: 'tier_estimate',
        is_estimate: true,
        pa: formulary?.prior_auth === true,
        st: formulary?.step_therapy === true,
      };
    }
    if (tier === 4 || tier === 5) {
      return {
        tier,
        label: 'est. 25–33%*',
        monthly: null,
        annual: null,
        source: 'tier_estimate',
        is_estimate: true,
        pa: formulary?.prior_auth === true,
        st: formulary?.step_therapy === true,
      };
    }
  }

  // Path 6 — no data anywhere. Compliance-critical: return
  // 'unavailable' so the cell renders '—' (em dash), NOT $0.
  return {
    tier,
    label: '—',
    monthly: null,
    annual: null,
    source: 'unavailable',
    is_estimate: false,
    pa: false,
    st: false,
  };
}

function notCovered(): DrugInfo {
  return {
    tier: null,
    label: 'Not covered',
    monthly: null,
    annual: null,
    source: 'excluded',
    is_estimate: false,
    pa: false,
    st: false,
  };
}

function tierCopay(plan: Plan, tier: number): number | null {
  const map: Record<number, keyof Plan['benefits']['rx_tiers']> = {
    1: 'tier_1', 2: 'tier_2', 3: 'tier_3', 4: 'tier_4', 5: 'tier_5',
    6: 'tier_6', 7: 'tier_7', 8: 'tier_8',
  };
  const key = map[tier];
  if (!key) return null;
  return plan.benefits.rx_tiers[key]?.copay ?? null;
}

function providerStatusFor(prov: Provider, plan: Plan): 'in' | 'out' | 'unknown' {
  const override = prov.manualOverrides?.[plan.carrier];
  if (override?.status === 'in') return 'in';
  const raw = prov.networkStatus?.[plan.id];
  if (raw === 'in') return 'in';
  if (raw === 'out') return 'out';
  return 'unknown';
}

interface MedicalDef {
  label: string;
  pick: (plan: Plan) => { copay: number | null; coinsurance: number | null; description: string | null };
}

const MEDICAL_DEFS: MedicalDef[] = [
  { label: 'PCP',                pick: (p) => p.benefits.medical.primary_care },
  { label: 'Specialist',         pick: (p) => p.benefits.medical.specialist },
  { label: 'Labs',               pick: (p) => p.benefits.medical.lab_services },
  { label: 'Imaging / MRI',      pick: (p) => p.benefits.medical.diagnostic_radiology },
  { label: 'ER',                 pick: (p) => p.benefits.medical.emergency },
  { label: 'Urgent Care',        pick: (p) => p.benefits.medical.urgent_care },
  { label: 'Outpatient Surgery', pick: (p) => p.benefits.medical.outpatient_surgery_hospital },
  { label: 'Mental Health',      pick: (p) => p.benefits.medical.mental_health_individual },
  { label: 'PT / OT',            pick: (p) => p.benefits.medical.physical_therapy },
  { label: 'Inpatient',          pick: (p) => p.benefits.medical.inpatient },
];

function copayCash(cs: { copay: number | null; coinsurance: number | null }): number | null {
  return cs.copay ?? null;
}

function formatCostShare(cs: { copay: number | null; coinsurance: number | null }): string {
  if (cs.copay != null) return `$${cs.copay}`;
  if (cs.coinsurance != null) return `${cs.coinsurance}%`;
  return '—';
}

// ─── Subcomponents ────────────────────────────────────────────────

function SectionHeader({ colSpan, label }: { colSpan: number; label: string }) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        style={{
          padding: '14px 14px 4px',
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: COL.navyHeader,
          background: COL.panelBg,
          borderBottom: `1.5px solid ${COL.navyHeader}`,
          fontFamily: FONT.body,
        }}
      >
        {label}
      </td>
    </tr>
  );
}

function CopayRowEl({ row, columns, betterIsHigher }: { row: CopayRow; columns: ColumnDef[]; betterIsHigher?: boolean }) {
  return (
    <tr>
      <th style={labelCellStyle}>{row.label}</th>
      {columns.map((col, ci) => {
        const s = styleFor(col.variant);
        const v = row.values[ci];
        const num = row.numbers[ci];
        const baseNum = row.numbers[0];
        const isNumeric = typeof num === 'number' && typeof baseNum === 'number';
        const delta = ci === 0 || !isNumeric || num === baseNum ? null : (num as number) - (baseNum as number);
        return (
          <td key={col.id} style={cellStyle(s.bodyBg)}>
            <span style={{ fontFamily: FONT.mono, fontSize: 12, color: s.bodyFg }}>{v}</span>
            {delta != null && delta !== 0 && (
              <DeltaBadge value={delta} flipBetter={betterIsHigher} />
            )}
          </td>
        );
      })}
    </tr>
  );
}

function TierBadge({ tier }: { tier: number }) {
  const palette = TIER_BADGE[tier] ?? { bg: '#e5e7eb', fg: '#374151' };
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        borderRadius: 4,
        background: palette.bg,
        color: palette.fg,
        fontSize: 10,
        fontWeight: 700,
        fontFamily: FONT.mono,
      }}
    >
      {tier}
    </span>
  );
}

function DeltaBadge({ value, flipBetter }: { value: number; flipBetter?: boolean }) {
  // flipBetter=true → positive delta is good (e.g. larger benefit dollar value)
  const isSavings = flipBetter ? value > 0 : value < 0;
  const sign = value < 0 ? '−' : '+';
  const abs = Math.abs(value);
  return (
    <span
      style={{
        marginLeft: 6,
        padding: '1px 6px',
        borderRadius: 4,
        fontSize: 10,
        fontFamily: FONT.mono,
        fontWeight: 700,
        background: isSavings ? COL.saveBg : COL.moreBg,
        color: isSavings ? COL.saveText : COL.moreText,
        whiteSpace: 'nowrap',
      }}
    >
      {sign}${abs.toLocaleString()}
    </span>
  );
}

function Flag({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 8,
        fontWeight: 700,
        padding: '1px 4px',
        borderRadius: 3,
        background: '#faeeda',
        color: '#854f0b',
        fontFamily: FONT.mono,
        marginLeft: 2,
      }}
    >
      {children}
    </span>
  );
}

// ─── V4 spec atoms ─────────────────────────────────────────────────

function ContextField({
  label,
  value,
  bold,
  mono,
  highlight,
}: {
  label: string;
  value: string;
  bold?: boolean;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
      <span
        style={{
          fontSize: 9,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: V4.textMuted,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 12,
          fontWeight: bold ? 700 : highlight ? 700 : 500,
          fontFamily: mono ? FONT.mono : FONT.body,
          color: highlight ? V4.green : V4.textPrimary,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function presetBtnStyle(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '6px 12px',
    borderRadius: 6,
    border: `1px solid ${active ? V4.navy : V4.border}`,
    background: active ? V4.navy : '#fff',
    color: active ? '#fff' : V4.textPrimary,
    fontSize: 11,
    fontWeight: 600,
    fontFamily: FONT.body,
    cursor: 'pointer',
  };
}

function v4ActionBtnStyle(primary: boolean): React.CSSProperties {
  return {
    padding: '8px 16px',
    borderRadius: 8,
    border: primary ? 'none' : `1px solid ${V4.border}`,
    background: primary ? V4.green : '#fff',
    color: primary ? '#fff' : V4.textPrimary,
    fontSize: 12,
    fontWeight: 700,
    fontFamily: FONT.body,
    cursor: 'pointer',
  };
}

// ─── Style atoms ───────────────────────────────────────────────────
// Module-level mirrors of the in-component LABEL_W / PLAN_W so the
// style helpers don't have to be threaded through props. If the
// component-level values change, update these too.
const LABEL_W = 180;
const PLAN_W = 190;

const labelCellStyle: React.CSSProperties = {
  width: LABEL_W,
  padding: '8px 14px',
  textAlign: 'left',
  fontSize: 12,
  fontWeight: 500,
  color: COL.inkSub,
  background: COL.panelBg,
  borderBottom: `1px solid ${COL.rule}`,
  whiteSpace: 'normal',
  fontFamily: FONT.body,
};

function cellStyle(bg: string | undefined): React.CSSProperties {
  return {
    width: PLAN_W,
    padding: '8px 14px',
    textAlign: 'left',
    fontSize: 12,
    color: COL.ink,
    background: bg ?? COL.white,
    borderBottom: `1px solid ${COL.rule}`,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
}

function pharmBtnStyle(active: boolean): React.CSSProperties {
  return {
    display: 'inline-block',
    padding: '5px 11px',
    borderRadius: 6,
    fontSize: 11,
    fontWeight: 600,
    fontFamily: FONT.body,
    background: active ? COL.navyHeader : '#fff',
    color: active ? '#fff' : COL.inkSub,
    border: `1px solid ${active ? COL.navyHeader : '#d1d5db'}`,
    marginRight: 4,
  };
}

const btnRecStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '8px 10px',
  borderRadius: 6,
  border: 'none',
  background: COL.tealHeader,
  color: '#fff',
  fontFamily: FONT.body,
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
  marginBottom: 4,
};
const btnRecOnStyle: React.CSSProperties = {
  ...btnRecStyle,
  background: COL.leafHeader,
};
const btnSecondaryStyle: React.CSSProperties = {
  ...btnRecStyle,
  background: '#f1f3f5',
  color: COL.inkSub,
  border: '1px solid #d1d5db',
};
const btnSunfireStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '6px 10px',
  borderRadius: 6,
  background: '#f1f3f5',
  color: COL.inkSub,
  fontFamily: FONT.body,
  fontSize: 11,
  fontWeight: 600,
  textAlign: 'center',
  textDecoration: 'none',
  border: '1px solid #d1d5db',
  boxSizing: 'border-box',
};

// ─── Assistance help section ─────────────────────────────────────────

function AssistanceHelpSection({
  medications,
  assistanceByMedId,
}: {
  medications: Medication[];
  assistanceByMedId: Record<string, AssistanceRow[]>;
}) {
  const [open, setOpen] = useState(true);
  const totalPrograms = medications.reduce(
    (acc, m) => acc + (assistanceByMedId[m.id]?.length ?? 0),
    0,
  );
  return (
    <div style={{ marginTop: 16, background: '#fff', border: `1px solid ${COL.rule}`, borderRadius: 12, overflow: 'hidden', fontFamily: FONT.body }}>
      <div
        style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', background: 'linear-gradient(0deg, #fef3c7, #fff)' }}
        onClick={() => setOpen((v) => !v)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 24, height: 24, borderRadius: '50%', background: '#e67e22', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700 }}>!</div>
          <div>
            <div style={{ fontFamily: FONT.serif, fontSize: 14, fontWeight: 700, color: COL.navyHeader }}>
              Medication assistance options
            </div>
            <div style={{ fontSize: 11, color: COL.inkSub }}>
              {medications.length} drug{medications.length === 1 ? '' : 's'} need help · {totalPrograms} program{totalPrograms === 1 ? '' : 's'} matched
            </div>
          </div>
        </div>
        <div style={{ fontSize: 11, color: COL.navyHeader, fontWeight: 600 }}>{open ? '−' : '+'}</div>
      </div>
      {open && (
        <div style={{ padding: '12px 16px 16px', borderTop: `1px solid ${COL.rule}` }}>
          {medications.map((m) => {
            const programs = assistanceByMedId[m.id] ?? [];
            return (
              <div key={m.id} id={`qv4-help-${m.id}`} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: COL.navyHeader, marginBottom: 6 }}>
                  {m.name}{m.strength ? ` ${m.strength}` : ''}
                </div>
                {programs.length === 0 ? (
                  <div style={{ fontSize: 12, color: COL.inkSub }}>
                    No manufacturer program matched on brand name. Try the generic-options below or search NeedyMeds / RxAssist.
                  </div>
                ) : (
                  programs.map((p) => <ProgramRow key={p.id} row={p} />)
                )}
              </div>
            );
          })}
          <div style={{ fontSize: 12, color: COL.inkSub, lineHeight: 1.5 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: COL.navyHeader, marginBottom: 6 }}>
              Medicare-side options (work for any drug)
            </div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li><strong>Formulary exception</strong> — prescriber requests coverage / lower tier (72hr / 24hr expedited).</li>
              <li><strong>Extra Help / LIS</strong> — Social Security low-income subsidy; drops Part D copays to $1.55–$11.20.</li>
              <li><strong>Medicare Prescription Payment Plan (M3P)</strong> — spreads the $2,000 OOP cap over 12 months.</li>
              <li><strong>Generic / therapeutic substitution</strong> — ask the prescriber for a tier-1 alternative.</li>
              <li><strong>Foundation grants</strong> — PAN, HealthWell, Good Days disease funds.</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function ProgramRow({ row }: { row: AssistanceRow }) {
  const tagBg = row.program_type === 'PAP' ? '#eaf3de' : row.program_type === 'copay_card' ? '#e6f1fb' : '#faeeda';
  const tagFg = row.program_type === 'PAP' ? '#3b6d11' : row.program_type === 'copay_card' ? '#0c447c' : '#854f0b';
  const tagLabel = row.program_type === 'PAP' ? 'Free drug' : row.program_type === 'copay_card' ? 'Copay card' : 'Foundation';
  return (
    <div style={{ padding: '8px 10px', border: `1px solid ${COL.rule}`, borderRadius: 8, marginBottom: 6, fontSize: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '2px 6px', borderRadius: 3, background: tagBg, color: tagFg }}>
          {tagLabel}
        </span>
        <span style={{ fontFamily: FONT.serif, fontWeight: 700, color: COL.navyHeader }}>{row.program_name}</span>
        {!row.covers_medicare && (
          <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', padding: '2px 6px', borderRadius: 3, background: COL.moreBg, color: COL.moreText }}>
            Excludes Medicare
          </span>
        )}
      </div>
      <div style={{ fontSize: 10, color: COL.inkSub, marginTop: 2 }}>{row.brand_name} · {row.manufacturer}</div>
      {row.eligibility_summary && (
        <div style={{ fontSize: 11, color: COL.inkSub, marginTop: 4, lineHeight: 1.4 }}>{row.eligibility_summary}</div>
      )}
      <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {row.application_url && (
          <a href={row.application_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, fontWeight: 600, color: COL.navyHeader, textDecoration: 'none', padding: '4px 10px', border: `1px solid ${COL.rule}`, borderRadius: 5 }}>
            Apply ↗
          </a>
        )}
        {row.phone_number && (
          <a href={`tel:${row.phone_number.replace(/\D/g, '')}`} style={{ fontSize: 11, fontWeight: 600, color: COL.navyHeader, textDecoration: 'none', padding: '4px 10px', border: `1px solid ${COL.rule}`, borderRadius: 5 }}>
            ☎ {row.phone_number}
          </a>
        )}
      </div>
    </div>
  );
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

// Small inline status surface for the AgentBase sync that fires when
// the broker clicks Recommend. Lives in the action row under the
// Recommend / Open SunFire buttons.
function SyncStatusPill(props: {
  state: 'idle' | 'syncing' | 'synced' | 'retrying' | 'error';
  error: string | null;
  url: string | null;
  givebackFlagged: boolean;
  onRetry: () => void;
}) {
  const { state, error, url, givebackFlagged, onRetry } = props;
  if (state === 'idle') return null;
  const baseStyle: React.CSSProperties = {
    marginTop: 6,
    fontSize: 10,
    fontWeight: 600,
    fontFamily: FONT.body,
    lineHeight: 1.3,
  };
  if (state === 'syncing' || state === 'retrying') {
    return (
      <div style={{ ...baseStyle, color: COL.inkSub }}>
        {state === 'syncing' ? 'Syncing to AgentBase…' : 'Retrying sync…'}
      </div>
    );
  }
  if (state === 'synced') {
    return (
      <div style={{ ...baseStyle, color: '#3b6d11' }}>
        ✓ Synced to AgentBase
        {url && (
          <>
            {' · '}
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#3b6d11', textDecoration: 'underline' }}
            >
              Open client →
            </a>
          </>
        )}
        {givebackFlagged && (
          <div style={{ fontWeight: 500, color: COL.inkSub, marginTop: 2 }}>
            Giveback flag set · re-evaluate at AEP
          </div>
        )}
      </div>
    );
  }
  // error
  return (
    <div style={{ ...baseStyle, color: '#a32d2d' }}>
      Sync failed
      {error && <span style={{ fontWeight: 400, marginLeft: 4 }}>· {error}</span>}
      {' · '}
      <button
        type="button"
        onClick={onRetry}
        style={{
          background: 'transparent',
          border: 'none',
          padding: 0,
          color: '#a32d2d',
          textDecoration: 'underline',
          cursor: 'pointer',
          fontWeight: 700,
          fontSize: 10,
          fontFamily: FONT.body,
        }}
      >
        Retry
      </button>
    </div>
  );
}
