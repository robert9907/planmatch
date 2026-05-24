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
  useMemo,
  useState,
  type CSSProperties,
  type DragEvent,
} from 'react';
import type { CostShare, Plan } from '@/types/plans';
import { useSession } from '@/hooks/useSession';
import { Container, Header, Nav, fmt } from './atoms';
import {
  annualEstimate,
  costShareNumeric,
  formatCostShare,
  formatPcp,
  formatPremium,
  formatSpecialist,
  planDisplay,
} from './planDisplay';

// Carriers that didn't file a value get "Not available" instead of the
// formatCostShare/formatPcp default "—". Per project rule, every
// benefit row stays visible — change the text, not the row.
function safeCostShare(s: string): string {
  return s === '—' ? 'Not available' : s;
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
  /**
   * Fire-and-forget AgentBase write-back. CompareScreen calls this with
   * the picked plan when the broker clicks Enroll on a card or the
   * summary bar. The hook on the shell handles state + retries; this
   * screen never blocks on it.
   */
  onRecommend?: (plan: Plan) => void;
  onBack: () => void;
  onNext: () => void;
}

interface Metric {
  key: string;
  label: string;
  format: (p: Plan) => string;
  numeric: (p: Plan) => number | null;
  higherIsBetter: boolean;
}

interface ProviderRow {
  networkStatus?: Record<string, string> | undefined;
}

function coveredCount(plan: Plan, rxcuis: string[]): number {
  let n = 0;
  for (const r of rxcuis) {
    const t = plan.formulary[r];
    if (t != null && t !== 'excluded') n += 1;
  }
  return n;
}

function providersInNetwork(plan: Plan, providers: ProviderRow[]): number {
  let n = 0;
  for (const p of providers) {
    if (p.networkStatus?.[plan.id] === 'in') n += 1;
  }
  return n;
}

// Cost-share metric factory — keeps the 21 medical / Rx-tier rows from
// dragging the array out to 100+ lines of boilerplate.
function csMetric(key: string, label: string, get: (p: Plan) => CostShare): Metric {
  return {
    key,
    label,
    format: (p) => safeCostShare(formatCostShare(get(p))),
    numeric: (p) => costShareNumeric(get(p)),
    higherIsBetter: false,
  };
}

function buildMetrics(args: {
  rxcuis: string[];
  providers: ProviderRow[];
  annualDrugByPlanId: Record<string, number | null>;
}): Metric[] {
  const { rxcuis, providers, annualDrugByPlanId } = args;
  const drug = (p: Plan) => annualDrugByPlanId[p.id] ?? null;

  return [
    {
      key: 'premium',
      label: 'Premium',
      format: (p) => `${formatPremium(p)}/mo`,
      numeric: (p) => p.premium,
      higherIsBetter: false,
    },
    {
      key: 'moop',
      label: 'MOOP',
      format: (p) => fmt(p.moop_in_network),
      numeric: (p) => p.moop_in_network,
      higherIsBetter: false,
    },
    {
      key: 'drugs',
      label: 'Drug cost / yr',
      format: (p) => {
        const v = drug(p);
        return v == null ? 'Not available' : `${fmt(v)}/yr`;
      },
      numeric: drug,
      higherIsBetter: false,
    },
    {
      key: 'meds',
      label: 'Meds covered',
      format: (p) =>
        rxcuis.length === 0 ? '—' : `${coveredCount(p, rxcuis)}/${rxcuis.length}`,
      numeric: (p) => (rxcuis.length === 0 ? null : coveredCount(p, rxcuis)),
      higherIsBetter: true,
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
    },
    {
      key: 'dental',
      label: 'Dental',
      format: (p) => planDisplay(p).dentalMax,
      numeric: (p) => p.benefits.dental.annual_max,
      higherIsBetter: true,
    },
    {
      key: 'vision',
      label: 'Vision',
      format: (p) => planDisplay(p).visionAllowance,
      numeric: (p) => p.benefits.vision.eyewear_allowance_year,
      higherIsBetter: true,
    },
    {
      key: 'otc',
      label: 'OTC / qtr',
      format: (p) => {
        const v = p.benefits.otc.allowance_per_quarter;
        return v > 0 ? `$${v}/qtr` : 'Not available';
      },
      numeric: (p) => p.benefits.otc.allowance_per_quarter,
      higherIsBetter: true,
    },
    {
      key: 'fitness',
      label: 'Fitness',
      format: (p) => planDisplay(p).fitness,
      numeric: (p) => (p.benefits.fitness.enabled ? 1 : 0),
      higherIsBetter: true,
    },
    {
      key: 'giveback',
      label: 'Part B giveback',
      format: (p) =>
        p.part_b_giveback > 0 ? `$${p.part_b_giveback}/mo` : 'Not available',
      numeric: (p) => p.part_b_giveback,
      higherIsBetter: true,
    },
    {
      key: 'stars',
      label: 'Star rating',
      format: (p) => `${p.star_rating} ★`,
      numeric: (p) => p.star_rating,
      higherIsBetter: true,
    },
    // ── Medical copays + Part D deductible ───────────────────────
    {
      key: 'pcp',
      label: 'PCP copay',
      format: (p) => safeCostShare(formatPcp(p)),
      numeric: (p) => costShareNumeric(p.benefits.medical.primary_care),
      higherIsBetter: false,
    },
    {
      key: 'specialist',
      label: 'Specialist',
      format: (p) => safeCostShare(formatSpecialist(p)),
      numeric: (p) => costShareNumeric(p.benefits.medical.specialist),
      higherIsBetter: false,
    },
    {
      key: 'partd_ded',
      label: 'Part D Ded.',
      format: (p) =>
        p.drug_deductible == null ? 'Not available' : `$${p.drug_deductible}`,
      numeric: (p) => p.drug_deductible,
      higherIsBetter: false,
    },
    csMetric('urgent_care', 'Urgent care', (p) => p.benefits.medical.urgent_care),
    csMetric('emergency', 'Emergency', (p) => p.benefits.medical.emergency),
    csMetric('inpatient', 'Inpatient (per stay)', (p) => p.benefits.medical.inpatient),
    csMetric(
      'out_surg_hosp',
      'Outpatient surg. (hosp)',
      (p) => p.benefits.medical.outpatient_surgery_hospital,
    ),
    csMetric(
      'out_surg_asc',
      'Outpatient surg. (ASC)',
      (p) => p.benefits.medical.outpatient_surgery_asc,
    ),
    csMetric(
      'out_obs',
      'Outpatient observation',
      (p) => p.benefits.medical.outpatient_observation,
    ),
    csMetric('lab', 'Lab services', (p) => p.benefits.medical.lab_services),
    csMetric('diag_tests', 'Diagnostic tests', (p) => p.benefits.medical.diagnostic_tests),
    csMetric('xray', 'X-ray', (p) => p.benefits.medical.xray),
    csMetric(
      'diag_radiology',
      'Diagnostic radiology',
      (p) => p.benefits.medical.diagnostic_radiology,
    ),
    csMetric(
      'ther_radiology',
      'Therapeutic radiology',
      (p) => p.benefits.medical.therapeutic_radiology,
    ),
    csMetric(
      'mh_indiv',
      'Mental health (indiv.)',
      (p) => p.benefits.medical.mental_health_individual,
    ),
    csMetric(
      'mh_group',
      'Mental health (group)',
      (p) => p.benefits.medical.mental_health_group,
    ),
    csMetric('pt', 'Physical therapy', (p) => p.benefits.medical.physical_therapy),
    csMetric('telehealth', 'Telehealth', (p) => p.benefits.medical.telehealth),
    // ── Rx tiers 1–5 ─────────────────────────────────────────────
    csMetric('rx_t1', 'Rx Tier 1', (p) => p.benefits.rx_tiers.tier_1),
    csMetric('rx_t2', 'Rx Tier 2', (p) => p.benefits.rx_tiers.tier_2),
    csMetric('rx_t3', 'Rx Tier 3', (p) => p.benefits.rx_tiers.tier_3),
    csMetric('rx_t4', 'Rx Tier 4', (p) => p.benefits.rx_tiers.tier_4),
    csMetric('rx_t5', 'Rx Tier 5', (p) => p.benefits.rx_tiers.tier_5),
    // ── Supplemental (string output, no winner highlighting) ─────
    {
      key: 'transport',
      label: 'Transportation',
      format: (p) => planDisplay(p).transport,
      numeric: () => null,
      higherIsBetter: true,
    },
    {
      key: 'food',
      label: 'Food card',
      format: (p) => planDisplay(p).meals,
      numeric: () => null,
      higherIsBetter: true,
    },
    {
      key: 'hearing',
      label: 'Hearing',
      format: (p) => planDisplay(p).hearing,
      numeric: () => null,
      higherIsBetter: true,
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
    return `$${diff}`;
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

function initSlots(pool: Plan[]): (Plan | null)[] {
  const out: (Plan | null)[] = [null, null, null, null];
  for (let i = 0; i < Math.min(4, pool.length); i++) {
    out[i] = pool[i];
  }
  return out;
}

export function CompareScreen({
  current,
  scoredPlans,
  ribbonByPlanId,
  annualDrugByPlanId,
  onRecommend,
  onBack,
  onNext,
}: Props) {
  const providers = useSession((s) => s.providers);
  const medications = useSession((s) => s.medications);

  const rxcuis = useMemo(
    () => medications.map((m) => m.rxcui).filter((s): s is string => !!s),
    [medications],
  );

  const metrics = useMemo(
    () => buildMetrics({ rxcuis, providers, annualDrugByPlanId }),
    [rxcuis, providers, annualDrugByPlanId],
  );

  // Baseline = the plan every slot is compared against. The client's
  // current plan when one is on file; otherwise the brain's #1 pick
  // (an AEP shopper with no incumbent still gets a useful diff column).
  // CURRENT ribbon means "this is the client's current plan"; when
  // we've fallen back to scoredPlans[0] the ribbon flips to TOP PICK.
  const baseline: Plan | null = current ?? scoredPlans[0] ?? null;
  const baselineIsCurrent = current != null;

  // Pool = baseline first (always slot 0), then every other scored
  // plan in brain-rank order. Slot 1–3 take the top three challengers;
  // the rest go to the bench.
  const pool: Plan[] = useMemo(() => {
    if (!baseline) return scoredPlans;
    const others = scoredPlans.filter((p) => p.id !== baseline.id);
    return [baseline, ...others];
  }, [baseline, scoredPlans]);

  const [slots, setSlots] = useState<(Plan | null)[]>(() => initSlots(pool));
  const [mode, setMode] = useState<'grid' | 'h2h'>('grid');
  const [challenger, setChallenger] = useState<Plan | null>(null);

  // Reconcile: any slot whose plan is no longer in the pool becomes
  // null. Bench = pool minus slot occupants.
  const poolIds = useMemo(() => new Set(pool.map((p) => p.id)), [pool]);
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
  const bench = useMemo(
    () => pool.filter((p) => !slotIds.has(p.id)),
    [pool, slotIds],
  );

  const visibleSlotPlans = useMemo(
    () => reconciledSlots.filter((p): p is Plan => !!p),
    [reconciledSlots],
  );

  const bestByMetric = useMemo<Record<string, number | null>>(() => {
    const out: Record<string, number | null> = {};
    for (const m of metrics) out[m.key] = bestNumeric(m, visibleSlotPlans);
    return out;
  }, [metrics, visibleSlotPlans]);

  // ── Empty state ────────────────────────────────────────────
  if (pool.length === 0) {
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
  // hook handles state + retry, the screen advances immediately.
  const recommendAndAdvance = (plan: Plan | null) => () => {
    if (plan) onRecommend?.(plan);
    onNext();
  };

  // ── H2H mode ───────────────────────────────────────────────
  if (mode === 'h2h' && challenger && baseline) {
    return (
      <H2HView
        baseline={baseline}
        baselineIsCurrent={baselineIsCurrent}
        challenger={challenger}
        pool={pool.filter((p) => p.id !== baseline.id)}
        metrics={metrics}
        annualDrugByPlanId={annualDrugByPlanId}
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
          : pool.find((p) => p.id === draggedPlanId) ?? null;
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
    if (bench.length === 0) return;
    const first = bench[0];
    setSlots((s) => {
      const next = [...s];
      next[slotIdx] = first;
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

      <ModeToggle
        mode={mode}
        h2hDisabled={!topChallenger}
        onGrid={() => setMode('grid')}
        onH2H={enterH2HFromToggle}
      />

      <Bench
        bench={bench}
        baseline={baseline}
        annualDrugByPlanId={annualDrugByPlanId}
        ribbonByPlanId={ribbonByPlanId ?? {}}
        providers={providers}
        onAddToBoard={addToBoard}
        onOpenH2H={openH2H}
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 14,
          margin: '14px 0',
        }}
      >
        {reconciledSlots.map((plan, i) => (
          <SlotCell
            key={i}
            slotIdx={i}
            plan={plan}
            isBaseline={plan != null && baseline != null && plan.id === baseline.id}
            baselineIsCurrent={baselineIsCurrent}
            baseline={baseline}
            metrics={metrics}
            bestByMetric={bestByMetric}
            onDrop={handleDrop}
            onClear={() => clearSlot(i)}
            onFill={() => fillEmptySlot(i)}
            onOpenH2H={openH2H}
            onEnroll={recommendAndAdvance(plan)}
          />
        ))}
      </div>

      <SummaryBar
        headline={topChallenger}
        savings={headlineSavings}
        onEnroll={recommendAndAdvance(topChallenger)}
      />

      <Nav onBack={onBack} onNext={onNext} nextLabel="CMS Compliance →" />
    </Container>
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

type BenchFilter = 'all' | 'hmo' | 'ppo' | 'zero';

function Bench({
  bench,
  baseline,
  annualDrugByPlanId,
  ribbonByPlanId,
  providers,
  onAddToBoard,
  onOpenH2H,
}: {
  bench: Plan[];
  baseline: Plan | null;
  annualDrugByPlanId: Record<string, number | null>;
  ribbonByPlanId: Record<string, string | null>;
  providers: ProviderRow[];
  onAddToBoard: (plan: Plan) => void;
  onOpenH2H: (plan: Plan) => void;
}) {
  const [filter, setFilter] = useState<BenchFilter>('all');

  const filtered = useMemo(() => {
    return bench.filter((p) => {
      if (filter === 'all') return true;
      const t = (p.plan_type ?? '').toUpperCase();
      if (filter === 'hmo') return t.includes('HMO');
      if (filter === 'ppo') return t.includes('PPO');
      if (filter === 'zero') return p.premium === 0;
      return true;
    });
  }, [bench, filter]);

  if (bench.length === 0) {
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
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontFamily: FONT_LABEL,
              fontSize: 10,
              fontWeight: 700,
              color: NAVY,
              textTransform: 'uppercase',
              letterSpacing: 0.8,
            }}
          >
            Bench — plans not on the board
          </span>
          <span
            style={{
              background: NAVY,
              color: SEAFOAM,
              fontFamily: FONT_NUM,
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 7px',
              borderRadius: 10,
            }}
          >
            {filter === 'all' ? bench.length : `${filtered.length}/${bench.length}`}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {([
            ['all', 'All'],
            ['hmo', 'HMO'],
            ['ppo', 'PPO'],
            ['zero', '$0 only'],
          ] as Array<[BenchFilter, string]>).map(([key, label]) => {
            const active = filter === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                style={{
                  background: active ? NAVY : 'white',
                  color: active ? 'white' : NAVY,
                  border: `1px solid ${active ? NAVY : BORDER}`,
                  borderRadius: 14,
                  padding: '4px 10px',
                  fontFamily: FONT_LABEL,
                  fontSize: 10,
                  fontWeight: 700,
                  cursor: 'pointer',
                  letterSpacing: 0.3,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 12,
          overflowX: 'auto',
          padding: '4px 2px 12px',
          scrollSnapType: 'x mandatory',
        }}
      >
        {filtered.length === 0 ? (
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
            No bench plans match this filter.
          </div>
        ) : (
          filtered.map((p) => (
            <BenchCard
              key={p.id}
              plan={p}
              baseline={baseline}
              annualDrugByPlanId={annualDrugByPlanId}
              ribbon={ribbonByPlanId[p.id] ?? null}
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
  providers,
  onAddToBoard,
  onOpenH2H,
}: {
  plan: Plan;
  baseline: Plan | null;
  annualDrugByPlanId: Record<string, number | null>;
  ribbon: string | null;
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
      : 'Not available'
    : `${inNetCount}/${providers.length}`;
  const sixthWins = showGiveback
    ? baseline != null && plan.part_b_giveback > baseline.part_b_giveback
    : providers.length > 0 && inNetCount === providers.length;

  const isBaseline = baseline != null && plan.id === baseline.id;
  const ribbonChip = ribbon ? RIBBON_STYLE[ribbon] : null;

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
        width: 220,
        scrollSnapAlign: 'start',
        background: 'white',
        border: `1px solid ${hover ? TEAL : BORDER}`,
        borderRadius: 12,
        overflow: 'hidden',
        boxShadow: '0 1px 4px rgba(13,47,94,0.05)',
        cursor: 'grab',
        display: 'flex',
        flexDirection: 'column',
      }}
      title={`${plan.carrier} ${plan.plan_name} — drag to a slot`}
    >
      <div
        style={{
          background: NAVY,
          color: 'white',
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        {ribbonChip && (
          <span
            style={{
              display: 'inline-block',
              alignSelf: 'flex-start',
              background: ribbonChip.bg,
              color: ribbonChip.color,
              fontFamily: FONT_LABEL,
              fontSize: 8,
              fontWeight: 800,
              letterSpacing: 0.8,
              padding: '2px 6px',
              borderRadius: 3,
              textTransform: 'uppercase',
            }}
          >
            {ribbonChip.label}
          </span>
        )}
        <div
          style={{
            fontFamily: FONT_LABEL,
            fontSize: 10,
            fontWeight: 700,
            color: SEAFOAM,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
          }}
        >
          {plan.carrier}
        </div>
        <div
          style={{
            fontFamily: FONT_LABEL,
            fontSize: 12,
            fontWeight: 700,
            color: 'white',
            lineHeight: 1.2,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {plan.plan_name}
        </div>
      </div>

      <div style={{ padding: 10 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 6,
          }}
        >
          <MetricMini label="Premium" value={`$${plan.premium}/mo`} winning={premiumWins} />
          <MetricMini label="MOOP" value={fmt(plan.moop_in_network)} winning={moopWins} />
          <MetricMini
            label="Drug / yr"
            value={drug == null ? 'Not available' : fmt(drug)}
            winning={drugWins}
          />
          <MetricMini label="Stars" value={`${plan.star_rating} ★`} winning={starsWins} />
          <MetricMini
            label="Dental"
            value={planDisplay(plan).dentalMax}
            winning={dentalWins}
          />
          <MetricMini label={sixthLabel} value={sixthValue} winning={sixthWins} />
        </div>

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            marginTop: 8,
            width: '100%',
            background: 'transparent',
            border: `1px solid ${BORDER}`,
            borderRadius: 6,
            padding: '5px 8px',
            fontFamily: FONT_LABEL,
            fontSize: 10,
            fontWeight: 700,
            color: NAVY,
            cursor: 'pointer',
            letterSpacing: 0.4,
            textTransform: 'uppercase',
          }}
        >
          {expanded ? 'Hide preview' : 'Quick preview'}
        </button>

        {expanded && (
          <div
            style={{
              marginTop: 8,
              borderTop: `1px solid ${BORDER}`,
              paddingTop: 8,
            }}
          >
            <PreviewRow label="PCP" value={formatPcp(plan)} />
            <PreviewRow label="Specialist" value={formatSpecialist(plan)} />
            <PreviewRow
              label="Urgent care"
              value={formatCostShare(plan.benefits.medical.urgent_care)}
            />
            <PreviewRow
              label="Emergency"
              value={formatCostShare(plan.benefits.medical.emergency)}
            />
            <PreviewRow
              label="Inpatient"
              value={formatCostShare(plan.benefits.medical.inpatient)}
            />
            <PreviewRow
              label="OTC / qtr"
              value={
                plan.benefits.otc.allowance_per_quarter > 0
                  ? `$${plan.benefits.otc.allowance_per_quarter}`
                  : 'Not avail.'
              }
            />
            <PreviewRow label="Vision" value={planDisplay(plan).visionAllowance} />
            <PreviewRow label="Fitness" value={planDisplay(plan).fitness} />
            <PreviewRow
              label="Part B back"
              value={plan.part_b_giveback > 0 ? `$${plan.part_b_giveback}/mo` : 'Not avail.'}
            />
            <PreviewRow
              label="Part D ded."
              value={plan.drug_deductible == null ? 'Not avail.' : `$${plan.drug_deductible}`}
            />
          </div>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 6,
          padding: 10,
          borderTop: `1px solid ${BORDER}`,
          background: PANEL,
        }}
      >
        <button
          type="button"
          onClick={() => onAddToBoard(plan)}
          style={{
            background: NAVY,
            color: 'white',
            border: 'none',
            borderRadius: 6,
            padding: '7px 0',
            fontFamily: FONT_LABEL,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
            cursor: 'pointer',
          }}
        >
          Add to board
        </button>
        <button
          type="button"
          onClick={() => onOpenH2H(plan)}
          disabled={isBaseline || !baseline}
          style={{
            background: 'white',
            color: NAVY,
            border: `1px solid ${BORDER}`,
            borderRadius: 6,
            padding: '7px 0',
            fontFamily: FONT_LABEL,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
            cursor: isBaseline || !baseline ? 'default' : 'pointer',
            opacity: isBaseline || !baseline ? 0.4 : 1,
          }}
        >
          H2H
        </button>
      </div>
    </div>
  );
}

function MetricMini({
  label,
  value,
  winning,
}: {
  label: string;
  value: string;
  winning: boolean;
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

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '3px 0',
        fontFamily: FONT_LABEL,
        fontSize: 10,
      }}
    >
      <span style={{ color: MUTED }}>{label}</span>
      <span style={{ fontFamily: FONT_NUM, fontWeight: 600, color: TEXT }}>{value}</span>
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
  onDrop,
  onClear,
  onFill,
  onOpenH2H,
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
  onDrop: (slotIdx: number, draggedPlanId: string) => void;
  onClear: () => void;
  onFill: () => void;
  onOpenH2H: (p: Plan) => void;
  onEnroll: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);

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

  if (!plan) {
    return (
      <div
        onDragOver={onDragOverHandler}
        onDragLeave={onDragLeaveHandler}
        onDrop={onDropHandler}
        onClick={onFill}
        style={{
          background: dragOver ? 'rgba(20,184,166,0.06)' : PANEL,
          border: `2px dashed ${dragOver ? TEAL : BORDER}`,
          borderRadius: 12,
          minHeight: 320,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          fontFamily: FONT_LABEL,
          fontSize: 12,
          fontWeight: 600,
          color: MUTED,
          textAlign: 'center',
          padding: 16,
        }}
      >
        Drop a plan here · click to auto-fill from bench
      </div>
    );
  }

  // Slot 0 = baseline. Ribbon flips between CURRENT (coral, "this is
  // the client's plan") and TOP PICK (gold, "no current on file — we
  // promoted the brain's #1 here"). All other slots are seafoam SLOT N.
  const ribbon = isBaseline
    ? baselineIsCurrent
      ? 'CURRENT'
      : '★ TOP PICK'
    : `SLOT ${slotIdx + 1}`;
  const ribbonBg = isBaseline ? (baselineIsCurrent ? CORAL : GOLD) : SEAFOAM;
  const ribbonColor = isBaseline ? 'white' : NAVY;

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
        background: 'white',
        border: `1px solid ${dragOver ? TEAL : BORDER}`,
        borderRadius: 12,
        overflow: 'hidden',
        boxShadow: '0 1px 4px rgba(13,47,94,0.05)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          background: NAVY,
          color: 'white',
          padding: '10px 12px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 8,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <span
            style={{
              display: 'inline-block',
              background: ribbonBg,
              color: ribbonColor,
              fontFamily: FONT_LABEL,
              fontSize: 9,
              fontWeight: 800,
              letterSpacing: 0.8,
              padding: '2px 8px',
              borderRadius: 4,
              marginBottom: 4,
            }}
          >
            {ribbon}
          </span>
          <div
            style={{
              fontFamily: FONT_LABEL,
              fontSize: 10,
              fontWeight: 700,
              color: SEAFOAM,
              letterSpacing: 0.4,
              textTransform: 'uppercase',
            }}
          >
            {plan.carrier}
          </div>
          <div
            style={{
              fontFamily: FONT_LABEL,
              fontSize: 13,
              fontWeight: 700,
              color: 'white',
              overflowWrap: 'break-word',
              wordBreak: 'break-word',
              lineHeight: 1.2,
              marginTop: 2,
            }}
          >
            {plan.plan_name}
          </div>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          aria-label="Remove plan from board"
          style={{
            background: 'rgba(255,255,255,0.12)',
            border: 'none',
            color: 'white',
            borderRadius: 6,
            width: 24,
            height: 24,
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          ✕
        </button>
      </div>

      <div style={{ padding: '8px 10px', flex: 1 }}>
        {metrics.map((m) => (
          <MetricRow
            key={m.key}
            metric={m}
            plan={plan}
            baseline={baseline}
            isBaseline={isBaseline}
            best={bestByMetric[m.key] ?? null}
          />
        ))}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 6,
          padding: 10,
          borderTop: `1px solid ${BORDER}`,
          background: PANEL,
        }}
      >
        <button
          type="button"
          onClick={() => onOpenH2H(plan)}
          disabled={isBaseline || !baseline}
          style={{ ...cardBtn('outline'), opacity: isBaseline || !baseline ? 0.4 : 1 }}
          title={isBaseline ? 'This is the baseline plan' : 'Open head-to-head'}
        >
          H2H
        </button>
        <button type="button" onClick={onEnroll} style={cardBtn('primary')}>
          Enroll
        </button>
      </div>
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
}: {
  metric: Metric;
  plan: Plan;
  baseline: Plan | null;
  /** True when this row is in the baseline slot — suppresses the
   *  delta-vs-self arrow (always 0). */
  isBaseline: boolean;
  best: number | null;
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
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 8,
        alignItems: 'center',
        padding: '5px 6px',
        background: isBest ? 'rgba(34,197,94,0.08)' : 'transparent',
        borderRadius: 6,
        marginBottom: 2,
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            fontFamily: FONT_NUM,
            fontSize: 12,
            fontWeight: 700,
            color: isBest ? '#15803d' : TEXT,
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
          </div>
        </div>

        {metrics.map((m, i) => {
          const dir = deltaVs(m, challenger, baseline);
          const deltaLabel = deltaText(m, challenger, baseline);
          const arrow = dir === 'better' ? '▲' : dir === 'worse' ? '▼' : null;
          const winBg =
            dir === 'better'
              ? 'rgba(34,197,94,0.08)'
              : dir === 'worse'
                ? 'rgba(239,68,68,0.06)'
                : 'transparent';
          return (
            <div
              key={m.key}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 110px 1fr',
                background: i % 2 === 0 ? 'white' : '#fcfcfd',
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
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span>{m.format(challenger)}</span>
                {arrow && deltaLabel && (
                  <span
                    style={{
                      fontFamily: FONT_NUM,
                      fontSize: 11,
                      fontWeight: 700,
                      color: dir === 'better' ? GREEN : CORAL,
                    }}
                  >
                    {arrow} {deltaLabel}
                  </span>
                )}
              </div>
            </div>
          );
        })}
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
