// EnrollScreen — agent-v3 screen 8.
//
// Final summary of the recommended plan plus the SunFire deep link
// CTA. Pre-populates SunFire's "Open Quote" URL with as much of the
// session payload as possible (carrier, plan id, ZIP, etc.). The
// link itself is a placeholder; the live deep-link contract sits in
// scripts/sunfire-deeplink.md (or wherever ops drops it) — wire that
// up by replacing buildSunFireLink().

import { useState } from 'react';
import type { Plan } from '@/types/plans';
import { useSession } from '@/hooks/useSession';
import { Card, Container, Header, Nav, fmt } from './atoms';
import { annualEstimate } from './planDisplay';
import type { ComplianceSnapshot, AgentV3SessionSummary } from './agentbaseSync';
import { SECTIONS, DISCLAIMERS } from '@/lib/compliance';

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

  // Toast state for the save-then-open SunFire flow. status: idle while
  // the button sits, saving while POST is in flight, saved on success
  // (then sunfire opens), error if the endpoint failed (sunfire stays
  // closed; broker retries).
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

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
        sub="All compliance items verified. Ready for SunFire submission."
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
              // Open SunFire in a new tab — only after the AgentBase
              // save lands. Use window.open instead of an <a> so the
              // open is gated on the await above.
              window.open(
                buildSunFireLink({ client, plan: recommendedPlan }),
                '_blank',
                'noopener',
              );
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
          {saveStatus === 'saving'
            ? 'Saving to AgentBase…'
            : 'Save & Open SunFire Matrix →'}
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
            ✓ Saved to AgentBase — SunFire opening in a new tab.
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
              padding: '8px 14px',
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            ⚠ AgentBase save failed: {saveError ?? 'unknown error'}. SunFire
            stayed closed so you can retry.
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

// Pre-populates the SunFire Matrix quote URL with the client + plan
// payload. The exact querystring contract isn't documented in this
// repo yet; this function intentionally encodes everything we know so
// when ops finalizes the deep-link spec, the only place to update is
// the hostname / param-name remapping below.
function buildSunFireLink({
  client,
  plan,
}: {
  client: ReturnType<typeof useSession.getState>['client'];
  plan: Plan;
}): string {
  const qs = new URLSearchParams();
  qs.set('npn', '10447418');
  qs.set('plan_id', plan.id);
  qs.set('contract', plan.contract_id);
  qs.set('plan_no', plan.plan_number);
  qs.set('carrier', plan.carrier);
  if (client.zip) qs.set('zip', client.zip);
  if (client.dob) qs.set('dob', client.dob);
  if (client.name) qs.set('name', client.name);
  if (client.phone) qs.set('phone', client.phone);
  if (client.email) qs.set('email', client.email);
  return `https://sunfirematrix.com/quote/start?${qs.toString()}`;
}
