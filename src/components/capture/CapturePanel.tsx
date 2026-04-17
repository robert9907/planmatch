import type { UseCaptureSessionResult } from '@/hooks/useCaptureSession';
import { useSession } from '@/hooks/useSession';
import { IncomingCard } from './IncomingCard';

interface CapturePanelProps {
  capture: UseCaptureSessionResult;
  /**
   * Which type of extraction this panel should auto-add on approve:
   *   'medication' — Step 3 (approves also seed providers from prescribing_physician)
   *   'provider'   — Step 4
   *   'any'        — both, route by item.type (demo default)
   */
  accept?: 'medication' | 'provider' | 'any';
}

export function CapturePanel({ capture, accept = 'any' }: CapturePanelProps) {
  const addMedication = useSession((s) => s.addMedication);
  const addProvider = useSession((s) => s.addProvider);

  function onApprove(itemId: string) {
    const approved = capture.approve(itemId);
    if (!approved) return;

    for (const extracted of approved.extracted) {
      if (extracted.type === 'medication' && (accept === 'medication' || accept === 'any')) {
        addMedication({
          name: extracted.drug_name,
          strength: extracted.strength ?? undefined,
          form: extracted.form ?? undefined,
          dosageInstructions: extracted.dosage_instructions ?? undefined,
          prescribingPhysician: extracted.prescribing_physician ?? undefined,
          source: 'capture',
          confidence: extracted.confidence,
        });
        if (extracted.prescribing_physician) {
          addProvider({
            name: extracted.prescribing_physician,
            source: 'from_med',
          });
        }
      } else if (extracted.type === 'provider' && (accept === 'provider' || accept === 'any')) {
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

  if (!capture.token) {
    return (
      <div
        className="pm-surface"
        style={{ padding: 16, textAlign: 'center', color: 'var(--i3)', fontSize: 13 }}
      >
        No capture session active. Send a link to start.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <StatusHeader capture={capture} />

      {capture.queue.length === 0 ? (
        <div
          className="pm-surface"
          style={{ padding: 16, textAlign: 'center', color: 'var(--i3)', fontSize: 13 }}
        >
          {capture.status === 'waiting'
            ? 'Waiting for first photo…'
            : 'All processed. Dorothy can send more anytime.'}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {capture.queue.map((item) => (
            <IncomingCard
              key={item.id}
              item={item}
              onApprove={() => onApprove(item.id)}
              onReject={() => capture.reject(item.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StatusHeader({ capture }: { capture: UseCaptureSessionResult }) {
  const statusLabel = statusToLabel(capture.status);
  return (
    <div
      className="pm-surface flex items-center justify-between"
      style={{ padding: '8px 12px', background: 'var(--sl)', borderColor: 'var(--sm)' }}
    >
      <div className="flex items-center gap-2">
        <PulseDot status={capture.status} />
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
            {statusLabel}
          </div>
          <div style={{ fontSize: 11, color: 'var(--i2)' }}>
            {capture.clientName && `${capture.clientName} · `}
            {capture.queue.length} item{capture.queue.length === 1 ? '' : 's'}
            {capture.pendingCount > 0 && ` · ${capture.pendingCount} pending`}
            {capture.link && (
              <>
                {' · '}
                <a
                  href={capture.link}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: 'var(--sage)', textDecoration: 'underline' }}
                >
                  view link
                </a>
              </>
            )}
          </div>
        </div>
      </div>
      <button type="button" onClick={capture.reset} className="pm-btn" style={{ height: 28 }}>
        End session
      </button>
    </div>
  );
}

function PulseDot({ status }: { status: UseCaptureSessionResult['status'] }) {
  const color =
    status === 'waiting'
      ? 'var(--amb)'
      : status === 'has_results'
        ? 'var(--sage)'
        : status === 'expired'
          ? 'var(--red)'
          : 'var(--i3)';
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        boxShadow: status === 'waiting' || status === 'has_results' ? `0 0 0 4px ${color}22` : undefined,
      }}
    />
  );
}

function statusToLabel(s: UseCaptureSessionResult['status']): string {
  switch (s) {
    case 'waiting':
      return 'Waiting for photos…';
    case 'has_results':
      return 'Receiving photos';
    case 'completed':
      return 'Capture complete';
    case 'expired':
      return 'Session expired';
    default:
      return 'No capture';
  }
}
