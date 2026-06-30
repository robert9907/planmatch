// FilterDropdown — reusable multi-select dropdown pill for the bench filter bar.
//
// Renders a pill button that shows the dropdown label plus an active-count
// badge when any options are selected. Clicking opens a checklist popover
// of options; clicking outside or hitting Escape closes it. Each option
// row shows its plan count so the broker can see how many bench plans
// would survive that single facet. A "Clear" footer appears whenever any
// option is selected.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

export interface FilterOption {
  value: string;
  label: string;
  count: number;
}

interface FilterDropdownProps {
  label: string;
  options: FilterOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Pill border + active-badge background. */
  accentColor: string;
}

const FONT_LABEL = "'DM Sans', system-ui, sans-serif";
const FONT_NUM = "'JetBrains Mono', ui-monospace, monospace";
const BORDER = '#e2e8f0';
const TEXT = '#0f172a';
const MUTED = '#64748b';
const PANEL = '#f8fafc';

export function FilterDropdown({
  label,
  options,
  selected,
  onChange,
  accentColor,
}: FilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click or Escape so the popover behaves like every
  // other dropdown the broker has seen elsewhere in agent-v3.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const activeCount = selected.length;
  const isActive = activeCount > 0;

  const toggle = (value: string) => {
    if (selectedSet.has(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const pillStyle: CSSProperties = {
    background: isActive ? accentColor : 'white',
    color: isActive ? 'white' : TEXT,
    border: `1px solid ${isActive ? accentColor : BORDER}`,
    borderRadius: 14,
    padding: '5px 10px',
    fontFamily: FONT_LABEL,
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    letterSpacing: 0.2,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    whiteSpace: 'nowrap',
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={pillStyle}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{label}</span>
        {isActive && (
          <span
            style={{
              background: 'rgba(255,255,255,0.25)',
              color: 'white',
              fontFamily: FONT_NUM,
              fontSize: 10,
              fontWeight: 700,
              padding: '1px 6px',
              borderRadius: 8,
              minWidth: 14,
              textAlign: 'center',
            }}
          >
            {activeCount}
          </span>
        )}
        <span style={{ fontSize: 9, opacity: 0.7 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            minWidth: 220,
            maxHeight: 320,
            overflowY: 'auto',
            background: 'white',
            border: `1px solid ${BORDER}`,
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(13,47,94,0.12)',
            zIndex: 50,
            padding: 4,
          }}
        >
          {options.length === 0 ? (
            <div
              style={{
                fontFamily: FONT_LABEL,
                fontSize: 11,
                color: MUTED,
                padding: '8px 10px',
              }}
            >
              No options available.
            </div>
          ) : (
            options.map((opt) => {
              const checked = selectedSet.has(opt.value);
              return (
                <label
                  key={opt.value}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    padding: '6px 8px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontFamily: FONT_LABEL,
                    fontSize: 12,
                    color: TEXT,
                    background: checked ? PANEL : 'white',
                  }}
                  onMouseDown={(e) => e.preventDefault()}
                >
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(opt.value)}
                      style={{
                        accentColor,
                        cursor: 'pointer',
                        margin: 0,
                      }}
                    />
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {opt.label}
                    </span>
                  </span>
                  <span
                    style={{
                      fontFamily: FONT_NUM,
                      fontSize: 10,
                      fontWeight: 600,
                      color: MUTED,
                      flexShrink: 0,
                    }}
                  >
                    {opt.count}
                  </span>
                </label>
              );
            })
          )}
          {isActive && (
            <div
              style={{
                borderTop: `1px solid ${BORDER}`,
                marginTop: 4,
                paddingTop: 4,
              }}
            >
              <button
                type="button"
                onClick={() => onChange([])}
                style={{
                  width: '100%',
                  background: 'transparent',
                  color: accentColor,
                  border: 'none',
                  padding: '6px 8px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontFamily: FONT_LABEL,
                  fontSize: 11,
                  fontWeight: 700,
                  textAlign: 'left',
                }}
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
