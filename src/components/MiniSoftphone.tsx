// MiniSoftphone — floating bottom-right widget for browser-based
// calling from PlanMatch. Mounted at the WorkflowShell level so it
// persists across Intake → Meds → Providers → Extras → Quote.
//
// States (top-to-bottom visual hierarchy):
//   • unavailable — env not configured / SDK init failed. Hidden by
//     default; broker can hover the corner to surface a one-line
//     diagnostic.
//   • idle        — ready to dial. Compact pill with the client name +
//     a green Call button.
//   • connecting/ringing — pulsing amber dot.
//   • connected   — red dot, MM:SS timer, mute/hold/dialpad/hangup.
//   • on-hold     — gray dot, "On hold" label, same controls.
//
// Screen-share coordination: when `shareActive` is true AND the call
// is connected, the header strip flips to "Sharing screen · On call
// 2:34" and exposes a single "End all" button that calls both
// onEndShare and hangup.

import { useEffect, useMemo, useState } from 'react';
import { formatDuration, useSoftphone, type SoftphoneState } from '@/hooks/useSoftphone';

interface Props {
  /** Pre-populated dial target — usually session.client.phone. */
  clientName?: string | null;
  clientPhone?: string | null;
  /** True when the broker has an active screen-share. The widget
   *  shows the combined "Sharing + On call" indicator and exposes
   *  End-all. Pass through from WorkflowShell. */
  shareActive?: boolean;
  /** Stop the screen share. Triggered by End-all. */
  onEndShare?: () => void;
  /** When the widget is rendered but the broker hasn't entered a
   *  phone yet, expose a "+ Add phone" handler that opens whatever
   *  affordance the parent owns (usually a modal / quick-input). */
  onRequestPhone?: () => void;
}

const COLORS = {
  navy: '#0c447c',
  navyDeep: '#1a2744',
  ink: '#1f2937',
  inkSub: '#4b5563',
  rule: '#e5e7eb',
  white: '#fff',
  green: '#3b6d11',
  greenBg: '#eaf3de',
  red: '#a32d2d',
  redBg: '#fcebeb',
  amber: '#854f0b',
  amberBg: '#faeeda',
  panelBg: '#fafaf7',
};

const FONT_BODY = "'Inter', system-ui, -apple-system, sans-serif";
const FONT_MONO = "'JetBrains Mono', monospace";

function statusColor(state: SoftphoneState): { dot: string; label: string } {
  switch (state) {
    case 'connected':  return { dot: COLORS.red,   label: 'On call' };
    case 'on-hold':    return { dot: COLORS.inkSub, label: 'On hold' };
    case 'connecting':
    case 'ringing':    return { dot: COLORS.amber, label: 'Ringing' };
    case 'idle':       return { dot: COLORS.green, label: 'Ready' };
    case 'unavailable':return { dot: COLORS.inkSub, label: 'Offline' };
  }
}

const DIALPAD: string[][] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['*', '0', '#'],
];

export function MiniSoftphone(props: Props) {
  const { clientName, clientPhone, shareActive, onEndShare, onRequestPhone } = props;

  const sp = useSoftphone({ enabled: true });
  const [expanded, setExpanded] = useState(false);
  const [dialpadOpen, setDialpadOpen] = useState(false);

  // Auto-expand when a call is active so the broker doesn't have to
  // click to see the duration / controls. Auto-collapse when the
  // call ends after a 2s grace so the duration stays visible briefly.
  useEffect(() => {
    if (sp.state === 'connecting' || sp.state === 'ringing' || sp.state === 'connected' || sp.state === 'on-hold') {
      setExpanded(true);
      return;
    }
    if (sp.state === 'idle') {
      // Keep open if user expanded it manually; otherwise collapse
      // 2s after returning to idle from a connected state.
      // (No grace timer here — re-collapse is harmless if the user
      // wanted it open they'll click it again.)
    }
  }, [sp.state]);

  const status = useMemo(() => statusColor(sp.state), [sp.state]);
  const onCall = sp.state === 'connected' || sp.state === 'on-hold';
  const callable =
    sp.state === 'idle' && !!clientPhone && /\d/.test(clientPhone);

  // Hide entirely when softphone is unavailable AND the broker hasn't
  // explicitly opened it. Keep the corner clean for the 99% of
  // sessions where Twilio works fine; surface a small offline pill
  // only when the broker has tried to use it.
  if (sp.state === 'unavailable' && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        title={sp.error ? `Softphone offline: ${sp.error}` : 'Softphone offline'}
        style={{
          position: 'fixed',
          bottom: 16,
          right: 16,
          width: 40,
          height: 40,
          borderRadius: '50%',
          background: COLORS.panelBg,
          border: `1px solid ${COLORS.rule}`,
          color: COLORS.inkSub,
          cursor: 'pointer',
          fontSize: 16,
          zIndex: 9000,
        }}
      >
        ☎︎
      </button>
    );
  }

  // Collapsed pill — circular badge that shows status + click to expand.
  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        title={`${status.label} — click to expand`}
        style={{
          position: 'fixed',
          bottom: 16,
          right: 16,
          width: 48,
          height: 48,
          borderRadius: '50%',
          background: COLORS.navy,
          color: COLORS.white,
          border: 'none',
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          cursor: 'pointer',
          fontSize: 18,
          zIndex: 9000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        ☎︎
        <span
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: status.dot,
            border: `2px solid ${COLORS.navy}`,
          }}
        />
      </button>
    );
  }

  // Expanded panel.
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        width: 280,
        background: COLORS.white,
        border: `1px solid ${COLORS.rule}`,
        borderRadius: 12,
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        fontFamily: FONT_BODY,
        color: COLORS.ink,
        zIndex: 9000,
      }}
    >
      {/* Combined-status header — flips when share + call are both active */}
      {shareActive && onCall ? (
        <div
          style={{
            background: COLORS.navyDeep,
            color: COLORS.white,
            padding: '8px 12px',
            borderTopLeftRadius: 12,
            borderTopRightRadius: 12,
            fontSize: 11,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>● Sharing + On call {formatDuration(sp.duration)}</span>
          <button
            type="button"
            onClick={() => {
              try { onEndShare?.(); } catch { /* noop */ }
              sp.hangup();
            }}
            style={{
              background: COLORS.red,
              color: COLORS.white,
              border: 'none',
              borderRadius: 6,
              padding: '3px 8px',
              fontSize: 10,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            End all
          </button>
        </div>
      ) : (
        <div
          style={{
            background: COLORS.panelBg,
            padding: '8px 12px',
            borderTopLeftRadius: 12,
            borderTopRightRadius: 12,
            fontSize: 11,
            fontWeight: 600,
            color: COLORS.inkSub,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: `1px solid ${COLORS.rule}`,
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: status.dot,
                animation:
                  sp.state === 'connecting' || sp.state === 'ringing'
                    ? 'pulseDot 1.2s ease-in-out infinite'
                    : 'none',
              }}
            />
            {shareActive ? 'Sharing screen · ' : ''}{status.label}
            {onCall && ` · ${formatDuration(sp.duration)}`}
          </span>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            title="Collapse"
            style={{
              background: 'transparent',
              border: 'none',
              color: COLORS.inkSub,
              cursor: 'pointer',
              fontSize: 14,
              padding: 0,
              lineHeight: 1,
            }}
          >
            ▾
          </button>
        </div>
      )}

      <style>{`@keyframes pulseDot { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>

      {/* Body */}
      <div style={{ padding: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.ink, marginBottom: 2 }}>
          {clientName || 'No client loaded'}
        </div>
        {clientPhone ? (
          <div style={{ fontSize: 11, color: COLORS.inkSub, fontFamily: FONT_MONO, marginBottom: 10 }}>
            {clientPhone}
          </div>
        ) : (
          <button
            type="button"
            onClick={onRequestPhone}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              color: COLORS.navy,
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              textDecoration: 'underline',
              marginBottom: 10,
            }}
          >
            + Add phone
          </button>
        )}

        {sp.error && (
          <div style={{ fontSize: 10, color: COLORS.red, marginBottom: 8 }}>
            {sp.error}
          </div>
        )}

        {/* Action buttons */}
        {!onCall ? (
          <button
            type="button"
            onClick={() => clientPhone && sp.call(clientPhone)}
            disabled={!callable}
            style={{
              width: '100%',
              padding: '10px',
              borderRadius: 8,
              border: 'none',
              background: callable ? COLORS.green : '#d1d5db',
              color: COLORS.white,
              fontSize: 13,
              fontWeight: 700,
              cursor: callable ? 'pointer' : 'not-allowed',
              fontFamily: FONT_BODY,
            }}
          >
            {sp.state === 'connecting' || sp.state === 'ringing' ? 'Calling…' : 'Call'}
          </button>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <button type="button" onClick={sp.toggleMute} style={smallBtnStyle(sp.muted)}>
                {sp.muted ? 'Unmute' : 'Mute'}
              </button>
              <button type="button" onClick={sp.toggleHold} style={smallBtnStyle(sp.state === 'on-hold')}>
                {sp.state === 'on-hold' ? 'Resume' : 'Hold'}
              </button>
              <button
                type="button"
                onClick={() => setDialpadOpen((v) => !v)}
                style={smallBtnStyle(dialpadOpen)}
              >
                {dialpadOpen ? '▴ Pad' : '▾ Pad'}
              </button>
            </div>
            <button
              type="button"
              onClick={sp.hangup}
              style={{
                width: '100%',
                padding: '8px',
                borderRadius: 8,
                border: 'none',
                background: COLORS.red,
                color: COLORS.white,
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: FONT_BODY,
              }}
            >
              Hang up
            </button>
            {dialpadOpen && (
              <div style={{ marginTop: 8 }}>
                {DIALPAD.map((row, ri) => (
                  <div key={ri} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                    {row.map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => sp.sendDtmf(d)}
                        style={{
                          flex: 1,
                          padding: '8px 0',
                          background: COLORS.panelBg,
                          border: `1px solid ${COLORS.rule}`,
                          borderRadius: 6,
                          fontSize: 14,
                          fontWeight: 600,
                          fontFamily: FONT_MONO,
                          cursor: 'pointer',
                        }}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function smallBtnStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: '6px 0',
    background: active ? COLORS.navy : COLORS.panelBg,
    color: active ? COLORS.white : COLORS.ink,
    border: `1px solid ${active ? COLORS.navy : COLORS.rule}`,
    borderRadius: 6,
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: FONT_BODY,
  };
}
