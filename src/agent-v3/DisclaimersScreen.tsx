// DisclaimersScreen — agent-v3 screen 2.
//
// Sits between Client and Meds so the broker reads the three CMS-
// required verbatim disclaimers BEFORE any plan discussion:
//
//   1. TPMO disclaimer  — required within the first minute of the call,
//      includes live ORG_COUNT + PLAN_COUNT derived from eligiblePlans.
//   2. Call recording notice — required at call start, before any plan
//      discussion.
//   3. Scope of Appointment confirmation — required before discussing
//      specific plans; SOA form must already be on file.
//
// Each disclaimer must be confirmed (via "I read this verbatim") before
// Continue is enabled. Confirmation writes to useSession.disclaimersConfirmed
// so the downstream ComplianceScreen counts it toward the 16-item gate.
//
// The 13 discussion-topic checkboxes from the canonical compliance set
// stay on ComplianceScreen (screen 7) — those are reviewed near the end
// of the call before SunFire enrollment.

import type { CSSProperties } from 'react';
import type { Plan } from '@/types/plans';
import { useSession } from '@/hooks/useSession';
import { DISCLAIMERS, renderDisclaimerBody } from '@/lib/compliance';
import { Container, Nav } from './atoms';

interface Props {
  eligiblePlans: Plan[];
  onBack: () => void;
  onNext: () => void;
}

export function DisclaimersScreen({ eligiblePlans, onBack, onNext }: Props) {
  const planType = useSession((s) => s.client.planType);
  const confirmed = useSession((s) => s.disclaimersConfirmed);
  const confirmDisclaimer = useSession((s) => s.confirmDisclaimer);

  // TPMO live counts. ORG_COUNT = unique carriers; PLAN_COUNT = total
  // plans in the broker's catalog for this client's county+state. Both
  // collapse to 1 when eligiblePlans hasn't loaded yet — the verbatim
  // text still reads correctly, just understates the catalog. By the
  // time the broker is reading the TPMO aloud the plan list has
  // landed.
  const orgCount =
    eligiblePlans.length > 0
      ? new Set(eligiblePlans.map((p) => p.carrier)).size
      : 1;
  const planCount = eligiblePlans.length > 0 ? eligiblePlans.length : 1;

  const total = DISCLAIMERS.length;
  const done = DISCLAIMERS.filter((d) => confirmed.includes(d.id)).length;
  const allDone = done >= total;

  return (
    <Container>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 20,
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: '#64748b',
              letterSpacing: 1,
              textTransform: 'uppercase',
            }}
          >
            Pre-Call Disclaimers
          </div>
          <div
            style={{
              fontFamily: "'Fraunces', Georgia, serif",
              fontSize: 22,
              fontWeight: 700,
              color: '#0d2f5e',
              marginTop: 3,
            }}
          >
            Read these verbatim before discussing plans
          </div>
          <div style={{ color: '#64748b', fontSize: 11, marginTop: 3 }}>
            CMS requires all three to land within the first minute of the call,
            in this order, with the exact wording shown.
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div
            style={{
              fontFamily: "'Fraunces', Georgia, serif",
              fontSize: 32,
              fontWeight: 800,
              color: '#0d2f5e',
            }}
          >
            {done}
            <span style={{ fontSize: 16, color: '#94a3b8' }}>/{total}</span>
          </div>
          <div
            style={{
              width: 100,
              height: 4,
              borderRadius: 2,
              background: '#e2e8f0',
              marginTop: 4,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${(done / total) * 100}%`,
                height: '100%',
                background: allDone ? '#34d399' : '#0d2f5e',
                borderRadius: 2,
                transition: 'width 0.3s',
              }}
            />
          </div>
        </div>
      </div>

      {DISCLAIMERS.map((def) => {
        const isDone = confirmed.includes(def.id);
        const body = renderDisclaimerBody(def, { orgCount, planCount, planType });
        return (
          <div key={def.id} style={ROW_STYLE(isDone)}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <button
                type="button"
                onClick={() => confirmDisclaimer(def.id)}
                style={CHECKBOX_STYLE(isDone)}
                aria-label={`Confirm ${def.title}`}
              >
                {isDone ? '✓' : '!'}
              </button>
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    flexWrap: 'wrap',
                  }}
                >
                  <span
                    style={{
                      fontWeight: 700,
                      fontSize: 14,
                      color: isDone ? '#059669' : '#0d2f5e',
                    }}
                  >
                    {def.title}
                  </span>
                  <span
                    style={{
                      background: '#fef3c7',
                      color: '#92400e',
                      fontSize: 8,
                      fontWeight: 700,
                      padding: '1px 5px',
                      borderRadius: 3,
                      letterSpacing: 0.5,
                      textTransform: 'uppercase',
                    }}
                  >
                    Verbatim Required
                  </span>
                </div>
                <div style={{ color: '#64748b', fontSize: 10, marginTop: 1 }}>
                  {def.when}
                </div>
                <div
                  style={{
                    background: 'rgba(13,47,94,0.03)',
                    borderLeft: '3px solid #0d2f5e',
                    borderRadius: '0 7px 7px 0',
                    padding: '10px 14px',
                    marginTop: 8,
                    fontSize: 13,
                    color: '#1e293b',
                    lineHeight: 1.6,
                  }}
                >
                  {body}
                </div>
                {!isDone && (
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'flex-end',
                      marginTop: 8,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => confirmDisclaimer(def.id)}
                      style={{
                        background: '#0d2f5e',
                        color: 'white',
                        border: 'none',
                        borderRadius: 6,
                        padding: '7px 14px',
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      I read this verbatim
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}

      <Nav onBack={onBack} onNext={onNext} nextDisabled={!allDone} />
    </Container>
  );
}

const ROW_STYLE = (done: boolean): CSSProperties => ({
  background: 'white',
  borderRadius: 10,
  padding: '14px 18px',
  marginBottom: 8,
  border: done
    ? '1px solid rgba(5,150,105,0.18)'
    : '1px solid rgba(245,158,11,0.25)',
  boxShadow: '0 1px 3px rgba(13,47,94,0.04)',
});

const CHECKBOX_STYLE = (done: boolean): CSSProperties => ({
  width: 24,
  height: 24,
  borderRadius: 6,
  flexShrink: 0,
  marginTop: 2,
  background: done ? '#059669' : '#f59e0b',
  border: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'white',
  fontSize: 14,
  fontWeight: 700,
  cursor: 'pointer',
  transition: 'all 0.2s',
});
