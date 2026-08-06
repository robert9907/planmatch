// Summary of Benefits drawer — the "fuller" variant of Quick Preview,
// only opened from board-slot cards (SlotCell), after a plan has made
// the top 4. Same 4-col PreviewGrid as QuickPreviewDrawer plus a
// per-medication cost breakdown fed from the DrugRow[] the brain
// already produced (BrainScore.drugBreakdown → adapted → passed to
// SlotCell as `drugBreakdown`).
//
// Per-drug monthly / annual come straight off DrugRow. Quarterly is
// derived (monthlyCopay × 3) — not a fabrication, just the monthly
// value multiplied. Totals sum across covered drugs only; uncovered
// drugs render a "Not covered" chip and don't contribute to the total.
//
// If drugBreakdown is empty (client has no meds captured), the
// medication section suppresses itself entirely and the drawer reads
// as the same 4-col benefit summary the QuickPreviewDrawer shows.

import type { CSSProperties } from 'react';
import type { Plan } from '@/types/plans';
import { TOKENS as T, FONT as F } from './tokens';
import { PreviewDrawerShell, PreviewGrid } from './QuickPreviewDrawer';

// Mirror of the DrugRow shape from CompareScreen.tsx — kept local so
// this file doesn't reach up into the parent for a type. If the shape
// evolves upstream, tsc will surface it via the prop signature.
interface DrugRow {
  rxcui: string;
  name: string;
  covered: boolean;
  tier: number | null;
  monthlyCopay: number | null;
  annualCost: number;
}

export interface SummaryOfBenefitsDrawerProps {
  plan: Plan;
  onClose: () => void;
  /** Per-drug cost rows the brain already emitted for this plan.
   *  Null when the client has no captured meds — the medication
   *  section suppresses in that case. */
  drugBreakdown: ReadonlyArray<DrugRow> | null;
}

export function SummaryOfBenefitsDrawer(props: SummaryOfBenefitsDrawerProps) {
  const { plan, onClose, drugBreakdown } = props;
  const hasMeds = drugBreakdown != null && drugBreakdown.length > 0;

  return (
    <PreviewDrawerShell
      title={`Summary of benefits · ${plan.carrier} ${planCleanName(plan)}`}
      subtitle="Full plan detail with medication cost breakdown"
      contractLabel={planContract(plan)}
      sbfUrl={plan.sbf_url}
      onClose={onClose}
      footer={null}
    >
      <PreviewGrid plan={plan} />
      {hasMeds && <MedCostBreakdown drugs={drugBreakdown!} />}
    </PreviewDrawerShell>
  );
}

// ─── Medication cost breakdown ──────────────────────────────────────

function MedCostBreakdown({ drugs }: { drugs: ReadonlyArray<DrugRow> }) {
  const covered = drugs.filter((d) => d.covered);
  const uncovered = drugs.filter((d) => !d.covered);

  const totalMonthly = covered.reduce(
    (sum, d) => sum + (d.monthlyCopay ?? 0),
    0,
  );
  const totalAnnual = covered.reduce((sum, d) => sum + d.annualCost, 0);
  const totalQuarterly = totalMonthly * 3;

  return (
    <div
      style={{
        borderTop: `1px solid ${T.navyLine}`,
        padding: '14px 18px 4px',
      }}
    >
      <div
        style={{
          color: T.mintOnDark,
          fontFamily: F.label,
          fontSize: 10,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          marginBottom: 8,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 8,
        }}
      >
        <span>Medication cost breakdown</span>
        <span
          style={{
            color: T.navyTextMuted,
            fontWeight: 500,
            fontSize: 10,
            textTransform: 'none',
            letterSpacing: 0,
          }}
        >
          {covered.length} of {drugs.length} covered
        </span>
      </div>

      {/* Column headers */}
      <div style={{ ...ROW, borderTop: 'none', paddingBottom: 6 }}>
        <div style={{ ...CELL_NAME, color: T.navyTextMuted, fontWeight: 700 }}>
          Drug
        </div>
        <div style={{ ...CELL_TIER, color: T.navyTextMuted, fontWeight: 700 }}>
          Tier
        </div>
        <div style={{ ...CELL_NUM, color: T.navyTextMuted, fontWeight: 700 }}>
          Monthly
        </div>
        <div style={{ ...CELL_NUM, color: T.navyTextMuted, fontWeight: 700 }}>
          Quarterly
        </div>
        <div style={{ ...CELL_NUM, color: T.navyTextMuted, fontWeight: 700 }}>
          Annual
        </div>
      </div>

      {covered.map((d) => {
        const monthly = d.monthlyCopay ?? 0;
        const quarterly = monthly * 3;
        return (
          <div key={d.rxcui || d.name} style={ROW}>
            <div style={CELL_NAME} title={d.name}>
              {d.name}
            </div>
            <div style={{ ...CELL_TIER, color: T.navyTextDim }}>
              {d.tier != null ? `Tier ${d.tier}` : '—'}
            </div>
            <div style={CELL_NUM}>
              {d.monthlyCopay == null ? '—' : fmtDollars(monthly)}
            </div>
            <div style={CELL_NUM}>
              {d.monthlyCopay == null ? '—' : fmtDollars(quarterly)}
            </div>
            <div style={CELL_NUM}>{fmtDollars(d.annualCost)}</div>
          </div>
        );
      })}

      {uncovered.map((d) => (
        <div key={d.rxcui || d.name} style={ROW}>
          <div
            style={{
              ...CELL_NAME,
              color: '#fca5a5',
            }}
            title={`${d.name} — not on this plan's formulary`}
          >
            {d.name}
          </div>
          <div style={CELL_TIER}>
            <span
              style={{
                background: 'rgba(239,68,68,0.18)',
                color: '#fca5a5',
                fontFamily: F.label,
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: 0.3,
                padding: '2px 6px',
                borderRadius: 3,
                whiteSpace: 'nowrap',
              }}
            >
              Not covered
            </span>
          </div>
          <div style={{ ...CELL_NUM, color: T.navyTextMuted }}>—</div>
          <div style={{ ...CELL_NUM, color: T.navyTextMuted }}>—</div>
          <div style={{ ...CELL_NUM, color: T.navyTextMuted }}>—</div>
        </div>
      ))}

      {/* Totals row — sums covered-only, matching the ranking pass. */}
      <div
        style={{
          ...ROW,
          borderTop: `1px solid ${T.navyLine}`,
          marginTop: 4,
          fontWeight: 700,
        }}
      >
        <div style={{ ...CELL_NAME, color: '#FFFFFF' }}>Total (covered)</div>
        <div style={{ ...CELL_TIER }} />
        <div style={{ ...CELL_NUM, color: '#FFFFFF' }}>
          {fmtDollars(totalMonthly)}
        </div>
        <div style={{ ...CELL_NUM, color: '#FFFFFF' }}>
          {fmtDollars(totalQuarterly)}
        </div>
        <div style={{ ...CELL_NUM, color: T.mintOnDark }}>
          {fmtDollars(totalAnnual)}
        </div>
      </div>

      <div
        style={{
          color: T.navyTextMuted,
          fontFamily: F.label,
          fontSize: 10,
          marginTop: 8,
          lineHeight: 1.5,
        }}
      >
        Quarterly = monthly copay × 3. Annual comes straight from the brain's
        per-drug estimate (LIS caps and phase transitions already applied where
        the plan files them). Uncovered drugs are excluded from the totals.
      </div>
    </div>
  );
}

// ─── Style constants ────────────────────────────────────────────────

const ROW: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1.6fr) 90px 90px 90px 100px',
  gap: 8,
  fontFamily: F.label,
  fontSize: 11.5,
  padding: '5px 0',
  borderTop: `1px solid ${T.navyRow}`,
  alignItems: 'baseline',
};

const CELL_NAME: CSSProperties = {
  color: '#EAF0F6',
  fontWeight: 500,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
};

const CELL_TIER: CSSProperties = {
  color: '#EAF0F6',
  fontFamily: F.num,
  fontSize: 10.5,
  fontWeight: 500,
  textAlign: 'left',
};

const CELL_NUM: CSSProperties = {
  color: '#EAF0F6',
  fontFamily: F.num,
  fontWeight: 500,
  textAlign: 'right',
};

// ─── Helpers (duplicated from QuickPreviewDrawer; keeping local so
//     this file can stand alone) ────────────────────────────────────

function fmtDollars(n: number): string {
  const v = Math.round(n);
  return `$${v.toLocaleString('en-US')}`;
}

function planCleanName(plan: Plan): string {
  const carrier = plan.carrier ?? '';
  const name = plan.plan_name ?? '';
  return carrier && name.toLowerCase().startsWith(carrier.toLowerCase())
    ? name.slice(carrier.length).trim()
    : name;
}

function planContract(plan: Plan): string | null {
  const [contract, planNum, seg] = plan.id.split('-');
  if (!contract || !planNum) return null;
  const segNorm = (seg ?? '0').replace(/^0+/, '') || '0';
  return `${contract}-${planNum}-${segNorm}`;
}
