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
import {
  PLAN_CATALOG_CUTOVER_MS,
  resolvePlanCatalogYear,
} from '../../api/library/planCatalogYear';
import { planYearOverride } from '../../api/library/planYearOverride';

// 8-screen agent flow: Client → Disclaimers → Meds → Providers →
// Priorities → Compare (4-up grid + H2H toggle) → Compliance →
// Enroll. The Disclaimers screen sits between Client and Meds —
// CMS requires the TPMO / call-recording / SOA verbatim reads to
// happen BEFORE any plan discussion (meds inventory counts as plan
// discussion). The Plans/Swipe deck collapsed into the Compare
// board, which now seeds slots directly from the brain's elimination
// funnel.
export type ScreenId =
  | 'intake'
  | 'disclaimers'
  | 'meds'
  | 'providers'
  | 'priorities'
  | 'compare'
  | 'compliance'
  | 'enroll';

export const SCREENS: ScreenId[] = [
  'intake',
  'disclaimers',
  'meds',
  'providers',
  'priorities',
  'compare',
  'compliance',
  'enroll',
];

const LABELS: Record<ScreenId, string> = {
  intake: 'Client',
  disclaimers: 'Disclaimers',
  meds: 'Meds',
  providers: 'Providers',
  priorities: 'Priorities',
  compare: 'Compare',
  compliance: 'Compliance',
  enroll: 'Enroll',
};

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
  /** href for the "AgentBase ↗" jump link AND the new "Call" button.
   *  Defaults to the prod CRM where the broker actually places the
   *  call. */
  agentBaseHref?: string;
}

// ─── Plan-year control ───────────────────────────────────────────────
//
// Which catalog year this quote is being built from, and a one-click
// switch to the other one.
//
// Why it exists: the catalog year is date-driven and flips at the Oct 15
// cutover, but CMS permits marketing next-year plans from Oct 1. Without
// this, a broker quoting during Oct 1-14 can only pull the current year
// while the consumer site already shows next year's plans. After the
// cutover it runs the other way — pinning the prior year for the mid-year
// SEP and effective-date work that continues through Dec 31.
//
// Why it RELOADS instead of setting React state: the Part D structural
// constants in DrugCostCard, PartDTimelineOverlay and plan-brain-utils
// resolve ONCE at module load. Flipping the year in state would leave those
// pinned to the old year while plan rows came back as the new one — pricing
// a 2027 plan with 2026 phase thresholds, the exact defect PR #26 fixed. A
// reload re-evaluates every module against one year, so the surface cannot
// go internally inconsistent. The broker is between quotes when they click.
//
// The pill goes amber whenever the active year is NOT the date default, so
// "I am pinned to a year I did not mean to be" is visible at a glance
// instead of being discovered from a wrong number on a client's quote.
const KNOWN_YEARS = [2026, 2027] as const;

function PlanYearPill() {
  const active = resolvePlanCatalogYear();
  const dateDefault = Date.now() >= PLAN_CATALOG_CUTOVER_MS ? 2027 : 2026;
  const pinned = planYearOverride() !== null && active !== dateDefault;
  const other = KNOWN_YEARS.find((y) => y !== active) ?? dateDefault;

  function switchTo(year: number) {
    const url = new URL(window.location.href);
    if (year === dateDefault) {
      url.searchParams.delete('plan_year');
    } else {
      url.searchParams.set('plan_year', String(year));
    }
    window.location.assign(url.toString());
  }

  return (
    <button
      type="button"
      onClick={() => switchTo(other)}
      title={
        pinned
          ? `Quoting PY${active} — pinned, not the ${dateDefault} default. Click for ${other}.`
          : `Quoting PY${active}. Click to switch to ${other}.`
      }
      style={{
        background: pinned ? 'rgba(245,158,11,0.18)' : 'rgba(131,240,249,0.12)',
        border: `1px solid ${pinned ? '#f59e0b' : 'rgba(131,240,249,0.3)'}`,
        borderRadius: 5,
        padding: '2px 8px',
        fontSize: 10,
        color: pinned ? '#fbbf24' : '#83f0f9',
        fontWeight: 700,
        letterSpacing: 1,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {pinned ? `PY${active} · pinned` : `PY${active}`}
    </button>
  );
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
  agentBaseHref = 'https://crm.generationhealth.me/',
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
        <PlanYearPill />
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
