// PinnedPlan — the always-visible plan card used at the top of the
// SwipeScreen. Two flavors: current plan (red border) and brain pick
// (seafoam border). Renders carrier/plan, stars/type, brain-score chip,
// MiniMetric row, BenBadge row, and a Compare button.

import type { Plan } from '@/types/plans';
import { BenBadge, MiniMetric, Stars, fmt } from './atoms';
import { formatPremium, planDisplay } from './planDisplay';

interface Props {
  plan: Plan;
  /** Display chrome — "Your Current Plan" or "★ Brain's Top Pick". */
  label: string;
  borderColor: string;
  /** Brain composite score 0-100, or null when not available. */
  brainScore?: number | null;
  /** First provider's NPI status against this plan, when available. */
  providerStatus?: 'in' | 'out' | 'unknown';
  /** Provider name to label the in-network indicator. */
  providerLabel?: string;
  /** Annual drug-cost (live from useDrugCosts). */
  annualDrugCost?: number | null;
  /** Monthly drug cost shorthand. */
  monthlyDrugCost?: number | null;
  /** Brain reason — single sentence explaining the rank. */
  reason?: string | null;
  onCompare: (plan: Plan) => void;
  /** Tap-anywhere → plan detail. Optional so legacy callers that
   *  haven't wired the modal still build; passing it makes the whole
   *  card tappable. */
  onShowDetail?: (plan: Plan) => void;
  /** Compact variant used for the current-plan rail at top of swipe. */
  compact?: boolean;
}

export function PinnedPlan({
  plan,
  label,
  borderColor,
  brainScore,
  providerStatus,
  providerLabel,
  annualDrugCost,
  monthlyDrugCost,
  reason,
  onCompare,
  onShowDetail,
  compact,
}: Props) {
  const disp = planDisplay(plan);
  return (
    <div
      onClick={(e) => {
        if (!onShowDetail) return;
        if ((e.target as HTMLElement).closest('button')) return;
        onShowDetail(plan);
      }}
      role={onShowDetail ? 'button' : undefined}
      tabIndex={onShowDetail ? 0 : undefined}
      style={{
        background: `linear-gradient(135deg, ${borderColor}10, ${borderColor}06)`,
        border: `2px solid ${borderColor}`,
        borderRadius: 14,
        padding: compact ? '12px 16px' : '16px 20px',
        position: 'relative',
        overflow: 'hidden',
        cursor: onShowDetail ? 'pointer' : 'default',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          background: borderColor,
          color: 'white',
          padding: '3px 12px',
          borderRadius: '0 0 0 10px',
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: 1,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: '1 1 200px', minWidth: 180 }}>
          <div
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: '#64748b',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            {plan.carrier}
          </div>
          <div
            style={{
              fontFamily: "'Fraunces', Georgia, serif",
              fontSize: compact ? 14 : 16,
              fontWeight: 700,
              color: '#0d2f5e',
              marginTop: 1,
            }}
          >
            {plan.plan_name}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              marginTop: 2,
            }}
          >
            <Stars rating={plan.star_rating} />
            <span style={{ fontSize: 9, color: '#94a3b8' }}>
              {plan.plan_type}
            </span>
            {brainScore != null && (
              <span
                style={{
                  background: '#0d2f5e',
                  color: '#83f0f9',
                  fontSize: 8,
                  fontWeight: 700,
                  padding: '1px 5px',
                  borderRadius: 3,
                }}
              >
                {Math.round(brainScore)}/100
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          <MiniMetric label="Premium" value={formatPremium(plan)} sub="/mo" />
          {monthlyDrugCost != null && (
            <MiniMetric
              label="Drugs"
              value={`$${monthlyDrugCost}`}
              sub="/mo"
            />
          )}
          <MiniMetric label="MOOP" value={fmt(plan.moop_in_network)} />
          {providerStatus && (
            <MiniMetric
              label={providerLabel ?? 'Doctor'}
              value={providerStatus === 'in' ? '✓' : providerStatus === 'out' ? '✕' : '?'}
              isStatus={providerStatus === 'in'}
            />
          )}
        </div>
        <button
          type="button"
          onClick={() => onCompare(plan)}
          style={{
            background: borderColor,
            color: 'white',
            border: 'none',
            borderRadius: 7,
            padding: '8px 14px',
            fontSize: 11,
            fontWeight: 700,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          Compare Benefits
        </button>
      </div>
      <div
        style={{
          display: 'flex',
          gap: 4,
          flexWrap: 'wrap',
          marginTop: 10,
        }}
      >
        <BenBadge
          icon="🦷"
          label="Dental"
          value={disp.dentalMax}
          good={
            disp.dentalMax !== 'None' && disp.dentalMax !== 'No annual cap filed'
          }
        />
        <BenBadge
          icon="👁"
          label="Vision"
          value={
            plan.benefits.vision.eyewear_allowance_year > 0
              ? `${disp.visionAllowance} eyewear`
              : disp.vision
          }
          good={plan.benefits.vision.eyewear_allowance_year > 0}
        />
        <BenBadge
          icon="👂"
          label="Hearing"
          value={disp.hearing}
          good={disp.hearing !== 'None' && disp.hearing !== 'Routine only'}
        />
        <BenBadge
          icon="🛒"
          label="OTC"
          value={disp.otcText}
          good={disp.otcMonthly >= 50}
        />
        {disp.meals !== 'None' && (
          <BenBadge icon="🍽" label="Meals" value={disp.meals} good />
        )}
        {disp.transport !== 'None' && (
          <BenBadge icon="🚗" label="Transport" value={disp.transport} good />
        )}
        {disp.fitness !== 'None' && (
          <BenBadge icon="🏋️" label="Fitness" value={disp.fitness} good />
        )}
      </div>
      {reason && !compact && (
        <div
          style={{
            marginTop: 8,
            fontSize: 10,
            color: '#475569',
            background: 'rgba(131,240,249,0.06)',
            borderRadius: 6,
            padding: '5px 8px',
            border: '1px solid rgba(131,240,249,0.12)',
          }}
        >
          🧠 {reason}
        </div>
      )}
      {annualDrugCost != null && !compact && (
        <div
          style={{
            marginTop: 6,
            fontSize: 10,
            color: '#94a3b8',
            textAlign: 'right',
          }}
        >
          Live annual drug spend: <strong>{fmt(annualDrugCost)}</strong>
        </div>
      )}
    </div>
  );
}
