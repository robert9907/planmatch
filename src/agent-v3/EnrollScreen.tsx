// EnrollScreen — agent-v3 screen 8.
//
// Final summary of the recommended plan plus the HealthSherpa Medicare
// enrollment CTA. On click we POST the client to /api/healthsherpa/sync,
// which always returns a public consumer intake URL (Rob's branded
// medicare.healthsherpa.com/intake/robert-simm page). That URL opens in
// a new tab. Contact creation in Rob's HealthSherpa CRM happens as a
// best-effort side-effect server-side; failure logs to console but does
// not block the tab. The error UI here only fires on a real network /
// server-error failure (rare) — with a Retry button that resets state.

import { useState } from 'react';
import type { Plan } from '@/types/plans';
import { useSession } from '@/hooks/useSession';
import { Card, Container, Header, Nav, fmt } from './atoms';
import { annualEstimate } from './planDisplay';
import type { ComplianceSnapshot, AgentV3SessionSummary } from './agentbaseSync';
import { SECTIONS, DISCLAIMERS } from '@/lib/compliance';
import { useHealthSherpaEnroll } from './lib/useHealthSherpaEnroll';

interface Props {
  current: Plan | null;
  /** Full brain-ranked plan list, descending by composite score. */
  scoredPlans: Plan[];
  annualDrugByPlanId: Record<string, number | null>;
  /** Awaited AgentBase write-back. The button below blocks on the
   *  Promise so the broker can't open SunFire until the recommendation
   *  is saved (CMS audit + recovery-from-broker-tab-close). On error
   *  the toast surfaces the message and SunFire stays closed so the
   *  broker can retry without losing context. */
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

  // Toast state for the save-then-open HealthSherpa flow. status: idle
  // while the button sits, saving while AgentBase POST is in flight,
  // syncing while the HealthSherpa /v1/contacts round-trip is in
  // flight, saved on success (then HealthSherpa opens), error if either
  // leg failed (HealthSherpa stays closed; broker retries).
  const [saveStatus, setSaveStatus] = useState<
    'idle' | 'saving' | 'syncing' | 'saved' | 'error'
  >('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const enroll = useHealthSherpaEnroll();

  // Top brain-ranked plan that isn't the client's current — falls
  // back to scoredPlans[0] when there's no current on file (e.g.
  // an AEP shopper with no incumbent).
  const recommendedPlan: Plan | null =
    scoredPlans.find((p) => p.id !== current?.id) ?? scoredPlans[0] ?? null;

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

  return (
    <Container>
      <Header
        title="Enrollment confirmed"
        sub="All compliance items verified. Ready for HealthSherpa submission."
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
        <button
          type="button"
          disabled={saveStatus === 'saving'}
          onClick={async () => {
            if (saveStatus === 'saving' || saveStatus === 'syncing') return;
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
            if (!r.ok) {
              setSaveStatus('error');
              setSaveError(r.error);
              return;
            }
            // AgentBase save landed — now sync to HealthSherpa Partner
            // API. On success the hook opens the pre-filled redirect_url
            // in a new tab. On failure NO tab opens; we surface the
            // error so the broker can retry rather than land on the
            // agent login page.
            setSaveStatus('syncing');
            const result = await enroll.openEnrollment({
              client,
              plan: recommendedPlan,
            });
            if (result.ok) {
              setSaveStatus('saved');
            } else {
              setSaveStatus('error');
              setSaveError(result.error ?? 'HealthSherpa Partner API sync failed');
            }
          }}
          style={{
            display: 'inline-block',
            background:
              saveStatus === 'saving' || saveStatus === 'syncing'
                ? 'linear-gradient(135deg, #94a3b8, #64748b)'
                : 'linear-gradient(135deg, #059669, #047857)',
            color: 'white',
            border: 'none',
            borderRadius: 13,
            padding: '16px 50px',
            fontSize: 16,
            fontWeight: 800,
            cursor:
              saveStatus === 'saving' || saveStatus === 'syncing' ? 'wait' : 'pointer',
            boxShadow: '0 8px 30px rgba(5,150,105,0.3)',
            letterSpacing: 0.5,
            textDecoration: 'none',
          }}
        >
          {saveStatus === 'saving'
            ? 'Saving to AgentBase…'
            : saveStatus === 'syncing'
              ? 'Connecting to HealthSherpa…'
              : 'Save & Open HealthSherpa →'}
        </button>
        <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 6 }}>
          Pre-populated · NPN 10447418
        </div>

        {saveStatus === 'saved' && (
          <div
            role="status"
            style={{
              marginTop: 12,
              display: 'inline-block',
              background: 'rgba(5,150,105,0.08)',
              border: '1px solid rgba(5,150,105,0.3)',
              borderRadius: 8,
              color: '#047857',
              padding: '8px 14px',
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            ✓ Saved to AgentBase — HealthSherpa opening in a new tab.
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
              ⚠ HealthSherpa did not open — {saveError ?? 'unknown error'}.
            </div>
            <button
              type="button"
              onClick={() => {
                setSaveStatus('idle');
                setSaveError(null);
                enroll.reset();
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
 *  capture per-disclaimer ISO timestamps that flow through this helper. */
function buildComplianceSnapshot({
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

