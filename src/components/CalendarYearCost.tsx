// CalendarYearCost — 3-level accordion that walks a senior through what
// their Part D drug costs would look like Jan → Dec on this plan, with
// the deductible / initial / gap / catastrophic phase transitions
// called out month-by-month and drug-by-drug.
//
// Pure presentational: the parent owns the calc inputs (drugs +
// plan.benefits.rx_tiers + per-plan formulary map) and we memoize the
// timeline locally. Shared across Top4Screen, PlanDetailView, and
// QuoteDeliveryV4 — one component, three render points.

import { useMemo, useState } from 'react';
import type { Medication } from '@/types/session';
import type { Plan } from '@/types/plans';
import type { FormularyHit } from '@/lib/formularyLookup';
import {
  computePartDTimeline,
  phaseLabel,
  PHASE_COLORS,
  PART_D_2026,
  type PartDPhase,
  type MonthCost,
  type DrugMonthCost,
} from '@/lib/partDPhaseCalc';

interface Props {
  medications: Medication[];
  plan: Plan;
  formulary: Record<string, FormularyHit>;
  // When true, the section starts expanded (used in PlanDetailView where
  // the user has already drilled in; Top4/Compare default closed to
  // keep the page short).
  defaultOpen?: boolean;
}

function fmtUsd(n: number): string {
  if (n === 0) return '$0';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function tierBadge(tier: DrugMonthCost['tier']): { label: string; color: string } {
  if (tier == null || tier === 'not_covered') {
    return { label: 'Not covered', color: '#d63031' };
  }
  return { label: `Tier ${tier}`, color: '#0d2f5e' };
}

function phaseChip(phase: PartDPhase | 'not_covered') {
  const bg = phase === 'not_covered' ? '#9A9389' : PHASE_COLORS[phase as PartDPhase];
  return (
    <span
      className="cyc-phase-chip"
      style={{ background: bg, color: '#fff' }}
    >
      {phaseLabel(phase)}
    </span>
  );
}

function Kpi({ value, label, accent }: { value: string; label: string; accent: string }) {
  return (
    <div className="cyc-kpi">
      <div className="cyc-kpi-bar" style={{ background: accent }} />
      <div className="cyc-kpi-v">{value}</div>
      <div className="cyc-kpi-l">{label}</div>
    </div>
  );
}

function MonthBar({ month, maxValue }: { month: MonthCost; maxValue: number }) {
  const segments: { color: string; width: number }[] = [];
  // If the month transitions phases, the bar is split into two-tone.
  // Simple approach: weight by drug share.
  const totalsByPhase = new Map<PartDPhase | 'not_covered', number>();
  for (const drug of month.drugs) {
    totalsByPhase.set(drug.phase, (totalsByPhase.get(drug.phase) ?? 0) + drug.userCost);
  }
  for (const [phase, value] of totalsByPhase.entries()) {
    if (value === 0) continue;
    const color =
      phase === 'not_covered' ? '#9A9389' : PHASE_COLORS[phase as PartDPhase];
    segments.push({ color, width: (value / Math.max(maxValue, 1)) * 100 });
  }
  // If no spend at all this month, render a flat catastrophic-color bar
  // at 2% so the user still sees the month exists.
  if (segments.length === 0) {
    segments.push({ color: PHASE_COLORS.catastrophic, width: 2 });
  }
  return (
    <div className="cyc-bar-row">
      <div className="cyc-bar-month">{month.monthName.slice(0, 3)}</div>
      <div className="cyc-bar-track">
        {segments.map((s, i) => (
          <div
            key={i}
            className="cyc-bar-seg"
            style={{ background: s.color, width: `${s.width}%` }}
          />
        ))}
      </div>
      <div className="cyc-bar-amt">{fmtUsd(month.monthTotal)}</div>
    </div>
  );
}

function MonthRow({ month }: { month: MonthCost }) {
  const [open, setOpen] = useState(false);
  const phaseChanged = month.startPhase !== month.endPhase;
  return (
    <div className="cyc-month">
      <button
        type="button"
        className="cyc-month-hdr"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="cyc-month-tri">{open ? '▼' : '▶'}</span>
        <span className="cyc-month-name">{month.monthName}</span>
        <span className="cyc-month-phase">
          {phaseChip(month.endPhase)}
          {phaseChanged && (
            <span className="cyc-month-phase-note">
              {' '}entered from {phaseLabel(month.startPhase)}
            </span>
          )}
        </span>
        <span className="cyc-month-amt">{fmtUsd(month.monthTotal)}</span>
      </button>
      {open && (
        <div className="cyc-month-body">
          {month.drugs.length === 0 ? (
            <div className="cyc-empty">No medications on file</div>
          ) : (
            <div className="cyc-drug-grid">
              <div className="cyc-drug-hdr">Medication</div>
              <div className="cyc-drug-hdr">Tier</div>
              <div className="cyc-drug-hdr">Retail / mo</div>
              <div className="cyc-drug-hdr">You pay</div>
              {month.drugs.map((d, i) => {
                const tb = tierBadge(d.tier);
                return (
                  <div key={i} className="cyc-drug-cells" style={{ display: 'contents' }}>
                    <div className="cyc-drug-name">
                      {d.name}
                      {d.coverageNote && (
                        <div className="cyc-drug-note">{d.coverageNote}</div>
                      )}
                    </div>
                    <div>
                      <span
                        className="cyc-tier-pill"
                        style={{ background: tb.color }}
                      >
                        {tb.label}
                      </span>
                    </div>
                    <div className="cyc-mono">{fmtUsd(d.retail)}</div>
                    <div className="cyc-mono cyc-userpay">{fmtUsd(d.userCost)}</div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="cyc-month-foot">
            <span>Year-to-date out-of-pocket</span>
            <span className="cyc-mono">{fmtUsd(month.cumulativeUserOop)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function CalendarYearCost({ medications, plan, formulary, defaultOpen }: Props) {
  const [open, setOpen] = useState(Boolean(defaultOpen));

  const timeline = useMemo(
    () => computePartDTimeline(medications, plan, formulary),
    [medications, plan, formulary],
  );

  if (medications.length === 0) {
    return (
      <div className="cyc cyc-empty-state">
        <span>Calendar Year Cost — add medications in Step 3 to project monthly drug costs.</span>
      </div>
    );
  }

  const monthlyMax = timeline.months.reduce(
    (m, mo) => Math.max(m, mo.monthTotal),
    0,
  );

  const catLabel = timeline.catastrophicStartsMonth
    ? timeline.months[timeline.catastrophicStartsMonth - 1].monthName
    : 'Not reached';

  const initialLabel = timeline.zeroDeductible
    ? 'No deductible'
    : timeline.initialPhaseStartsMonth
      ? timeline.months[timeline.initialPhaseStartsMonth - 1].monthName
      : 'Still in deductible';

  return (
    <div className="cyc">
      <button
        type="button"
        className="cyc-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="cyc-toggle-tri">{open ? '▼' : '▶'}</span>
        <span className="cyc-toggle-title">
          {open ? 'Calendar Year Cost' : 'Click to see Calendar Year Cost'}
        </span>
        <span className="cyc-toggle-total">
          {fmtUsd(timeline.totalAnnualOop)} <small>/ year</small>
        </span>
      </button>
      {open && (
        <div className="cyc-body">
          <div className="cyc-kpis">
            <Kpi
              value={fmtUsd(timeline.totalAnnualOop)}
              label="Total out-of-pocket"
              accent={PHASE_COLORS.initial}
            />
            <Kpi
              value={initialLabel}
              label="Exits deductible"
              accent={PHASE_COLORS.deductible}
            />
            <Kpi
              value={catLabel}
              label="$0 copays start"
              accent={PHASE_COLORS.catastrophic}
            />
            <Kpi
              value={fmtUsd(Math.max(0, PART_D_2026.TROOP_CAP - timeline.totalAnnualOop))}
              label="Under the $2,000 cap by"
              accent={PHASE_COLORS.gap}
            />
          </div>
          <div className="cyc-legend">
            <span className="cyc-leg-i" style={{ background: PHASE_COLORS.deductible }} />
            <span>Deductible (you pay 100%)</span>
            <span className="cyc-leg-i" style={{ background: PHASE_COLORS.initial }} />
            <span>Initial coverage (filed copay)</span>
            <span className="cyc-leg-i" style={{ background: PHASE_COLORS.gap }} />
            <span>Coverage gap (25% of retail)</span>
            <span className="cyc-leg-i" style={{ background: PHASE_COLORS.catastrophic }} />
            <span>Catastrophic ($0)</span>
          </div>
          <div className="cyc-chart">
            {timeline.months.map((m) => (
              <MonthBar key={m.month} month={m} maxValue={monthlyMax} />
            ))}
          </div>
          <div className="cyc-months">
            {timeline.months.map((m) => (
              <MonthRow key={m.month} month={m} />
            ))}
          </div>
          {timeline.hasUncoveredDrug && (
            <div className="cyc-warn">
              ⚠ One or more of your medications is not on this plan's formulary.
              The "Not covered" amounts above estimate what you'd pay at retail
              and are not credited toward your Part D out-of-pocket cap.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
