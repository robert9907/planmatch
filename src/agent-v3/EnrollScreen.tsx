// EnrollScreen — agent-v3 screen 8.
//
// Final review + save to AgentBase. The recommendation, meds, providers,
// and compliance snapshot are POSTed to /api/agentbase-recommend; the
// broker then jumps to the AgentBase client card to review and submit
// to HealthSherpa from there (the CRM has its own "Open in HealthSherpa"
// button with the full contact record). Plan Match does NOT touch
// HealthSherpa directly — keeping the enrollment funnel in one place
// (AgentBase) makes CMS audit + duplicate-contact avoidance simpler.

import { useState } from 'react';
import type { Plan } from '@/types/plans';
import { useSession } from '@/hooks/useSession';
import { Card, Container, Header, Nav, fmt } from './atoms';
import { annualEstimate } from './planDisplay';
import type { ComplianceSnapshot, AgentV3SessionSummary } from './agentbaseSync';
import { SECTIONS, DISCLAIMERS } from '@/lib/compliance';

// AgentBase CRM base URL — mirrors AGENTBASE_CRM_URL on the server
// (api/agentbase-recommend.ts:37). Client card URL pattern is
// <base>/clients/<id>; if the AgentBase clientId isn't pinned in the URL
// (broker landed via seed / hand-key path), we fall back to the CRM
// home so the broker still has a one-click jump.
const AGENTBASE_CRM_BASE = 'https://agentbase-crm.vercel.app';

function readClientIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const v = new URLSearchParams(window.location.search).get('clientId');
  return v && v.trim() ? v.trim() : null;
}

interface Props {
  current: Plan | null;
  /** Full brain-ranked plan list, descending by composite score. */
  scoredPlans: Plan[];
  annualDrugByPlanId: Record<string, number | null>;
  /** Awaited AgentBase write-back. The button below blocks on the
   *  Promise so the broker can't jump to the client card until the
   *  recommendation is saved. On error the toast surfaces the message
   *  and the Retry button re-fires the same POST. */
  onRecommend?: (
    plan: Plan,
    snapshot: { compliance: ComplianceSnapshot; sessionSummary: AgentV3SessionSummary },
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  onBack: () => void;
}

export function EnrollScreen({
  current,
  scoredPlans,
  annualDrugByPlanId,
  onRecommend,
  onBack,
}: Props) {
  const client = useSession((s) => s.client);
  const providers = useSession((s) => s.providers);
  const medications = useSession((s) => s.medications);
  const complianceChecked = useSession((s) => s.complianceChecked);
  const disclaimersConfirmed = useSession((s) => s.disclaimersConfirmed);
  const complianceTimestamps = useSession((s) => s.complianceTimestamps);
  const disclaimerTimestamps = useSession((s) => s.disclaimerTimestamps);
  const resetSession = useSession((s) => s.resetSession);
  const recommendationId = useSession((s) => s.recommendation);

  // Save-to-AgentBase state machine.
  //   idle    — button ready
  //   saving  — /api/agentbase-recommend POST in flight
  //   saved   — 2xx; success card renders with jump-to-CRM buttons
  //   error   — non-2xx or network failure; Retry re-fires the same POST
  const [saveStatus, setSaveStatus] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  // Prefer the broker's explicit Compare pick (session.recommendation);
  // fall back to the top brain-ranked non-incumbent otherwise (e.g. an
  // AEP shopper with no incumbent, or the broker jumped past Compare).
  const recommendedPlan: Plan | null =
    (recommendationId
      ? scoredPlans.find((p) => p.id === recommendationId)
      : null) ??
    scoredPlans.find((p) => p.id !== current?.id) ??
    scoredPlans[0] ??
    null;

  if (!recommendedPlan) {
    return (
      <Container>
        <Header
          title="Pick a finalist first"
          sub="Run the Compare screen to surface a recommendation."
        />
        <Nav onBack={onBack} />
      </Container>
    );
  }

  const candAnnual = annualEstimate(recommendedPlan, annualDrugByPlanId[recommendedPlan.id] ?? null).total;
  const curAnnual = current
    ? annualEstimate(current, annualDrugByPlanId[current.id] ?? null).total
    : null;
  const saved = candAnnual != null && curAnnual != null ? curAnnual - candAnnual : null;

  const clientId = readClientIdFromUrl();
  const clientCardUrl = clientId
    ? `${AGENTBASE_CRM_BASE}/clients/${clientId}`
    : AGENTBASE_CRM_BASE;

  function startNewSession() {
    resetSession();
    // Drop ?clientId= (and any other seed params) so the next Intake
    // starts clean instead of re-hydrating from the completed client.
    if (typeof window !== 'undefined') {
      window.location.href = window.location.pathname;
    }
  }

  return (
    <Container>
      <Header
        title="Ready to save"
        sub="Review the recommendation and save to the AgentBase client card. Submit to HealthSherpa from the CRM."
      />
      <Card style={{ border: '2px solid #059669' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 14,
            gap: 12,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 9,
                fontWeight: 700,
                color: '#64748b',
                textTransform: 'uppercase',
              }}
            >
              {recommendedPlan.carrier}
            </div>
            <div
              style={{
                fontFamily: "'Fraunces', Georgia, serif",
                fontSize: 18,
                fontWeight: 700,
                color: '#0d2f5e',
              }}
            >
              {recommendedPlan.plan_name}
            </div>
          </div>
          <span
            style={{
              background: 'linear-gradient(135deg,#059669,#047857)',
              color: 'white',
              fontWeight: 800,
              fontSize: 9,
              padding: '3px 10px',
              borderRadius: 5,
            }}
          >
            ★ Recommended
          </span>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 8,
            marginBottom: 14,
          }}
        >
          <Stat label="Premium" value={recommendedPlan.premium === 0 ? '$0' : `$${recommendedPlan.premium}`} green={recommendedPlan.premium === 0} />
          <Stat
            label="Est. Annual Drugs"
            value={
              annualDrugByPlanId[recommendedPlan.id] != null
                ? fmt(annualDrugByPlanId[recommendedPlan.id]!)
                : '—'
            }
          />
          <Stat
            label="Annual Savings"
            value={saved != null && saved > 0 ? fmt(saved) : '—'}
            green={saved != null && saved > 0}
          />
        </div>

        <div
          style={{
            borderTop: '1px solid #e2e8f0',
            paddingTop: 12,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 6,
            fontSize: 11,
          }}
        >
          <div>
            <span style={{ color: '#64748b' }}>Client:</span>{' '}
            <strong>{client.name || '—'}</strong>
          </div>
          <div>
            <span style={{ color: '#64748b' }}>County:</span>{' '}
            <strong>
              {client.county ? `${client.county}, ${client.state}` : '—'}
            </strong>
          </div>
          <div>
            <span style={{ color: '#64748b' }}>Provider:</span>{' '}
            <strong>{providers[0]?.name ?? '—'}</strong>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <span style={{ color: '#64748b' }}>Meds:</span>{' '}
            <strong>{medications.map((m) => m.name).join(', ') || '—'}</strong>
          </div>
        </div>
      </Card>

      <div style={{ textAlign: 'center', marginTop: 20 }}>
        {saveStatus !== 'saved' && (
          <>
            <button
              type="button"
              disabled={saveStatus === 'saving'}
              onClick={async () => {
                if (saveStatus === 'saving') return;
                setSaveStatus('saving');
                setSaveError(null);
                const compliance = buildComplianceSnapshot({
                  complianceChecked,
                  disclaimersConfirmed,
                  complianceTimestamps,
                  disclaimerTimestamps,
                });
                const sessionSummary: AgentV3SessionSummary = {
                  zip: client.zip,
                  county: client.county,
                  planYear: 2026,
                  estimatedAnnualCost: candAnnual ?? undefined,
                };
                const r = await (onRecommend?.(recommendedPlan, { compliance, sessionSummary }) ??
                  Promise.resolve<{ ok: true } | { ok: false; error: string }>({ ok: true }));
                if (r.ok) {
                  setSaveStatus('saved');
                } else {
                  setSaveStatus('error');
                  setSaveError(r.error);
                }
              }}
              style={{
                display: 'inline-block',
                background:
                  saveStatus === 'saving'
                    ? 'linear-gradient(135deg, #94a3b8, #64748b)'
                    : 'linear-gradient(135deg, #059669, #047857)',
                color: 'white',
                border: 'none',
                borderRadius: 13,
                padding: '16px 50px',
                fontSize: 16,
                fontWeight: 800,
                cursor: saveStatus === 'saving' ? 'wait' : 'pointer',
                boxShadow: '0 8px 30px rgba(5,150,105,0.3)',
                letterSpacing: 0.5,
                textDecoration: 'none',
              }}
            >
              {saveStatus === 'saving' ? 'Saving to AgentBase…' : 'Save to AgentBase ✓'}
            </button>
            <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 6 }}>
              Pre-populated · NPN 10447418
            </div>
          </>
        )}

        {saveStatus === 'saved' && (
          <div
            role="status"
            style={{
              marginTop: 4,
              display: 'inline-block',
              background: 'rgba(5,150,105,0.08)',
              border: '2px solid rgba(5,150,105,0.4)',
              borderRadius: 12,
              color: '#047857',
              padding: '18px 22px',
              textAlign: 'center',
              maxWidth: 520,
            }}
          >
            <div style={{ fontSize: 32, lineHeight: 1, marginBottom: 6 }}>✓</div>
            <div
              style={{
                fontFamily: "'Fraunces', Georgia, serif",
                fontSize: 18,
                fontWeight: 800,
                color: '#065f46',
                marginBottom: 4,
              }}
            >
              Recommendation saved to AgentBase
            </div>
            <div
              style={{
                fontSize: 12,
                color: '#047857',
                fontWeight: 600,
                marginBottom: 12,
              }}
            >
              {client.name || 'Client'} · {recommendedPlan.carrier} ·{' '}
              {recommendedPlan.plan_name}
            </div>
            <div style={{ fontSize: 11, color: '#065f46', marginBottom: 14 }}>
              Open the client card in AgentBase to review and submit to HealthSherpa.
            </div>
            <div
              style={{
                display: 'flex',
                gap: 10,
                justifyContent: 'center',
                flexWrap: 'wrap',
              }}
            >
              <a
                href={clientCardUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-block',
                  background: 'linear-gradient(135deg, #059669, #047857)',
                  color: 'white',
                  padding: '10px 20px',
                  borderRadius: 10,
                  fontSize: 13,
                  fontWeight: 800,
                  textDecoration: 'none',
                  letterSpacing: 0.3,
                }}
              >
                Open Client Card →
              </a>
              <button
                type="button"
                onClick={startNewSession}
                style={{
                  background: 'white',
                  color: '#065f46',
                  border: '1px solid #047857',
                  borderRadius: 10,
                  padding: '10px 20px',
                  fontSize: 13,
                  fontWeight: 800,
                  cursor: 'pointer',
                  letterSpacing: 0.3,
                }}
              >
                Start New Session
              </button>
            </div>
          </div>
        )}
        {saveStatus === 'error' && (
          <div
            role="alert"
            style={{
              marginTop: 12,
              display: 'inline-block',
              background: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: 8,
              color: '#7f1d1d',
              padding: '10px 14px',
              fontSize: 12,
              fontWeight: 700,
              textAlign: 'left',
              maxWidth: 460,
            }}
          >
            <div style={{ marginBottom: 6 }}>
              ⚠ Save to AgentBase failed — {saveError ?? 'unknown error'}.
            </div>
            <button
              type="button"
              onClick={() => {
                setSaveStatus('idle');
                setSaveError(null);
              }}
              style={{
                background: '#7f1d1d',
                color: 'white',
                border: 'none',
                borderRadius: 6,
                padding: '6px 14px',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Retry
            </button>
          </div>
        )}
      </div>

      <Nav onBack={onBack} />
    </Container>
  );
}

/** Derives the ComplianceSnapshot the recommend endpoint expects from
 *  the session's array-of-IDs compliance model. The 13-item discussion
 *  checklist + 3 verbatim disclaimers map down to 5 named booleans CMS
 *  reviewers actually look at:
 *    soaConfirmed              ← disclaimersConfirmed includes 'soa'
 *    callRecordingDisclosed    ← disclaimersConfirmed includes 'call_recording'
 *    scopeConfirmed            ← disclaimersConfirmed includes 'tpmo'
 *                                 (TPMO is what scopes the conversation)
 *    moopExplained             ← complianceChecked includes 'plan_costs'
 *    formularyExplained        ← complianceChecked includes 'formulary_tiers'
 *    networkExplained          ← complianceChecked includes 'plan_network'
 *    consentRecorded           ← all 16 items confirmed (the gate fires
 *                                 only after the broker has worked
 *                                 through every checklist row)
 *  Timestamps are passed as null here; Fix 3 wires the session store to
 *  capture per-disclaimer ISO timestamps that flow through this helper.
 *  Exported so ComplianceScreen's save-to-AgentBase gate can build the
 *  same snapshot shape without duplicating the mapping logic. */
export function buildComplianceSnapshot({
  complianceChecked,
  disclaimersConfirmed,
  complianceTimestamps,
  disclaimerTimestamps,
}: {
  complianceChecked: string[];
  disclaimersConfirmed: string[];
  complianceTimestamps: Record<string, string>;
  disclaimerTimestamps: Record<string, string>;
}): ComplianceSnapshot {
  const hasDisc = (id: string) => disclaimersConfirmed.includes(id);
  const hasItem = (id: string) => complianceChecked.includes(id);
  const allChecklistItemIds = SECTIONS.flatMap((s) => s.items.map((i) => i.id));
  const allItemsDone =
    allChecklistItemIds.every(hasItem) && DISCLAIMERS.every((d) => hasDisc(d.id));
  // consentRecordedAt is the latest of all stamps once everything is
  // confirmed — i.e. the time the broker finished the checklist. CMS
  // reviewers want the moment full consent landed, not the start of
  // the call.
  const allTimestamps = [
    ...Object.values(complianceTimestamps),
    ...Object.values(disclaimerTimestamps),
  ];
  const consentRecordedAt =
    allItemsDone && allTimestamps.length > 0
      ? allTimestamps.reduce((a, b) => (a > b ? a : b))
      : null;
  return {
    soaConfirmed: hasDisc('soa'),
    soaConfirmedAt: disclaimerTimestamps['soa'] ?? null,
    scopeConfirmed: hasDisc('tpmo'),
    moopExplained: hasItem('plan_costs'),
    formularyExplained: hasItem('formulary_tiers'),
    networkExplained: hasItem('plan_network'),
    consentRecorded: allItemsDone,
    consentRecordedAt,
    callRecordingDisclosed: hasDisc('call_recording'),
    callRecordingDisclosedAt: disclaimerTimestamps['call_recording'] ?? null,
  };
}

function Stat({
  label,
  value,
  green,
}: {
  label: string;
  value: string;
  green?: boolean;
}) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div
        style={{
          fontSize: 9,
          color: '#64748b',
          fontWeight: 600,
          textTransform: 'uppercase',
          marginBottom: 3,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "'Fraunces', Georgia, serif",
          fontSize: 20,
          fontWeight: 800,
          color: green ? '#059669' : '#0d2f5e',
        }}
      >
        {value}
      </div>
    </div>
  );
}

