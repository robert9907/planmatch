import { useSession, selectNoteCount } from '@/hooks/useSession';

interface TabColumnProps {
  open: boolean;
  onToggle: () => void;
}

export function TabColumn({ open, onToggle }: TabColumnProps) {
  const count = useSession(selectNoteCount);

  return (
    <div
      className="flex flex-col items-center border-l"
      style={{
        width: 30,
        background: 'var(--wh)',
        borderColor: 'var(--w2)',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex-1 w-full flex items-center justify-center"
        style={{
          cursor: 'pointer',
          background: open ? 'var(--sl)' : 'transparent',
          color: open ? 'var(--ink)' : 'var(--i2)',
          borderLeft: open ? '2px solid var(--sage)' : '2px solid transparent',
          writingMode: 'vertical-rl',
          transform: 'rotate(180deg)',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          paddingTop: 16,
          paddingBottom: 16,
        }}
        aria-label={open ? 'Close notepad' : 'Open notepad'}
        aria-expanded={open}
      >
        Notes {count > 0 && `· ${count}`}
      </button>
    </div>
  );
}
