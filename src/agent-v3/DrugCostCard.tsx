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
import { PART_D_OOP_CAP_2026 } from '@/lib/plan-brain-utils';
import type { DrugPhaseHit } from '@/hooks/useDrugPhases';

// ─── Constants ────────────────────────────────────────────────────────

const PART_D_MAX_DEDUCTIBLE_2026 = 590;

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

/** Per-fill user pay in the given phase. Reads phaseHit when the
 *  library returned a filed cost-share; falls back to tier notionals
 *  when the phase row is missing or of type 0 (n/a). */
function fillCostInPhase(
  drug: DrugCostCardDrugRow,
  phaseHit: DrugPhaseHit | undefined,
  phase: PhaseKey,
): number {
  if (!drug.covered || drug.tier == null) return 0;
  const notionalRetail =
    NOTIONAL_RETAIL_MONTHLY[drug.tier] ?? NOTIONAL_RETAIL_MONTHLY[3];
  if (phase === 'catastrophic') return 0;
  if (phase === 'gap') {
    // IRA §11201 eliminated the gap for 2025+; keep $0 so the UI can
    // still label a row without misleading dollar amounts.
    return 0;
  }
  if (phase === 'deductible') {
    // In deductible the beneficiary pays retail (up to remaining
    // deductible). We approximate at notional retail — the exact
    // "up to remaining" clamp happens in the timeline builder.
    return notionalRetail;
  }
  // initial — prefer the library-filed row; else use monthlyCopay from
  // the rank result; else fall back to tier notional × 0 (unknown).
  const cell = phaseHit?.phases.initial;
  if (cell && cell.cost_amount != null) {
    if (cell.cost_type === 1) return cell.cost_amount;
    if (cell.cost_type === 2) return Math.round(notionalRetail * cell.cost_amount);
  }
  if (typeof drug.monthlyCopay === 'number') return drug.monthlyCopay;
  return Math.round(drug.annualCost / 12);
}

function isFillMonth(month: number, fillsPerYear: 12 | 4): boolean {
  if (fillsPerYear === 12) return true;
  // 4 fills → months 1, 4, 7, 10 (start-of-quarter refills)
  return month === 1 || month === 4 || month === 7 || month === 10;
}

function buildDrugTimeline(
  drug: DrugCostCardDrugRow,
  phaseHit: DrugPhaseHit | undefined,
  lisTier: LisTier,
  fillsPerYear: 12 | 4,
): DrugTimeline {
  const lisCaps = getLisCopays(lisTier);
  const deductibleApplies = phaseHit?.deductible_applies === true;
  const isBrand = drug.tier != null && drug.tier >= 3;
  const lisPerFillCap = lisCaps ? (isBrand ? lisCaps.brand : lisCaps.generic) : null;

  const cells: CalendarCell[] = [];
  let cumulativeStandard = 0;    // pre-LIS user-OOP running total
  let currentPhase: PhaseKey = deductibleApplies ? 'deductible' : 'initial';
  let deductibleFillCount = 0;
  let initialFillCount = 0;
  let catastrophicFillCount = 0;
  let deductibleTotalCost = 0;
  let initialTotalCost = 0;
  let catastrophicTotalCost = 0;
  let totalStandard = 0;
  let totalLisCapped = 0;
  let everInDeductible = deductibleApplies;
  let everInInitial = !deductibleApplies;
  let everInCatastrophic = false;

  for (let m = 1; m <= 12; m += 1) {
    const fill = isFillMonth(m, fillsPerYear);
    if (!fill) {
      cells.push({
        month: m,
        isFillMonth: false,
        phase: null,
        standardCost: 0,
        liscappedCost: 0,
      });
      continue;
    }

    let cellPhase = currentPhase;
    let standardCost = fillCostInPhase(drug, phaseHit, cellPhase);

    // Clamp the deductible fill so cumulative never overshoots the
    // deductible amount — the real Part D rule is proportional.
    if (cellPhase === 'deductible') {
      const remaining = PART_D_MAX_DEDUCTIBLE_2026 - cumulativeStandard;
      if (standardCost > remaining) standardCost = Math.max(remaining, 0);
    }

    const liscappedCost =
      lisPerFillCap != null && drug.covered && cellPhase !== 'catastrophic'
        ? Math.min(standardCost, lisPerFillCap)
        : standardCost;

    if (cellPhase === 'deductible') {
      deductibleFillCount += 1;
      deductibleTotalCost += liscappedCost;
    } else if (cellPhase === 'initial') {
      initialFillCount += 1;
      initialTotalCost += liscappedCost;
    } else if (cellPhase === 'catastrophic') {
      catastrophicFillCount += 1;
      catastrophicTotalCost += liscappedCost;
    }
    totalStandard += standardCost;
    totalLisCapped += liscappedCost;
    cumulativeStandard += standardCost;

    cells.push({
      month: m,
      isFillMonth: true,
      phase: cellPhase,
      standardCost,
      liscappedCost,
    });

    // Phase transitions — apply AFTER this fill is booked, so the
    // month whose fill first crosses the threshold shows the phase
    // that led INTO the transition, and the next fill picks up the
    // new phase.
    if (currentPhase === 'deductible' && cumulativeStandard >= PART_D_MAX_DEDUCTIBLE_2026) {
      currentPhase = 'initial';
      everInInitial = true;
    }
    if (cumulativeStandard >= PART_D_OOP_CAP_2026 && currentPhase !== 'catastrophic') {
      currentPhase = 'catastrophic';
      everInCatastrophic = true;
    }
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
  autoExpand,
  onExpand,
}: {
  drug: DrugCostCardDrugRow;
  meta: Medication | undefined;
  phaseHit: DrugPhaseHit | undefined;
  lisTier: LisTier;
  mismatch: string | null;
  fillsPerYear: 12 | 4;
  autoExpand: boolean;
  onExpand?: (rxcui: string, timeline: DrugTimeline) => void;
}) {
  const [expanded, setExpanded] = useState(autoExpand);

  const uncovered = !drug.covered;
  const dose = meta?.dose ?? null;
  const caps = getLisCopays(lisTier);
  const timeline = buildDrugTimeline(drug, phaseHit, lisTier, fillsPerYear);
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
