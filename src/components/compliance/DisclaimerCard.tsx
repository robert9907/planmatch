import { useState } from 'react';
import type { DisclaimerDef } from '@/lib/compliance';

interface DisclaimerCardProps {
  def: DisclaimerDef;
  renderedBody: string;
  confirmed: boolean;
  onConfirm: () => void;
}

export function DisclaimerCard({ def, renderedBody, confirmed, onConfirm }: DisclaimerCardProps) {
  const [expanded, setExpanded] = useState(!confirmed);

  return (
    <div
      className="pm-surface"
      style={{
        borderColor: confirmed ? 'var(--sage)' : 'var(--amb)',
        background: confirmed ? 'var(--sl)' : 'var(--at)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center justify-between w-full text-left"
        style={{
          padding: '12px 14px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--ink)',
        }}
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-3">
          <StatusDot confirmed={confirmed} />
          <div>
            <div
              className="flex items-center gap-2"
              style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}
            >
              {def.title}
              <RequiredBadge />
            </div>
            <div style={{ fontSize: 11, color: 'var(--i2)', marginTop: 2 }}>{def.when}</div>
          </div>
        </div>
        <span
          style={{
            fontSize: 12,
            color: 'var(--i3)',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0)',
            transition: 'transform 120ms ease',
          }}
        >
          ▾
        </span>
      </button>

      {expanded && (
        <div
          style={{
            padding: '0 14px 14px',
            borderTop: '1px dashed var(--w2)',
          }}
        >
          <div
            style={{
              fontFamily: 'Lora, serif',
              fontSize: 15,
              lineHeight: 1.6,
              color: 'var(--ink)',
              padding: '14px 16px',
              marginTop: 10,
              background: 'var(--wh)',
              borderRadius: 10,
              border: '1px solid var(--w2)',
              borderLeft: '4px solid var(--sage)',
              whiteSpace: 'pre-wrap',
            }}
          >
            {renderedBody}
          </div>

          <div className="flex items-center justify-between" style={{ marginTop: 10, gap: 10, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 11, color: 'var(--i2)', lineHeight: 1.4, flex: 1, minWidth: 200 }}>
              Read verbatim to the client, in full. Confirm only after you have spoken it aloud.
            </div>
            {confirmed ? (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 12px',
                  borderRadius: 8,
                  background: 'var(--sage)',
                  color: '#fff',
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                ✓ Read verbatim
              </span>
            ) : (
              <button
                type="button"
                onClick={() => {
                  onConfirm();
                  setExpanded(false);
                }}
                className="pm-btn pm-btn-primary"
              >
                I read this verbatim
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusDot({ confirmed }: { confirmed: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 28,
        height: 28,
        borderRadius: 999,
        background: confirmed ? 'var(--sage)' : 'var(--amb)',
        color: '#fff',
        display: 'grid',
        placeItems: 'center',
        fontSize: 14,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {confirmed ? '✓' : '!'}
    </span>
  );
}

function RequiredBadge() {
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        padding: '2px 6px',
        borderRadius: 4,
        background: 'var(--rt)',
        color: 'var(--red)',
        border: '1px solid var(--red)',
      }}
    >
      Verbatim required
    </span>
  );
}
