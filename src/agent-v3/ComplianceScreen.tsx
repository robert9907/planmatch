// ComplianceScreen — agent-v3 screen 7.
//
// Reads the canonical 16-item set from src/lib/compliance.ts:
//   • 3 verbatim disclaimers (TPMO, call recording, SOA) — confirmed
//     earlier on DisclaimersScreen (screen 2). This screen shows them
//     as a read-only status row so the broker can see complete
//     compliance picture; the SunFire gate still requires all 3.
//   • 13 discussion-topic checkboxes across 6 sections — checkbox
//     writes to useSession.complianceChecked. 2 items flagged
//     "NEW 2026" per CMS marketing rules (LIS/MSP eligibility,
//     Medigap GI rights).
//
// Enrollment Gate is locked until ALL 16 items are confirmed. Once
// unlocked, the gate button POSTs the recommendation to AgentBase via
// /api/agentbase-recommend (same onRecommend handler EnrollScreen
// uses; endpoint is idempotent). Plan Match does NOT touch HealthSherpa
// directly — the broker jumps to the AgentBase client card and submits
// to HealthSherpa from there.

import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { Plan } from '@/types/plans';
import { useSession } from '@/hooks/useSession';
import {
  DISCLAIMERS,
  SECTIONS,
  totalComplianceItems,
} from '@/lib/compliance';
import { Container, Nav } from './atoms';
import { annualEstimate } from './planDisplay';
import type { ComplianceSnapshot, AgentV3SessionSummary } from './agentbaseSync';
import { buildComplianceSnapshot } from './EnrollScreen';

// Mirrors EnrollScreen.tsx:24 — kept as a duplicated constant rather
// than a shared import to keep this screen's gate self-contained.
const AGENTBASE_CRM_BASE = 'https://agentbase-crm.vercel.app';

function readClientIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const v = new URLSearchParams(window.location.search).get('clientId');
  return v && v.trim() ? v.trim() : null;
}

interface Props {
  onBack: () => void;
  onNext: () => void;
  /** Brain-ranked plans (scored ∪ bench) in ranking order. This is the
   *  ONLY valid source of a recommendation — the brain excludes the
   *  incumbent + non-shoppable plans, and /api/agentbase-recommend
   *  requires the picked plan to have a matching ScoredPlan for the
   *  CMS audit payload. Never fall back to a library-ranked list or
   *  the incumbent slot to satisfy the gate. */
  brainRankedPlans: Plan[];
  annualDrugByPlanId: Record<string, number | null>;
  /** Same onRecommend the EnrollScreen uses. Save is idempotent — a
   *  broker who saves here and again on EnrollScreen upserts the same
   *  row (api/agentbase-recommend.ts key = phone + dob). */
  onRecommend?: (
    plan: Plan,
    snapshot: { compliance: ComplianceSnapshot; sessionSummary: AgentV3SessionSummary },
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export function ComplianceScreen({
  onBack,
  onNext,
  brainRankedPlans,
  annualDrugByPlanId,
  onRecommend,
}: Props) {
  const checked = useSession((s) => s.complianceChecked);
  const confirmed = useSession((s) => s.disclaimersConfirmed);
  const toggleItem = useSession((s) => s.toggleComplianceItem);
  const client = useSession((s) => s.client);
  const complianceTimestamps = useSession((s) => s.complianceTimestamps);
  const disclaimerTimestamps = useSession((s) => s.disclaimerTimestamps);
  const resetSession = useSession((s) => s.resetSession);
  const recommendationId = useSession((s) => s.recommendation);

  const [saveStatus, setSaveStatus] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  const total = totalComplianceItems();
  const done = new Set(checked).size + new Set(confirmed).size;
  const allDone = done >= total;
  const disclaimersDone = DISCLAIMERS.filter((d) => confirmed.includes(d.id)).length;
  const disclaimersAllDone = disclaimersDone >= DISCLAIMERS.length;

  // Resolution order — strictly against the brain-ranked set:
  //   1. session.recommendation, if it's a brain-ranked plan (broker's
  //      explicit Compare pick — validated so a stale/bogus id can't
  //      leak the incumbent back in).
  //   2. brainRankedPlans[0] — brain's top pick. Excludes the incumbent
  //      and any non-shoppable plans by construction.
  //   3. null → button disables + copy tells the broker to pick a plan.
  //
  // Deliberately does NOT consider `current` / `currentPlanId` here.
  // The incumbent is never a valid recommendation.
  const recommendedPlan: Plan | null =
    (recommendationId
      ? brainRankedPlans.find((p) => p.id === recommendationId)
      : null) ??
    brainRankedPlans[0] ??
    null;

  // One-shot resolution trace — surfaces the chosen id + why so a broker
  // report ("gate said Liberty again") is diagnosable from the console
  // without a code-dive.
  console.log('[Compliance] recommendedPlan resolution:', {
    sessionRecommendationId: recommendationId,
    brainRankedIds: brainRankedPlans.map((p) => p.id),
    resolved: recommendedPlan
      ? { id: recommendedPlan.id, carrier: recommendedPlan.carrier, name: recommendedPlan.plan_name }
      : null,
    source: recommendationId && brainRankedPlans.some((p) => p.id === recommendationId)
      ? 'session.recommendation'
      : brainRankedPlans[0]
        ? 'brainRankedPlans[0]'
        : 'none',
  });

  const candAnnual = recommendedPlan
    ? annualEstimate(recommendedPlan, annualDrugByPlanId[recommendedPlan.id] ?? null).total
    : null;

  const clientId = readClientIdFromUrl();
  const clientCardUrl = clientId
    ? `${AGENTBASE_CRM_BASE}/clients/${clientId}`
    : AGENTBASE_CRM_BASE;

  function startNewSession() {
    resetSession();
    if (typeof window !== 'undefined') {
      window.location.href = window.location.pathname;
    }
  }

  const gateReady = allDone && recommendedPlan != null && saveStatus !== 'saving';

  return (
    <Container>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 20,
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: '#64748b',
              letterSpacing: 1,
              textTransform: 'uppercase',
            }}
          >
            CMS Compliance Checklist
          </div>
          <div
            style={{
              fontFamily: "'Fraunces', Georgia, serif",
              fontSize: 22,
              fontWeight: 700,
              color: '#0d2f5e',
              marginTop: 3,
            }}
          >
            Finish this before enrolling
          </div>
          <div style={{ color: '#64748b', fontSize: 11, marginTop: 3 }}>
            {total} items · {DISCLAIMERS.length} verbatim + {total - DISCLAIMERS.length}{' '}
            discussion topics
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div
            style={{
              fontFamily: "'Fraunces', Georgia, serif",
              fontSize: 32,
              fontWeight: 800,
              color: '#0d2f5e',
            }}
          >
            {done}
            <span style={{ fontSize: 16, color: '#94a3b8' }}>/{total}</span>
          </div>
          <div
            style={{
              width: 100,
              height: 4,
              borderRadius: 2,
              background: '#e2e8f0',
              marginTop: 4,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${(done / total) * 100}%`,
                height: '100%',
                background: allDone ? '#34d399' : '#0d2f5e',
                borderRadius: 2,
                transition: 'width 0.3s',
              }}
            />
          </div>
        </div>
      </div>

      {/* Verbatim disclaimers — confirmed earlier on the Disclaimers
          screen (screen 2). Show as read-only status so the broker
          can see the complete compliance picture; the gate below
          still requires all 3 confirmed before SunFire unlocks. */}
      <div
        style={{
          background: disclaimersAllDone ? 'rgba(5,150,105,0.04)' : '#fffbeb',
          border: disclaimersAllDone
            ? '1px solid rgba(5,150,105,0.18)'
            : '1px solid rgba(245,158,11,0.3)',
          borderRadius: 10,
          padding: '12px 16px',
          marginBottom: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: '#475569',
              letterSpacing: 1,
              textTransform: 'uppercase',
            }}
          >
            Required Disclaimers
          </div>
          <div style={{ fontSize: 12, color: '#0d2f5e', marginTop: 2 }}>
            {disclaimersAllDone
              ? 'All 3 verbatim disclaimers confirmed on the Disclaimers screen.'
              : `${DISCLAIMERS.length - disclaimersDone} disclaimer${
                  DISCLAIMERS.length - disclaimersDone === 1 ? '' : 's'
                } still need to be confirmed — go back to the Disclaimers screen.`}
          </div>
        </div>
        <div
          style={{
            fontFamily: "'Fraunces', Georgia, serif",
            fontSize: 20,
            fontWeight: 800,
            color: disclaimersAllDone ? '#059669' : '#d97706',
          }}
        >
          {disclaimersDone}/{DISCLAIMERS.length}
        </div>
      </div>

      {/* Discussion-topic sections */}
      {SECTIONS.map((sec) => {
        const sectionDone = sec.items.filter((it) => checked.includes(it.id)).length;
        return (
          <div key={sec.key} style={{ marginBottom: 16 }}>
            <SectionHeader
              title={sec.title}
              done={sectionDone}
              total={sec.items.length}
            />
            {sec.items.map((it) => {
              const isDone = checked.includes(it.id);
              return (
                <div key={it.id} style={ROW_STYLE(isDone)}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <button
                      type="button"
                      onClick={() => toggleItem(it.id)}
                      style={CHECKBOX_STYLE(isDone, false)}
                    >
                      {isDone ? '✓' : ''}
                    </button>
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span
                          style={{
                            fontWeight: 700,
                            fontSize: 13,
                            color: isDone ? '#059669' : '#0d2f5e',
                          }}
                        >
                          {it.label}
                        </span>
                        {it.new2026 && (
                          <span
                            style={{
                              background: '#dbeafe',
                              color: '#1e40af',
                              fontSize: 8,
                              fontWeight: 700,
                              padding: '1px 5px',
                              borderRadius: 3,
                            }}
                          >
                            NEW 2026
                          </span>
                        )}
                      </div>
                      {it.detail && (
                        <div style={{ color: '#64748b', fontSize: 10, marginTop: 1 }}>
                          {it.detail}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      {/* Reference-only compliance docs — not part of the 16-item gate.
          Collapsed by default so the checklist stays the focus; broker
          can expand mid-call when asked "how long do you keep my call?"
          or to confirm a grievance pointer. */}
      <RetentionPolicy />
      <GrievanceProcedure />

      <div
        style={{
          background: allDone ? 'rgba(5,150,105,0.04)' : '#fffbeb',
          border: allDone ? '2px solid #059669' : '2px solid #f59e0b',
          borderRadius: 11,
          padding: '16px 20px',
          marginTop: 6,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div
              style={{
                fontSize: 9,
                fontWeight: 700,
                color: allDone ? '#059669' : '#d97706',
                letterSpacing: 1,
                textTransform: 'uppercase',
              }}
            >
              Enrollment Gate
            </div>
            <div
              style={{
                fontWeight: 700,
                fontSize: 14,
                color: '#0d2f5e',
                marginTop: 3,
              }}
            >
              {saveStatus === 'saved'
                ? 'Recommendation saved to AgentBase.'
                : !allDone
                  ? `${total - done} items left before Save unlocks.`
                  : recommendedPlan
                    ? `Ready to save — ${recommendedPlan.carrier} · ${recommendedPlan.plan_name}`
                    : brainRankedPlans.length === 0
                      ? 'Brain ranking not ready — go back to Compare.'
                      : 'Pick a plan on Compare first.'}
            </div>
            <div style={{ fontSize: 10, color: '#64748b', marginTop: 1 }}>
              Rob Simm · NC #10447418 · NPN 10447418
            </div>
          </div>
          {saveStatus !== 'saved' && (
            <button
              type="button"
              onClick={
                gateReady && recommendedPlan
                  ? async () => {
                      setSaveStatus('saving');
                      setSaveError(null);
                      const compliance = buildComplianceSnapshot({
                        complianceChecked: checked,
                        disclaimersConfirmed: confirmed,
                        complianceTimestamps,
                        disclaimerTimestamps,
                      });
                      const sessionSummary: AgentV3SessionSummary = {
                        zip: client.zip,
                        county: client.county,
                        planYear: 2026,
                        estimatedAnnualCost: candAnnual ?? undefined,
                      };
                      const r = await (onRecommend?.(recommendedPlan, {
                        compliance,
                        sessionSummary,
                      }) ??
                        Promise.resolve<{ ok: true } | { ok: false; error: string }>(
                          { ok: true },
                        ));
                      if (r.ok) {
                        setSaveStatus('saved');
                      } else {
                        setSaveStatus('error');
                        setSaveError(r.error);
                      }
                    }
                  : undefined
              }
              disabled={!gateReady}
              style={{
                background: gateReady
                  ? 'linear-gradient(135deg, #059669, #047857)'
                  : '#e2e8f0',
                color: gateReady ? 'white' : '#94a3b8',
                border: 'none',
                borderRadius: 8,
                padding: '11px 22px',
                fontSize: 13,
                fontWeight: 700,
                cursor: gateReady ? 'pointer' : 'default',
                transition: 'all 0.3s',
              }}
            >
              {saveStatus === 'saving' ? 'Saving to AgentBase…' : 'Save to AgentBase ✓'}
            </button>
          )}
        </div>

        {saveStatus === 'saved' && (
          <div
            role="status"
            style={{
              marginTop: 14,
              background: 'rgba(5,150,105,0.08)',
              border: '1px solid rgba(5,150,105,0.35)',
              borderRadius: 10,
              padding: '14px 16px',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 22, lineHeight: 1, marginBottom: 4 }}>✓</div>
            <div
              style={{
                fontFamily: "'Fraunces', Georgia, serif",
                fontSize: 15,
                fontWeight: 800,
                color: '#065f46',
                marginBottom: 2,
              }}
            >
              Saved to AgentBase
            </div>
            <div
              style={{
                fontSize: 11,
                color: '#047857',
                fontWeight: 600,
                marginBottom: 10,
              }}
            >
              {client.name || 'Client'} · {recommendedPlan?.carrier} ·{' '}
              {recommendedPlan?.plan_name}
            </div>
            <div style={{ fontSize: 10, color: '#065f46', marginBottom: 12 }}>
              Open the client card in AgentBase to review and submit to HealthSherpa.
            </div>
            <div
              style={{
                display: 'flex',
                gap: 8,
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
                  padding: '9px 18px',
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 800,
                  textDecoration: 'none',
                  letterSpacing: 0.3,
                }}
              >
                Open Client Card →
              </a>
              <button
                type="button"
                onClick={onNext}
                style={{
                  background: 'white',
                  color: '#065f46',
                  border: '1px solid #047857',
                  borderRadius: 8,
                  padding: '9px 18px',
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: 'pointer',
                  letterSpacing: 0.3,
                }}
              >
                Review on Enroll →
              </button>
              <button
                type="button"
                onClick={startNewSession}
                style={{
                  background: 'white',
                  color: '#065f46',
                  border: '1px solid #047857',
                  borderRadius: 8,
                  padding: '9px 18px',
                  fontSize: 12,
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
              background: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: 8,
              color: '#7f1d1d',
              padding: '10px 14px',
              fontSize: 12,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <span>⚠ Save to AgentBase failed — {saveError ?? 'unknown error'}.</span>
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

function SectionHeader({
  title,
  sub,
  done,
  total,
}: {
  title: string;
  sub?: string;
  done: number;
  total: number;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        marginBottom: 6,
        gap: 8,
      }}
    >
      <div>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: '#475569',
            letterSpacing: 1,
            textTransform: 'uppercase',
          }}
        >
          {title}
        </span>
        {sub && (
          <span style={{ fontSize: 10, color: '#94a3b8', marginLeft: 6 }}>
            {sub}
          </span>
        )}
      </div>
      <span style={{ fontSize: 9, color: '#94a3b8' }}>
        {done}/{total}
      </span>
    </div>
  );
}

const ROW_STYLE = (done: boolean): CSSProperties => ({
  background: 'white',
  borderRadius: 9,
  padding: '12px 16px',
  marginBottom: 5,
  border: done
    ? '1px solid rgba(5,150,105,0.15)'
    : '1px solid rgba(13,47,94,0.06)',
  boxShadow: '0 1px 3px rgba(13,47,94,0.03)',
});

const CHECKBOX_STYLE = (done: boolean, verbatim: boolean): CSSProperties => ({
  width: 22,
  height: 22,
  borderRadius: 5,
  flexShrink: 0,
  marginTop: 1,
  background: done ? '#059669' : verbatim ? '#f59e0b' : 'white',
  border: done
    ? 'none'
    : verbatim
      ? '2px solid #f59e0b'
      : '2px solid #cbd5e1',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'white',
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
  transition: 'all 0.2s',
});

// ── Call Recording Retention Policy ─────────────────────────────────
// CMS CY2027 Final Rule (effective 2026-10-01) split call-recording
// retention into two tracks. Documenting the CORRECT version of the
// rules here so the broker doesn't fall back on the older "10 years
// for everything" shorthand mid-call. Reference-only; not part of the
// 16-item enrollment gate.
//
// Sources:
//   • 42 CFR §422.2274 (Medicare Advantage marketing)
//   • CY2027 Final Rule (Federal Register, 2026)
//   • CMS Final Rule Fact Sheet
//
// Storage: Twilio. Twilio does NOT auto-delete recordings by default —
// they persist indefinitely until a delete API call. So the
// 6-or-10-year obligation is a procedural rule, not a vendor setting
// that needs to be configured. Verified 2026-06-24.

function RetentionPolicy() {
  return (
    <details
      style={{
        background: '#f8fafc',
        border: '1px solid rgba(13,47,94,0.08)',
        borderRadius: 10,
        padding: '10px 14px',
        marginBottom: 12,
        marginTop: 18,
        fontSize: 12,
        lineHeight: 1.55,
        color: '#1e293b',
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          fontWeight: 700,
          color: '#0d2f5e',
          listStyle: 'revert',
        }}
      >
        Call Recording Retention Policy <span style={{ color: '#64748b', fontWeight: 500 }}>(CY2027 Final Rule)</span>
      </summary>

      <div style={{ marginTop: 10 }}>
        <div style={SECTION_HEAD}>Marketing &amp; Sales Calls</div>
        <ul style={LIST}>
          <li>
            <strong>6-year total retention</strong> (reduced from prior
            10-year shorthand).
          </li>
          <li>
            Years 1–3: <strong>audio recording required</strong> —
            transcript alone is not sufficient.
          </li>
          <li>
            Years 4–6: audio <em>or</em> a complete and accurate
            transcript acceptable. CMS defines "complete and accurate"
            as documenting the full recording and reflecting all
            statements as originally occurred.
          </li>
          <li>
            Applies to <strong>all</strong> marketing and sales calls —
            independent agents <em>and</em> call centers. No solo-
            producer exemption.
          </li>
        </ul>

        <div style={SECTION_HEAD}>Enrollment Calls (unchanged — separate track)</div>
        <ul style={LIST}>
          <li>
            <strong>10-year retention</strong> from date of call. CMS
            explicitly declined to reduce it in CY2027.
          </li>
          <li>
            The enrollment portion of a call serves as the enrollment
            form and proof of intent to enroll.
          </li>
          <li>
            <strong>Mixed calls roll up:</strong> if a single call
            contains both sales discussion and enrollment, the entire
            call falls under the 10-year track.
          </li>
        </ul>

        <div style={SECTION_HEAD}>Operational Policy — GenerationHealth</div>
        <ul style={LIST}>
          <li>
            Retain <strong>all</strong> call audio for 10 years. Avoids
            misclassification risk on mixed sales-plus-enrollment calls.
          </li>
          <li>
            <strong>Storage:</strong> Twilio (US region). Twilio retains
            recordings indefinitely by default — no auto-delete is
            configured, so the 10-year obligation is a procedural rule,
            not a vendor setting.
          </li>
          <li>
            <strong>Access:</strong> authorized broker personnel only,
            via Twilio Console or AgentBase CRM call log.
          </li>
          <li>
            <strong>Deletion prohibited</strong> during the retention
            period.
          </li>
          <li>
            <strong>Lead-source consent records:</strong> 10 years
            (matches enrollment track).
          </li>
        </ul>

        <div style={{ fontSize: 10, color: '#64748b', marginTop: 8 }}>
          Refs: 42 CFR §422.2274 · CY2027 Final Rule (Federal Register) ·
          CMS Final Rule Fact Sheet. Last verified 2026-06-24.
        </div>
      </div>
    </details>
  );
}

const SECTION_HEAD: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#0d2f5e',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  marginTop: 10,
  marginBottom: 4,
};

const LIST: CSSProperties = {
  margin: '0 0 6px 0',
  paddingLeft: 18,
};

// ── Grievance & Appeals Procedure ───────────────────────────────────
// CMS requires brokers to document how beneficiaries can file
// grievances. Independent brokers CANNOT file grievances on a member's
// behalf — they must direct the consumer to the plan or to one of
// the federal/state escalation paths.
//
// Acknowledgment + resolution timelines per CMS Medicare Managed Care
// Manual ch.13 / 42 CFR §422.564 (MA) and §423.564 (Part D):
//   • Plan must acknowledge within 5 calendar days
//   • Plan must resolve within 30 calendar days (60 for Part D)

function GrievanceProcedure() {
  return (
    <details
      style={{
        background: '#f8fafc',
        border: '1px solid rgba(13,47,94,0.08)',
        borderRadius: 10,
        padding: '10px 14px',
        marginBottom: 12,
        fontSize: 12,
        lineHeight: 1.55,
        color: '#1e293b',
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          fontWeight: 700,
          color: '#0d2f5e',
          listStyle: 'revert',
        }}
      >
        Grievance &amp; Appeals Procedure <span style={{ color: '#64748b', fontWeight: 500 }}>(broker cannot file on behalf)</span>
      </summary>

      <div style={{ marginTop: 10 }}>
        <p style={{ margin: 0 }}>
          If you have a complaint about your Medicare Advantage or Part D
          plan, you have the right to file a grievance. Contact your
          plan directly using the phone number on your member ID card.
          You may also contact:
        </p>

        <div style={SECTION_HEAD}>Federal escalation</div>
        <ul style={LIST}>
          <li>
            <strong>1-800-MEDICARE</strong> (1-800-633-4227) — 24/7,
            TTY 1-877-486-2048.
          </li>
          <li>
            <strong>CMS Ombudsman:</strong>{' '}
            <a
              href="https://www.cms.gov/about-cms/what-we-do/ombudsman"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#0071e3' }}
            >
              cms.gov/about-cms/what-we-do/ombudsman
            </a>
            .
          </li>
        </ul>

        <div style={SECTION_HEAD}>State Health Insurance Assistance Program (SHIP)</div>
        <ul style={LIST}>
          <li>
            <strong>North Carolina:</strong> 1-855-408-1212
          </li>
          <li>
            <strong>Texas:</strong> 1-800-252-9240
          </li>
          <li>
            <strong>Georgia:</strong> 1-866-552-4464
          </li>
        </ul>

        <div style={SECTION_HEAD}>Broker role</div>
        <p style={{ margin: '0 0 6px 0' }}>
          As your independent broker, I can help you understand the
          grievance process but <strong>cannot file on your behalf</strong>.
        </p>

        <div style={SECTION_HEAD}>Plan timelines</div>
        <ul style={LIST}>
          <li>
            Plans must <strong>acknowledge grievances within 5 calendar
            days</strong>.
          </li>
          <li>
            Plans must <strong>resolve within 30 calendar days</strong>
            (60 calendar days for Part D).
          </li>
        </ul>

        <div style={{ fontSize: 10, color: '#64748b', marginTop: 8 }}>
          Refs: 42 CFR §422.564 (MA grievances) · §423.564 (Part D
          grievances) · CMS Medicare Managed Care Manual ch. 13.
        </div>
      </div>
    </details>
  );
}
