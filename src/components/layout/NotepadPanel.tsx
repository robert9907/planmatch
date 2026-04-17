import { useEffect, useRef, useState } from 'react';
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

export function NotepadPanel({ open, onClose }: NotepadPanelProps) {
  const notes = useSession(selectNotes);
  const addNote = useSession((s) => s.addNote);
  const removeNote = useSession((s) => s.removeNote);

  const [selectedType, setSelectedType] = useState<NoteType>('general');
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

  function submit() {
    if (!draft.trim()) return;
    addNote(selectedType, draft);
    setDraft('');
  }

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
        <div
          className="uppercase font-semibold mb-1"
          style={{ color: 'var(--i3)', fontSize: 10, letterSpacing: '0.08em' }}
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
                  <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
                    <span
                      className="uppercase font-semibold"
                      style={{ color: meta.fg, fontSize: 10, letterSpacing: '0.06em' }}
                    >
                      {meta.label}
                    </span>
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
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
