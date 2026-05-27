// SnapTrigger — agent-v3 "Send Snap Link" button + inline status pill.
//
// Sits on the IntakeScreen Client card. Reuses the existing
// capture_sessions infrastructure (the photo-capture link the v4 wizard
// has shipped for months) but with:
//   • snap-variant SMS copy ("Rob from Generation Health here. Tap this
//     link to snap photos of your pill bottles so I can find you the
//     best plan.") sent via capture-start's new sms_variant param.
//   • agent_session_id pinned to useSession.sessionId so the resulting
//     capture row can be reconciled back to this quote.
//
// Three render modes:
//   • inactive  → 📸 Send Snap Link button (the form is one tap away).
//   • starting  → button shows "Sending link…".
//   • active    → status pill: "Link sent · waiting" / "N items received".
//                 The "End" button resets the capture session so the
//                 broker can resend if needed.

import { useEffect, useState } from 'react';
import type { UseCaptureSessionResult } from '@/hooks/useCaptureSession';
import { useSession } from '@/hooks/useSession';

interface Props {
  capture: UseCaptureSessionResult;
}

export function SnapTrigger({ capture }: Props) {
  const clientName = useSession((s) => s.client.name);
  const clientPhone = useSession((s) => s.client.phone);
  const sessionId = useSession((s) => s.sessionId);

  const [showForm, setShowForm] = useState(false);
  const [phone, setPhone] = useState(clientPhone);
  const [name, setName] = useState(clientName);

  // Keep the local form fields in sync with the session as the broker
  // types into IntakeScreen above — otherwise typing in the form
  // overrides itself the next time AgentBase hydration fires.
  useEffect(() => {
    if (!showForm) setPhone(clientPhone);
  }, [clientPhone, showForm]);
  useEffect(() => {
    if (!showForm) setName(clientName);
  }, [clientName, showForm]);

  const active =
    !!capture.token &&
    capture.status !== 'expired' &&
    capture.status !== 'completed';

  if (active) {
    const itemLabel =
      capture.queue.length === 0
        ? capture.status === 'waiting'
          ? 'Waiting for first photo…'
          : 'Link opened — waiting for first photo…'
        : `${capture.queue.length} item${capture.queue.length === 1 ? '' : 's'} received`;
    return (
      <div
        style={{
          background: 'rgba(131,240,249,0.08)',
          border: '1px solid rgba(131,240,249,0.3)',
          borderRadius: 10,
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span style={{ fontSize: 16 }}>📸</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#0d2f5e' }}>
            Snap link sent
          </div>
          <div style={{ fontSize: 11, color: '#64748b' }}>
            {itemLabel}
            {capture.smsError && (
              <span style={{ color: '#a32d2d', marginLeft: 8 }}>
                · SMS error: {capture.smsError}
              </span>
            )}
            {capture.link && (
              <>
                {' · '}
                <a
                  href={capture.link}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    color: '#0071e3',
                    textDecoration: 'underline',
                    fontWeight: 600,
                  }}
                >
                  view client page
                </a>
              </>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={capture.reset}
          style={{
            background: 'transparent',
            border: '1px solid rgba(13,47,94,0.12)',
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 11,
            fontWeight: 600,
            color: '#64748b',
            cursor: 'pointer',
          }}
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
        onClick={() => {
          setPhone(clientPhone);
          setName(clientName);
          setShowForm(true);
        }}
        style={{
          background: 'linear-gradient(135deg, #0d2f5e, #1a4a8a)',
          color: 'white',
          border: 'none',
          borderRadius: 9,
          padding: '10px 16px',
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: 0.3,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        📸 Send Snap Link
      </button>
    );
  }

  async function handleSend() {
    const trimmedPhone = phone.trim();
    if (!trimmedPhone) return;
    await capture.start({
      client_name: name.trim() || undefined,
      client_phone: trimmedPhone,
      send_sms: true,
      agent_session_id: sessionId,
      sms_variant: 'snap',
    });
    setShowForm(false);
  }

  return (
    <div
      style={{
        background: '#f8fafc',
        border: '1px solid rgba(13,47,94,0.08)',
        borderRadius: 10,
        padding: 12,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: '#64748b',
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          marginBottom: 6,
        }}
      >
        Send a Snap Link
      </div>
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
        Client texts a link, snaps pill bottles, drugs auto-populate here.
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="First name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={inputStyle}
        />
        <input
          type="tel"
          placeholder="(828) 555-1212"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          style={{ ...inputStyle, flex: 1, minWidth: 180 }}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button
          type="button"
          onClick={handleSend}
          disabled={!phone.trim() || capture.isStarting}
          style={{
            background: 'linear-gradient(135deg, #0d2f5e, #1a4a8a)',
            color: 'white',
            border: 'none',
            borderRadius: 9,
            padding: '8px 14px',
            fontSize: 12,
            fontWeight: 700,
            cursor: !phone.trim() || capture.isStarting ? 'default' : 'pointer',
            opacity: !phone.trim() || capture.isStarting ? 0.5 : 1,
          }}
        >
          {capture.isStarting ? 'Sending…' : 'Send link'}
        </button>
        <button
          type="button"
          onClick={() => setShowForm(false)}
          style={{
            background: 'transparent',
            border: '1.5px solid rgba(13,47,94,0.12)',
            borderRadius: 9,
            padding: '8px 14px',
            fontSize: 12,
            fontWeight: 600,
            color: '#0d2f5e',
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
      {capture.startError && (
        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            color: '#a32d2d',
            fontWeight: 600,
          }}
        >
          {capture.startError}
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  height: 34,
  padding: '0 10px',
  borderRadius: 8,
  border: '1px solid rgba(13,47,94,0.12)',
  background: 'white',
  color: '#0d2f5e',
  fontSize: 13,
  outline: 'none',
  fontFamily: 'inherit',
};
