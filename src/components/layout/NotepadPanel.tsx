import { useEffect, useMemo, useRef, useState } from 'react';
import type { NoteType } from '@/types/session';
import { useSession, selectNotes } from '@/hooks/useSession';

interface NotepadPanelProps {
  open: boolean;
  onClose: () => void;
}

interface TypeMeta {
  key: NoteType;
  label: string;
  hint: string;
  bg: string;
  fg: string;
  border: string;
}

const NOTE_TYPES: TypeMeta[] = [
  { key: 'general',    label: 'General',    hint: 'G', bg: 'var(--w2)',  fg: 'var(--ink)', border: 'var(--w3)' },
  { key: 'concern',    label: 'Concern',    hint: 'C', bg: 'var(--rt)',  fg: 'var(--red)', border: 'var(--red)' },
  { key: 'preference', label: 'Preference', hint: 'P', bg: 'var(--sl)',  fg: 'var(--sage)', border: 'var(--sage)' },
  { key: 'followup',   label: 'Follow-up',  hint: 'F', bg: 'var(--at)',  fg: 'var(--amb)', border: 'var(--amb)' },
  { key: 'question',   label: 'Question',   hint: 'Q', bg: 'var(--bt)',  fg: 'var(--blue)', border: 'var(--blue)' },
  { key: 'objection',  label: 'Objection',  hint: 'O', bg: 'var(--rt)',  fg: 'var(--red)', border: 'var(--red)' },
  { key: 'decision',   label: 'Decision',   hint: 'D', bg: 'var(--tl)',  fg: 'var(--teal)', border: 'var(--teal)' },
  { key: 'compliance', label: 'Compliance', hint: 'X', bg: 'var(--pt)',  fg: 'var(--pur)', border: 'var(--pur)' },
  { key: 'medical',    label: 'Medical',    hint: 'M', bg: 'var(--nvlt)', fg: 'var(--navy)', border: 'var(--nvbd)' },
  { key: 'financial',  label: 'Financial',  hint: '$', bg: 'var(--tl)',  fg: 'var(--teal)', border: 'var(--teal)' },
];

const TYPE_LOOKUP = Object.fromEntries(NOTE_TYPES.map((t) => [t.key, t])) as Record<NoteType, TypeMeta>;

interface CarrierOpt {
  key: string;
  label: string;
  // Expanded name shown as a tooltip — useful when the short label is an
  // abbreviation (UHC, BCBS). The `key` is what gets persisted on the note.
  full?: string;
}

const CARRIERS: CarrierOpt[] = [
  { key: 'UHC',             label: 'UHC',             full: 'United Healthcare' },
  { key: 'Humana',          label: 'Humana' },
  { key: 'Aetna',           label: 'Aetna' },
  { key: 'Cigna',           label: 'Cigna' },
  { key: 'WellCare',        label: 'WellCare' },
  { key: 'BCBS',            label: 'BCBS',            full: 'Blue Cross Blue Shield' },
  { key: 'Mutual of Omaha', label: 'Mutual of Omaha' },
  { key: 'Devoted',         label: 'Devoted' },
  { key: 'Centene',         label: 'Centene' },
  { key: 'Other',           label: 'Other' },
];

interface ScenarioDef {
  label: string;
  // When a carrier is selected and its key is in this array, the scenario
  // gets visually prioritized above scenarios that don't list the carrier.
  // Empty/omitted = applies to all carriers (the current default for every
  // scenario — carrier-specific filtering is future work).
  carriers?: readonly string[];
}

// Kept here as a const so this module owns the scenario vocabulary. When we
// want agent-editable scenarios later, lift this into Supabase or another
// store with the same shape.
const SCENARIOS: ScenarioDef[] = [
  { label: 'High cost of medications' },
  { label: 'Losing Medicaid / redetermination' },
  { label: 'Doctor left network' },
  { label: 'Moved to new area' },
  { label: 'Part B premium reduction issue' },
  { label: 'Special Enrollment Period' },
  { label: 'Annual review / plan comparison' },
  { label: 'Benefits not as described' },
  { label: 'Dual eligible / D-SNP opportunity' },
  { label: 'Prescription not covered' },
  { label: 'New to Medicare' },
  { label: 'Turning 65' },
];

export function NotepadPanel({ open, onClose }: NotepadPanelProps) {
  const notes = useSession(selectNotes);
  const addNote = useSession((s) => s.addNote);
  const removeNote = useSession((s) => s.removeNote);

  const [selectedType, setSelectedType] = useState<NoteType>('general');
  // Sticky across submits so an agent can batch-tag a run of notes for one
  // carrier. Cleared only by re-clicking the active carrier or picking another.
  const [selectedCarrier, setSelectedCarrier] = useState<string | null>(null);
  // Cleared on submit so each note gets its own scenario context.
  const [selectedScenario, setSelectedScenario] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const orderedScenarios = useMemo(() => {
    if (!selectedCarrier) {
      return SCENARIOS.map((s, i) => ({ ...s, relevant: false, order: i }));
    }
    return SCENARIOS
      .map((s, i) => ({
        ...s,
        relevant: !!s.carriers?.includes(selectedCarrier),
        order: i,
      }))
      .sort((a, b) => {
        if (a.relevant !== b.relevant) return a.relevant ? -1 : 1;
        return a.order - b.order;
      });
  }, [selectedCarrier]);

  const firstNonRelevantIndex = selectedCarrier
    ? orderedScenarios.findIndex((s) => !s.relevant)
    : -1;
  // Divider only shows when both a relevant bucket and a non-relevant bucket
  // exist. With today's empty `carriers` arrays, nothing is ever relevant,
  // so the divider stays hidden until a scenario declares a carrier.
  const showDivider =
    firstNonRelevantIndex > 0 && firstNonRelevantIndex < orderedScenarios.length;

  function toggleCarrier(key: string) {
    setSelectedCarrier((prev) => (prev === key ? null : key));
  }

  function applyScenario(label: string) {
    setDraft((prev) => (prev.trim() ? `${prev}\n${label}` : label));
    setSelectedScenario(label);
    inputRef.current?.focus();
  }

  function submit() {
    if (!draft.trim()) return;
    addNote(selectedType, draft, {
      carrier: selectedCarrier ?? undefined,
      scenario: selectedScenario ?? undefined,
    });
    setDraft('');
    setSelectedScenario(null);
  }

  const sectionHeading = {
    color: 'var(--i3)',
    fontSize: 10,
    letterSpacing: '0.08em',
  } as const;

  return (
    <aside
      aria-hidden={!open}
      className="flex flex-col border-l shadow-xl"
      style={{
        width: 310,
        height: '100%',
        background: 'var(--wh)',
        borderColor: 'var(--w2)',
        color: 'var(--ink)',
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 220ms cubic-bezier(.2,.8,.2,1)',
        flexShrink: 0,
      }}
    >
      <div
        className="flex items-center justify-between px-3 border-b"
        style={{ height: 44, borderColor: 'var(--w2)' }}
      >
        <div className="flex items-center gap-2">
          <span className="font-lora font-semibold" style={{ fontSize: 14 }}>
            Session Notepad
          </span>
          <span
            className="inline-flex items-center justify-center font-semibold"
            style={{
              minWidth: 20,
              height: 18,
              padding: '0 5px',
              borderRadius: 999,
              fontSize: 11,
              background: 'var(--sl)',
              color: 'var(--sage)',
              border: '1px solid var(--sm)',
            }}
          >
            {notes.length}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close notepad"
          className="pm-btn"
          style={{ height: 26, padding: '0 8px' }}
        >
          ✕
        </button>
      </div>

      <div className="px-3 pt-3">
        {/* Carrier row — single-select, sticky across submits */}
        <div className="uppercase font-semibold mb-1" style={sectionHeading}>
          Carrier
        </div>
        <div className="flex flex-wrap gap-1">
          {CARRIERS.map((c) => {
            const active = c.key === selectedCarrier;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => toggleCarrier(c.key)}
                title={c.full ?? c.label}
                aria-pressed={active}
                style={{
                  padding: '4px 8px',
                  borderRadius: 999,
                  fontSize: 10,
                  fontWeight: 600,
                  lineHeight: 1.1,
                  background: active ? 'var(--sl)' : 'var(--wh)',
                  color: active ? 'var(--sage)' : 'var(--i2)',
                  border: `1px solid ${active ? 'var(--sage)' : 'var(--w2)'}`,
                  cursor: 'pointer',
                }}
              >
                {c.label}
              </button>
            );
          })}
        </div>

        {/* Scenario cards — click to insert text into draft and tag the note */}
        <div className="uppercase font-semibold mb-1" style={{ ...sectionHeading, marginTop: 10 }}>
          Scenario
        </div>
        <div className="grid grid-cols-2 gap-1">
          {orderedScenarios.flatMap((s, i) => {
            const nodes = [] as React.ReactNode[];
            if (showDivider && i === firstNonRelevantIndex) {
              nodes.push(
                <div
                  key={`divider-${i}`}
                  style={{
                    gridColumn: '1 / -1',
                    height: 1,
                    background: 'var(--w2)',
                    margin: '4px 0',
                  }}
                />,
              );
            }
            const active = selectedScenario === s.label;
            nodes.push(
              <button
                key={s.label}
                type="button"
                onClick={() => applyScenario(s.label)}
                title={s.label}
                style={{
                  padding: '6px 8px',
                  borderRadius: 6,
                  fontSize: 10,
                  lineHeight: 1.25,
                  textAlign: 'left',
                  background: active ? 'var(--sl)' : 'var(--warm)',
                  color: active ? 'var(--sage)' : 'var(--i2)',
                  border: `1px solid ${active ? 'var(--sage)' : 'var(--w2)'}`,
                  cursor: 'pointer',
                }}
              >
                {s.label}
              </button>,
            );
            return nodes;
          })}
        </div>

        {/* Existing Quick Add (note type) row */}
        <div
          className="uppercase font-semibold mb-1"
          style={{ ...sectionHeading, marginTop: 10 }}
        >
          Quick Add
        </div>
        <div className="grid grid-cols-5 gap-1">
          {NOTE_TYPES.map((t) => {
            const active = t.key === selectedType;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setSelectedType(t.key)}
                title={t.label}
                style={{
                  height: 38,
                  padding: '4px 2px',
                  borderRadius: 7,
                  fontSize: 10,
                  fontWeight: 600,
                  lineHeight: 1.1,
                  background: active ? t.bg : 'var(--wh)',
                  color: active ? t.fg : 'var(--i2)',
                  border: `1px solid ${active ? t.border : 'var(--w2)'}`,
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <span style={{ fontSize: 11, fontWeight: 700 }}>{t.hint}</span>
                <span style={{ fontSize: 9 }}>{t.label}</span>
              </button>
            );
          })}
        </div>

        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={`Add a ${TYPE_LOOKUP[selectedType].label.toLowerCase()} note…`}
          rows={3}
          className="w-full mt-2 p-2 resize-none"
          style={{
            fontSize: 13,
            borderRadius: 8,
            border: '1px solid var(--w2)',
            background: 'var(--warm)',
            color: 'var(--ink)',
            outline: 'none',
            fontFamily: 'inherit',
          }}
        />

        <div className="flex items-center justify-between mt-2">
          <span style={{ color: 'var(--i3)', fontSize: 11 }}>⌘/Ctrl + Enter</span>
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim()}
            className="pm-btn pm-btn-primary"
            style={{
              opacity: draft.trim() ? 1 : 0.5,
              cursor: draft.trim() ? 'pointer' : 'not-allowed',
            }}
          >
            Add note
          </button>
        </div>
      </div>

      <div
        className="flex-1 overflow-y-auto px-3 mt-3 pb-3"
        style={{ borderTop: '1px solid var(--w2)' }}
      >
        {notes.length === 0 ? (
          <div
            className="text-center mt-8"
            style={{ color: 'var(--i3)', fontSize: 12 }}
          >
            No notes yet. Pick a type and start writing — everything you capture here
            rides along into the AgentBase session.
          </div>
        ) : (
          <ul className="flex flex-col gap-2 pt-3">
            {notes.map((n) => {
              const meta = TYPE_LOOKUP[n.type];
              return (
                <li
                  key={n.id}
                  style={{
                    borderRadius: 8,
                    border: `1px solid ${meta.border}`,
                    background: meta.bg,
                    padding: 8,
                  }}
                >
                  <div
                    className="flex items-center justify-between"
                    style={{ marginBottom: 4, gap: 6 }}
                  >
                    <div className="flex items-center" style={{ gap: 6, flexWrap: 'wrap' }}>
                      <span
                        className="uppercase font-semibold"
                        style={{ color: meta.fg, fontSize: 10, letterSpacing: '0.06em' }}
                      >
                        {meta.label}
                      </span>
                      {n.carrier && (
                        <span
                          style={{
                            fontSize: 9,
                            fontWeight: 600,
                            letterSpacing: '0.04em',
                            padding: '1px 6px',
                            borderRadius: 10,
                            background: 'var(--wh)',
                            color: 'var(--sage)',
                            border: '1px solid var(--sage)',
                          }}
                        >
                          {n.carrier}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span style={{ color: 'var(--i3)', fontSize: 10 }}>
                        {new Date(n.createdAt).toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeNote(n.id)}
                        aria-label="Delete note"
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: 'var(--i3)',
                          cursor: 'pointer',
                          fontSize: 12,
                          lineHeight: 1,
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--ink)', whiteSpace: 'pre-wrap' }}>
                    {n.body}
                  </div>
                  {n.scenario && (
                    <div
                      style={{
                        fontSize: 10,
                        color: 'var(--i3)',
                        marginTop: 4,
                        fontStyle: 'italic',
                      }}
                    >
                      ▸ {n.scenario}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
