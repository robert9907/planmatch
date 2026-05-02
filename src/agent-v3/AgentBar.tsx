// AgentBar — sticky top nav for the agent-v3 shell.
//
// Mockup chrome ported verbatim. Live wires:
//   • screen nav   → AgentV3App's setScreen
//   • view toggle  → cosmetic (controls AgentInsight visibility)
//   • phone        → AgentV3App opens/closes the PhonePanel; the
//                    button color reflects the live softphone state
//                    (idle vs connecting/ringing/connected) so the
//                    broker can see the call status without opening
//                    the panel
//   • share cycle  → useScreenShareStore.start / stop. The mockup
//                    cycles off → desktop → mobile, but the existing
//                    share backend is a single Twilio Video Room
//                    (no desktop/mobile distinction yet) so we collapse
//                    that to off → on. Documented in screenShareLabel
//                    so a future split is a single-place change.
//   • compliance   → percent of Object.values(checks).filter(Boolean)
//                    forwarded by AgentV3App. Bar turns green at 100%.
//   • AgentBase ↗  → opens robert9907/agentbase-crm in a new tab. The
//                    real "save session" button stays inside the
//                    workflow (existing SaveSessionButton); this is
//                    just a quick-jump to the CRM dashboard so the
//                    broker can verify a hydrated client mid-call.

import type { SoftphoneState } from '@/hooks/useSoftphone';

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
  phoneActive: boolean;
  phoneState: SoftphoneState;
  onTogglePhone: () => void;
  shareOn: boolean;
  shareStarting: boolean;
  onCycleShare: () => void;
  complianceProgress: number;
  /** Brain pick + user-kept plans, capped at FINALIST_CAP. */
  finalistCount: number;
  /** href for the "AgentBase ↗" jump link. Defaults to the prod CRM. */
  agentBaseHref?: string;
}

export function AgentBar({
  screen,
  onNav,
  clientView,
  onToggleView,
  phoneActive,
  phoneState,
  onTogglePhone,
  shareOn,
  shareStarting,
  onCycleShare,
  complianceProgress,
  finalistCount,
  agentBaseHref = 'https://agentbase-crm.vercel.app/',
}: Props) {
  // The phone button reflects the live softphone state so the broker
  // doesn't need to open the panel to see they're on a call.
  const phoneLive = phoneState === 'connected' || phoneState === 'on-hold';
  const phoneLabel = phoneLive
    ? 'On Call'
    : phoneState === 'ringing' || phoneState === 'connecting'
      ? 'Ringing…'
      : phoneActive
        ? 'Open'
        : 'Call';
  const phoneHot = phoneLive || phoneActive;

  const shareLabel = shareStarting ? 'Starting…' : shareOn ? 'Sharing' : 'Share';

  return (
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

      {/* Right: Phone + Screen Share + Readiness + AgentBase */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Phone */}
        <button
          type="button"
          onClick={onTogglePhone}
          style={{
            background: phoneHot
              ? 'rgba(52,211,153,0.2)'
              : 'rgba(255,255,255,0.06)',
            border: `1px solid ${phoneHot ? '#34d399' : 'rgba(255,255,255,0.15)'}`,
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 12,
            cursor: 'pointer',
            color: phoneHot ? '#34d399' : 'rgba(255,255,255,0.5)',
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          📞 {phoneLabel}
        </button>

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
  );
}
