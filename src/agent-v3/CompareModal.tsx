// CompareModal — side-by-side current-vs-candidate plan popover.
// Triggered from PinnedPlan + SwipeCard "Compare Benefits" buttons.
//
// Annual savings header reads (currentTotal − candidateTotal). When the
// candidate is more expensive the chip is suppressed (the spec only
// renders savings when savings > 0).

import type { Plan } from '@/types/plans';
import {
  Card as _CardUnused,
  Container as _ContainerUnused,
  PRI_BTN,
  fmt,
} from './atoms';
import {
  annualEstimate,
  formatPcp,
  formatPremium,
  formatSpecialist,
  planDisplay,
} from './planDisplay';

void _CardUnused;
void _ContainerUnused;

interface Props {
  current: Plan;
  candidate: Plan;
  /** Annual drug-cost lookup keyed by Plan.id. */
  annualDrugByPlanId: Record<string, number | null>;
  onClose: () => void;
}

export function CompareModal({
  current,
  candidate,
  annualDrugByPlanId,
  onClose,
}: Props) {
  const cur = planDisplay(current);
  const cand = planDisplay(candidate);
  const curDrug = annualDrugByPlanId[current.id] ?? null;
  const candDrug = annualDrugByPlanId[candidate.id] ?? null;
  const curAnnual = annualEstimate(current, curDrug).total;
  const candAnnual = annualEstimate(candidate, candDrug).total;
  const savings =
    curAnnual != null && candAnnual != null ? curAnnual - candAnnual : null;

  const rows: { l: string; a: string; b: string; w?: boolean }[] = [
    {
      l: 'Premium',
      a: `${formatPremium(current)}/mo`,
      b: `${formatPremium(candidate)}/mo`,
      w: candidate.premium <= current.premium,
    },
    {
      l: 'Annual Drugs',
      a: curDrug != null ? fmt(curDrug) : '—',
      b: candDrug != null ? fmt(candDrug) : '—',
      w: curDrug != null && candDrug != null ? candDrug < curDrug : undefined,
    },
    {
      l: 'PCP',
      a: formatPcp(current),
      b: formatPcp(candidate),
    },
    {
      l: 'Specialist',
      a: formatSpecialist(current),
      b: formatSpecialist(candidate),
    },
    {
      l: 'MOOP',
      a: fmt(current.moop_in_network),
      b: fmt(candidate.moop_in_network),
      w: candidate.moop_in_network < current.moop_in_network,
    },
    {
      l: 'Part D Ded.',
      a: `$${current.drug_deductible ?? 0}`,
      b: `$${candidate.drug_deductible ?? 0}`,
      w: (candidate.drug_deductible ?? 0) <= (current.drug_deductible ?? 0),
    },
    { l: 'Dental', a: cur.dental, b: cand.dental },
    { l: 'Dental Max', a: cur.dentalMax, b: cand.dentalMax },
    { l: 'Vision', a: cur.vision, b: cand.vision },
    { l: 'Vision $', a: cur.visionAllowance, b: cand.visionAllowance },
    { l: 'Hearing', a: cur.hearing, b: cand.hearing },
    {
      l: 'OTC',
      a: cur.otcText,
      b: cand.otcText,
      w: cand.otcMonthly > cur.otcMonthly,
    },
    { l: 'Meals', a: cur.meals, b: cand.meals },
    { l: 'Transport', a: cur.transport, b: cand.transport },
    { l: 'Fitness', a: cur.fitness, b: cand.fitness },
    {
      l: 'Stars',
      a: `${current.star_rating} ★`,
      b: `${candidate.star_rating} ★`,
      w: candidate.star_rating > current.star_rating,
    },
  ];

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        zIndex: 300,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white',
          borderRadius: 16,
          maxWidth: 640,
          width: '100%',
          maxHeight: '90vh',
          overflow: 'auto',
          boxShadow: '0 20px 80px rgba(0,0,0,0.3)',
        }}
      >
        <div
          style={{
            background: 'linear-gradient(135deg,#0d2f5e,#1a4a8a)',
            padding: '16px 20px',
            borderRadius: '16px 16px 0 0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 14,
          }}
        >
          <div>
            <div
              style={{
                color: '#83f0f9',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 1,
                textTransform: 'uppercase',
              }}
            >
              Benefits Comparison
            </div>
            <div
              style={{
                color: 'white',
                fontFamily: "'Fraunces', Georgia, serif",
                fontSize: 16,
                fontWeight: 700,
                marginTop: 3,
              }}
            >
              {current.carrier} vs {candidate.carrier}
            </div>
          </div>
          {savings != null && savings > 0 && (
            <div
              style={{
                background: '#059669',
                color: 'white',
                borderRadius: 7,
                padding: '6px 14px',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: 9, opacity: 0.85 }}>Annual Savings</div>
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 800,
                  fontFamily: "'Fraunces', Georgia, serif",
                }}
              >
                {fmt(savings)}
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'rgba(255,255,255,0.1)',
              border: 'none',
              color: 'white',
              fontSize: 16,
              width: 32,
              height: 32,
              borderRadius: 7,
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '150px 1fr 1fr',
            padding: '10px 16px',
            background: '#f8fafc',
            borderBottom: '1px solid #e2e8f0',
          }}
        >
          <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b' }}>
            Benefit
          </div>
          <div
            style={{
              textAlign: 'center',
              fontSize: 9,
              color: '#ef4444',
              fontWeight: 700,
              textTransform: 'uppercase',
            }}
          >
            Current — {current.plan_name}
          </div>
          <div
            style={{
              textAlign: 'center',
              fontSize: 9,
              color: '#059669',
              fontWeight: 700,
              textTransform: 'uppercase',
            }}
          >
            {candidate.plan_name}
          </div>
        </div>

        {rows.map((r, i) => (
          <div
            key={r.l}
            style={{
              display: 'grid',
              gridTemplateColumns: '150px 1fr 1fr',
              padding: '8px 16px',
              background: i % 2 === 0 ? 'white' : '#fafbfc',
              borderBottom: '1px solid rgba(13,47,94,0.03)',
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 600, color: '#475569' }}>
              {r.l}
            </div>
            <div style={{ textAlign: 'center', fontSize: 11, color: '#94a3b8' }}>
              {r.a}
            </div>
            <div
              style={{
                textAlign: 'center',
                fontSize: 11,
                fontWeight: r.w ? 700 : 500,
                color: r.w ? '#059669' : '#0d2f5e',
                background: r.w ? 'rgba(5,150,105,0.04)' : 'transparent',
                borderRadius: 3,
                padding: '1px 0',
              }}
            >
              {r.b}
            </div>
          </div>
        ))}
        <div style={{ padding: 16, textAlign: 'center' }}>
          <button type="button" onClick={onClose} style={PRI_BTN}>
            Back to Plans
          </button>
        </div>
      </div>
    </div>
  );
}
