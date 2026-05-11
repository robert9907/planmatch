// SwipeCard — the tinder card itself.
//
// Drag right past +100px → "Keep" (gated by capReached).
// Drag left past −100px → "Eliminate".
// Tap-to-eliminate, tap-to-compare, tap-to-keep buttons mirror the swipe.
// Gold border when this is the lowest-Rx plan in the swipe pool — the
// caller decides which plan id qualifies and passes `isGold`.

import { useRef, useState } from 'react';
import type { Plan } from '@/types/plans';
import { BenBadge, MetricCard, Stars, fmt } from './atoms';
import { formatPremium, planDisplay } from './planDisplay';

interface Props {
  plan: Plan;
  // Optional — when the broker hasn't picked a current plan (new to
  // Medicare, SEP, IEP, or just hasn't been captured upstream yet)
  // the card still renders. The vs-current comparison columns (MOOP /
  // Part D arrows) gracefully degrade to standalone metric values.
  current: Plan | null;
  onLeft: () => void;
  onRight: () => void;
  onCompare: (plan: Plan) => void;
  /** 0-based index of this card in the swipe pool. */
  idx: number;
  total: number;
  capReached: boolean;
  brainScore: number | null;
  brainReason: string | null;
  /** Annual drug-cost lookup for this plan + the current plan. */
  annualDrugByPlanId: Record<string, number | null>;
  monthlyDrugByPlanId: Record<string, number | null>;
  /** First provider's NPI status against this plan. */
  providerStatus: 'in' | 'out' | 'unknown';
  providerLabel: string;
  /** Spec: gold border when this is the lowest-Rx plan in the pool. */
  isGold: boolean;
}

export function SwipeCard({
  plan,
  current,
  onLeft,
  onRight,
  onCompare,
  idx,
  total,
  capReached,
  brainScore,
  brainReason,
  annualDrugByPlanId,
  monthlyDrugByPlanId,
  providerStatus,
  providerLabel,
  isGold,
}: Props) {
  const [dx, setDx] = useState(0);
  const [drag, setDrag] = useState(false);
  const [exit, setExit] = useState<'left' | 'right' | null>(null);
  const startX = useRef(0);

  const start = (cx: number) => {
    startX.current = cx;
    setDrag(true);
  };
  const move = (cx: number) => {
    if (drag) setDx(cx - startX.current);
  };
  const end = () => {
    setDrag(false);
    if (dx > 100 && !capReached) {
      setExit('right');
      window.setTimeout(onRight, 300);
    } else if (dx < -100) {
      setExit('left');
      window.setTimeout(onLeft, 300);
    } else {
      setDx(0);
    }
  };

  const rot = dx * 0.05;
  const op = exit ? 0 : 1;
  const tf = exit
    ? `translateX(${exit === 'left' ? -600 : 600}px) rotate(${exit === 'left' ? -15 : 15}deg)`
    : `translateX(${dx}px) rotate(${rot}deg)`;
  const showKeep = dx > 50 && !capReached;
  const showNope = dx < -50;

  const disp = planDisplay(plan);
  const monthlyDrug = monthlyDrugByPlanId[plan.id] ?? null;
  const monthlyDrugCurrent = current ? monthlyDrugByPlanId[current.id] ?? null : null;
  const annualDrug = annualDrugByPlanId[plan.id] ?? null;

  return (
    <div
      onMouseDown={(e) => start(e.clientX)}
      onMouseMove={(e) => {
        if (drag) move(e.clientX);
      }}
      onMouseUp={end}
      onMouseLeave={() => {
        if (drag) end();
      }}
      onTouchStart={(e) => start(e.touches[0].clientX)}
      onTouchMove={(e) => move(e.touches[0].clientX)}
      onTouchEnd={end}
      style={{
        background: isGold
          ? 'linear-gradient(135deg, #fffdf5, #fef9e7, #fffdf5)'
          : 'white',
        borderRadius: 18,
        padding: '22px 24px',
        boxShadow:
          showKeep || showNope
            ? '0 16px 60px rgba(13,47,94,0.15)'
            : isGold
              ? '0 4px 30px rgba(202,138,4,0.2)'
              : '0 4px 24px rgba(13,47,94,0.08)',
        border: showKeep
          ? '3px solid #059669'
          : showNope
            ? '3px solid #ef4444'
            : isGold
              ? '2px solid #ca8a04'
              : '1px solid rgba(13,47,94,0.06)',
        cursor: drag ? 'grabbing' : 'grab',
        transform: tf,
        opacity: op,
        transition: drag ? 'none' : 'all 0.3s ease',
        userSelect: 'none',
        position: 'relative',
        touchAction: 'pan-y',
      }}
    >
      {isGold && !showKeep && !showNope && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            background: 'linear-gradient(135deg, #ca8a04, #eab308)',
            color: 'white',
            padding: '4px 12px',
            borderRadius: '0 16px 0 10px',
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: 1,
            textTransform: 'uppercase',
            boxShadow: '0 2px 8px rgba(202,138,4,0.3)',
          }}
        >
          🥇 Lowest Rx Cost
        </div>
      )}
      {showKeep && (
        <div
          style={{
            position: 'absolute',
            top: 18,
            right: 18,
            background: '#059669',
            color: 'white',
            padding: '5px 14px',
            borderRadius: 8,
            fontSize: 15,
            fontWeight: 800,
            letterSpacing: 2,
            transform: 'rotate(12deg)',
          }}
        >
          KEEP ✓
        </div>
      )}
      {showNope && (
        <div
          style={{
            position: 'absolute',
            top: 18,
            left: 18,
            background: '#ef4444',
            color: 'white',
            padding: '5px 14px',
            borderRadius: 8,
            fontSize: 15,
            fontWeight: 800,
            letterSpacing: 2,
            transform: 'rotate(-12deg)',
          }}
        >
          NOPE ✕
        </div>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 14,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 10,
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
              fontSize: 18,
              fontWeight: 700,
              color: '#0d2f5e',
              marginTop: 2,
            }}
          >
            {plan.plan_name}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 3,
            }}
          >
            <Stars rating={plan.star_rating} />
            <span style={{ fontSize: 10, color: '#94a3b8' }}>
              {plan.plan_type}
            </span>
            {brainScore != null && (
              <span
                style={{
                  background:
                    brainScore >= 70
                      ? '#dbeafe'
                      : brainScore >= 50
                        ? '#fef3c7'
                        : '#fee2e2',
                  color:
                    brainScore >= 70
                      ? '#1e40af'
                      : brainScore >= 50
                        ? '#92400e'
                        : '#991b1b',
                  fontSize: 9,
                  fontWeight: 700,
                  padding: '2px 6px',
                  borderRadius: 4,
                }}
              >
                Brain: {Math.round(brainScore)}/100
              </span>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div
            style={{
              fontFamily: "'Fraunces', Georgia, serif",
              fontSize: 28,
              fontWeight: 800,
              color: plan.premium === 0 ? '#059669' : '#0d2f5e',
              lineHeight: 1,
            }}
          >
            {formatPremium(plan)}
          </div>
          <div style={{ fontSize: 10, color: '#64748b', marginTop: 1 }}>
            /mo premium
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 6,
          marginBottom: 12,
        }}
      >
        <MetricCard
          label="Drugs"
          value={monthlyDrug != null ? `$${monthlyDrug}` : '—'}
          sub="/mo"
          comp={monthlyDrugCurrent ?? undefined}
          better={
            monthlyDrug != null && monthlyDrugCurrent != null
              ? monthlyDrug < monthlyDrugCurrent
              : undefined
          }
        />
        <MetricCard
          label="MOOP"
          value={fmt(plan.moop_in_network)}
          comp={current ? current.moop_in_network : undefined}
          better={
            current ? plan.moop_in_network < current.moop_in_network : undefined
          }
        />
        <MetricCard
          label="Part D"
          value={`$${plan.drug_deductible ?? 0}`}
          comp={current ? current.drug_deductible ?? 0 : undefined}
          better={
            current
              ? (plan.drug_deductible ?? 0) <= (current.drug_deductible ?? 0)
              : undefined
          }
        />
        <MetricCard
          label={providerLabel}
          value={
            providerStatus === 'in'
              ? '✓ In-Net'
              : providerStatus === 'out'
                ? '✕ Out'
                : '? Unknown'
          }
          isStatus={providerStatus === 'in'}
          isWarning={providerStatus === 'out'}
        />
      </div>

      <div
        style={{
          display: 'flex',
          gap: 4,
          flexWrap: 'wrap',
          marginBottom: 10,
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
          value={disp.visionAllowance}
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
      </div>

      {brainReason && (
        <div
          style={{
            background: 'rgba(13,47,94,0.03)',
            borderRadius: 7,
            padding: '6px 10px',
            border: '1px solid rgba(13,47,94,0.04)',
            marginBottom: 14,
          }}
        >
          <span style={{ fontSize: 10 }}>🧠</span>{' '}
          <span style={{ fontSize: 11, color: '#334155' }}>{brainReason}</span>
        </div>
      )}

      {annualDrug != null && (
        <div
          style={{
            fontSize: 10,
            color: '#94a3b8',
            marginBottom: 10,
            textAlign: 'right',
          }}
        >
          Live annual drug spend: <strong>{fmt(annualDrug)}</strong>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onLeft();
          }}
          style={{
            flex: 1,
            background: 'rgba(239,68,68,0.05)',
            border: '2px solid #ef4444',
            borderRadius: 9,
            padding: '11px 0',
            fontSize: 13,
            fontWeight: 700,
            color: '#ef4444',
            cursor: 'pointer',
          }}
        >
          ✕ Eliminate
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCompare(plan);
          }}
          style={{
            flex: 1,
            background: 'white',
            border: '2px solid #0d2f5e',
            borderRadius: 9,
            padding: '11px 0',
            fontSize: 13,
            fontWeight: 700,
            color: '#0d2f5e',
            cursor: 'pointer',
          }}
        >
          Compare
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (!capReached) onRight();
          }}
          disabled={capReached}
          style={{
            flex: 1,
            background: capReached ? '#f1f5f9' : 'rgba(5,150,105,0.05)',
            border: `2px solid ${capReached ? '#cbd5e1' : '#059669'}`,
            borderRadius: 9,
            padding: '11px 0',
            fontSize: 13,
            fontWeight: 700,
            color: capReached ? '#94a3b8' : '#059669',
            cursor: capReached ? 'default' : 'pointer',
          }}
        >
          ✓ Keep
        </button>
      </div>
      <div style={{ textAlign: 'center', marginTop: 10 }}>
        <span style={{ fontSize: 10, color: '#94a3b8' }}>
          Plan {idx + 1} of {total}
        </span>
      </div>
    </div>
  );
}
