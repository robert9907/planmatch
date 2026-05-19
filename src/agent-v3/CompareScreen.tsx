// CompareScreen — agent-v3 screen 6 ("Top 4").
//
// Margaret-proof client-facing redesign: full-bleed dark navy backdrop,
// minimal header (GenerationHealth.me + X), single centered "Top 4"
// pill, optional gold notice when the client's current plan isn't
// offered in their county, then up to 4 stacked plan cards. Each card
// has a grade circle (A when brain composite ≥ 75, otherwise B), a
// "What you asked for" trio (Dental, Vision, OTC), a 7-cell medical
// copays grid, and a full-width Compare button. The brain pick gets a
// 2 px seafoam border and a "strongest match" badge.
//
// Tapping a Compare button hands the candidate plan to the shell which
// flips screen → 'comparison' (PlanComparisonScreen) for the head-to-
// head breakdown. The shell also hides the AgentBar while this screen
// is active so the client sees nothing but plans.

import type { CSSProperties } from 'react';
import type { Plan } from '@/types/plans';
import {
  costShareNumeric,
  formatCostShare,
  planDisplay,
} from './planDisplay';

const NAVY = '#1a2744';
const SEAFOAM = '#5DCAA5';
const SEAFOAM_LIGHT = '#B8E6D4';
const SEAFOAM_DARK = '#0A6B52';
const GRADE_B_BLUE = '#85B7EB';
const NOTICE_GOLD = '#F0D78C';

interface Props {
  current: Plan | null;
  /** True when the client named a current plan but it isn't offered in
   *  their county — surfaces the gold notice bar at the top. */
  currentMissingInCounty: boolean;
  /** finalists[0] = brain pick (when present) + each user-kept plan,
   *  capped at 4 by the shell. */
  finalists: Plan[];
  /** Whether finalists[0] is the brain pick (true) vs. just the first
   *  kept plan (false, when noCurrentPlan or brain pick is missing). */
  hasBrainPick: boolean;
  annualDrugByPlanId: Record<string, number | null>;
  brainScoreByPlanId: Record<string, number>;
  /** Closes the Top 4 view — wired to the shell's history pop so the
   *  X-close routes back to whichever screen launched Top 4. */
  onClose: () => void;
  /** Launches PlanComparisonScreen with this challenger vs the current
   *  plan. When there's no current plan the shell falls back to the
   *  finalist with the highest brain composite. */
  onCompare: (plan: Plan) => void;
  onBack: () => void;
  onNext: () => void;
}

export function CompareScreen({
  current,
  currentMissingInCounty,
  finalists,
  hasBrainPick,
  annualDrugByPlanId,
  brainScoreByPlanId,
  onClose,
  onCompare,
  onBack,
  onNext,
}: Props) {
  return (
    <div style={SCREEN_ROOT}>
      <ScreenHeader onClose={onClose} />

      <div style={{ maxWidth: 480, margin: '0 auto', padding: '0 18px 32px' }}>
        <div style={{ display: 'flex', justifyContent: 'center', margin: '6px 0 18px' }}>
          <span style={PILL_TAB}>Top 4</span>
        </div>

        {currentMissingInCounty && (
          <div style={NOTICE_BAR} role="status">
            <span aria-hidden style={{ fontSize: 16 }}>⚠</span>
            <span>
              Your current plan isn’t offered in your county. We picked
              the closest match below.
            </span>
          </div>
        )}

        <h1 style={SECTION_TITLE}>Your top 4 plans</h1>
        <div style={SECTION_SUB}>
          Side by side, with what matters most to you on top.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {finalists.length === 0 ? (
            <div style={EMPTY_BLOCK}>
              Pick at least one plan on the swipe screen first.
            </div>
          ) : (
            finalists.map((plan, i) => {
              const isBest = i === 0 && hasBrainPick;
              const annualDrug = annualDrugByPlanId[plan.id] ?? null;
              const score = brainScoreByPlanId[plan.id];
              const grade: 'A' | 'B' = score != null && score >= 75 ? 'A' : 'B';
              return (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  isBest={isBest}
                  grade={grade}
                  annualDrug={annualDrug}
                  onCompare={() => onCompare(plan)}
                  canCompare={Boolean(current)}
                />
              );
            })
          )}
        </div>

        <div style={NAV_ROW}>
          <button type="button" onClick={onBack} style={BACK_BTN}>
            ← Back
          </button>
          {finalists.length > 0 && (
            <button type="button" onClick={onNext} style={NEXT_BTN}>
              Continue →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ScreenHeader({ onClose }: { onClose: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 18px 6px',
      }}
    >
      <span
        style={{
          fontFamily: "'Fraunces', Georgia, serif",
          fontSize: 18,
          fontWeight: 700,
          color: SEAFOAM_LIGHT,
          letterSpacing: 0.2,
        }}
      >
        GenerationHealth.me
      </span>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        style={{
          background: 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(255,255,255,0.18)',
          color: 'white',
          width: 36,
          height: 36,
          borderRadius: 18,
          fontSize: 16,
          fontWeight: 600,
          cursor: 'pointer',
          lineHeight: 1,
        }}
      >
        ✕
      </button>
    </div>
  );
}

interface PlanCardProps {
  plan: Plan;
  isBest: boolean;
  grade: 'A' | 'B';
  annualDrug: number | null;
  onCompare: () => void;
  canCompare: boolean;
}

function PlanCard({ plan, isBest, grade, annualDrug, onCompare, canCompare }: PlanCardProps) {
  const d = planDisplay(plan);
  const m = plan.benefits.medical;

  // Top trio — "What you asked for".
  const dentalText = formatDental(plan);
  const visionText = d.visionAllowance === '$0' ? 'None' : d.visionAllowance;
  const otcText = formatOtc(plan);

  // Medical copays. Spec calls out 7 cells; we map "Imaging" to
  // diagnostic_radiology (MRI/CT) since the spec separates X-ray.
  const copayRows: { label: string; value: string }[] = [
    { label: 'Specialist', value: formatCostShare(m.specialist) },
    { label: 'Imaging', value: formatCostShare(m.diagnostic_radiology) },
    { label: 'Emergency room', value: formatCostShare(m.emergency) },
    { label: 'Hospital per day', value: formatHospital(m.inpatient) },
    { label: 'Urgent care', value: formatCostShare(m.urgent_care) },
    { label: 'X-ray', value: formatCostShare(m.xray) },
    {
      label: 'Estimated drug cost',
      value:
        annualDrug != null
          ? `$${annualDrug.toLocaleString()} per year`
          : '—',
    },
  ];

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: isBest
          ? `2px solid ${SEAFOAM}`
          : '0.5px solid rgba(255,255,255,0.25)',
        borderRadius: 16,
        padding: '18px 18px 16px',
        boxShadow: isBest ? '0 0 0 4px rgba(93,202,165,0.08)' : 'none',
      }}
    >
      {isBest && (
        <div
          style={{
            display: 'inline-block',
            background: SEAFOAM,
            color: '#0A2A1F',
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 1,
            textTransform: 'uppercase',
            padding: '3px 9px',
            borderRadius: 10,
            marginBottom: 12,
          }}
        >
          Strongest match
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 14,
        }}
      >
        <GradeCircle grade={grade} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              color: 'white',
              fontSize: 15,
              fontWeight: 700,
              lineHeight: 1.2,
              overflowWrap: 'break-word',
              wordBreak: 'break-word',
            }}
          >
            {plan.plan_name}
          </div>
          <div
            style={{
              color: 'rgba(255,255,255,0.65)',
              fontSize: 12,
              marginTop: 2,
            }}
          >
            {plan.carrier}
          </div>
        </div>
        <div
          style={{
            color: 'white',
            fontSize: 14,
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          {formatPremiumLong(plan)}
        </div>
      </div>

      <SectionLabel
        text="What you asked for"
        color={SEAFOAM}
        topBorder={false}
      />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 6,
          marginBottom: 16,
        }}
      >
        <TopCell label="Dental" value={dentalText} />
        <TopCell label="Vision" value={visionText} />
        <TopCell label="OTC" value={otcText} />
      </div>

      <SectionLabel
        text="Medical copays"
        color="rgba(255,255,255,0.55)"
        topBorder
      />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          rowGap: 10,
          columnGap: 18,
          marginBottom: 18,
        }}
      >
        {copayRows.map((r) => (
          <div
            key={r.label}
            style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}
          >
            <span
              style={{
                fontSize: 13,
                color: 'rgba(255,255,255,0.55)',
                marginBottom: 1,
              }}
            >
              {r.label}
            </span>
            <span style={{ fontSize: 14, color: 'white', fontWeight: 600 }}>
              {r.value}
            </span>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={onCompare}
        disabled={!canCompare}
        title={
          canCompare
            ? 'Compare this plan against the client’s current plan'
            : 'Add a current plan first to compare'
        }
        style={{
          width: '100%',
          minHeight: 48,
          borderRadius: 999,
          padding: '12px 18px',
          fontSize: 16,
          fontWeight: 700,
          letterSpacing: 0.2,
          cursor: canCompare ? 'pointer' : 'not-allowed',
          opacity: canCompare ? 1 : 0.5,
          background: isBest ? SEAFOAM_DARK : 'transparent',
          color: 'white',
          border: isBest
            ? `1px solid ${SEAFOAM}`
            : '1px solid rgba(255,255,255,0.35)',
        }}
      >
        Compare
      </button>
    </div>
  );
}

function GradeCircle({ grade }: { grade: 'A' | 'B' }) {
  const isA = grade === 'A';
  const color = isA ? SEAFOAM : GRADE_B_BLUE;
  return (
    <div
      style={{
        width: 42,
        height: 42,
        borderRadius: 21,
        background: `${color}33`,
        border: `2px solid ${color}`,
        color,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: "'Fraunces', Georgia, serif",
        fontWeight: 800,
        fontSize: 22,
        flexShrink: 0,
      }}
    >
      {grade}
    </div>
  );
}

function SectionLabel({
  text,
  color,
  topBorder,
}: {
  text: string;
  color: string;
  topBorder: boolean;
}) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        color,
        marginBottom: 8,
        paddingTop: topBorder ? 12 : 0,
        borderTop: topBorder ? '1px solid rgba(255,255,255,0.12)' : 'none',
      }}
    >
      {text}
    </div>
  );
}

function TopCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <span style={{ fontSize: 16, color: 'white', fontWeight: 700 }}>
        {value}
      </span>
      <span
        style={{
          fontSize: 11,
          color: 'rgba(255,255,255,0.5)',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          marginTop: 2,
        }}
      >
        {label}
      </span>
    </div>
  );
}

// ── formatters tuned for the spec's spell-out requirement ────────────

function formatPremiumLong(plan: Plan): string {
  return plan.premium === 0
    ? '$0 per month'
    : `$${plan.premium} per month`;
}

function formatDental(plan: Plan): string {
  const d = plan.benefits.dental;
  if (d.annual_max > 0) return `$${d.annual_max.toLocaleString()} per year`;
  if (d.comprehensive || d.preventive) return 'Covered';
  return 'None';
}

function formatOtc(plan: Plan): string {
  // pm_plan_benefits files OTC quarterly; spec spells out "per month".
  const monthly = Math.round(plan.benefits.otc.allowance_per_quarter / 3);
  return monthly > 0 ? `$${monthly} per month` : 'None';
}

function formatHospital(cs: Plan['benefits']['medical']['inpatient']): string {
  const num = costShareNumeric(cs);
  if (num == null) return '—';
  if (cs.copay != null) return `$${cs.copay} per day`;
  // Coinsurance — render the percent as-is.
  return `${cs.coinsurance ?? num}%`;
}

// ── style atoms ─────────────────────────────────────────────────────

const SCREEN_ROOT: CSSProperties = {
  minHeight: '100vh',
  background: NAVY,
  color: 'white',
  margin: 0,
};

const PILL_TAB: CSSProperties = {
  background: 'rgba(255,255,255,0.12)',
  color: 'white',
  borderRadius: 999,
  padding: '6px 18px',
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: 0.4,
  border: '1px solid rgba(255,255,255,0.18)',
};

const NOTICE_BAR: CSSProperties = {
  background: 'rgba(240,215,140,0.14)',
  border: '1px solid rgba(240,215,140,0.4)',
  color: NOTICE_GOLD,
  borderRadius: 10,
  padding: '10px 12px',
  fontSize: 13,
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  marginBottom: 14,
  lineHeight: 1.4,
};

const SECTION_TITLE: CSSProperties = {
  fontSize: 20,
  fontWeight: 700,
  color: 'white',
  margin: '0 0 4px',
  fontFamily: 'inherit',
};

const SECTION_SUB: CSSProperties = {
  fontSize: 14,
  color: 'rgba(255,255,255,0.6)',
  marginBottom: 18,
};

const EMPTY_BLOCK: CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  border: '0.5px solid rgba(255,255,255,0.25)',
  borderRadius: 16,
  padding: '24px 18px',
  color: 'rgba(255,255,255,0.7)',
  fontSize: 14,
  textAlign: 'center',
};

const NAV_ROW: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  marginTop: 22,
  gap: 12,
};

const BACK_BTN: CSSProperties = {
  background: 'transparent',
  color: 'rgba(255,255,255,0.8)',
  border: '1px solid rgba(255,255,255,0.25)',
  borderRadius: 999,
  padding: '10px 18px',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
};

const NEXT_BTN: CSSProperties = {
  background: SEAFOAM_DARK,
  color: 'white',
  border: `1px solid ${SEAFOAM}`,
  borderRadius: 999,
  padding: '10px 22px',
  fontSize: 14,
  fontWeight: 700,
  cursor: 'pointer',
};
