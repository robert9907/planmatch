// Agent-v3 Compare surface — per-plan drug cost card. Renders the
// per-drug detail Rob's brokers use to justify the plan pick to the
// beneficiary. Replaces the older DrugBreakdown 'full' variant that
// only showed name / tier / copay / annual.
//
// Data sources:
//   • drugBreakdown        — library rank result per drug (rxcui,
//                            name, covered, tier, monthlyCopay,
//                            annualCost). Populated by AgentV3App
//                            via drugBreakdownByPlanId.
//   • drugPhasesByRxcui    — per-drug phase breakdown from
//                            useDrugPhases (POST /api/drug-phases).
//                            Adds deductible / initial / catastrophic
//                            cost sharing + drug_type + tier_specialty.
//   • lisTier / dualEligibleAdjustment — from buildAgentV3LisMaps
//                            (Phase 2) so the card shows LIS caps in
//                            plain language and the strike-through
//                            standard cost.
//   • comparisonPlans      — the other plans in the Compare grid, so
//                            the card can surface a "same molecule,
//                            different classification" callout when
//                            drug_type differs between plans.
//
// Palette (3-value drug_type — matches agent's pm_formulary_v2 CHECK
// constraint 'generic' | 'brand' | 'specialty'):
//   generic   → green   ("Generic")
//   brand     → amber   ("Brand")
//   specialty → red     ("Specialty")
//
// Deferred (Phase 5 follow-ups, not shipped here):
//   • Monthly cost timeline (12-column grid keyed on fill cadence).
//   • Retail/mail pharmacy_type toggle inside the card (currently
//     always the 'pref' 30-day retail row).

import type { ReactNode } from 'react';
import type { Plan } from '@/types/plans';
import type { Medication } from '@/types/session';
import type { DualEligibleAdjustment, LisTier } from '@/lib/dual-eligible';
import { getLisCopays } from '@/lib/dual-eligible';
import type { DrugPhaseHit } from '@/hooks/useDrugPhases';

// ─── Types ────────────────────────────────────────────────────────────

/** Trimmed shape the parent already builds. Matches CompareScreen's
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
}

// ─── Palette + font tokens ────────────────────────────────────────────
// Matches the color literals CompareScreen already uses inline so the
// card sits visually next to MetricRow / DrugBreakdown without a theme
// mismatch.

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

function fmtDollars(n: number): string {
  const rounded = Math.round(n);
  return `$${rounded.toLocaleString('en-US')}`;
}

function fmtCents(n: number): string {
  return `$${n.toFixed(2)}`;
}

// ─── Sub-components ───────────────────────────────────────────────────

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

/** LIS subsidy banner — top of the card. Matches Rob's spec:
 *   • lisTier === 'none'                → gray "No LIS subsidy" line
 *   • lisTier === 'full_institutional'  → green "All Part D copays $0"
 *   • other full_low / full_high        → green cap description */
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

/** Compact phase strip — "Ded: $X → Init: $Y/mo → Cat: $0". Skips
 *  phases where cost_amount is null (deductible often absent when the
 *  tier is exempted). */
function PhaseStrip({ hit }: { hit: DrugPhaseHit | undefined }) {
  if (!hit) return null;
  const segments: string[] = [];
  const render = (label: string, cell: DrugPhaseHit['phases'][keyof DrugPhaseHit['phases']]) => {
    if (!cell) return null;
    if (cell.cost_type === 0) return null;
    if (cell.cost_type === 1 && cell.cost_amount != null) {
      segments.push(`${label}: $${Math.round(cell.cost_amount)}`);
      return null;
    }
    if (cell.cost_type === 2 && cell.cost_amount != null) {
      const pct = (cell.cost_amount * 100).toFixed(0);
      segments.push(`${label}: ${pct}%`);
      return null;
    }
    return null;
  };
  render('Ded', hit.phases.deductible);
  render('Init', hit.phases.initial);
  render('Cat', hit.phases.catastrophic);
  if (segments.length === 0) return null;
  return (
    <div
      style={{
        fontFamily: FONT_LABEL,
        fontSize: 10,
        color: MUTED,
        marginTop: 2,
        lineHeight: 1.35,
      }}
    >
      {segments.join(' → ')}
    </div>
  );
}

// ─── Cross-plan mismatch note ─────────────────────────────────────────
//
// Rob's spec: "Same molecule, different classification — [Plan A]
// covers as Generic, [Plan B] covers as Preferred brand. This drives
// the $X/yr difference." We compute per-drug against every OTHER plan
// in comparisonPlans; render at most ONE line per drug so the card
// stays scannable.

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

// ─── One drug row ─────────────────────────────────────────────────────

function DrugRowFull({
  drug,
  meta,
  phaseHit,
  lisTier,
  mismatch,
}: {
  drug: DrugCostCardDrugRow;
  meta: Medication | undefined;
  phaseHit: DrugPhaseHit | undefined;
  lisTier: LisTier;
  mismatch: string | null;
}) {
  const dose = meta?.dose ?? null;
  const uncovered = !drug.covered;
  // LIS-adjusted per-drug cost — mirrors buildAgentV3LisMaps'
  // applyLisCapsToLibraryPlan tier heuristic (tier 1-2 = generic, 3+ =
  // brand; specialty treated as brand for cap purposes).
  let adjustedAnnual = drug.annualCost;
  const caps = getLisCopays(lisTier);
  if (caps && drug.covered && drug.tier != null) {
    const perFill = drug.annualCost > 0 ? drug.annualCost / 12 : 0;
    const isBrand = drug.tier >= 3;
    const cap = isBrand ? caps.brand : caps.generic;
    adjustedAnnual = Math.round(Math.min(perFill, cap) * 12);
  }
  const showStrike = caps && drug.covered && adjustedAnnual < drug.annualCost;

  return (
    <div
      style={{
        padding: '8px 10px',
        borderTop: `1px solid ${BORDER}`,
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              flexWrap: 'wrap',
              fontFamily: FONT_LABEL,
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
            {dose && (
              <span style={{ color: MUTED, fontWeight: 400 }}>{dose}</span>
            )}
            <TierBadge tier={drug.tier} />
            <DrugTypeBadge drugType={phaseHit?.drug_type} />
          </div>
          <PhaseStrip hit={phaseHit} />
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
                {fmtDollars(drug.annualCost)}/yr
              </span>
              <span style={{ color: '#0a5c3a' }}>
                {fmtDollars(adjustedAnnual)}/yr
              </span>
            </>
          ) : (
            <span>{fmtDollars(drug.annualCost)}/yr</span>
          )}
        </div>
      </div>
      {mismatch && (
        <div
          style={{
            marginTop: 4,
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
    </div>
  );
}

// ─── Totals + agent talking point ─────────────────────────────────────

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

/** Best-effort one-liner Rob's brokers can read verbatim.
 *   Priority:
 *     1. Cross-plan classification mismatch (biggest surprise driver)
 *     2. LIS savings (when active + non-trivial)
 *     3. Highest-cost drug (default cost driver) */
function buildTalkingPoint(args: {
  plan: Plan;
  drugBreakdown: ReadonlyArray<DrugCostCardDrugRow>;
  phaseByRxcui: Map<string, DrugPhaseHit> | undefined;
  comparisonPlans: ReadonlyArray<DrugCostCardComparisonPlan> | undefined;
  planName: string;
  lisTier: LisTier;
  standardTotal: number;
  adjustedTotal: number;
}): string | null {
  const { drugBreakdown, phaseByRxcui, comparisonPlans, planName, lisTier } =
    args;
  // 1. Mismatch driver — first drug whose classification differs.
  if (comparisonPlans && phaseByRxcui) {
    for (const d of drugBreakdown) {
      const hit = phaseByRxcui.get(`${args.plan.id}::${d.rxcui}`);
      if (!hit?.drug_type) continue;
      const line = findMismatch(
        d.rxcui,
        planName,
        hit.drug_type,
        d.annualCost,
        comparisonPlans,
      );
      if (line) {
        // Rephrase for the plan-summary voice — less compare-cell,
        // more broker-cue.
        return `Your ${d.name} is classified differently by these plans — that drives the cost difference.`;
      }
    }
  }
  // 2. LIS savings line — when we actually saved something meaningful.
  const savings = args.standardTotal - args.adjustedTotal;
  const caps = getLisCopays(lisTier);
  if (caps && savings > 100) {
    return `LIS caps your copays at ${fmtCents(caps.generic)} generic / ${fmtCents(caps.brand)} brand per fill — saving ${fmtDollars(savings)}/yr on this plan.`;
  }
  // 3. Fallback — call out the highest-cost drug.
  if (drugBreakdown.length > 0) {
    const top = [...drugBreakdown].sort((a, b) => b.annualCost - a.annualCost)[0];
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
  } = props;

  if (drugBreakdown.length === 0) return null;

  // Meds map for dose lookup.
  const medByRxcui = new Map<string, Medication>();
  for (const m of medications) {
    if (m.rxcui) medByRxcui.set(m.rxcui, m);
  }

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

  const talkingPoint = buildTalkingPoint({
    plan,
    drugBreakdown,
    phaseByRxcui: drugPhasesByRxcui,
    comparisonPlans,
    planName: plan.plan_name ?? plan.plan_number ?? plan.id,
    lisTier,
    standardTotal,
    adjustedTotal,
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
        <span
          style={{
            fontSize: 10,
            color: MUTED,
          }}
        >
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
          <DrugRowFull
            key={d.rxcui || d.name}
            drug={d}
            meta={medByRxcui.get(d.rxcui)}
            phaseHit={phaseHit}
            lisTier={lisTier}
            mismatch={mismatch}
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
