// Quick Preview drawer — opens in-place below the 4-Up Board when the
// broker clicks "Quick preview" on a bench card. Purpose: let the
// agent evaluate a plan before deciding to add it to the board. All
// data reads from what the parent already passed to BenchCard — no
// new fetches. Dark-navy panel per the /mnt/user-data/outputs/
// planmatch-2026-redesign.html .preview-drawer reference.
//
// The Summary of Benefits drawer (board cards) reuses the same
// PreviewSection primitive below via composition; see
// SummaryOfBenefitsDrawer.tsx.

import type { CSSProperties } from 'react';
import type { Plan } from '@/types/plans';
import { TOKENS as T, FONT as F } from './tokens';
import {
  planDisplay,
  formatCostShareWithRange,
  formatPcp,
  formatSpecialist,
} from '../planDisplay';
import { formatInpatientLadder } from '@/lib/inpatient-format';
import { formatOtc } from '@/lib/extractBenefitValue';

// ─── Public entry points ────────────────────────────────────────────

export interface QuickPreviewDrawerProps {
  plan: Plan;
  onClose: () => void;
  onAddToBoard: (plan: Plan) => void;
  /** True when the plan is already on the board — hides "Add to
   *  board" so the drawer doesn't invite a no-op. */
  isOnBoard?: boolean;
}

export function QuickPreviewDrawer(props: QuickPreviewDrawerProps) {
  const { plan, onClose, onAddToBoard, isOnBoard = false } = props;

  return (
    <PreviewDrawerShell
      title={`Quick preview · ${plan.carrier} ${planCleanName(plan)}`}
      subtitle="Opens in place — no navigation away from the board"
      sbfUrl={plan.sbf_url}
      contractLabel={planContract(plan)}
      onClose={onClose}
      footer={
        !isOnBoard ? (
          <button
            type="button"
            onClick={() => onAddToBoard(plan)}
            style={{
              background: T.mint600,
              color: T.mintOnMint,
              border: 'none',
              borderRadius: 8,
              padding: '9px 22px',
              fontFamily: F.label,
              fontSize: 12.5,
              fontWeight: 700,
              letterSpacing: 0.3,
              cursor: 'pointer',
            }}
          >
            Add to board →
          </button>
        ) : null
      }
    >
      <PreviewGrid plan={plan} />
    </PreviewDrawerShell>
  );
}

// ─── Shared shell used by both drawers ──────────────────────────────

export function PreviewDrawerShell({
  title,
  subtitle,
  contractLabel,
  sbfUrl,
  onClose,
  footer,
  children,
}: {
  title: string;
  subtitle: string;
  contractLabel: string | null;
  sbfUrl: string | null | undefined;
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={title}
      style={{
        margin: '14px 0',
        background: T.navy950,
        borderRadius: 12,
        overflow: 'hidden',
        boxShadow: '0 4px 18px rgba(10,18,32,0.18)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          padding: '14px 18px',
          borderBottom: `1px solid ${T.navyLine}`,
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              color: '#FFFFFF',
              fontFamily: F.label,
              fontSize: 13.5,
              fontWeight: 600,
              lineHeight: 1.25,
            }}
          >
            {title}
          </div>
          <div
            style={{
              color: T.navyTextMuted,
              fontFamily: F.label,
              fontSize: 11,
              marginTop: 3,
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            {contractLabel && (
              <span
                style={{
                  fontFamily: F.num,
                  color: T.navyTextDim,
                  letterSpacing: 0.5,
                }}
              >
                {contractLabel}
              </span>
            )}
            <span>{subtitle}</span>
            {sbfUrl && (
              <a
                href={sbfUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                style={{
                  color: T.mintOnDark,
                  textDecoration: 'none',
                  fontWeight: 700,
                  background: 'rgba(127,224,196,0.18)',
                  padding: '2px 7px',
                  borderRadius: 3,
                  letterSpacing: 0.3,
                }}
                title="Summary of Benefits (source PDF)"
              >
                📄 SBF ↗
              </a>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          style={{
            color: T.navyTextMuted,
            fontFamily: F.label,
            fontSize: 11,
            fontWeight: 600,
            border: `1px solid ${T.navyChipBorder}`,
            background: 'transparent',
            borderRadius: 6,
            padding: '5px 10px',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Close ×
        </button>
      </div>

      {children}

      {footer && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            padding: '12px 18px',
            borderTop: `1px solid ${T.navyLine}`,
            background: '#0C1626',
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}

// ─── 4-col benefit grid — reused by both drawers ────────────────────

export function PreviewGrid({ plan }: { plan: Plan }) {
  const isPdp = plan.plan_type === 'PDP';
  const cs = (getter: (p: Plan) => Parameters<typeof formatCostShareWithRange>[0]) =>
    formatCostShareWithRange(getter(plan), { isPdp });

  // Inpatient ladder MUST show every tier per CMS disclosure
  // ([[feedback_inpatient_full_ladder]]). formatInpatientLadder
  // returns a \n-joined string; the PreviewRow variant flips to
  // whiteSpace: pre-line so all lines render.
  const inpatientLadder = formatInpatientLadder(
    plan.benefits.medical.inpatient.description,
    plan.benefits.medical.inpatient.copay,
    plan.benefits.medical.inpatient.coinsurance,
  );
  const mhInpatientLadder = formatInpatientLadder(
    plan.benefits.medical.mental_health_inpatient.description,
    plan.benefits.medical.mental_health_inpatient.copay,
    plan.benefits.medical.mental_health_inpatient.coinsurance,
  );
  const snfLadder = formatInpatientLadder(
    plan.benefits.medical.snf.description,
    plan.benefits.medical.snf.copay,
    plan.benefits.medical.snf.coinsurance,
  );

  const otcQuarterly = plan.benefits.otc.allowance_per_quarter;
  const partBGiveback = plan.part_b_giveback;
  const display = planDisplay(plan);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        gap: 0,
      }}
    >
      <PreviewColumn title="Provider &amp; care">
        <PreviewRow label="PCP copay" value={formatPcp(plan)} />
        <PreviewRow label="Specialist" value={formatSpecialist(plan)} />
        <PreviewRow
          label="Urgent care"
          value={cs((p) => p.benefits.medical.urgent_care)}
        />
        <PreviewRow
          label="Emergency"
          value={cs((p) => p.benefits.medical.emergency)}
        />
        <PreviewRow
          label="Telehealth"
          value={cs((p) => p.benefits.medical.telehealth)}
        />
      </PreviewColumn>

      <PreviewColumn title="Hospital">
        <PreviewRow
          label="Inpatient"
          value={inpatientLadder ?? '—'}
          multiline
        />
        <PreviewRow
          label="Inpatient mental"
          value={mhInpatientLadder ?? '—'}
          multiline
        />
        <PreviewRow
          label="Skilled nursing"
          value={snfLadder ?? '—'}
          multiline
        />
        <PreviewRow
          label="Outpatient surg. (hosp)"
          value={cs((p) => p.benefits.medical.outpatient_surgery_hospital)}
        />
        <PreviewRow
          label="Outpatient surg. (ASC)"
          value={cs((p) => p.benefits.medical.outpatient_surgery_asc)}
        />
      </PreviewColumn>

      <PreviewColumn title="Rx &amp; pharmacy">
        <PreviewRow
          label="Part D deductible"
          value={plan.drug_deductible == null ? '—' : `$${plan.drug_deductible}`}
        />
        <PreviewRow
          label="Tier 1"
          value={cs((p) => p.benefits.rx_tiers.tier_1)}
        />
        <PreviewRow
          label="Tier 2"
          value={cs((p) => p.benefits.rx_tiers.tier_2)}
        />
        <PreviewRow
          label="Tier 3"
          value={cs((p) => p.benefits.rx_tiers.tier_3)}
        />
        <PreviewRow
          label="Tier 4"
          value={cs((p) => p.benefits.rx_tiers.tier_4)}
        />
        <PreviewRow
          label="Tier 5"
          value={cs((p) => p.benefits.rx_tiers.tier_5)}
        />
        {plan.benefits.rx_tiers.tier_6 && (
          <PreviewRow
            label="Tier 6"
            value={cs(() => plan.benefits.rx_tiers.tier_6!)}
          />
        )}
      </PreviewColumn>

      <PreviewColumn title="Extras">
        <PreviewRow label="Dental" value={display.dentalMax} />
        <PreviewRow label="Vision" value={display.visionAllowance} />
        <PreviewRow
          label="OTC / qtr"
          value={formatOtc(otcQuarterly, plan.benefits.otc.description)}
        />
        <PreviewRow label="Fitness" value={display.fitness} />
        <PreviewRow label="Hearing" value={display.hearing} />
        <PreviewRow label="Transport" value={display.transport} />
        <PreviewRow label="Food card" value={display.meals} />
        <PreviewRow
          label="Part B back"
          value={partBGiveback > 0 ? `$${partBGiveback}/mo` : '—'}
        />
      </PreviewColumn>
    </div>
  );
}

// ─── Section primitives ─────────────────────────────────────────────

function PreviewColumn({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: '12px 16px',
        borderRight: `1px solid ${T.navyLine}`,
      }}
    >
      <h4
        style={{
          color: T.mintOnDark,
          fontFamily: F.label,
          fontSize: 10,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          margin: '0 0 8px',
        }}
        // Column headers may be short enough that the borderRight on
        // the last column visually noises the right edge; the parent
        // grid handles that by using overflow: hidden on the drawer.
      >
        {title}
      </h4>
    {children}
    </div>
  );
}

function PreviewRow({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  const rowStyle: CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    fontFamily: F.label,
    fontSize: 11.5,
    padding: '5px 0',
    borderTop: `1px solid ${T.navyRow}`,
    gap: 8,
  };
  const valStyle: CSSProperties = {
    color: '#EAF0F6',
    fontWeight: 500,
    fontFamily: F.num,
    whiteSpace: multiline ? 'pre-line' : 'nowrap',
    textAlign: multiline ? 'right' : 'right',
    lineHeight: multiline ? 1.35 : 1.2,
    minWidth: 0,
    // Preserve the full inpatient ladder — do NOT ellipsize.
    // [[feedback_inpatient_full_ladder]] applies to every surface.
  };
  return (
    <div style={rowStyle}>
      <span style={{ color: T.navyTextMuted, flexShrink: 0 }}>{label}</span>
      <span style={valStyle}>{value}</span>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────
// Plan.plan_name from CMS files sometimes prepends the carrier
// (Wellcare especially — "Wellcare Simple (HMO-POS)"). Suppress the
// prefix so the drawer title doesn't read "Wellcare Wellcare Simple".
// Same predicate as the drag-tooltip fix in CompareScreen.tsx.
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
