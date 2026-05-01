// PhonePanel — slide-out softphone for the agent-v3 shell.
//
// Wires the mockup's chrome to the existing useSoftphone hook so:
//   • idle           → "Call <First>" green button
//   • connecting     → orange "Connecting…" placeholder
//   • ringing        → orange "Ringing…" placeholder
//   • connected      → live MM:SS timer + Mute / Hold / End row
//   • on-hold        → same row but Hold button reads "Resume"
//   • unavailable    → mic blocked / token failure → red "Unavailable"
//                      banner + the underlying error so Rob can fix it
//                      (browser permissions are the usual culprit)
//
// The dialpad sends DTMF via useSoftphone.sendDtmf when on a live
// call; outside a call the buttons stage a manual phone number for
// the call() invocation. This matches the mockup's static dialpad
// while keeping the softphone hook the single source of truth for
// call state.

import { useState } from 'react';
import { formatDuration, type SoftphoneState } from '@/hooks/useSoftphone';

interface Props {
  active: boolean;
  onClose: () => void;
  // Client info (from useSession.client)
  clientName: string;
  clientPhone: string;
  // Live softphone API (from useSoftphone — hosted in AgentV3App so the
  // AgentBar can also read state without re-mounting the device).
  state: SoftphoneState;
  duration: number;
  muted: boolean;
  error: string | null;
  call: (phoneNumber: string) => Promise<void>;
  hangup: () => void;
  toggleMute: () => void;
  toggleHold: () => void;
  sendDtmf: (digit: string) => void;
}

export function PhonePanel({
  active,
  onClose,
  clientName,
  clientPhone,
  state,
  duration,
  muted,
  error,
  call,
  hangup,
  toggleMute,
  toggleHold,
  sendDtmf,
}: Props) {
  const [manual, setManual] = useState('');
  if (!active) return null;

  const live = state === 'connected' || state === 'on-hold';
  const ringing = state === 'ringing' || state === 'connecting';
  const targetNumber = clientPhone || manual;
  const firstName = (clientName || 'Client').split(' ')[0];

  function onDigit(d: string) {
    if (live) {
      sendDtmf(d);
      return;
    }
    setManual((m) => (m + d).slice(0, 17));
  }

  return (
    <div
      style={{
        position: 'fixed',
        right: 0,
        top: 44,
        bottom: 0,
        width: 300,
        background: 'linear-gradient(180deg, #0a1628, #0d2f5e)',
        borderLeft: '2px solid #83f0f9',
        zIndex: 200,
        display: 'flex',
        flexDirection: 'column',
        padding: 20,
        boxShadow: '-8px 0 40px rgba(0,0,0,0.3)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 24,
        }}
      >
        <span
          style={{
            color: '#83f0f9',
            fontWeight: 700,
            fontSize: 14,
            letterSpacing: 1,
            textTransform: 'uppercase',
          }}
        >
          Softphone
        </span>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: 'rgba(255,255,255,0.4)',
            fontSize: 18,
            cursor: 'pointer',
          }}
        >
          ✕
        </button>
      </div>

      {/* Client info */}
      <div
        style={{
          background: 'rgba(255,255,255,0.05)',
          borderRadius: 10,
          padding: 16,
          marginBottom: 16,
        }}
      >
        <div style={{ color: 'white', fontWeight: 700, fontSize: 16 }}>
          {clientName || 'No client selected'}
        </div>
        <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, marginTop: 4 }}>
          {clientPhone || (manual ? `Dialing: ${manual}` : 'No phone on file')}
        </div>
        {live && (
          <div
            style={{
              color: state === 'on-hold' ? '#f59e0b' : '#34d399',
              fontSize: 24,
              fontWeight: 800,
              fontFamily: "'JetBrains Mono', monospace",
              marginTop: 8,
            }}
          >
            {formatDuration(duration)}
            {state === 'on-hold' && (
              <span
                style={{
                  fontSize: 11,
                  marginLeft: 8,
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                }}
              >
                On hold
              </span>
            )}
          </div>
        )}
        {ringing && (
          <div
            style={{
              color: '#f59e0b',
              fontSize: 13,
              fontWeight: 700,
              marginTop: 8,
            }}
          >
            {state === 'ringing' ? 'Ringing…' : 'Connecting…'}
          </div>
        )}
        {state === 'unavailable' && (
          <div
            style={{
              color: '#fca5a5',
              fontSize: 11,
              marginTop: 8,
              lineHeight: 1.4,
            }}
          >
            Softphone unavailable — check mic permissions or refresh.
            {error && (
              <div style={{ color: 'rgba(252,165,165,0.7)', marginTop: 4 }}>
                {error}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Dialpad */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 8,
          marginBottom: 16,
        }}
      >
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map(
          (d) => (
            <button
              key={d}
              type="button"
              onClick={() => onDigit(d)}
              style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8,
                padding: '12px 0',
                color: 'white',
                fontSize: 18,
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {d}
            </button>
          ),
        )}
      </div>

      {/* Call controls */}
      <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
        {(state === 'idle' || state === 'unavailable') && (
          <button
            type="button"
            onClick={() => {
              if (!targetNumber) return;
              void call(targetNumber);
            }}
            disabled={!targetNumber || state === 'unavailable'}
            style={{
              flex: 1,
              background:
                !targetNumber || state === 'unavailable'
                  ? 'rgba(255,255,255,0.06)'
                  : 'linear-gradient(135deg, #059669, #047857)',
              color: 'white',
              border: 'none',
              borderRadius: 10,
              padding: '14px 0',
              fontSize: 15,
              fontWeight: 700,
              cursor:
                !targetNumber || state === 'unavailable' ? 'not-allowed' : 'pointer',
              opacity: !targetNumber || state === 'unavailable' ? 0.5 : 1,
            }}
          >
            📞 Call {firstName}
          </button>
        )}
        {ringing && (
          <button
            type="button"
            onClick={hangup}
            style={{
              flex: 1,
              background: '#f59e0b',
              color: 'white',
              border: 'none',
              borderRadius: 10,
              padding: '14px 0',
              fontSize: 15,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {state === 'ringing' ? 'Ringing…' : 'Connecting…'} (Cancel)
          </button>
        )}
        {live && (
          <>
            <button
              type="button"
              onClick={toggleMute}
              style={{
                flex: 1,
                background: muted ? 'rgba(245,158,11,0.2)' : 'rgba(255,255,255,0.08)',
                color: muted ? '#f59e0b' : 'white',
                border: `1px solid ${muted ? '#f59e0b' : 'rgba(255,255,255,0.15)'}`,
                borderRadius: 10,
                padding: '12px 0',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {muted ? '🔇 Muted' : '🔇 Mute'}
            </button>
            <button
              type="button"
              onClick={toggleHold}
              style={{
                flex: 1,
                background:
                  state === 'on-hold'
                    ? 'rgba(245,158,11,0.2)'
                    : 'rgba(255,255,255,0.08)',
                color: state === 'on-hold' ? '#f59e0b' : 'white',
                border: `1px solid ${state === 'on-hold' ? '#f59e0b' : 'rgba(255,255,255,0.15)'}`,
                borderRadius: 10,
                padding: '12px 0',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {state === 'on-hold' ? '▶ Resume' : '⏸ Hold'}
            </button>
            <button
              type="button"
              onClick={hangup}
              style={{
                flex: 1,
                background: '#ef4444',
                color: 'white',
                border: 'none',
                borderRadius: 10,
                padding: '12px 0',
                fontSize: 13,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              End
            </button>
          </>
        )}
      </div>
    </div>
  );
}
