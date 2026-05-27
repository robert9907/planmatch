// SnapInbox — agent-v3 unconfirmed-items queue.
//
// Renders pending capture items above the live MedsScreen / ProvidersScreen
// lists. Each row gets an amber "📸 SCANNED" badge, a one-line summary
// of the extracted fields, and ✓ / ✕ buttons.
//
//   • ✓ pushes the item into useSession via the same addMedication /
//     addProvider calls the existing CapturePanel uses. Medication
//     approvals also seed a Provider row from prescribing_physician
//     so the Providers tab auto-populates (matches the spec).
//   • ✕ rejects the item — same useCaptureSession.reject mechanic.
//
// Filtering: pass accept='medication' from MedsScreen and
// accept='provider' from ProvidersScreen. Items whose extracted entries
// don't match the active accept set stay hidden — they'll surface on
// the other tab.

import type {
  IncomingQueueItem,
  UseCaptureSessionResult,
} from '@/hooks/useCaptureSession';
import type { ExtractedItem } from '@/types/capture';
import { useSession } from '@/hooks/useSession';
import { FADE_SLIDE_IN } from './styles';

interface Props {
  capture: UseCaptureSessionResult;
  accept: 'medication' | 'provider';
}

export function SnapInbox({ capture, accept }: Props) {
  const addMedication = useSession((s) => s.addMedication);
  const addProvider = useSession((s) => s.addProvider);

  // Only show pending items whose extracted array contains at least one
  // entry of the accepted type. A single capture frame can produce
  // multiple extracted entries (e.g. a pharmacy printout listing two
  // refills) — we display the row once, but approve fans out across
  // every matching extracted entry.
  const rows = capture.queue.filter(
    (q) => q.decision === 'pending' && q.extracted.some((e) => matchesAccept(e, accept)),
  );

  if (!capture.token) return null;
  if (rows.length === 0) {
    // Render nothing when the inbox is empty for this tab — the
    // SnapTrigger pill on IntakeScreen already conveys overall status.
    return null;
  }

  function onApprove(item: IncomingQueueItem) {
    const approved = capture.approve(item.id);
    if (!approved) return;
    for (const extracted of approved.extracted) {
      if (extracted.type === 'medication' && accept === 'medication') {
        addMedication({
          name: extracted.drug_name,
          strength: extracted.strength ?? undefined,
          form: extracted.form ?? undefined,
          dosageInstructions: extracted.dosage_instructions ?? undefined,
          prescribingPhysician: extracted.prescribing_physician ?? undefined,
          source: 'capture',
          confidence: extracted.confidence,
        });
        // Auto-seed a provider row from the prescriber name so the
        // Providers tab fills in without a second tap. Matches the
        // existing CapturePanel behavior (and Phase 4 of the spec).
        if (extracted.prescribing_physician) {
          addProvider({
            name: extracted.prescribing_physician,
            source: 'from_med',
          });
        }
      } else if (extracted.type === 'provider' && accept === 'provider') {
        addProvider({
          name: extracted.provider_name,
          specialty: extracted.specialty ?? undefined,
          address: extracted.address ?? undefined,
          phone: extracted.phone ?? undefined,
          source: 'capture',
        });
      }
    }
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: '#92400e',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          marginBottom: 6,
          paddingLeft: 4,
        }}
      >
        📸 Scanned — waiting for your OK
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((row, i) => (
          <SnapRow
            key={row.id}
            row={row}
            accept={accept}
            index={i}
            onApprove={() => onApprove(row)}
            onReject={() => capture.reject(row.id)}
          />
        ))}
      </div>
    </div>
  );
}

interface RowProps {
  row: IncomingQueueItem;
  accept: 'medication' | 'provider';
  index: number;
  onApprove: () => void;
  onReject: () => void;
}

function SnapRow({ row, accept, index, onApprove, onReject }: RowProps) {
  const summary = summarize(row, accept);
  return (
    <div
      style={{
        background: '#fffbeb',
        border: '1px solid #fde68a',
        borderRadius: 10,
        padding: '10px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        animation: `${FADE_SLIDE_IN} 0.3s ease ${index * 0.05}s both`,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 2,
          }}
        >
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: 0.6,
              textTransform: 'uppercase',
              background: '#fef3c7',
              color: '#92400e',
              padding: '2px 7px',
              borderRadius: 10,
            }}
          >
            📸 Scanned
          </span>
          {summary.confidence && (
            <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600 }}>
              {summary.confidence} confidence
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: '#0d2f5e',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {summary.title}
        </div>
        {summary.sub && (
          <div
            style={{
              fontSize: 11,
              color: '#64748b',
              marginTop: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {summary.sub}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onApprove}
        aria-label={`Confirm ${summary.title}`}
        style={{
          background: 'linear-gradient(135deg, #059669, #10b981)',
          color: 'white',
          border: 'none',
          borderRadius: 8,
          padding: '7px 14px',
          fontSize: 13,
          fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        ✓
      </button>
      <button
        type="button"
        onClick={onReject}
        aria-label={`Dismiss ${summary.title}`}
        style={{
          background: 'transparent',
          border: '1.5px solid rgba(13,47,94,0.12)',
          borderRadius: 8,
          padding: '6px 12px',
          fontSize: 13,
          fontWeight: 700,
          color: '#64748b',
          cursor: 'pointer',
        }}
      >
        ✕
      </button>
    </div>
  );
}

interface Summary {
  title: string;
  sub: string | null;
  confidence: string | null;
}

function summarize(row: IncomingQueueItem, accept: 'medication' | 'provider'): Summary {
  for (const e of row.extracted) {
    if (!matchesAccept(e, accept)) continue;
    if (e.type === 'medication') {
      const parts = [e.strength, e.form, e.dosage_instructions].filter(Boolean);
      const sub = parts.length > 0 ? parts.join(' · ') : null;
      return {
        title: e.drug_name || 'Unreadable label',
        sub,
        confidence: e.confidence ?? null,
      };
    }
    if (e.type === 'provider') {
      const parts = [e.specialty, e.practice_name, e.phone].filter(Boolean);
      const sub = parts.length > 0 ? parts.join(' · ') : null;
      return {
        title: e.provider_name || 'Unreadable provider card',
        sub,
        confidence: null,
      };
    }
  }
  return { title: 'Unreadable image', sub: null, confidence: null };
}

function matchesAccept(e: ExtractedItem, accept: 'medication' | 'provider'): boolean {
  return e.type === accept;
}
