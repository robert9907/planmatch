import type { IncomingQueueItem } from '@/hooks/useCaptureSession';
import type { ExtractedItem } from '@/types/capture';

interface IncomingCardProps {
  item: IncomingQueueItem;
  onApprove: () => void;
  onReject: () => void;
}

export function IncomingCard({ item, onApprove, onReject }: IncomingCardProps) {
  const extracted = item.extracted[0];
  const decision = item.decision;

  const borderColor = decision === 'approved'
    ? 'var(--sage)'
    : decision === 'rejected'
      ? 'var(--red)'
      : 'var(--w2)';

  return (
    <div
      className="pm-surface"
      style={{
        borderColor,
        padding: 10,
        opacity: decision === 'rejected' ? 0.55 : 1,
      }}
    >
      <div className="flex gap-3">
        {item.image_url ? (
          <img
            src={item.image_url}
            alt="Captured label"
            style={{
              width: 60,
              height: 60,
              borderRadius: 6,
              objectFit: 'cover',
              border: '1px solid var(--w2)',
              flexShrink: 0,
            }}
          />
        ) : (
          <div
            style={{
              width: 60,
              height: 60,
              borderRadius: 6,
              background: 'var(--w2)',
              display: 'grid',
              placeItems: 'center',
              color: 'var(--i3)',
              fontSize: 10,
              flexShrink: 0,
            }}
          >
            no img
          </div>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            {extracted ? (
              <TypeBadge type={extracted.type} confidence={'confidence' in extracted ? extracted.confidence : null} />
            ) : (
              <TypeBadge type="unknown" confidence={null} />
            )}
            <span style={{ color: 'var(--i3)', fontSize: 11 }}>
              {new Date(item.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </span>
          </div>

          <ExtractedSummary item={extracted} />

          {item.error && (
            <div
              style={{
                marginTop: 4,
                padding: '4px 6px',
                background: 'var(--rt)',
                color: 'var(--red)',
                borderRadius: 6,
                fontSize: 11,
              }}
            >
              {item.error}
            </div>
          )}
        </div>
      </div>

      <div className="flex gap-2 mt-2">
        {decision === 'pending' ? (
          <>
            <button
              type="button"
              onClick={onApprove}
              className="pm-btn pm-btn-primary"
              style={{ flex: 1, height: 30 }}
              disabled={!extracted || extracted.type === 'unknown'}
            >
              Approve
            </button>
            <button
              type="button"
              onClick={onReject}
              className="pm-btn"
              style={{ height: 30 }}
            >
              Reject
            </button>
          </>
        ) : (
          <div
            style={{
              flex: 1,
              textAlign: 'center',
              fontSize: 12,
              fontWeight: 600,
              color: decision === 'approved' ? 'var(--sage)' : 'var(--red)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            {decision === 'approved' ? '✓ Added to session' : '✕ Rejected'}
          </div>
        )}
      </div>
    </div>
  );
}

function TypeBadge({ type, confidence }: { type: string; confidence: string | null }) {
  const map: Record<string, { bg: string; fg: string; border: string; label: string }> = {
    medication: { bg: 'var(--sl)', fg: 'var(--sage)', border: 'var(--sage)', label: 'Medication' },
    provider: { bg: 'var(--pt)', fg: 'var(--pur)', border: 'var(--pur)', label: 'Provider' },
    unknown: { bg: 'var(--w2)', fg: 'var(--i2)', border: 'var(--w3)', label: 'Unreadable' },
  };
  const meta = map[type] ?? map.unknown;
  return (
    <div className="flex items-center gap-1">
      <span
        className="uppercase font-semibold"
        style={{
          fontSize: 10,
          letterSpacing: '0.06em',
          padding: '2px 6px',
          borderRadius: 999,
          background: meta.bg,
          color: meta.fg,
          border: `1px solid ${meta.border}`,
        }}
      >
        {meta.label}
      </span>
      {confidence && (
        <span style={{ color: 'var(--i3)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {confidence} conf.
        </span>
      )}
    </div>
  );
}

function ExtractedSummary({ item }: { item: ExtractedItem | undefined }) {
  if (!item) return null;
  if (item.type === 'medication') {
    return (
      <div style={{ marginTop: 4, fontSize: 13 }}>
        <div style={{ fontWeight: 600, color: 'var(--ink)' }}>
          {item.drug_name}
          {item.strength ? ` · ${item.strength}` : ''}
          {item.form ? ` · ${item.form}` : ''}
        </div>
        {item.dosage_instructions && (
          <div style={{ color: 'var(--i2)', fontSize: 12, marginTop: 2 }}>
            {item.dosage_instructions}
          </div>
        )}
        {item.prescribing_physician && (
          <div style={{ color: 'var(--i2)', fontSize: 12, marginTop: 2 }}>
            Rx: {item.prescribing_physician}
          </div>
        )}
      </div>
    );
  }
  if (item.type === 'provider') {
    return (
      <div style={{ marginTop: 4, fontSize: 13 }}>
        <div style={{ fontWeight: 600, color: 'var(--ink)' }}>
          {item.provider_name}
          {item.credentials ? `, ${item.credentials}` : ''}
        </div>
        {item.specialty && (
          <div style={{ color: 'var(--i2)', fontSize: 12, marginTop: 2 }}>{item.specialty}</div>
        )}
        {item.practice_name && (
          <div style={{ color: 'var(--i2)', fontSize: 12 }}>{item.practice_name}</div>
        )}
      </div>
    );
  }
  return (
    <div style={{ marginTop: 4, fontSize: 12, color: 'var(--i2)' }}>
      {item.note || 'Could not read this label.'}
    </div>
  );
}
