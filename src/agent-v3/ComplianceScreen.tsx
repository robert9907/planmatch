// ComplianceScreen — agent-v3 screen 7.
//
// Reads the canonical 16-item set from src/lib/compliance.ts:
//   • 3 verbatim disclaimers (TPMO, call recording, SOA) — confirmed
//     earlier on DisclaimersScreen (screen 2). This screen shows them
//     as a read-only status row so the broker can see complete
//     compliance picture; the SunFire gate still requires all 3.
//   • 13 discussion-topic checkboxes across 6 sections — checkbox
//     writes to useSession.complianceChecked. 2 items flagged
//     "NEW 2026" per CMS marketing rules (LIS/MSP eligibility,
//     Medigap GI rights).
//
// HealthSherpa Enrollment Gate is locked until ALL 16 items are
// confirmed. The gate's "Open HealthSherpa" CTA shares intent with
// EnrollScreen's final CTA — it advances the screen and opens the
// HealthSherpa Medicare intake in a new tab so the broker can co-pilot
// the application while the audit trail finishes saving.

import type { CSSProperties } from 'react';
import { useSession } from '@/hooks/useSession';
import {
  DISCLAIMERS,
  SECTIONS,
  totalComplianceItems,
} from '@/lib/compliance';
import { Container, Nav } from './atoms';
import { useHealthSherpaEnroll } from './lib/useHealthSherpaEnroll';

interface Props {
  onBack: () => void;
  onNext: () => void;
}

export function ComplianceScreen({ onBack, onNext }: Props) {
  const checked = useSession((s) => s.complianceChecked);
  const confirmed = useSession((s) => s.disclaimersConfirmed);
  const toggleItem = useSession((s) => s.toggleComplianceItem);
  const client = useSession((s) => s.client);
  const enroll = useHealthSherpaEnroll();

  const total = totalComplianceItems();
  const done = new Set(checked).size + new Set(confirmed).size;
  const allDone = done >= total;
  const disclaimersDone = DISCLAIMERS.filter((d) => confirmed.includes(d.id)).length;
  const disclaimersAllDone = disclaimersDone >= DISCLAIMERS.length;

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
            CMS Compliance Checklist
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
            Finish this before enrolling
          </div>
          <div style={{ color: '#64748b', fontSize: 11, marginTop: 3 }}>
            {total} items · {DISCLAIMERS.length} verbatim + {total - DISCLAIMERS.length}{' '}
            discussion topics
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

      {/* Verbatim disclaimers — confirmed earlier on the Disclaimers
          screen (screen 2). Show as read-only status so the broker
          can see the complete compliance picture; the gate below
          still requires all 3 confirmed before SunFire unlocks. */}
      <div
        style={{
          background: disclaimersAllDone ? 'rgba(5,150,105,0.04)' : '#fffbeb',
          border: disclaimersAllDone
            ? '1px solid rgba(5,150,105,0.18)'
            : '1px solid rgba(245,158,11,0.3)',
          borderRadius: 10,
          padding: '12px 16px',
          marginBottom: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: '#475569',
              letterSpacing: 1,
              textTransform: 'uppercase',
            }}
          >
            Required Disclaimers
          </div>
          <div style={{ fontSize: 12, color: '#0d2f5e', marginTop: 2 }}>
            {disclaimersAllDone
              ? 'All 3 verbatim disclaimers confirmed on the Disclaimers screen.'
              : `${DISCLAIMERS.length - disclaimersDone} disclaimer${
                  DISCLAIMERS.length - disclaimersDone === 1 ? '' : 's'
                } still need to be confirmed — go back to the Disclaimers screen.`}
          </div>
        </div>
        <div
          style={{
            fontFamily: "'Fraunces', Georgia, serif",
            fontSize: 20,
            fontWeight: 800,
            color: disclaimersAllDone ? '#059669' : '#d97706',
          }}
        >
          {disclaimersDone}/{DISCLAIMERS.length}
        </div>
      </div>

      {/* Discussion-topic sections */}
      {SECTIONS.map((sec) => {
        const sectionDone = sec.items.filter((it) => checked.includes(it.id)).length;
        return (
          <div key={sec.key} style={{ marginBottom: 16 }}>
            <SectionHeader
              title={sec.title}
              done={sectionDone}
              total={sec.items.length}
            />
            {sec.items.map((it) => {
              const isDone = checked.includes(it.id);
              return (
                <div key={it.id} style={ROW_STYLE(isDone)}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <button
                      type="button"
                      onClick={() => toggleItem(it.id)}
                      style={CHECKBOX_STYLE(isDone, false)}
                    >
                      {isDone ? '✓' : ''}
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
                            fontSize: 13,
                            color: isDone ? '#059669' : '#0d2f5e',
                          }}
                        >
                          {it.label}
                        </span>
                        {it.new2026 && (
                          <span
                            style={{
                              background: '#dbeafe',
                              color: '#1e40af',
                              fontSize: 8,
                              fontWeight: 700,
                              padding: '1px 5px',
                              borderRadius: 3,
                            }}
                          >
                            NEW 2026
                          </span>
                        )}
                      </div>
                      {it.detail && (
                        <div style={{ color: '#64748b', fontSize: 10, marginTop: 1 }}>
                          {it.detail}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      <div
        style={{
          background: allDone ? 'rgba(5,150,105,0.04)' : '#fffbeb',
          border: allDone ? '2px solid #059669' : '2px solid #f59e0b',
          borderRadius: 11,
          padding: '16px 20px',
          marginTop: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: allDone ? '#059669' : '#d97706',
              letterSpacing: 1,
              textTransform: 'uppercase',
            }}
          >
            HealthSherpa Enrollment Gate
          </div>
          <div
            style={{
              fontWeight: 700,
              fontSize: 14,
              color: '#0d2f5e',
              marginTop: 3,
            }}
          >
            {allDone
              ? 'All items confirmed — ready to enroll.'
              : `${total - done} items left before Enroll Now unlocks.`}
          </div>
          <div style={{ fontSize: 10, color: '#64748b', marginTop: 1 }}>
            Rob Simm · NC #10447418 · NPN 10447418
          </div>
        </div>
        <button
          type="button"
          onClick={
            allDone && enroll.status !== 'syncing'
              ? () => {
                  void enroll.openEnrollment({ client });
                  onNext();
                }
              : undefined
          }
          disabled={!allDone || enroll.status === 'syncing'}
          style={{
            background: allDone
              ? 'linear-gradient(135deg, #059669, #047857)'
              : '#e2e8f0',
            color: allDone ? 'white' : '#94a3b8',
            border: 'none',
            borderRadius: 8,
            padding: '11px 22px',
            fontSize: 13,
            fontWeight: 700,
            cursor:
              allDone && enroll.status !== 'syncing' ? 'pointer' : 'default',
            transition: 'all 0.3s',
          }}
        >
          {enroll.status === 'syncing'
            ? 'Connecting to HealthSherpa…'
            : 'Open HealthSherpa →'}
        </button>
      </div>

      <Nav onBack={onBack} />
    </Container>
  );
}

function SectionHeader({
  title,
  sub,
  done,
  total,
}: {
  title: string;
  sub?: string;
  done: number;
  total: number;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        marginBottom: 6,
        gap: 8,
      }}
    >
      <div>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: '#475569',
            letterSpacing: 1,
            textTransform: 'uppercase',
          }}
        >
          {title}
        </span>
        {sub && (
          <span style={{ fontSize: 10, color: '#94a3b8', marginLeft: 6 }}>
            {sub}
          </span>
        )}
      </div>
      <span style={{ fontSize: 9, color: '#94a3b8' }}>
        {done}/{total}
      </span>
    </div>
  );
}

const ROW_STYLE = (done: boolean): CSSProperties => ({
  background: 'white',
  borderRadius: 9,
  padding: '12px 16px',
  marginBottom: 5,
  border: done
    ? '1px solid rgba(5,150,105,0.15)'
    : '1px solid rgba(13,47,94,0.06)',
  boxShadow: '0 1px 3px rgba(13,47,94,0.03)',
});

const CHECKBOX_STYLE = (done: boolean, verbatim: boolean): CSSProperties => ({
  width: 22,
  height: 22,
  borderRadius: 5,
  flexShrink: 0,
  marginTop: 1,
  background: done ? '#059669' : verbatim ? '#f59e0b' : 'white',
  border: done
    ? 'none'
    : verbatim
      ? '2px solid #f59e0b'
      : '2px solid #cbd5e1',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'white',
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
  transition: 'all 0.2s',
});
