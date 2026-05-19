// AgentBar — sticky top nav for the agent-v3 shell.
//
// Mockup chrome ported verbatim. Live wires:
//   • screen nav   → AgentV3App's setScreen
//   • view toggle  → cosmetic (controls AgentInsight visibility)
//   • Call ↗       → opens AgentBase CRM in a new tab. PlanMatch does
//                    not place voice calls; the broker dials from
//                    AgentBase. This button is just a deep-link so the
//                    workflow doesn't require switching tabs by hand.
//   • share cycle  → useScreenShareStore.start / stop. The mockup
//                    cycles off → desktop → mobile, but the existing
//                    share backend is a single Twilio Video Room
//                    (no desktop/mobile distinction yet) so we collapse
//                    that to off → on. When sharing is live the button
//                    flips to a red "Stop sharing" pill with a pulsing
//                    dot, and an SMS-status banner immediately below
//                    surfaces the /api/screen-share-start outcome (sent
//                    to +E.164 / failed with copy-link fallback) so a
//                    silent SMS failure is impossible to miss.
//   • compliance   → percent of Object.values(checks).filter(Boolean)
//                    forwarded by AgentV3App. Bar turns green at 100%.
//   • AgentBase ↗  → opens robert9907/agentbase-crm in a new tab. The
//                    real "save session" button stays inside the
//                    workflow (existing SaveSessionButton); this is
//                    just a quick-jump to the CRM dashboard so the
//                    broker can verify a hydrated client mid-call.

import { useState } from 'react';

// Aligned with reference/plan-match-agent-full.jsx: 8 screens. The
// previous waterfall (Results → Report → Compare) collapses into a
// Tinder-style Swipe screen pinned with the current plan and the
// Broker Brain pick, then a single Compare Finalists table.
export type ScreenId =
  | 'intake'
  | 'meds'
  | 'providers'
  | 'priorities'
  | 'swipe'
  | 'compare'
  | 'compliance'
  | 'enroll';

export const SCREENS: ScreenId[] = [
  'intake',
  'meds',
  'providers',
  'priorities',
  'swipe',
  'compare',
  'compliance',
  'enroll',
];

const LABELS: Record<ScreenId, string> = {
  intake: 'Client',
  meds: 'Meds',
  providers: 'Providers',
  priorities: 'Priorities',
  swipe: 'Plans',
  compare: 'Compare',
  compliance: 'Compliance',
  enroll: 'Enroll',
};

// Finalist cap from the spec: Brain pick + up to 3 user-kept plans.
export const FINALIST_CAP = 4;

interface Props {
  screen: ScreenId;
  onNav: (s: ScreenId) => void;
  clientView: boolean;
  onToggleView: () => void;
  shareOn: boolean;
  shareStarting: boolean;
  /** True when the API returned smsFailed for the active share. */
  shareSmsFailed: boolean;
  /** E.164 destination the API attempted; null when no result yet. */
  shareSmsTo: string | null;
  /** Last error from useScreenShareStore.start (catastrophic failure
   *  before the room came up — distinct from smsFailed). */
  shareError: string | null;
  /** Public /watch/{roomId} link for the active share. Surfaced as a
   *  copy-link fallback when SMS delivery fails. */
  shareLink: string | null;
  onCycleShare: () => void;
  complianceProgress: number;
  /** Brain pick + user-kept plans, capped at FINALIST_CAP. */
  finalistCount: number;
  /** href for the "AgentBase ↗" jump link AND the new "Call" button.
   *  Defaults to the prod CRM where the broker actually places the
   *  call. */
  agentBaseHref?: string;
}

export function AgentBar({
  screen,
  onNav,
  clientView,
  onToggleView,
  shareOn,
  shareStarting,
  shareSmsFailed,
  shareSmsTo,
  shareError,
  shareLink,
  onCycleShare,
  complianceProgress,
  finalistCount,
  agentBaseHref = 'https://agentbase-crm.vercel.app/',
}: Props) {
  const [linkCopied, setLinkCopied] = useState(false);

  const shareLabel = shareStarting ? 'Starting…' : shareOn ? 'Sharing' : 'Share';

  async function copyShareLink() {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // Clipboard API can be blocked by older Safari permissions; fall
      // back to a window.prompt so the broker can still grab the link.
      window.prompt('Copy this link to send to the client:', shareLink);
    }
  }

  // Status banner shown immediately under the bar when a share is
  // active or has just failed. Three states:
  //   • shareError    — start failed before the room came up
  //   • shareSmsFailed — room is up, broker is sharing, but Twilio
  //                      rejected the SMS. Show a copy-link button so
  //                      the broker can paste the URL into iMessage.
  //   • shareOn       — happy path, SMS delivered.
  const banner = shareError ? (
    <div style={SHARE_BANNER_BASE} role="alert">
      <span>⚠ Share failed: {shareError}</span>
    </div>
  ) : shareOn && shareSmsFailed ? (
    <div
      style={{
        ...SHARE_BANNER_BASE,
        background: '#7f1d1d',
        color: '#fecaca',
      }}
      role="alert"
    >
      <span>
        SMS to {shareSmsTo ?? 'client'} failed — copy the link and send
        it manually.
      </span>
      {shareLink && (
        <button
          type="button"
          onClick={copyShareLink}
          style={SHARE_BANNER_BTN}
        >
          {linkCopied ? '✓ Copied' : 'Copy link'}
        </button>
      )}
    </div>
  ) : shareOn ? (
    <div
      style={{
        ...SHARE_BANNER_BASE,
        background: '#064e3b',
        color: '#a7f3d0',
      }}
    >
      <span>✓ SMS sent to {shareSmsTo ?? 'client'} — they can join now.</span>
      {shareLink && (
        <button
          type="button"
          onClick={copyShareLink}
          style={SHARE_BANNER_BTN}
        >
          {linkCopied ? '✓ Copied' : 'Copy link'}
        </button>
      )}
    </div>
  ) : null;

  return (
    <>
    <div
      style={{
        background: 'linear-gradient(135deg, #0a1628 0%, #0d2f5e 100%)',
        padding: '6px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '2px solid #83f0f9',
        position: 'sticky',
        top: 0,
        zIndex: 100,
        flexWrap: 'wrap',
        gap: 6,
      }}
    >
      {/* Left: Brand + View Toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            fontFamily: "'Fraunces', Georgia, serif",
            fontSize: 15,
            color: '#83f0f9',
            fontWeight: 700,
          }}
        >
          PlanMatch
        </span>
        <button
          type="button"
          onClick={onToggleView}
          title={
            clientView
              ? 'Showing client-facing view (Broker Brain insights hidden)'
              : 'Showing agent view (Broker Brain insights visible)'
          }
          style={{
            background: clientView
              ? 'rgba(52,211,153,0.2)'
              : 'rgba(131,240,249,0.12)',
            border: `1px solid ${clientView ? '#34d399' : 'rgba(131,240,249,0.3)'}`,
            borderRadius: 5,
            padding: '2px 8px',
            fontSize: 10,
            color: clientView ? '#34d399' : '#83f0f9',
            fontWeight: 700,
            letterSpacing: 1,
            textTransform: 'uppercase',
            cursor: 'pointer',
          }}
        >
          {clientView ? '👁 Client' : '🧠 Agent'}
        </button>
      </div>

      {/* Center: Screen Nav */}
      <div style={{ display: 'flex', gap: 2 }}>
        {SCREENS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onNav(s)}
            style={{
              background: screen === s ? '#83f0f9' : 'rgba(255,255,255,0.04)',
              color: screen === s ? '#0d2f5e' : 'rgba(255,255,255,0.4)',
              border: 'none',
              borderRadius: 4,
              padding: '4px 8px',
              fontSize: 10,
              fontWeight: screen === s ? 700 : 500,
              cursor: 'pointer',
            }}
          >
            {LABELS[s]}
          </button>
        ))}
      </div>

      {/* Right: Call (deep-link) + Screen Share + Readiness + AgentBase */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Call — voice happens in AgentBase, not here. This is just a
            deep-link to the CRM so the broker doesn't have to swap tabs
            by hand mid-quote. Open in a named tab so repeat clicks
            focus the existing AgentBase window instead of stacking. */}
        <a
          href={agentBaseHref}
          target="agentbase-crm"
          rel="noreferrer"
          title="Place the call in AgentBase CRM"
          style={{
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 12,
            cursor: 'pointer',
            color: 'rgba(255,255,255,0.5)',
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            textDecoration: 'none',
          }}
        >
          📞 Call ↗
        </a>

        {/* Screen Share. When active the button flips to a red
            "Stop sharing" affordance with a pulsing dot — same visual
            language MiniSoftphone uses on /compare so the broker
            recognizes "I am live" at a glance. */}
        <button
          type="button"
          onClick={onCycleShare}
          disabled={shareStarting}
          title={shareOn ? 'Click to stop sharing' : 'Share screen with the client'}
          style={{
            background: shareOn
              ? 'rgba(239,68,68,0.18)'
              : 'rgba(255,255,255,0.06)',
            border: `1px solid ${shareOn ? '#ef4444' : 'rgba(255,255,255,0.15)'}`,
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 12,
            cursor: shareStarting ? 'wait' : 'pointer',
            color: shareOn ? '#fecaca' : 'rgba(255,255,255,0.5)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {shareOn ? (
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: '#ef4444',
                animation: 'pma3-pulse 1.2s ease-in-out infinite',
              }}
            />
          ) : (
            <span aria-hidden>🖥</span>
          )}
          {shareOn ? 'Stop sharing' : shareLabel}
        </button>

        {/* Compliance readiness */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <div
            style={{
              width: 60,
              height: 4,
              borderRadius: 2,
              background: 'rgba(255,255,255,0.1)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${complianceProgress}%`,
                height: '100%',
                background: complianceProgress >= 100 ? '#34d399' : '#f59e0b',
                borderRadius: 2,
                transition: 'width 0.4s',
              }}
            />
          </div>
          <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 9 }}>
            {Math.round(complianceProgress)}%
          </span>
        </div>

        {/* Finalist counter — Brain pick + kept plans, capped at 4.
            Renders the live count off the swipe state so the broker
            can see how close they are to the cap from any screen. */}
        <span
          title={`${finalistCount} of ${FINALIST_CAP} finalists selected`}
          style={{
            color: 'rgba(255,255,255,0.35)',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 0.3,
          }}
        >
          ✓{Math.min(finalistCount, FINALIST_CAP)}/{FINALIST_CAP}
        </span>

        {/* AgentBase link */}
        <a
          href={agentBaseHref}
          target="_blank"
          rel="noreferrer"
          style={{
            background: 'rgba(131,240,249,0.08)',
            border: '1px solid rgba(131,240,249,0.2)',
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 10,
            cursor: 'pointer',
            color: '#83f0f9',
            fontWeight: 700,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            textDecoration: 'none',
          }}
        >
          AgentBase ↗
        </a>
      </div>
    </div>
    {banner}
    </>
  );
}

const SHARE_BANNER_BASE = {
  position: 'sticky' as const,
  top: 38,
  zIndex: 99,
  padding: '6px 16px',
  fontSize: 12,
  fontWeight: 600,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  background: '#7f1d1d',
  color: '#fecaca',
};

const SHARE_BANNER_BTN = {
  background: 'rgba(255,255,255,0.15)',
  border: '1px solid rgba(255,255,255,0.3)',
  borderRadius: 4,
  padding: '2px 10px',
  fontSize: 11,
  fontWeight: 700,
  color: 'inherit',
  cursor: 'pointer',
};
