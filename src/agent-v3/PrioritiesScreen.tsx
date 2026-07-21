// PrioritiesScreen — agent-v3 screen 4.
//
// Ranked pick-3 for extras. The selected keys ride to the consumer
// brain's Gate 3 (see ~/Code/plan-match/packages/brain/src/plan-brain.ts
// — post-2026-07 semantics): P1 hard-eliminates, P2 and P3 contribute
// to gate3Score. Insertion order determines slot: first tap = P1.
// Reorder buttons on the priority-order panel let the broker adjust
// after the fact.

import { useEffect, useRef, useState } from 'react';
import { Container, Header, Nav } from './atoms';

const MAX_PICKS = 3;
const PRIORITY_LABELS: Record<1 | 2 | 3, { badge: string; long: string }> = {
  1: { badge: '1st', long: 'Most Important' },
  2: { badge: '2nd', long: 'Important' },
  3: { badge: '3rd', long: 'Nice to Have' },
};
// Solid / medium / light seafoam per priority slot.
const PRIORITY_BG: Record<number, string> = {
  0: '#83f0f9',
  1: '#a8f4fb',
  2: '#d1faff',
};

export interface PriorityToggle {
  key: PriorityKey;
  label: string;
  icon: string;
}

export type PriorityKey =
  | 'dental'
  | 'vision'
  | 'hearing'
  | 'otc'
  | 'fitness'
  | 'transportation'
  | 'telehealth'
  | 'healthy_foods'
  | 'partb_giveback';

export const PRIORITY_OPTIONS: PriorityToggle[] = [
  { key: 'dental',         label: 'Dental',           icon: '🦷' },
  { key: 'vision',         label: 'Vision',           icon: '👁' },
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
  const atCap = selected.length >= MAX_PICKS;

  // Inline cap hint — appears when broker taps a 4th option. Auto-
  // clears after 3.5s or when a selection is removed. Not a modal.
  const [showCapHint, setShowCapHint] = useState(false);
  const hintTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (hintTimerRef.current != null) window.clearTimeout(hintTimerRef.current);
    },
    [],
  );
  useEffect(() => {
    if (!atCap && showCapHint) setShowCapHint(false);
  }, [atCap, showCapHint]);
  function flashHint() {
    setShowCapHint(true);
    if (hintTimerRef.current != null) window.clearTimeout(hintTimerRef.current);
    hintTimerRef.current = window.setTimeout(() => setShowCapHint(false), 3500);
  }
  function attemptToggle(key: PriorityKey) {
    const isAdding = selected.indexOf(key) < 0;
    if (isAdding && atCap) {
      flashHint();
      return;
    }
    onToggle(key);
  }

  return (
    <Container>
      <Header
        title="What benefits matter most to you?"
        sub={`Pick your top ${MAX_PICKS} in order of importance. We'll prioritize plans that match.`}
      />
      <div style={{ fontSize: 12, color: 'rgba(13,47,94,0.6)', marginBottom: 8, textAlign: 'right' }}>
        {selected.length} of {MAX_PICKS} selected
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 8,
        }}
      >
        {PRIORITY_OPTIONS.map((opt) => {
          const priorityIdx = selected.indexOf(opt.key);
          const on = priorityIdx >= 0;
          const dim = !on && atCap;
          const meta = on && priorityIdx < 3 ? PRIORITY_LABELS[(priorityIdx + 1) as 1 | 2 | 3] : null;
          const badgeBg = PRIORITY_BG[priorityIdx] ?? '#83f0f9';
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => attemptToggle(opt.key)}
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
                flexDirection: 'column',
                gap: 6,
                transition: 'all 0.2s',
                opacity: dim ? 0.45 : 1,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
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
                {meta ? (
                  <span
                    aria-label={`Priority ${meta.badge}`}
                    style={{
                      marginLeft: 'auto',
                      minWidth: 28,
                      height: 20,
                      padding: '0 6px',
                      borderRadius: 999,
                      background: badgeBg,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#0d2f5e',
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: '0.02em',
                    }}
                  >
                    {meta.badge}
                  </span>
                ) : on ? (
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
                ) : null}
              </div>
              {meta && (
                <span
                  style={{
                    alignSelf: 'flex-start',
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: badgeBg,
                    color: '#0d2f5e',
                  }}
                >
                  {meta.long}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {showCapHint && (
        <div
          role="status"
          style={{
            marginTop: 10,
            padding: '8px 12px',
            borderRadius: 8,
            background: '#fff7ed',
            border: '1px solid #fdba74',
            color: '#7c2d12',
            fontSize: 12,
            fontStyle: 'italic',
          }}
        >
          You can only pick {MAX_PICKS} — tap one to remove it first.
        </div>
      )}

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
            1st is the hard gate — a plan must offer it. 2nd and 3rd break ties between similar-cost plans.
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
