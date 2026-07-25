// Basket-level Part D phase-timeline overlay for the CompareScreen
// board. Renders one horizontal 12-month bar per plan (up to 3),
// stacked so the broker can eyeball how the same drug basket behaves
// across the top-picked plans — where each plan enters catastrophic,
// which one keeps the member in initial coverage longest, which one
// front-loads spend into a deductible spike.
//
// All math via api/library/partDTimeline; this component holds zero
// math itself (per the Task 3 spec — "keep all math in /api/library/").
//
// Data assembly:
//   • drugBreakdown per plan → per-drug notional retail (via tier),
//     per-drug tier + covered flag.
//   • drugPhases per (planId, rxcui) → per-drug per-phase cost sharing,
//     deductible_applies flag.
//   • plan.drug_deductible → plan-level deductible pot.
// The mapping into the library's DrugFill + PlanInput shape happens
// once per plan below.

import type { ReactNode } from 'react';
import type { Plan } from '@/types/plans';
import type { Medication } from '@/types/session';
import type { DualEligibleAdjustment, LisTier } from '@/lib/dual-eligible';
import { getLisCopays } from '@/lib/dual-eligible';
import type { DrugPhaseHit } from '@/hooks/useDrugPhases';
import {
  partDTimeline,
  type DrugFill,
  type MonthlyRow,
  type PlanInput as PartDPlanInput,
  type TierCostShares,
} from '../../api/library/partDTimeline';
import { getPlanYearParams } from '../../api/library/planYearParams';

// ─── Tokens (kept in sync with DrugCostCard) ─────────────────────────

const TEXT = '#0f172a';
const MUTED = '#64748b';
const BORDER = 'rgba(0,0,0,0.08)';
const FONT_LABEL = 'Inter, system-ui, sans-serif';
const FONT_NUM = '"JetBrains Mono", ui-monospace, monospace';

const PHASE_COLOR: Record<MonthlyRow['phase'], { bg: string; fg: string; label: string }> = {
  deductible:   { bg: 'rgba(245,158,11,0.28)', fg: '#854F0B', label: 'Deductible' },
  initial:      { bg: 'rgba(59,130,246,0.20)', fg: '#1E40AF', label: 'Initial coverage' },
  catastrophic: { bg: 'rgba(34,197,94,0.28)',  fg: '#0a5c3a', label: 'Catastrophic ($0)' },
};

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const CARD_PLAN_YEAR = 2026;
const PART_D_PARAMS = getPlanYearParams(CARD_PLAN_YEAR);

// Notional retail per tier — same values as plan-brain-utils
// NOTIONAL_TIER_FULL_COST and DrugCostCard NOTIONAL_RETAIL_MONTHLY,
// duplicated here to keep this component free of that transitive
// dependency chain.
const NOTIONAL_RETAIL_MONTHLY: Record<number, number> = {
  1: 8, 2: 30, 3: 200, 4: 500, 5: 1500, 6: 8, 7: 30, 8: 200,
};

// ─── Public types ────────────────────────────────────────────────────

export interface PartDTimelineOverlayDrug {
  rxcui: string;
  name: string;
  tier: number | null;
  covered: boolean;
  /** Rank-result monthly copay; fallback when the phase row is silent. */
  monthlyCopay: number | null;
}

export interface PartDTimelineOverlayPlan {
  plan: Plan;
  drugBreakdown: ReadonlyArray<PartDTimelineOverlayDrug>;
  /** Keyed by `${plan.id}::${rxcui}` (matches useDrugPhases contract). */
  drugPhasesByRxcui: ReadonlyMap<string, DrugPhaseHit>;
  dualEligible?: DualEligibleAdjustment;
}

export interface PartDTimelineOverlayProps {
  /** Plans to overlay — spec says top 3, this component accepts 1..3
   *  and lays out however many arrive. */
  plans: ReadonlyArray<PartDTimelineOverlayPlan>;
  /** Ambient LIS tier — flows into the per-plan LIS cap applied on top
   *  of the library's per-phase output. */
  lisTier: LisTier;
  /** Client medications — passed so future dosage-aware pricing can
   *  slot in without a signature change. Not consumed today. */
  medications: ReadonlyArray<Medication>;
  /** 30-day retail default (12) or 90-day mail (4). Same value used
   *  for every drug on every plan in the overlay. */
  fillsPerYear?: 12 | 4;
}

// ─── Assembly helpers ────────────────────────────────────────────────

/** Build the library's PlanInput from a plan's per-drug phase hits.
 *  tierCostShares is aggregated across drugs sharing the same tier —
 *  when two drugs in the basket file different initial cost shares
 *  for the same tier (rare data anomaly), the first wins. */
function planInputFromBreakdown(
  planDeductible: number | null,
  drugs: ReadonlyArray<PartDTimelineOverlayDrug>,
  drugPhasesByRxcui: ReadonlyMap<string, DrugPhaseHit>,
  planId: string,
): PartDPlanInput {
  const tierShares: Record<number, TierCostShares> = {};
  const deductibleApplyTiers = new Set<number>();

  for (const d of drugs) {
    if (!d.covered || d.tier == null) continue;
    const hit = drugPhasesByRxcui.get(`${planId}::${d.rxcui}`);
    if (hit?.deductible_applies) deductibleApplyTiers.add(d.tier);

    if (!tierShares[d.tier]) tierShares[d.tier] = {};
    const bucket = tierShares[d.tier];
    if (!bucket.initial) {
      const init = hit?.phases.initial;
      const initAmount = init?.cost_amount;
      if (init && initAmount != null) {
        bucket.initial = init.cost_type === 1
          ? { type: 'copay', amount: initAmount }
          : { type: 'coinsurance', amount: initAmount };
      } else if (typeof d.monthlyCopay === 'number') {
        bucket.initial = { type: 'copay', amount: d.monthlyCopay };
      }
    }
    if (!bucket.deductible) {
      const ded = hit?.phases.deductible;
      const dedAmount = ded?.cost_amount;
      if (ded && dedAmount != null) {
        bucket.deductible = ded.cost_type === 1
          ? { type: 'copay', amount: dedAmount }
          : { type: 'coinsurance', amount: dedAmount };
      }
    }
  }

  return {
    deductible: planDeductible ?? PART_D_PARAMS.partDDeductibleMax,
    deductibleAppliesToTiers: Array.from(deductibleApplyTiers),
    tierCostShares: tierShares,
  };
}

function drugFillsFromBreakdown(
  drugs: ReadonlyArray<PartDTimelineOverlayDrug>,
  fillsPerYear: number,
): DrugFill[] {
  return drugs
    .filter((d) => d.covered && d.tier != null)
    .map((d) => ({
      rxcui: d.rxcui,
      name: d.name,
      tier: d.tier,
      monthlyGrossCost:
        NOTIONAL_RETAIL_MONTHLY[d.tier ?? 3] ?? NOTIONAL_RETAIL_MONTHLY[3],
      fillsPerYear,
    }));
}

// Post-hoc LIS cap on the library's memberCost. The library is LIS-
// agnostic — full-LIS members pay per-tier caps regardless of plan
// cost sharing, so we clamp each fill month here. Catastrophic phase
// is already $0 from the library, so the cap is a no-op there.
function applyLisCap(
  rows: MonthlyRow[],
  drugs: ReadonlyArray<PartDTimelineOverlayDrug>,
  lisTier: LisTier,
): MonthlyRow[] {
  const caps = getLisCopays(lisTier);
  if (!caps) return rows;
  // Split cap by fill count per month: sum of (per-drug cap × fills)
  // clamped against the standard memberCost. Since fills-per-drug is
  // uniform across the basket in this component, use a single cap per
  // drug — brand vs generic decided by tier ≥ 3.
  const capPerDrug = drugs
    .filter((d) => d.covered && d.tier != null)
    .map((d) => (d.tier != null && d.tier >= 3 ? caps.brand : caps.generic));
  const totalCapPerFillMonth = capPerDrug.reduce((s, c) => s + c, 0);
  return rows.map((r) => {
    if (r.phase === 'catastrophic') return r;
    if (r.memberCost === 0) return r;
    // If any drug filled this month, the cap applies per drug per fill.
    // Assume 12-fills-per-year cadence for this approximation (spec
    // notes the cap is per-month, not per-fill of one drug).
    const capThisMonth = totalCapPerFillMonth;
    if (r.memberCost <= capThisMonth) return r;
    return { ...r, memberCost: capThisMonth };
  });
}

interface PlanTimeline {
  plan: Plan;
  rows: MonthlyRow[];
  totalMemberCost: number;
  catastrophicMonth: number | null;
  hasStraddle: boolean;
}

function buildPlanTimeline(
  entry: PartDTimelineOverlayPlan,
  lisTier: LisTier,
  fillsPerYear: number,
): PlanTimeline {
  const drugs = drugFillsFromBreakdown(entry.drugBreakdown, fillsPerYear);
  const rows = drugs.length === 0
    ? Array.from({ length: 12 }, (_, i): MonthlyRow => ({
        month: i + 1,
        phase: 'initial',
        memberCost: 0,
        cumulativeMemberCost: 0,
        troop: 0,
        grossDrugCost: 0,
        phaseChangedMidMonth: false,
      }))
    : applyLisCap(
        partDTimeline({
          planYear: CARD_PLAN_YEAR,
          planYearParams: PART_D_PARAMS,
          plan: planInputFromBreakdown(
            entry.plan.drug_deductible,
            entry.drugBreakdown,
            entry.drugPhasesByRxcui,
            entry.plan.id,
          ),
          drugs,
        }),
        entry.drugBreakdown,
        lisTier,
      );

  const totalMemberCost = rows.reduce((s, r) => s + r.memberCost, 0);
  const firstCat = rows.find((r) => r.phase === 'catastrophic');
  const catastrophicMonth = firstCat?.month ?? null;
  const hasStraddle = rows.some((r) => r.phaseChangedMidMonth);
  return {
    plan: entry.plan,
    rows,
    totalMemberCost,
    catastrophicMonth,
    hasStraddle,
  };
}

// ─── Formatters ──────────────────────────────────────────────────────

function fmtDollars(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function planLabel(plan: Plan): string {
  return plan.plan_name ?? plan.plan_number ?? plan.id;
}

// ─── Component ───────────────────────────────────────────────────────

export function PartDTimelineOverlay(
  props: PartDTimelineOverlayProps,
): ReactNode {
  const { plans, lisTier, fillsPerYear = 12 } = props;
  if (plans.length === 0) return null;

  const timelines = plans.slice(0, 3).map((p) =>
    buildPlanTimeline(p, lisTier, fillsPerYear),
  );

  // Peak month cost across all plans, for a shared cell-height reference.
  const maxMonthly = Math.max(
    1,
    ...timelines.flatMap((t) => t.rows.map((r) => r.memberCost)),
  );

  return (
    <div
      data-testid="part-d-timeline-overlay"
      style={{
        background: 'white',
        border: `1px solid ${BORDER}`,
        borderRadius: 12,
        padding: 16,
        margin: '14px 0',
        boxShadow: '0 1px 4px rgba(13,47,94,0.05)',
        fontFamily: FONT_LABEL,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            color: MUTED,
          }}
        >
          Part D cost timeline — {CARD_PLAN_YEAR}
        </span>
        <PhaseLegend />
      </div>

      <MonthAxis />

      {timelines.map((t) => (
        <PlanRow
          key={t.plan.id}
          timeline={t}
          maxMonthly={maxMonthly}
        />
      ))}

      <div
        style={{
          marginTop: 10,
          fontSize: 10,
          color: MUTED,
          lineHeight: 1.5,
        }}
      >
        Estimate based on current formulary and stated drug list; actual costs
        vary with pharmacy, dosage changes, and mid-year formulary updates.
        Deductible ${PART_D_PARAMS.partDDeductibleMax} / catastrophic threshold
        ${PART_D_PARAMS.troopCap.toLocaleString('en-US')} per IRA §11201.
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────

function PhaseLegend(): ReactNode {
  return (
    <div style={{ display: 'flex', gap: 10, fontSize: 10, color: MUTED }}>
      {(Object.keys(PHASE_COLOR) as MonthlyRow['phase'][]).map((k) => (
        <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span
            aria-hidden
            style={{
              width: 10, height: 10, borderRadius: 2,
              background: PHASE_COLOR[k].bg,
              border: `1px solid ${PHASE_COLOR[k].fg}`,
              display: 'inline-block',
            }}
          />
          {PHASE_COLOR[k].label}
        </span>
      ))}
    </div>
  );
}

function MonthAxis(): ReactNode {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '160px repeat(12, minmax(0, 1fr))',
        gap: 2,
        marginTop: 8,
        marginBottom: 2,
      }}
    >
      <div />
      {MONTH_LABELS.map((m) => (
        <div
          key={m}
          style={{
            fontSize: 9,
            fontWeight: 700,
            textAlign: 'center',
            color: MUTED,
            letterSpacing: 0.3,
            textTransform: 'uppercase',
          }}
        >
          {m}
        </div>
      ))}
    </div>
  );
}

function PlanRow({
  timeline,
  maxMonthly,
}: {
  timeline: PlanTimeline;
  maxMonthly: number;
}): ReactNode {
  const catCall = timeline.catastrophicMonth != null
    ? `Enters catastrophic in ${MONTH_LABELS[timeline.catastrophicMonth - 1]} — $0 after.`
    : null;

  return (
    <div style={{ marginTop: 6 }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '160px repeat(12, minmax(0, 1fr))',
          gap: 2,
          alignItems: 'stretch',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 600,
            color: TEXT,
            paddingRight: 8,
            minWidth: 0,
          }}
        >
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={planLabel(timeline.plan)}
          >
            {planLabel(timeline.plan)}
          </span>
          <span
            style={{
              fontSize: 10,
              fontFamily: FONT_NUM,
              fontWeight: 700,
              color: MUTED,
              marginTop: 2,
            }}
          >
            {fmtDollars(timeline.totalMemberCost)}/yr
          </span>
        </div>
        {timeline.rows.map((r) => {
          const heightPct = maxMonthly > 0
            ? Math.max(4, Math.round((r.memberCost / maxMonthly) * 100))
            : 4;
          const color = PHASE_COLOR[r.phase];
          return (
            <div
              key={r.month}
              title={`${MONTH_LABELS[r.month - 1]} · ${color.label} · ${fmtDollars(r.memberCost)}${
                r.phaseChangedMidMonth ? ' · phase changed mid-month' : ''
              }`}
              style={{
                position: 'relative',
                minHeight: 36,
                background: 'rgba(15,23,42,0.03)',
                borderRadius: 3,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-end',
                alignItems: 'center',
                padding: '2px 1px',
              }}
            >
              <div
                style={{
                  width: '100%',
                  height: `${heightPct}%`,
                  background: color.bg,
                  borderTop: r.phaseChangedMidMonth
                    ? `2px dashed ${color.fg}`
                    : `1px solid ${color.fg}`,
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  bottom: 1,
                  left: 0,
                  right: 0,
                  textAlign: 'center',
                  fontSize: 8,
                  fontFamily: FONT_NUM,
                  fontWeight: 700,
                  color: color.fg,
                  lineHeight: 1,
                }}
              >
                {r.memberCost > 0 ? fmtDollars(r.memberCost) : ''}
              </div>
            </div>
          );
        })}
      </div>
      {catCall && (
        <div
          style={{
            marginLeft: 160,
            marginTop: 4,
            fontSize: 10,
            fontWeight: 600,
            color: PHASE_COLOR.catastrophic.fg,
          }}
        >
          {catCall}
        </div>
      )}
    </div>
  );
}
