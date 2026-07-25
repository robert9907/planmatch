// Agent-v3 Compare surface — per-plan drug cost card with expandable
// per-drug rows. Each drug collapses to a single line (name + tier +
// classification + annual $) and expands to a 12-month calendar grid
// showing per-fill cost + coverage phase per month, a 4-row phase
// breakdown (Deductible / Initial / Gap / Catastrophic), and an
// agent talking point auto-derived from the expanded drug's phase
// data.
//
// Data sources:
//   • drugBreakdown        — library rank result per drug (rxcui,
//                            name, covered, tier, monthlyCopay,
//                            annualCost). Populated by AgentV3App
//                            via drugBreakdownByPlanId.
//   • drugPhasesByRxcui    — per-drug phase breakdown from
//                            useDrugPhases (POST /api/drug-phases).
//                            Adds deductible / initial / catastrophic
//                            cost sharing + drug_type + tier_specialty
//                            + deductible_applies.
//   • lisTier              — from client.lisTier. Drives banner + LIS
//                            cap application on every calendar cell.
//
// Cadence model (this build):
//   Card-level cadence — every drug on this card uses the same
//   pharmacy_type + days_supply pair (currently 'pref' + 30-day, set
//   by CompareScreen when it calls useDrugPhases). Per-drug cadence
//   toggle is a follow-up when the intake screen captures it per
//   medication.
//
// Phase timeline model (per drug, isolated):
//   • deductible_applies = false               → all fills in 'initial'
//   • deductible_applies = true                → month-by-month sim:
//       cumulative user-OOP tracks against PART_D_MAX_DEDUCTIBLE_2026
//       ($590) and PART_D_OOP_CAP_2026 ($2100). Phase transitions on
//       the fill that crosses the threshold. Simulation is per-drug
//       (each drug's own cumulative) — the real Part D deductible is
//       shared across the whole basket, but the per-drug story here
//       gives the broker enough to explain "you'll hit the deductible
//       on the January refill" for THIS drug. Aggregate totals
//       already live in buildAgentV3LisMaps.
//
// Coverage gap (2 in CMS enum) was eliminated by IRA §11201 for 2025+.
// The gap row still renders (Rob's spec) with a "$0 — gap eliminated"
// note so the broker can quote the pre-IRA structure verbatim if
// asked.

import { useState, type ReactNode } from 'react';
import type { Plan } from '@/types/plans';
import type { Medication } from '@/types/session';
import type { DualEligibleAdjustment, LisTier } from '@/lib/dual-eligible';
import { getLisCopays } from '@/lib/dual-eligible';
import type { DrugPhaseHit } from '@/hooks/useDrugPhases';
import {
  partDTimeline,
  type DrugFill,
  type PlanInput as PartDPlanInput,
  type TierCostShares,
} from '../../api/library/partDTimeline';
import { getPlanYearParams } from '../../api/library/planYearParams';

// ─── Constants ────────────────────────────────────────────────────────
//
// Card-level plan year — Rob's spec keeps the Compare surface anchored
// to the current year (agent quotes for effective-date within the year).
// Cross-year projections would need this threaded from the client's
// intended effective date; that's a follow-up when mid-year enrollment
// quoting lands.
const CARD_PLAN_YEAR = 2026;
const PART_D_PARAMS = getPlanYearParams(CARD_PLAN_YEAR);
const PART_D_MAX_DEDUCTIBLE_2026 = PART_D_PARAMS.partDDeductibleMax;
const PART_D_OOP_CAP_2026 = PART_D_PARAMS.troopCap;

/** Notional retail per fill by tier — used when a phase costs
 *  coinsurance and we don't have a live pm_drug_cost_cache hit. Same
 *  values as plan-brain-utils' NOTIONAL_TIER_FULL_COST. */
const NOTIONAL_RETAIL_MONTHLY: Record<number, number> = {
  1: 8,
  2: 30,
  3: 200,
  4: 500,
  5: 1500,
  6: 8,
  7: 30,
  8: 200,
};

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// ─── Types ────────────────────────────────────────────────────────────

/** Trimmed shape the parent already builds. Mirrors CompareScreen's
 *  DrugRow interface (not re-exported to avoid a circular import). */
export interface DrugCostCardDrugRow {
  rxcui: string;
  name: string;
  covered: boolean;
  tier: number | null;
  monthlyCopay: number | null;
  annualCost: number;
}

export interface DrugCostCardComparisonPlan {
  planId: string;
  planName: string;
  drugBreakdown: ReadonlyArray<DrugCostCardDrugRow>;
  drugPhasesByRxcui?: Map<string, DrugPhaseHit>;
}

export interface DrugCostCardProps {
  plan: Plan;
  medications: ReadonlyArray<Medication>;
  drugBreakdown: ReadonlyArray<DrugCostCardDrugRow>;
  drugPhasesByRxcui?: Map<string, DrugPhaseHit>;
  lisTier: LisTier;
  dualEligibleAdjustment?: DualEligibleAdjustment;
  comparisonPlans?: ReadonlyArray<DrugCostCardComparisonPlan>;
  /** Fills per year — 12 for 30-day retail, 4 for 90-day mail/pref.
   *  Threaded from the card's pharmacyType/daysSupply pair; defaults
   *  to 12 when omitted. */
  fillsPerYear?: 12 | 4;
}

type PhaseKey = 'deductible' | 'initial' | 'gap' | 'catastrophic';

interface CalendarCell {
  month: number;               // 1..12
  isFillMonth: boolean;
  phase: PhaseKey | null;      // null when no fill this month
  standardCost: number;        // pre-LIS user pay for this fill
  liscappedCost: number;       // post-LIS user pay for this fill
}

interface DrugTimeline {
  cells: CalendarCell[];
  totalStandard: number;
  totalLisCapped: number;
  deductibleFillCount: number;
  initialFillCount: number;
  catastrophicFillCount: number;
  deductibleTotalCost: number;
  initialTotalCost: number;
  catastrophicTotalCost: number;
  everInDeductible: boolean;
  everInInitial: boolean;
  everInCatastrophic: boolean;
}

// ─── Palette + font tokens ────────────────────────────────────────────

const TEXT = '#0f172a';
const MUTED = '#64748b';
const BORDER = 'rgba(0,0,0,0.08)';
const FONT_LABEL = 'Inter, system-ui, sans-serif';
const FONT_NUM = '"JetBrains Mono", ui-monospace, monospace';

const CLS_PALETTE = {
  generic: { bg: '#e6faf6', fg: '#085041', label: 'Generic' },
  brand: { bg: '#fef3c7', fg: '#854F0B', label: 'Brand' },
  specialty: { bg: '#fee2e2', fg: '#791F1F', label: 'Specialty' },
} as const;

const PHASE_STYLE: Record<PhaseKey, { bg: string; fg: string; label: string; short: string; dot: string }> = {
  deductible:   { bg: 'rgba(245,158,11,0.15)', fg: '#854F0B', label: 'Deductible',       short: 'Ded',  dot: '#F59E0B' },
  initial:      { bg: 'rgba(59,130,246,0.10)', fg: '#1E40AF', label: 'Initial coverage', short: 'Init', dot: '#3B82F6' },
  gap:          { bg: 'rgba(107,114,128,0.10)', fg: '#374151', label: 'Coverage gap',    short: 'Gap',  dot: '#6B7280' },
  catastrophic: { bg: 'rgba(34,197,94,0.15)',  fg: '#0a5c3a', label: 'Catastrophic',     short: 'Cat',  dot: '#22C55E' },
};

// ─── Formatters ───────────────────────────────────────────────────────

function fmtDollars(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}
function fmtCents(n: number): string {
  return `$${n.toFixed(2)}`;
}

// ─── Small badge components ───────────────────────────────────────────

function DrugTypeBadge({
  drugType,
}: {
  drugType: DrugPhaseHit['drug_type'] | undefined;
}) {
  if (!drugType) return null;
  const p = CLS_PALETTE[drugType];
  return (
    <span
      title="Drug classification"
      style={{
        display: 'inline-block',
        fontFamily: FONT_LABEL,
        fontSize: 10,
        fontWeight: 700,
        padding: '2px 6px',
        borderRadius: 5,
        background: p.bg,
        color: p.fg,
        lineHeight: 1.1,
        whiteSpace: 'nowrap',
      }}
    >
      {p.label}
    </span>
  );
}

function TierBadge({ tier }: { tier: number | null }) {
  if (tier == null) return null;
  return (
    <span
      style={{
        display: 'inline-block',
        fontFamily: FONT_NUM,
        fontSize: 10,
        fontWeight: 700,
        padding: '2px 6px',
        borderRadius: 5,
        background: 'rgba(15,23,42,0.06)',
        color: TEXT,
        lineHeight: 1.1,
        whiteSpace: 'nowrap',
      }}
    >
      T{tier}
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        transition: 'transform 200ms ease',
        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        fontSize: 11,
        lineHeight: 1,
        color: MUTED,
      }}
    >
      ▾
    </span>
  );
}

// ─── LIS subsidy banner ───────────────────────────────────────────────

function LisSubsidyBanner({ lisTier }: { lisTier: LisTier }) {
  const caps = getLisCopays(lisTier);
  if (lisTier === 'none' || !caps) {
    return (
      <div
        style={{
          fontFamily: FONT_LABEL,
          fontSize: 11,
          padding: '6px 10px',
          background: 'rgba(15,23,42,0.04)',
          color: MUTED,
          borderTop: `1px solid ${BORDER}`,
        }}
      >
        No LIS subsidy — standard plan cost sharing applies.
      </div>
    );
  }
  const message =
    lisTier === 'full_institutional'
      ? 'All Part D copays are $0.'
      : `Full LIS subsidy — copays capped at ${fmtCents(caps.generic)} generic / ${fmtCents(caps.brand)} brand per fill. No Part D deductible.`;
  return (
    <div
      style={{
        fontFamily: FONT_LABEL,
        fontSize: 11,
        fontWeight: 600,
        padding: '6px 10px',
        background: 'rgba(34,197,94,0.12)',
        color: '#0a5c3a',
        borderTop: `1px solid ${BORDER}`,
      }}
    >
      {message}
    </div>
  );
}

// ─── Timeline compute ─────────────────────────────────────────────────

function isFillMonth(month: number, fillsPerYear: 12 | 4): boolean {
  if (fillsPerYear === 12) return true;
  // 4 fills → months 1, 4, 7, 10 (start-of-quarter refills)
  return month === 1 || month === 4 || month === 7 || month === 10;
}

/** Translate a per-drug DrugPhaseHit + the plan's filed drug deductible
 *  into the library's PlanInput shape for a basket of exactly one drug.
 *  Used by buildDrugTimeline so the per-row calendar respects the same
 *  math as the basket-level projector, just isolated to this drug. */
function planInputForSingleDrug(
  drug: DrugCostCardDrugRow,
  phaseHit: DrugPhaseHit | undefined,
  planDrugDeductible: number | null,
): PartDPlanInput {
  const tier = drug.tier ?? 0;
  const tierShares: TierCostShares = {};
  // pm_beneficiary_cost_v2 cost_type: 1 = flat copay, 2 = coinsurance
  // (fraction 0..1). Map to the library's discriminated union.
  const dedAmount = phaseHit?.phases.deductible?.cost_amount;
  if (dedAmount != null) {
    tierShares.deductible = phaseHit!.phases.deductible!.cost_type === 1
      ? { type: 'copay', amount: dedAmount }
      : { type: 'coinsurance', amount: dedAmount };
  }
  const initAmount = phaseHit?.phases.initial?.cost_amount;
  if (initAmount != null) {
    tierShares.initial = phaseHit!.phases.initial!.cost_type === 1
      ? { type: 'copay', amount: initAmount }
      : { type: 'coinsurance', amount: initAmount };
  } else if (typeof drug.monthlyCopay === 'number') {
    // Fallback to rank-result copay when the SPUF row is missing an
    // initial cost share — same fallback the pre-refactor code used.
    tierShares.initial = { type: 'copay', amount: drug.monthlyCopay };
  }
  return {
    // Plans that don't file drug_deductible fall back to the year's
    // max — matches the pre-refactor behavior of assuming full ceiling
    // when data is missing (conservative for the beneficiary).
    deductible: planDrugDeductible ?? PART_D_MAX_DEDUCTIBLE_2026,
    deductibleAppliesToTiers: phaseHit?.deductible_applies ? [tier] : [],
    tierCostShares: { [tier]: tierShares },
  };
}

function buildDrugTimeline(
  drug: DrugCostCardDrugRow,
  phaseHit: DrugPhaseHit | undefined,
  lisTier: LisTier,
  fillsPerYear: 12 | 4,
  planDrugDeductible: number | null,
): DrugTimeline {
  const lisCaps = getLisCopays(lisTier);
  const isBrand = drug.tier != null && drug.tier >= 3;
  const lisPerFillCap = lisCaps ? (isBrand ? lisCaps.brand : lisCaps.generic) : null;

  // Off-formulary / uncovered → skip library, emit empty cells so the
  // calendar can render "not covered" instead of dollar amounts.
  if (!drug.covered || drug.tier == null) {
    return {
      cells: Array.from({ length: 12 }, (_, i) => ({
        month: i + 1,
        isFillMonth: false,
        phase: null,
        standardCost: 0,
        liscappedCost: 0,
      })),
      totalStandard: 0,
      totalLisCapped: 0,
      deductibleFillCount: 0,
      initialFillCount: 0,
      catastrophicFillCount: 0,
      deductibleTotalCost: 0,
      initialTotalCost: 0,
      catastrophicTotalCost: 0,
      everInDeductible: false,
      everInInitial: false,
      everInCatastrophic: false,
    };
  }

  const notionalRetail =
    NOTIONAL_RETAIL_MONTHLY[drug.tier] ?? NOTIONAL_RETAIL_MONTHLY[3];
  const singleDrugFill: DrugFill = {
    rxcui: drug.rxcui,
    name: drug.name,
    tier: drug.tier,
    monthlyGrossCost: notionalRetail,
    fillsPerYear,
  };
  const rows = partDTimeline({
    planYear: CARD_PLAN_YEAR,
    plan: planInputForSingleDrug(drug, phaseHit, planDrugDeductible),
    drugs: [singleDrugFill],
    planYearParams: PART_D_PARAMS,
  });

  const cells: CalendarCell[] = [];
  let totalStandard = 0;
  let totalLisCapped = 0;
  let deductibleFillCount = 0;
  let initialFillCount = 0;
  let catastrophicFillCount = 0;
  let deductibleTotalCost = 0;
  let initialTotalCost = 0;
  let catastrophicTotalCost = 0;
  let everInDeductible = false;
  let everInInitial = false;
  let everInCatastrophic = false;

  for (const r of rows) {
    const fill = isFillMonth(r.month, fillsPerYear);
    if (!fill) {
      cells.push({
        month: r.month,
        isFillMonth: false,
        phase: null,
        standardCost: 0,
        liscappedCost: 0,
      });
      continue;
    }
    const standardCost = r.memberCost;
    // LIS caps override plan cost sharing whenever the member has any
    // LIS tier; the cap doesn't apply once catastrophic is reached
    // (member cost is already $0 there).
    const liscappedCost =
      lisPerFillCap != null && r.phase !== 'catastrophic'
        ? Math.min(standardCost, lisPerFillCap)
        : standardCost;

    // Map the library's basket-level phase back onto the per-drug cell.
    // For per-drug isolation, the library's phase is exactly this
    // drug's phase in the current month.
    const cellPhase: PhaseKey = r.phase;

    if (cellPhase === 'deductible') {
      deductibleFillCount += 1;
      deductibleTotalCost += liscappedCost;
      everInDeductible = true;
    } else if (cellPhase === 'initial') {
      initialFillCount += 1;
      initialTotalCost += liscappedCost;
      everInInitial = true;
    } else if (cellPhase === 'catastrophic') {
      catastrophicFillCount += 1;
      catastrophicTotalCost += liscappedCost;
      everInCatastrophic = true;
    }
    totalStandard += standardCost;
    totalLisCapped += liscappedCost;
    cells.push({
      month: r.month,
      isFillMonth: true,
      phase: cellPhase,
      standardCost,
      liscappedCost,
    });
  }

  return {
    cells,
    totalStandard,
    totalLisCapped,
    deductibleFillCount,
    initialFillCount,
    catastrophicFillCount,
    deductibleTotalCost,
    initialTotalCost,
    catastrophicTotalCost,
    everInDeductible,
    everInInitial,
    everInCatastrophic,
  };
}

// ─── Phase legend ─────────────────────────────────────────────────────

function PhaseLegend({ timeline }: { timeline: DrugTimeline }) {
  const items: PhaseKey[] = [];
  if (timeline.everInDeductible) items.push('deductible');
  if (timeline.everInInitial) items.push('initial');
  if (timeline.everInCatastrophic) items.push('catastrophic');
  if (items.length === 0) items.push('initial');
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        padding: '4px 0 6px',
        fontFamily: FONT_LABEL,
        fontSize: 10,
        color: MUTED,
      }}
    >
      {items.map((k) => (
        <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: PHASE_STYLE[k].dot,
            }}
          />
          {PHASE_STYLE[k].label}
        </span>
      ))}
    </div>
  );
}

// ─── Calendar grid ────────────────────────────────────────────────────

function CalendarGrid({
  timeline,
  showLisStrike,
  allZero,
}: {
  timeline: DrugTimeline;
  showLisStrike: boolean;
  allZero: boolean;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
        gap: 3,
        marginTop: 2,
      }}
    >
      {timeline.cells.map((c) => {
        const emptyBg = allZero
          ? 'rgba(34,197,94,0.10)'
          : 'rgba(15,23,42,0.03)';
        const bg = c.phase ? PHASE_STYLE[c.phase].bg : emptyBg;
        const fg = c.phase ? PHASE_STYLE[c.phase].fg : MUTED;
        return (
          <div
            key={c.month}
            style={{
              background: bg,
              color: fg,
              padding: '4px 2px',
              borderRadius: 4,
              textAlign: 'center',
              fontFamily: FONT_LABEL,
              minWidth: 0,
              lineHeight: 1.15,
            }}
          >
            <div
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: 0.3,
                textTransform: 'uppercase',
              }}
            >
              {MONTH_LABELS[c.month - 1]}
            </div>
            <div
              style={{
                fontFamily: FONT_NUM,
                fontSize: 10,
                fontWeight: 700,
                marginTop: 1,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
              }}
            >
              {c.isFillMonth ? fmtDollars(c.liscappedCost) : '—'}
            </div>
            {showLisStrike && c.isFillMonth && c.standardCost > c.liscappedCost && (
              <div
                style={{
                  fontFamily: FONT_NUM,
                  fontSize: 8,
                  color: MUTED,
                  textDecoration: 'line-through',
                  lineHeight: 1,
                }}
              >
                {fmtDollars(c.standardCost)}
              </div>
            )}
            {c.phase && (
              <div
                style={{
                  fontSize: 8,
                  fontWeight: 700,
                  letterSpacing: 0.3,
                  textTransform: 'uppercase',
                  marginTop: 1,
                }}
              >
                {PHASE_STYLE[c.phase].short}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Phase breakdown rows ─────────────────────────────────────────────

function PhaseBreakdownRows({ timeline }: { timeline: DrugTimeline }) {
  const Row = ({
    phase,
    countLabel,
    total,
  }: {
    phase: PhaseKey;
    countLabel: string;
    total: number;
  }) => {
    const p = PHASE_STYLE[phase];
    return (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr auto',
          gap: 8,
          alignItems: 'center',
          padding: '4px 0',
          fontFamily: FONT_LABEL,
          fontSize: 11,
          borderBottom: `1px dashed ${BORDER}`,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: p.dot,
            display: 'inline-block',
          }}
          aria-hidden
        />
        <span style={{ color: TEXT }}>
          {p.label} <span style={{ color: MUTED, fontSize: 10 }}>· {countLabel}</span>
        </span>
        <span
          style={{
            fontFamily: FONT_NUM,
            fontWeight: 700,
            textAlign: 'right',
            color: total > 0 ? TEXT : MUTED,
          }}
        >
          {fmtDollars(total)}
        </span>
      </div>
    );
  };
  const dedLabel =
    timeline.deductibleFillCount > 0
      ? `${timeline.deductibleFillCount} fill${timeline.deductibleFillCount === 1 ? '' : 's'} until $${PART_D_MAX_DEDUCTIBLE_2026} met`
      : 'not applicable';
  const initLabel =
    timeline.initialFillCount > 0
      ? `${timeline.initialFillCount} fill${timeline.initialFillCount === 1 ? '' : 's'} at plan copay`
      : 'not reached';
  const gapLabel = 'IRA §11201 eliminated the gap for 2025+';
  const catLabel =
    timeline.catastrophicFillCount > 0
      ? `${timeline.catastrophicFillCount} fill${timeline.catastrophicFillCount === 1 ? '' : 's'} at $0`
      : `after $${PART_D_OOP_CAP_2026} annual out-of-pocket`;
  return (
    <div style={{ marginTop: 8 }}>
      <Row phase="deductible" countLabel={dedLabel} total={timeline.deductibleTotalCost} />
      <Row phase="initial" countLabel={initLabel} total={timeline.initialTotalCost} />
      <Row phase="gap" countLabel={gapLabel} total={0} />
      <Row phase="catastrophic" countLabel={catLabel} total={timeline.catastrophicTotalCost} />
    </div>
  );
}

// ─── Drug row (collapsible) ───────────────────────────────────────────

function DrugRowDropdown({
  drug,
  meta,
  phaseHit,
  lisTier,
  mismatch,
  fillsPerYear,
  planDrugDeductible,
  autoExpand,
  onExpand,
}: {
  drug: DrugCostCardDrugRow;
  meta: Medication | undefined;
  phaseHit: DrugPhaseHit | undefined;
  lisTier: LisTier;
  mismatch: string | null;
  fillsPerYear: 12 | 4;
  planDrugDeductible: number | null;
  autoExpand: boolean;
  onExpand?: (rxcui: string, timeline: DrugTimeline) => void;
}) {
  const [expanded, setExpanded] = useState(autoExpand);

  const uncovered = !drug.covered;
  const dose = meta?.dose ?? null;
  const caps = getLisCopays(lisTier);
  const timeline = buildDrugTimeline(drug, phaseHit, lisTier, fillsPerYear, planDrugDeductible);
  const showStrike = caps != null && timeline.totalLisCapped < timeline.totalStandard;
  // A drug is "trivial-cost" when every fill's LIS-adjusted cost is 0
  // (e.g. Tier 1 generic with LIS institutional, or a plan that files
  // $0 copay for T1). Special-cased per Rob's spec: minimal expanded
  // view + a single tagline.
  const allZero = timeline.totalLisCapped === 0 && drug.covered;

  // Surface the timeline back up to the parent so the talking point
  // can reference the most-recently-expanded drug's phase data.
  const displayAnnual = showStrike ? timeline.totalLisCapped : timeline.totalStandard;

  return (
    <div style={{ borderTop: `1px solid ${BORDER}` }}>
      <button
        type="button"
        onClick={() => {
          const next = !expanded;
          setExpanded(next);
          if (next && onExpand) onExpand(drug.rxcui, timeline);
        }}
        aria-expanded={expanded}
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto auto',
          gap: 8,
          alignItems: 'center',
          width: '100%',
          background: 'transparent',
          border: 'none',
          padding: '10px',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: FONT_LABEL,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              flexWrap: 'wrap',
              fontSize: 12,
              fontWeight: 600,
              color: uncovered ? '#991b1b' : TEXT,
              lineHeight: 1.3,
            }}
          >
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
                maxWidth: '100%',
              }}
              title={drug.name}
            >
              {drug.name}
            </span>
            {dose && <span style={{ color: MUTED, fontWeight: 400 }}>{dose}</span>}
            <TierBadge tier={drug.tier} />
            <DrugTypeBadge drugType={phaseHit?.drug_type} />
          </div>
        </div>
        <div
          style={{
            fontFamily: FONT_NUM,
            fontSize: 12,
            fontWeight: 700,
            textAlign: 'right',
            whiteSpace: 'nowrap',
            color: uncovered ? '#991b1b' : TEXT,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
          }}
        >
          {uncovered ? (
            <span>Not covered</span>
          ) : showStrike ? (
            <>
              <span
                style={{
                  textDecoration: 'line-through',
                  color: MUTED,
                  fontWeight: 400,
                  fontSize: 10,
                }}
              >
                {fmtDollars(timeline.totalStandard)}/yr
              </span>
              <span style={{ color: '#0a5c3a' }}>
                {fmtDollars(displayAnnual)}/yr
              </span>
            </>
          ) : (
            <span>{fmtDollars(displayAnnual)}/yr</span>
          )}
        </div>
        <Chevron open={expanded} />
      </button>

      {mismatch && (
        <div
          style={{
            margin: '0 10px 8px',
            fontFamily: FONT_LABEL,
            fontSize: 10,
            color: '#854F0B',
            background: 'rgba(245,158,11,0.10)',
            padding: '4px 6px',
            borderRadius: 4,
            lineHeight: 1.4,
          }}
        >
          {mismatch}
        </div>
      )}

      {expanded && !uncovered && (
        <div style={{ padding: '0 10px 10px' }}>
          {allZero ? (
            <>
              <CalendarGrid timeline={timeline} showLisStrike={showStrike} allZero />
              <div
                style={{
                  marginTop: 8,
                  padding: '6px 8px',
                  borderRadius: 6,
                  background: 'rgba(34,197,94,0.10)',
                  color: '#0a5c3a',
                  fontFamily: FONT_LABEL,
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                $0 copay all year{drug.tier != null ? ` — Tier ${drug.tier} generic.` : '.'}
              </div>
            </>
          ) : (
            <>
              <PhaseLegend timeline={timeline} />
              <CalendarGrid timeline={timeline} showLisStrike={showStrike} allZero={false} />
              <PhaseBreakdownRows timeline={timeline} />
            </>
          )}
        </div>
      )}

      {expanded && uncovered && (
        <div
          style={{
            padding: '0 10px 10px',
            fontFamily: FONT_LABEL,
            fontSize: 11,
            color: '#991b1b',
          }}
        >
          This drug isn't on the plan's formulary. The beneficiary pays
          full retail with no Part D credit toward the deductible.
        </div>
      )}
    </div>
  );
}

// ─── Totals row ───────────────────────────────────────────────────────

function TotalsRow({
  standardTotal,
  adjustedTotal,
  showStrike,
}: {
  standardTotal: number;
  adjustedTotal: number;
  showStrike: boolean;
}) {
  const savings = standardTotal - adjustedTotal;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px',
        borderTop: `1px solid ${BORDER}`,
        background: 'rgba(15,23,42,0.03)',
      }}
    >
      <span
        style={{
          fontFamily: FONT_LABEL,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.4,
          textTransform: 'uppercase',
          color: MUTED,
        }}
      >
        Annual total
      </span>
      <span
        style={{
          fontFamily: FONT_NUM,
          fontSize: 14,
          fontWeight: 800,
          textAlign: 'right',
          color: showStrike ? '#0a5c3a' : TEXT,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
        }}
      >
        {showStrike ? (
          <>
            <span
              style={{
                textDecoration: 'line-through',
                color: MUTED,
                fontWeight: 500,
                fontSize: 11,
              }}
            >
              {fmtDollars(standardTotal)}/yr
            </span>
            <span>{fmtDollars(adjustedTotal)}/yr</span>
            {savings > 0 && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: '#0a5c3a',
                  background: 'rgba(34,197,94,0.15)',
                  padding: '1px 6px',
                  borderRadius: 4,
                  marginTop: 2,
                }}
              >
                Saved {fmtDollars(savings)}/yr with LIS
              </span>
            )}
          </>
        ) : (
          <span>{fmtDollars(standardTotal)}/yr</span>
        )}
      </span>
    </div>
  );
}

// ─── Cross-plan mismatch note ─────────────────────────────────────────

function findMismatch(
  rxcui: string,
  thisPlanName: string,
  thisType: DrugPhaseHit['drug_type'] | undefined,
  thisAnnual: number,
  comparisonPlans: ReadonlyArray<DrugCostCardComparisonPlan>,
): string | null {
  if (!thisType) return null;
  for (const other of comparisonPlans) {
    const otherHit = other.drugPhasesByRxcui?.get(`${other.planId}::${rxcui}`);
    const otherType = otherHit?.drug_type;
    if (!otherType || otherType === thisType) continue;
    const otherRow = other.drugBreakdown.find((r) => r.rxcui === rxcui);
    if (!otherRow) continue;
    const delta = Math.abs(otherRow.annualCost - thisAnnual);
    const thisLabel = CLS_PALETTE[thisType]?.label ?? thisType;
    const otherLabel = CLS_PALETTE[otherType]?.label ?? otherType;
    const dollars = delta > 0 ? ` (${fmtDollars(delta)}/yr difference)` : '';
    return `Same molecule, different classification — ${thisPlanName} covers as ${thisLabel}, ${other.planName} covers as ${otherLabel}${dollars}.`;
  }
  return null;
}

// ─── Talking point ────────────────────────────────────────────────────

/** Auto-generated one-liner referencing the most-recently expanded
 *  drug's phase data. Rob's example:
 *    "Your acetazolamide hits the $590 deductible in January, then
 *     you pay $6.45 every 90-day fill during initial coverage."
 *  Falls back to LIS-savings framing when no drug is expanded, then
 *  to a top-cost-driver mention. */
function buildTalkingPoint(args: {
  expandedDrug: DrugCostCardDrugRow | null;
  expandedTimeline: DrugTimeline | null;
  drugBreakdown: ReadonlyArray<DrugCostCardDrugRow>;
  lisTier: LisTier;
  standardTotal: number;
  adjustedTotal: number;
  fillsPerYear: 12 | 4;
}): string | null {
  const { expandedDrug, expandedTimeline, fillsPerYear } = args;

  // Expanded-drug frame — Rob's canonical example.
  if (expandedDrug && expandedTimeline) {
    const t = expandedTimeline;
    const hitDeductible = t.deductibleFillCount > 0;
    const firstInitialCell = t.cells.find(
      (c) => c.isFillMonth && c.phase === 'initial',
    );
    const firstInitialCost = firstInitialCell?.liscappedCost ?? null;
    const cadenceLabel = fillsPerYear === 4 ? '90-day' : '30-day';
    if (hitDeductible && firstInitialCost != null) {
      return `Your ${expandedDrug.name} hits the $${PART_D_MAX_DEDUCTIBLE_2026} deductible in January, then you pay ${fmtCents(firstInitialCost)} every ${cadenceLabel} fill during initial coverage.`;
    }
    if (t.everInCatastrophic) {
      return `Your ${expandedDrug.name} crosses the $${PART_D_OOP_CAP_2026} out-of-pocket cap mid-year — Part D covers 100% after that.`;
    }
    if (firstInitialCost != null && firstInitialCost === 0) {
      return `Your ${expandedDrug.name} is $0 all year${expandedDrug.tier != null ? ` (Tier ${expandedDrug.tier}).` : '.'}`;
    }
    if (firstInitialCost != null) {
      return `Your ${expandedDrug.name} is ${fmtCents(firstInitialCost)} per ${cadenceLabel} fill during initial coverage — ${fmtDollars(t.totalLisCapped)}/yr.`;
    }
  }

  // No expansion — LIS savings frame.
  const caps = getLisCopays(args.lisTier);
  const savings = args.standardTotal - args.adjustedTotal;
  if (caps && savings > 100) {
    return `LIS caps your copays at ${fmtCents(caps.generic)} generic / ${fmtCents(caps.brand)} brand per fill — saving ${fmtDollars(savings)}/yr on this plan.`;
  }

  // Fallback — top cost driver.
  if (args.drugBreakdown.length > 0) {
    const top = [...args.drugBreakdown].sort(
      (a, b) => b.annualCost - a.annualCost,
    )[0];
    if (top && top.annualCost > 0) {
      return `${top.name} is your biggest cost driver on this plan — ${fmtDollars(top.annualCost)}/yr.`;
    }
  }
  return null;
}

// ─── Main card ────────────────────────────────────────────────────────

export function DrugCostCard(props: DrugCostCardProps): ReactNode {
  const {
    plan,
    medications,
    drugBreakdown,
    drugPhasesByRxcui,
    lisTier,
    dualEligibleAdjustment,
    comparisonPlans,
    fillsPerYear = 12,
  } = props;

  const [expandedRxcui, setExpandedRxcui] = useState<string | null>(null);
  const [expandedTimeline, setExpandedTimeline] = useState<DrugTimeline | null>(
    null,
  );

  if (drugBreakdown.length === 0) return null;

  const medByRxcui = new Map<string, Medication>();
  for (const m of medications) {
    if (m.rxcui) medByRxcui.set(m.rxcui, m);
  }

  // If only 1 drug, auto-expand it so the calendar shows immediately.
  const autoExpand = drugBreakdown.length === 1;

  const standardTotal =
    dualEligibleAdjustment?.original.totalAnnualDrugCost ??
    drugBreakdown.reduce((s, d) => s + d.annualCost, 0);
  const adjustedTotal = drugBreakdown.reduce((s, d) => {
    if (!d.covered || d.tier == null) return s + d.annualCost;
    const caps = getLisCopays(lisTier);
    if (!caps) return s + d.annualCost;
    const perFill = d.annualCost > 0 ? d.annualCost / 12 : 0;
    const isBrand = d.tier >= 3;
    const cap = isBrand ? caps.brand : caps.generic;
    return s + Math.round(Math.min(perFill, cap) * 12);
  }, 0);
  const showStrike = getLisCopays(lisTier) != null && adjustedTotal < standardTotal;

  const expandedDrug = expandedRxcui
    ? drugBreakdown.find((d) => d.rxcui === expandedRxcui) ?? null
    : autoExpand
      ? drugBreakdown[0]
      : null;
  const effectiveTimeline =
    expandedTimeline ??
    (autoExpand && expandedDrug
      ? buildDrugTimeline(
          expandedDrug,
          drugPhasesByRxcui?.get(`${plan.id}::${expandedDrug.rxcui}`),
          lisTier,
          fillsPerYear,
          plan.drug_deductible,
        )
      : null);
  const talkingPoint = buildTalkingPoint({
    expandedDrug,
    expandedTimeline: effectiveTimeline,
    drugBreakdown,
    lisTier,
    standardTotal,
    adjustedTotal,
    fillsPerYear,
  });

  return (
    <div
      style={{
        borderTop: `1px solid ${BORDER}`,
        background: 'white',
        fontFamily: FONT_LABEL,
      }}
    >
      <div
        style={{
          padding: '6px 10px 2px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 6,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            color: MUTED,
          }}
        >
          Drug costs
        </span>
        <span style={{ fontSize: 10, color: MUTED }}>
          {drugBreakdown.filter((d) => d.covered).length}/{drugBreakdown.length} covered
        </span>
      </div>
      <LisSubsidyBanner lisTier={lisTier} />
      {drugBreakdown.map((d) => {
        const phaseHit = drugPhasesByRxcui?.get(`${plan.id}::${d.rxcui}`);
        const mismatch = comparisonPlans
          ? findMismatch(
              d.rxcui,
              plan.plan_name ?? plan.plan_number ?? plan.id,
              phaseHit?.drug_type,
              d.annualCost,
              comparisonPlans,
            )
          : null;
        return (
          <DrugRowDropdown
            key={d.rxcui || d.name}
            drug={d}
            meta={medByRxcui.get(d.rxcui)}
            phaseHit={phaseHit}
            lisTier={lisTier}
            mismatch={mismatch}
            fillsPerYear={fillsPerYear}
            planDrugDeductible={plan.drug_deductible}
            autoExpand={autoExpand}
            onExpand={(_rxcui, timeline) => {
              setExpandedRxcui(_rxcui);
              setExpandedTimeline(timeline);
            }}
          />
        );
      })}
      <TotalsRow
        standardTotal={standardTotal}
        adjustedTotal={adjustedTotal}
        showStrike={showStrike}
      />
      {talkingPoint && (
        <div
          style={{
            padding: '8px 10px',
            borderTop: `1px solid ${BORDER}`,
            fontFamily: FONT_LABEL,
            fontSize: 11,
            fontStyle: 'italic',
            color: MUTED,
            background: 'rgba(15,23,42,0.02)',
            lineHeight: 1.4,
          }}
        >
          {talkingPoint}
        </div>
      )}
    </div>
  );
}
