import { useState } from 'react';
import type { UseCaptureSessionResult } from '@/hooks/useCaptureSession';
import { useSession } from '@/hooks/useSession';

interface CaptureButtonProps {
  capture: UseCaptureSessionResult;
  label?: string;
}

export function CaptureButton({ capture, label = 'Send photo capture link' }: CaptureButtonProps) {
  const clientName = useSession((s) => s.client.name);
  const clientPhone = useSession((s) => s.client.phone);
  const [phone, setPhone] = useState(clientPhone || '');
  const [name, setName] = useState(clientName || '');
  const [showForm, setShowForm] = useState(false);

  const hasActive = !!capture.token && capture.status !== 'expired' && capture.status !== 'completed';

  async function handleSend() {
    if (!phone.trim()) return;
    await capture.start({ client_name: name.trim() || undefined, client_phone: phone.trim(), send_sms: true });
    setShowForm(false);
  }

  if (hasActive) {
    return (
      <div
        className="pm-surface flex items-center justify-between"
        style={{ padding: '8px 12px', borderColor: 'var(--sage)', background: 'var(--sl)' }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
            📷 Capture link sent
          </div>
          <div style={{ fontSize: 11, color: 'var(--i2)' }}>
            {capture.status === 'waiting' ? 'Waiting for first photo…' : `${capture.queue.length} items received`}
            {capture.smsError && (
              <span style={{ color: 'var(--red)' }}> · SMS error: {capture.smsError}</span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={capture.reset}
          className="pm-btn"
          style={{ height: 28 }}
        >
          End
        </button>
      </div>
    );
  }

  if (!showForm) {
    return (
      <button
        type="button"
        onClick={() => setShowForm(true)}
        className="pm-btn pm-btn-primary"
        style={{ height: 36 }}
      >
        📷 {label}
      </button>
    );
  }

  return (
    <div className="pm-surface" style={{ padding: 12 }}>
      <div style={{ fontSize: 12, color: 'var(--i2)', marginBottom: 6 }}>
        Send SMS with a photo-capture link.
      </div>
      <div className="flex gap-2 flex-wrap">
        <input
          type="text"
          placeholder="First name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={inputStyle}
        />
        <input
          type="tel"
          placeholder="Phone — (828) 555-1212"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          style={{ ...inputStyle, flex: 1, minWidth: 180 }}
        />
      </div>
      <div className="flex gap-2 mt-2">
        <button
          type="button"
          onClick={handleSend}
          disabled={!phone.trim() || capture.isStarting}
          className="pm-btn pm-btn-primary"
          style={{ opacity: !phone.trim() || capture.isStarting ? 0.6 : 1 }}
        >
          {capture.isStarting ? 'Sending…' : 'Send link'}
        </button>
        <button type="button" onClick={() => setShowForm(false)} className="pm-btn">
          Cancel
        </button>
      </div>
      {capture.startError && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--red)' }}>{capture.startError}</div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  height: 34,
  padding: '0 10px',
  borderRadius: 8,
  border: '1px solid var(--w2)',
  background: 'var(--warm)',
  color: 'var(--ink)',
  fontSize: 13,
  outline: 'none',
  fontFamily: 'inherit',
};
