// PrioritiesScreen — agent-v3 screen 4.
//
// Toggle buttons that capture what the client cares about. The
// selected keys are passed up to the shell as `userPriorities` (a
// string[] forwarded to /api/library/rank-plans). The consumer-repo
// brain (Gate 3) uses these as hard eliminators — pick order drives
// the relax-from-bottom fallback when no county plans satisfy every
// pick. See ~/Code/plan-match/packages/brain/src/plan-brain.ts.
//
// Two of the toggles ("low_rx" and "low_premium") aren't extras keys —
// they're weight-profile overrides handled in AgentV3App. The shell
// strips them out of userPriorities before the library call.

import { Container, Header, Nav } from './atoms';

export interface PriorityToggle {
  key: PriorityKey;
  label: string;
  icon: string;
}

export type PriorityKey =
  | 'low_rx'
  | 'keep_doctor'
  | 'dental'
  | 'vision'
  | 'low_premium'
  | 'hearing'
  | 'otc'
  | 'fitness'
  | 'transportation'
  | 'telehealth'
  | 'healthy_foods'
  | 'partb_giveback';

export const PRIORITY_OPTIONS: PriorityToggle[] = [
  { key: 'low_rx',         label: 'Low Rx costs',     icon: '💊' },
  { key: 'keep_doctor',    label: 'Keep my doctor',   icon: '🩺' },
  { key: 'dental',         label: 'Dental',           icon: '🦷' },
  { key: 'vision',         label: 'Vision',           icon: '👁' },
  { key: 'low_premium',    label: 'Low premium',      icon: '💰' },
  { key: 'hearing',        label: 'Hearing aids',     icon: '👂' },
  { key: 'otc',            label: 'OTC allowance',    icon: '🛒' },
  { key: 'fitness',        label: 'Gym / Fitness',    icon: '🏋️' },
  { key: 'transportation', label: 'Transportation',   icon: '🚗' },
  { key: 'telehealth',     label: 'Telehealth',       icon: '📺' },
  { key: 'healthy_foods',  label: 'Healthy foods',    icon: '🥦' },
  { key: 'partb_giveback', label: 'Part B giveback',  icon: '↩️' },
];

interface Props {
  selected: PriorityKey[];
  onToggle: (key: PriorityKey) => void;
  onMove?: (key: PriorityKey, direction: 'up' | 'down') => void;
  onNext: () => void;
  onBack: () => void;
}

export function PrioritiesScreen({ selected, onToggle, onMove, onNext, onBack }: Props) {
  const set = new Set(selected);
  return (
    <Container>
      <Header
        title="What matters most to you?"
        sub="We'll weight your results based on your priorities."
      />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 8,
        }}
      >
        {PRIORITY_OPTIONS.map((opt) => {
          const on = set.has(opt.key);
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => onToggle(opt.key)}
              style={{
                background: on
                  ? 'linear-gradient(135deg, #0d2f5e, #1a4a8a)'
                  : 'white',
                border: on
                  ? '2px solid #83f0f9'
                  : '2px solid rgba(13,47,94,0.06)',
                borderRadius: 10,
                padding: '14px 12px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                transition: 'all 0.2s',
              }}
            >
              <span style={{ fontSize: 20 }}>{opt.icon}</span>
              <span
                style={{
                  fontWeight: 600,
                  fontSize: 13,
                  color: on ? '#83f0f9' : '#0d2f5e',
                }}
              >
                {opt.label}
              </span>
              {on && (
                <span
                  style={{
                    marginLeft: 'auto',
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    background: '#83f0f9',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#0d2f5e',
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  ✓
                </span>
              )}
            </button>
          );
        })}
      </div>

      {selected.length > 0 && onMove && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            border: '2px solid rgba(13,47,94,0.08)',
            borderRadius: 10,
            background: 'white',
          }}
        >
          <div
            style={{
              fontSize: 11,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              fontWeight: 700,
              color: '#0d2f5e',
              marginBottom: 6,
            }}
          >
            Priority order
          </div>
          <div style={{ fontSize: 12, color: 'rgba(13,47,94,0.6)', marginBottom: 8 }}>
            Brain relaxes the bottom pick first if no county plans match every selected priority.
          </div>
          <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {selected.map((key, idx) => {
              const opt = PRIORITY_OPTIONS.find((o) => o.key === key);
              const isFirst = idx === 0;
              const isLast = idx === selected.length - 1;
              return (
                <li
                  key={key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 10px',
                    background: 'rgba(131,240,249,0.12)',
                    border: '1px solid #83f0f9',
                    borderRadius: 8,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      background: '#0d2f5e',
                      color: '#83f0f9',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11,
                      fontWeight: 700,
                      flexShrink: 0,
                    }}
                  >
                    {idx + 1}
                  </span>
                  <span style={{ flex: 1, fontSize: 13, color: '#0d2f5e', fontWeight: 600 }}>
                    {opt?.icon ?? ''} {opt?.label ?? key}
                  </span>
                  <button
                    type="button"
                    aria-label={`Move ${opt?.label ?? key} up`}
                    disabled={isFirst}
                    onClick={() => onMove(key, 'up')}
                    style={{
                      background: 'transparent',
                      border: '1px solid rgba(13,47,94,0.2)',
                      borderRadius: 4,
                      padding: '2px 6px',
                      cursor: isFirst ? 'not-allowed' : 'pointer',
                      opacity: isFirst ? 0.4 : 1,
                      color: '#0d2f5e',
                      fontSize: 11,
                    }}
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${opt?.label ?? key} down`}
                    disabled={isLast}
                    onClick={() => onMove(key, 'down')}
                    style={{
                      background: 'transparent',
                      border: '1px solid rgba(13,47,94,0.2)',
                      borderRadius: 4,
                      padding: '2px 6px',
                      cursor: isLast ? 'not-allowed' : 'pointer',
                      opacity: isLast ? 0.4 : 1,
                      color: '#0d2f5e',
                      fontSize: 11,
                    }}
                  >
                    ▼
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      <Nav onBack={onBack} onNext={onNext} nextLabel="Show All Plans →" />
    </Container>
  );
}
