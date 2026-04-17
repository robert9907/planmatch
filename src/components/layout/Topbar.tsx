import { useTheme } from '@/hooks/useTheme';
import { useSession, selectNoteCount } from '@/hooks/useSession';
import { BROKER } from '@/lib/constants';

interface TopbarProps {
  onOpenNotes: () => void;
}

export function Topbar({ onOpenNotes }: TopbarProps) {
  const { theme, toggle } = useTheme();
  const noteCount = useSession(selectNoteCount);
  const clientName = useSession((s) => s.client.name);
  const clientState = useSession((s) => s.client.state);

  return (
    <header
      className="flex items-center gap-3 px-4 border-b"
      style={{
        height: 56,
        background: 'var(--wh)',
        borderColor: 'var(--w2)',
        color: 'var(--ink)',
      }}
    >
      <div className="flex items-center gap-2">
        <div
          className="grid place-items-center text-white font-bold"
          style={{ width: 30, height: 30, borderRadius: 7, background: 'var(--sage)' }}
        >
          PM
        </div>
        <div className="leading-tight">
          <div className="font-lora font-semibold" style={{ fontSize: 15 }}>
            PlanMatch
          </div>
          <div style={{ color: 'var(--i2)', fontSize: 11 }}>
            Medicare Advantage
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 ml-2">
        {BROKER.states.map((s) => {
          const active = clientState === s;
          return (
            <span
              key={s}
              className="inline-flex items-center justify-center font-semibold"
              style={{
                height: 22,
                padding: '0 8px',
                borderRadius: 999,
                fontSize: 11,
                background: active ? 'var(--sm)' : 'var(--wh)',
                color: active ? 'var(--ink)' : 'var(--i2)',
                border: `1px solid ${active ? 'var(--sage)' : 'var(--w2)'}`,
              }}
            >
              {s}
            </span>
          );
        })}
      </div>

      <div className="flex-1" />

      {clientName && (
        <div
          className="flex items-center gap-2 px-2"
          style={{
            height: 32,
            borderRadius: 8,
            background: 'var(--sl)',
            border: '1px solid var(--sm)',
            color: 'var(--ink)',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          <span
            className="grid place-items-center text-white font-bold"
            style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--sage)', fontSize: 11 }}
          >
            {clientName
              .split(' ')
              .map((p) => p[0])
              .slice(0, 2)
              .join('')
              .toUpperCase()}
          </span>
          {clientName}
        </div>
      )}

      <button
        type="button"
        onClick={onOpenNotes}
        className="pm-btn relative"
        aria-label="Open notepad"
      >
        <NotepadIcon />
        <span>Notes</span>
        {noteCount > 0 && (
          <span
            className="absolute grid place-items-center text-white font-bold"
            style={{
              top: -6,
              right: -6,
              minWidth: 18,
              height: 18,
              padding: '0 4px',
              borderRadius: 999,
              background: 'var(--sage)',
              fontSize: 10,
            }}
          >
            {noteCount}
          </span>
        )}
      </button>

      <button
        type="button"
        onClick={toggle}
        className="pm-btn"
        aria-label="Toggle color theme"
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>
    </header>
  );
}

function NotepadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h12l4 4v12a2 2 0 0 1-2 2H4z" />
      <path d="M8 10h8M8 14h8M8 18h5" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}
