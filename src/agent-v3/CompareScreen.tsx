// CompareScreen — agent-v3 screen 6.
//
// Side-by-side benefits table: Current plan column (red) on the left,
// then the brain pick (★ Top) plus every kept plan from the swipe
// stack. The bottom "Est. Annual" row sums premium × 12 + the live
// annual drug cost from useDrugCosts; per-finalist column also shows
// the savings vs current when positive. Best-per-row cells get a green
// tint to draw the eye.

import type { Plan } from '@/types/plans';
import { useSession } from '@/hooks/useSession';
import { Card, Container, Header, Nav, fmt } from './atoms';
import {
  annualEstimate,
  formatPcp,
  formatPremium,
  formatSpecialist,
  planDisplay,
} from './planDisplay';

interface Props {
  current: Plan | null;
  brainPick: Plan | null;
  kept: Plan[];
  annualDrugByPlanId: Record<string, number | null>;
  onBack: () => void;
  onNext: () => void;
}

export function CompareScreen({
  current,
  brainPick,
  kept,
  annualDrugByPlanId,
  onBack,
  onNext,
}: Props) {
  const finalists = [brainPick, ...kept].filter((p): p is Plan => !!p);
  // Provider in-network status by plan id, copied off the first
  // provider's networkStatus (matches what swipe + pinned cards show).
  const providers = useSession((s) => s.providers);
  const firstProv = providers[0] ?? null;
  const providerLabel = firstProv?.name?.split(' ').slice(0, 2).join(' ') ?? 'Doctor';
  const statusFor = (planId: string): 'in' | 'out' | 'unknown' => {
    if (!firstProv) return 'unknown';
    return (firstProv.networkStatus?.[planId] as 'in' | 'out' | 'unknown') ?? 'unknown';
  };

  if (finalists.length === 0) {
    return (
      <Container wide>
        <Header
          title="Your finalists — side by side"
          sub="Pick at least one plan in Swipe Mode first."
        />
        <Nav onBack={onBack} />
      </Container>
    );
  }

  // Each row: a label + a getter for the candidate plan + a string for
  // the current plan. Numeric rows include a number-extractor so we can
  // auto-highlight the best column.
  const rows: {
    l: string;
    g: (p: Plan) => string;
    c: string;
    n?: (p: Plan) => number | null;
    cn?: number | null;
  }[] = [
    {
      l: 'Premium',
      g: (p) => `${formatPremium(p)}/mo`,
      c: current ? `${formatPremium(current)}/mo` : '—',
      n: (p) => p.premium,
      cn: current?.premium ?? null,
    },
    {
      l: 'Annual Drugs',
      g: (p) => {
        const d = annualDrugByPlanId[p.id];
        return d == null ? '—' : `${fmt(d)}/yr`;
      },
      c: current && annualDrugByPlanId[current.id] != null
        ? `${fmt(annualDrugByPlanId[current.id]!)}/yr`
        : '—',
      n: (p) => annualDrugByPlanId[p.id] ?? null,
      cn: current ? annualDrugByPlanId[current.id] ?? null : null,
    },
    {
      l: 'PCP',
      g: (p) => formatPcp(p),
      c: current ? formatPcp(current) : '—',
    },
    {
      l: 'Specialist',
      g: (p) => formatSpecialist(p),
      c: current ? formatSpecialist(current) : '—',
    },
    {
      l: 'MOOP',
      g: (p) => fmt(p.moop_in_network),
      c: current ? fmt(current.moop_in_network) : '—',
      n: (p) => p.moop_in_network,
      cn: current?.moop_in_network ?? null,
    },
    {
      l: 'Part D Ded.',
      g: (p) => `$${p.drug_deductible ?? 0}`,
      c: current ? `$${current.drug_deductible ?? 0}` : '—',
    },
    {
      l: 'Dental',
      g: (p) => planDisplay(p).dentalMax,
      c: current ? planDisplay(current).dentalMax : '—',
    },
    {
      l: 'Vision',
      g: (p) => planDisplay(p).visionAllowance,
      c: current ? planDisplay(current).visionAllowance : '—',
    },
    {
      l: 'Hearing',
      g: (p) => planDisplay(p).hearing,
      c: current ? planDisplay(current).hearing : '—',
    },
    {
      l: 'OTC',
      g: (p) => planDisplay(p).otcText,
      c: current ? planDisplay(current).otcText : '—',
    },
    {
      l: providerLabel,
      g: (p) => statusToGlyph(statusFor(p.id)),
      c: current ? statusToGlyph(statusFor(current.id)) : '—',
    },
    {
      l: 'Stars',
      g: (p) => `${p.star_rating} ★`,
      c: current ? `${current.star_rating} ★` : '—',
      n: (p) => p.star_rating,
      cn: current?.star_rating ?? null,
    },
  ];

  const cols = `140px 1fr repeat(${finalists.length}, 1fr)`;

  return (
    <Container wide>
      <Header
        title="Your finalists — side by side"
        sub="Current plan vs your top options."
      />
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: cols,
            background: 'linear-gradient(135deg, #0d2f5e, #1a4a8a)',
          }}
        >
          <div style={{ padding: 12 }} />
          <div
            style={{
              padding: 12,
              borderLeft: '1px solid rgba(255,255,255,0.06)',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                fontSize: 8,
                color: 'rgba(255,255,255,0.35)',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: 1,
              }}
            >
              Current
            </div>
            <div style={{ color: '#ef4444', fontSize: 11, fontWeight: 700, marginTop: 2 }}>
              {current?.carrier ?? '—'}
            </div>
          </div>
          {finalists.map((p, i) => (
            <div
              key={p.id}
              style={{
                padding: 12,
                borderLeft: '1px solid rgba(255,255,255,0.06)',
                textAlign: 'center',
              }}
            >
              {i === 0 && brainPick && (
                <div
                  style={{
                    background: '#83f0f9',
                    color: '#0d2f5e',
                    fontSize: 8,
                    fontWeight: 800,
                    padding: '1px 5px',
                    borderRadius: 3,
                    display: 'inline-block',
                    marginBottom: 2,
                    letterSpacing: 1,
                    textTransform: 'uppercase',
                  }}
                >
                  ★ Top
                </div>
              )}
              <div
                style={{
                  color: 'rgba(255,255,255,0.5)',
                  fontSize: 9,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                }}
              >
                {p.carrier}
              </div>
              <div
                style={{
                  color: 'white',
                  fontSize: 10,
                  fontWeight: 700,
                  marginTop: 1,
                }}
              >
                {p.plan_name}
              </div>
            </div>
          ))}
        </div>

        {rows.map((r, i) => {
          const numericVals = r.n
            ? finalists.map(r.n).filter((v): v is number => v != null)
            : [];
          // For "stars" we want the maximum (best is high); other numeric
          // rows treat lower as better. Detect by row label.
          const higherIsBetter = r.l === 'Stars';
          let bestVal: number | null = null;
          if (numericVals.length > 0) {
            bestVal = higherIsBetter ? Math.max(...numericVals) : Math.min(...numericVals);
          }
          return (
            <div
              key={r.l}
              style={{
                display: 'grid',
                gridTemplateColumns: cols,
                background: i % 2 === 0 ? '#f8fafc' : 'white',
                borderTop: '1px solid rgba(13,47,94,0.03)',
              }}
            >
              <div style={{ padding: '9px 12px', fontSize: 11, fontWeight: 600, color: '#475569' }}>
                {r.l}
              </div>
              <div
                style={{
                  padding: '9px 12px',
                  textAlign: 'center',
                  fontSize: 11,
                  color: '#94a3b8',
                  borderLeft: '1px solid rgba(13,47,94,0.03)',
                }}
              >
                {r.c}
              </div>
              {finalists.map((p) => {
                const num = r.n ? r.n(p) : null;
                const isBest =
                  bestVal != null &&
                  num != null &&
                  num === bestVal &&
                  (r.cn == null || (higherIsBetter ? num > r.cn : num < r.cn));
                return (
                  <div
                    key={p.id}
                    style={{
                      padding: '9px 12px',
                      textAlign: 'center',
                      fontSize: 11,
                      fontWeight: isBest ? 700 : 500,
                      color: isBest ? '#059669' : '#0d2f5e',
                      borderLeft: '1px solid rgba(13,47,94,0.03)',
                      background: isBest ? 'rgba(5,150,105,0.04)' : 'transparent',
                    }}
                  >
                    {r.g(p)}
                  </div>
                );
              })}
            </div>
          );
        })}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: cols,
            background:
              'linear-gradient(135deg, rgba(13,47,94,0.04), rgba(131,240,249,0.06))',
            borderTop: '2px solid #0d2f5e',
          }}
        >
          <div style={{ padding: 14, fontWeight: 800, fontSize: 12, color: '#0d2f5e' }}>
            Est. Annual
          </div>
          <div
            style={{
              padding: 14,
              textAlign: 'center',
              fontWeight: 700,
              fontSize: 14,
              color: '#ef4444',
              borderLeft: '1px solid rgba(13,47,94,0.06)',
            }}
          >
            {current
              ? (() => {
                  const t = annualEstimate(current, annualDrugByPlanId[current.id] ?? null).total;
                  return t != null ? fmt(t) : '—';
                })()
              : '—'}
          </div>
          {finalists.map((p) => {
            const t = annualEstimate(p, annualDrugByPlanId[p.id] ?? null).total;
            const ct = current
              ? annualEstimate(current, annualDrugByPlanId[current.id] ?? null).total
              : null;
            const savings = t != null && ct != null ? ct - t : null;
            return (
              <div
                key={p.id}
                style={{
                  padding: 14,
                  textAlign: 'center',
                  borderLeft: '1px solid rgba(13,47,94,0.06)',
                }}
              >
                <div
                  style={{
                    fontWeight: 800,
                    fontSize: 14,
                    color: '#0d2f5e',
                    fontFamily: "'Fraunces', Georgia, serif",
                  }}
                >
                  {t != null ? fmt(t) : '—'}
                </div>
                {savings != null && savings > 0 && (
                  <div
                    style={{
                      fontSize: 11,
                      color: '#059669',
                      fontWeight: 700,
                      marginTop: 2,
                    }}
                  >
                    Save {fmt(savings)}/yr
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
      <Nav onBack={onBack} onNext={onNext} nextLabel="CMS Compliance →" />
    </Container>
  );
}

function statusToGlyph(s: 'in' | 'out' | 'unknown'): string {
  if (s === 'in') return '✓';
  if (s === 'out') return '✕';
  return '?';
}
