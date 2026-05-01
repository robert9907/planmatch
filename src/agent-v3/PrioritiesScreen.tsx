// PrioritiesScreen — agent-v3 screen 4.
//
// Eight toggle buttons that capture what the client cares about. Three
// are pre-toggled to mirror the spec's "common starting point". The
// selected keys are passed up to the shell as `userPriorities` (a
// string[] consumed by usePlanBrain.computeExtrasValue) which doubles
// the extras axis for any benefit the user named.
//
// Two of the toggles ("low_rx" and "low_premium") aren't extra keys —
// they map to weight-profile overrides instead. The shell handles that
// translation; this screen just holds the boolean grid.

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
  | 'transportation';

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
];

interface Props {
  selected: PriorityKey[];
  onToggle: (key: PriorityKey) => void;
  onNext: () => void;
  onBack: () => void;
}

export function PrioritiesScreen({ selected, onToggle, onNext, onBack }: Props) {
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
      <Nav onBack={onBack} onNext={onNext} nextLabel="Show All Plans →" />
    </Container>
  );
}
