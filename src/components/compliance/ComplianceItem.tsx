import type { ComplianceItemDef } from '@/lib/compliance';

interface ComplianceItemProps {
  def: ComplianceItemDef;
  checked: boolean;
  onToggle: () => void;
}

export function ComplianceItem({ def, checked, onToggle }: ComplianceItemProps) {
  return (
    <label
      className="flex items-start gap-3 cursor-pointer"
      style={{
        padding: 10,
        borderRadius: 9,
        border: `1px solid ${checked ? 'var(--sm)' : 'var(--w2)'}`,
        background: checked ? 'var(--sl)' : 'var(--wh)',
        transition: 'background 120ms ease, border-color 120ms ease',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        style={{
          width: 18,
          height: 18,
          accentColor: 'var(--sage)',
          marginTop: 2,
          flexShrink: 0,
          cursor: 'pointer',
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: checked ? 'var(--ink)' : 'var(--ink)',
              textDecoration: checked ? 'none' : 'none',
            }}
          >
            {def.label}
          </span>
          {def.new2026 && <New2026Badge />}
        </div>
        {def.detail && (
          <div style={{ fontSize: 11, color: 'var(--i2)', marginTop: 3, lineHeight: 1.4 }}>
            {def.detail}
          </div>
        )}
      </div>
    </label>
  );
}

function New2026Badge() {
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        padding: '2px 6px',
        borderRadius: 4,
        background: 'var(--pt)',
        color: 'var(--pur)',
        border: '1px solid var(--pur)',
      }}
    >
      New 2026
    </span>
  );
}
