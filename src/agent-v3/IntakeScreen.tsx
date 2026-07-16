// IntakeScreen — agent-v3 screen 1.
//
// Mockup intent: a calm, client-facing-feeling form that collects
// name / dob / zip / county / phone / email / current plan. Reads &
// writes useSession.client so anything hydrated from AgentBase
// (Landing → Recent Clients) shows up pre-filled and any edits
// persist for the downstream screens (Meds, Providers, etc).
//
// Wires:
//   • ZIP → /api/zip-county debounced lookup, paints county + state
//     when 5 digits land, surfaces a green dot when confirmed.
//   • DOB string is left as raw text the broker types; the mockup
//     used MM/DD/YYYY display, the existing v4 stores YYYY-MM-DD.
//     We accept either — broker types what the carrier portal shows.
//   • Current Plan — searchable picker fed by eligiblePlans (loaded
//     in AgentV3App once state+county are known). Optional; "No
//     current plan / New to Medicare" sits at the top of the list.
//     Selection writes useSession.currentPlanId so Compare can paint
//     the baseline column.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Plan } from '@/types/plans';
import type { UseCaptureSessionResult } from '@/hooks/useCaptureSession';
import { useSession } from '@/hooks/useSession';
import type { EnrollmentPeriod, SepLifeEvent, StateCode } from '@/types/session';
import { SEP_LIFE_EVENT_LABELS, SEP_LIFE_EVENT_TO_CMS } from '@/types/session';
import type { LisTier, LivingSetting, MedicaidLevel } from '@/lib/dual-eligible';
import { deemLisTier } from '@/lib/dual-eligible';
import { DISCLAIMERS } from '@/lib/compliance';
import {
  Card,
  Container,
  Field,
  FieldInput,
  GreenDot,
  Header,
  Nav,
} from './atoms';
import { SnapTrigger } from './SnapTrigger';

// ── Eligibility segmented-pill options ────────────────────────────
// Chip labels for the Medicaid category, living setting, and LIS tier
// pill rows on the Eligibility card. Keys match the enums in
// src/lib/dual-eligible.ts; the brain reads client.medicaidLevel /
// livingSetting / lisTier verbatim.

const MEDICAID_LEVEL_CHIPS: ReadonlyArray<{ key: MedicaidLevel; label: string }> = [
  { key: 'none', label: 'None' },
  { key: 'qi',   label: 'QI' },
  { key: 'slmb', label: 'SLMB' },
  { key: 'qmb',  label: 'QMB' },
  { key: 'fbde', label: 'FBDE' },
];

const LIVING_SETTING_CHIPS: ReadonlyArray<{ key: LivingSetting; label: string }> = [
  { key: 'community',              label: 'Community' },
  { key: 'institutional_or_hcbs',  label: 'Institution / HCBS' },
];

const LIS_TIER_CHIPS: ReadonlyArray<{ key: LisTier; label: string }> = [
  { key: 'none',                label: 'None' },
  { key: 'full_institutional',  label: 'Full institutional ($0/$0)' },
  { key: 'full_low',            label: 'Full low ($1.60/$4.90)' },
  { key: 'full_high',           label: 'Full high ($5.10/$12.65)' },
];

// ── Enrollment period options ─────────────────────────────────────
// Five CMS periods the broker/consumer can pick. Matches types in
// src/types/session.ts. Body copy is a one-liner shown under the pill
// row once a period is picked.
const ENROLLMENT_PERIODS: ReadonlyArray<{
  value: EnrollmentPeriod;
  label: string;
  body: string;
}> = [
  { value: 'IEP',  label: 'IEP',  body: 'Turning 65, first time enrolling' },
  { value: 'ICEP', label: 'ICEP', body: 'New to Medicare, choosing first plan' },
  { value: 'AEP',  label: 'AEP',  body: 'Annual enrollment, Oct 15 – Dec 7' },
  { value: 'OEP',  label: 'OEP',  body: 'Open enrollment, Jan 1 – Mar 31' },
  { value: 'SEP',  label: 'SEP',  body: 'Life event (lost coverage, moved, etc.)' },
];

// Six plain-English SEP life events. Same set the consumer surfaces —
// the agent deliberately sees identical language. Order chosen to
// front-load the most common triggers. NO CMS reason code dropdown
// anywhere; the codes are derived from these keys via SEP_LIFE_EVENT_TO_CMS.
const SEP_LIFE_EVENT_ORDER: ReadonlyArray<SepLifeEvent> = [
  'moved',
  'lost_employer',
  'lost_aca',
  'left_facility',
  'new_medicaid',
  'doctor_left',
];

/** Segmented pill button used across the three Eligibility rows.
 *  Style matches the existing "Dual eligible" pill so the card feels
 *  cohesive. Not exported — local to IntakeScreen. */
function SegmentedPill({
  on,
  label,
  onClick,
}: {
  on: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        borderRadius: 999,
        border: on ? '1.5px solid #0d2f5e' : '1px solid rgba(13,47,94,0.18)',
        background: on ? 'rgba(131,240,249,0.18)' : 'white',
        color: '#0d2f5e',
        fontSize: 12,
        fontWeight: on ? 700 : 500,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {label}
      {on && <span aria-hidden>✓</span>}
    </button>
  );
}

function splitNameForCreate(full: string): { first: string; last: string } {
  const parts = (full ?? '').trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function hasClientIdParam(): boolean {
  if (typeof window === 'undefined') return false;
  const v = new URLSearchParams(window.location.search).get('clientId');
  return Boolean(v && v.trim());
}

interface Props {
  /** Plan catalog fetched by AgentV3App for the client's county+state.
   *  Empty array when ZIP hasn't resolved yet — the picker stays hidden
   *  until at least one plan lands. */
  eligiblePlans: Plan[];
  /** Carrier-prefixed label captured from `?current_plan_name=…` on
   *  mount (AgentBase "Quote in Plan Match" deep-link). Used as a
   *  fallback render for the Current Plan picker while eligiblePlans is
   *  still loading — so the broker sees the plan pre-selected instantly
   *  on landing instead of an empty input that fills a beat later. */
  presetCurrentPlanLabel?: string | null;
  /** Shared capture session — lifted to AgentV3App so the Meds and
   *  Providers screens can observe the same queue. SnapTrigger uses it
   *  to send the SMS link and surface the live status pill. */
  capture: UseCaptureSessionResult;
  onNext: () => void;
}

export function IntakeScreen({
  eligiblePlans,
  presetCurrentPlanLabel,
  capture,
  onNext,
}: Props) {
  const client = useSession((s) => s.client);
  const updateClient = useSession((s) => s.updateClient);
  const currentPlanId = useSession((s) => s.currentPlanId);
  const setCurrentPlanId = useSession((s) => s.setCurrentPlanId);
  const setNoCurrentPlan = useSession((s) => s.setNoCurrentPlan);
  const disclaimersConfirmed = useSession((s) => s.disclaimersConfirmed);
  const confirmDisclaimer = useSession((s) => s.confirmDisclaimer);
  const callRecordingDisclosed = disclaimersConfirmed.includes('call_recording');
  const callRecordingDef = DISCLAIMERS.find((d) => d.id === 'call_recording');

  const [zipLoading, setZipLoading] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);
  const zipInFlight = useRef<AbortController | null>(null);

  // Debounced ZIP → county/state lookup. Mirrors the v4 IntakePage
  // wiring — same /api/zip-county route, same abort-on-change behavior
  // so a fast typist doesn't race a stale response over a fresh one.
  //
  // Always writes county + state from the API response (instead of
  // diffing against the current session value) so a persisted-session
  // mismatch ("" or null vs the real county) can never get stuck
  // showing "—" after the lookup lands. The deep-link path (AgentBase
  // "Quote in Plan Match") pre-writes county+state via URL params; the
  // lookup just re-confirms them with the authoritative pm_zip_county
  // value. We intentionally do NOT skip the lookup when the session
  // already has county/state populated — earlier attempts to do that
  // caused fresh broker ZIP entries to silently no-op, leaving the
  // County field stuck at "—" for 27713.
  //
  // console.info breadcrumbs make a runtime failure visible in the
  // broker's dev tools without surfacing a user-facing message — the
  // rightHint already covers explicit errors.
  useEffect(() => {
    if (!client.zip || !/^\d{5}$/.test(client.zip)) return;
    const ctl = new AbortController();
    zipInFlight.current?.abort();
    zipInFlight.current = ctl;
    const t = window.setTimeout(async () => {
      setZipLoading(true);
      setZipError(null);
      try {
        console.info(`[intake] zip-county fetch zip=${client.zip}`);
        const res = await fetch(`/api/zip-county?zip=${client.zip}`, {
          signal: ctl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { county?: string; state?: StateCode };
        if (ctl.signal.aborted) return;
        console.info(
          `[intake] zip-county response zip=${client.zip} → county=${body.county ?? 'null'} state=${body.state ?? 'null'}`,
        );
        const patch: Partial<typeof client> = {};
        if (body.county) patch.county = body.county;
        if (body.state) patch.state = body.state;
        if (Object.keys(patch).length > 0) updateClient(patch);
      } catch (err) {
        if (!ctl.signal.aborted) {
          console.warn(
            `[intake] zip-county failed zip=${client.zip}:`,
            (err as Error).message,
          );
          setZipError((err as Error).message);
        }
      } finally {
        if (!ctl.signal.aborted) setZipLoading(false);
      }
    }, 250);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
  }, [client.zip]); // eslint-disable-line react-hooks/exhaustive-deps

  // Continue requires the four fields the rest of the workflow can't
  // function without PLUS the call-recording disclosure (CMS requires
  // it at call start, before any plan discussion). Email is
  // nice-to-have but not blocking; the broker often captures it
  // mid-call after the SOA. Current plan is optional too — many
  // shoppers are new to Medicare.
  //
  // Why gate here and not just on the Disclaimers screen? CMS
  // requires the call-recording notice BEFORE any quoting begins.
  // Intake is the first screen the broker hits with a live caller,
  // so locking Continue until call_recording is confirmed prevents
  // the broker from skipping straight into plan discussion. TPMO +
  // SOA still happen on the Disclaimers screen (screen 2) where
  // they belong contextually with the live ORG_COUNT/PLAN_COUNT.
  const canContinue = Boolean(
    client.name &&
      client.dob &&
      /^\d{5}$/.test(client.zip) &&
      client.phone &&
      callRecordingDisclosed &&
      client.enrollmentPeriod &&
      (client.enrollmentPeriod !== 'SEP' || client.sepLifeEvent),
  );

  // Enrollment period write path — non-SEP picks clear stale SEP fields
  // so re-picking (e.g. broker fat-fingers SEP → switches to AEP) can't
  // leave an orphaned life event / CMS code on the session.
  function onEnrollmentPeriodChange(period: EnrollmentPeriod) {
    if (period === 'SEP') {
      updateClient({ enrollmentPeriod: 'SEP' });
    } else {
      updateClient({
        enrollmentPeriod: period,
        sepLifeEvent: undefined,
        sepReasonCode: undefined,
      });
    }
  }

  // SEP life-event → CMS code derivation. This is the SEP fraud gate:
  // the broker never types or picks a raw CMS code; the six plain-
  // English cards are the only path to a sepReasonCode.
  function onSepLifeEventChange(event: SepLifeEvent) {
    updateClient({
      enrollmentPeriod: 'SEP',
      sepLifeEvent: event,
      sepReasonCode: SEP_LIFE_EVENT_TO_CMS[event],
    });
  }

  // Inline create-client. Fires only when the broker landed on
  // /agent-v3 without a ?clientId= (new caller, no CRM row yet) and
  // hit Continue. POSTs to /api/agentbase-create-client; on success
  // pins the returned id into the URL via history.replaceState so all
  // downstream syncs (med upsert, provider link, recommend) resolve
  // straight to this row instead of re-doing phone/dob matching.
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleContinue() {
    if (!canContinue || creating) return;
    setCreateError(null);

    // Already hydrated from ?clientId= — nothing to create.
    if (hasClientIdParam()) {
      onNext();
      return;
    }

    const { first, last } = splitNameForCreate(client.name);
    if (!first || !last) {
      setCreateError(
        'Enter both first and last name so the AgentBase row can be created.',
      );
      return;
    }

    setCreating(true);
    try {
      const res = await fetch('/api/agentbase-create-client', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: first,
          lastName: last,
          phone: client.phone || undefined,
          email: client.email || undefined,
          dob: client.dob || undefined,
          zip: client.zip,
          county: client.county || undefined,
          state: client.state || undefined,
          medicareId: client.mbi || undefined,
          currentPlanId: currentPlanId || undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as
        | { clientId: number; created: boolean }
        | { error: string };
      if (!res.ok || !('clientId' in body)) {
        const msg =
          'error' in body && typeof body.error === 'string'
            ? body.error
            : `create-client ${res.status}`;
        setCreateError(msg);
        return;
      }
      // Pin clientId into the URL so a refresh re-hydrates this row
      // and the recommend endpoint resolves by id.
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('clientId', String(body.clientId));
        window.history.replaceState(null, '', url.toString());
      } catch {
        // history API unavailable (very old browser); ignore.
      }
      onNext();
    } catch (err) {
      setCreateError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  // ── Current plan picker state ────────────────────────────────────
  const selectedPlan = useMemo<Plan | null>(
    () =>
      currentPlanId ? eligiblePlans.find((p) => p.id === currentPlanId) ?? null : null,
    [currentPlanId, eligiblePlans],
  );
  const selectedLabel = useMemo<string>(() => {
    if (selectedPlan) return `${selectedPlan.carrier} · ${selectedPlan.plan_name}`;
    // Fallback: AgentBase deep-link supplied currentPlanId + a plan-name
    // hint via URL params. Until eligiblePlans resolves the matching row
    // we render that hint so the broker sees the plan "locked in"
    // instead of staring at an empty picker that fills a moment later.
    if (currentPlanId && presetCurrentPlanLabel) return presetCurrentPlanLabel;
    return '';
  }, [selectedPlan, currentPlanId, presetCurrentPlanLabel]);

  const [planQuery, setPlanQuery] = useState('');
  const [planOpen, setPlanOpen] = useState(false);
  const planBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!planOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!planBoxRef.current) return;
      if (!planBoxRef.current.contains(e.target as Node)) setPlanOpen(false);
    }
    window.addEventListener('mousedown', onDocClick);
    return () => window.removeEventListener('mousedown', onDocClick);
  }, [planOpen]);

  // Filter by carrier OR plan_name substring. Limit to 50 results so
  // the dropdown doesn't try to paint 600 rows in counties with deep
  // catalogs. Sort: carrier asc, then plan name asc.
  const filteredPlans = useMemo<Plan[]>(() => {
    if (eligiblePlans.length === 0) return [];
    const q = planQuery.trim().toLowerCase();
    const matches = q
      ? eligiblePlans.filter(
          (p) =>
            p.carrier.toLowerCase().includes(q) ||
            p.plan_name.toLowerCase().includes(q),
        )
      : [...eligiblePlans];
    matches.sort((a, b) => {
      if (a.carrier !== b.carrier) return a.carrier.localeCompare(b.carrier);
      return a.plan_name.localeCompare(b.plan_name);
    });
    return matches.slice(0, 50);
  }, [eligiblePlans, planQuery]);

  function selectPlan(plan: Plan) {
    setCurrentPlanId(plan.id);
    setPlanQuery('');
    setPlanOpen(false);
  }

  function selectNoCurrentPlan() {
    setNoCurrentPlan(true);
    setPlanQuery('');
    setPlanOpen(false);
  }

  // Auto-detect dual-eligible status from the current plan's name. SNP
  // plans surface "D-SNP" or "Dual" in the marketing name (e.g.
  // "UHC Dual Complete NC-S1 (HMO D-SNP)"); when the broker picks one
  // it's a near-certain signal that the client is Medicaid + Medicare.
  // We flip dsnpEligible=true on first encounter so the brain stops
  // stripping D-SNPs from the Compare bench. Tracked per-id via a ref
  // so the auto-set fires exactly once per plan selection — if the
  // broker toggles it back off after the auto-set, we don't fight them
  // (the guard returns early since the id hasn't changed).
  const dsnpAutoSetIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = currentPlanId ?? (presetCurrentPlanLabel ? `__preset__` : null);
    if (!id) return;
    if (dsnpAutoSetIdRef.current === id) return;
    dsnpAutoSetIdRef.current = id;
    const name = selectedPlan?.plan_name ?? presetCurrentPlanLabel ?? '';
    if (!name) return;
    if (/d-?snp|\bdual\b/i.test(name) && client.dsnpEligible !== true) {
      updateClient({ dsnpEligible: true });
    }
  }, [
    currentPlanId,
    selectedPlan,
    presetCurrentPlanLabel,
    client.dsnpEligible,
    updateClient,
  ]);

  // Render the picker when eligiblePlans has loaded (the usual path) OR
  // when the deep-link pre-supplied a current plan and the catalog is
  // still in flight (so the broker sees the locked-in plan immediately
  // instead of a missing field that pops in seconds later).
  const showPicker =
    (eligiblePlans.length > 0 && Boolean(client.county)) ||
    Boolean(currentPlanId && presetCurrentPlanLabel);

  const countyValue = client.county
    ? (
        <>
          <GreenDot /> {client.county} County
          {client.state ? `, ${client.state}` : ''}
        </>
      )
    : '';

  return (
    <Container>
      <Header
        title="Let's find your perfect plan"
        sub="We'll walk through this together — about 5 minutes."
      />
      {callRecordingDef && (
        <div
          style={{
            background: callRecordingDisclosed ? 'rgba(5,150,105,0.04)' : '#fffbeb',
            border: callRecordingDisclosed
              ? '1px solid rgba(5,150,105,0.2)'
              : '2px solid #f59e0b',
            borderRadius: 11,
            padding: '14px 18px',
            marginBottom: 14,
          }}
        >
          <div
            style={{
              fontSize: 9,
              fontWeight: 800,
              color: callRecordingDisclosed ? '#059669' : '#d97706',
              letterSpacing: 1,
              textTransform: 'uppercase',
              marginBottom: 4,
            }}
          >
            Call Recording Disclosure · CMS-required at call start
          </div>
          <div
            style={{
              fontFamily: "'Fraunces', Georgia, serif",
              fontSize: 15,
              fontWeight: 700,
              color: '#0d2f5e',
              marginBottom: 6,
            }}
          >
            Read aloud verbatim, then confirm:
          </div>
          <div
            style={{
              fontSize: 12,
              color: '#334155',
              lineHeight: 1.5,
              fontStyle: 'italic',
              marginBottom: 12,
            }}
          >
            “{callRecordingDef.body}”
          </div>
          <button
            type="button"
            onClick={() => {
              if (!callRecordingDisclosed) confirmDisclaimer('call_recording');
            }}
            disabled={callRecordingDisclosed}
            style={{
              background: callRecordingDisclosed
                ? 'linear-gradient(135deg, #059669, #047857)'
                : '#f59e0b',
              color: 'white',
              border: 'none',
              borderRadius: 7,
              padding: '8px 16px',
              fontSize: 12,
              fontWeight: 700,
              cursor: callRecordingDisclosed ? 'default' : 'pointer',
              letterSpacing: 0.3,
            }}
          >
            {callRecordingDisclosed
              ? '✓ Confirmed — call recording disclosed to beneficiary'
              : 'I have disclosed call recording to the beneficiary'}
          </button>
        </div>
      )}
      <Card>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 14,
          }}
        >
          <FieldInput
            label="Name"
            value={client.name}
            onChange={(v) => updateClient({ name: v })}
            placeholder="Robert Johnson"
          />
          <FieldInput
            label="Date of Birth"
            value={client.dob}
            onChange={(v) => updateClient({ dob: v })}
            placeholder="03/15/1958"
          />
          <FieldInput
            label="ZIP"
            value={client.zip}
            onChange={(v) => updateClient({ zip: v.replace(/\D/g, '').slice(0, 5) })}
            inputMode="numeric"
            maxLength={5}
            placeholder="27713"
            rightHint={
              zipLoading
                ? 'looking up…'
                : zipError
                  ? `lookup failed: ${zipError}`
                  : undefined
            }
          />
          {/* County is read-only — derived from the ZIP lookup. Render
              the static Field atom so it matches the mockup's chrome. */}
          <Field label="County" value={countyValue} />
          <FieldInput
            label="Phone"
            value={client.phone}
            onChange={(v) => updateClient({ phone: v })}
            type="tel"
            inputMode="tel"
            placeholder="(919) 555-0147"
          />
          <FieldInput
            label="Email"
            value={client.email ?? ''}
            onChange={(v) => updateClient({ email: v })}
            type="email"
            inputMode="email"
            placeholder="rjohnson58@gmail.com"
          />
          {showPicker && (
            <div style={{ gridColumn: '1 / -1' }} ref={planBoxRef}>
              <label
                style={{
                  display: 'block',
                  fontSize: 10,
                  fontWeight: 600,
                  color: '#64748b',
                  marginBottom: 4,
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                }}
              >
                Current Plan (if any)
                <span
                  style={{
                    marginLeft: 8,
                    fontWeight: 500,
                    textTransform: 'none',
                    letterSpacing: 0,
                    color: '#94a3b8',
                  }}
                >
                  {eligiblePlans.length > 0
                  ? `${eligiblePlans.length} plans in ${client.county} County`
                  : `loading plans…`}
                </span>
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  type="text"
                  value={planOpen ? planQuery : selectedLabel}
                  onChange={(e) => {
                    setPlanQuery(e.target.value);
                    if (!planOpen) setPlanOpen(true);
                  }}
                  onFocus={() => setPlanOpen(true)}
                  placeholder={
                    selectedPlan
                      ? selectedLabel
                      : 'Type carrier or plan name… (or pick "No current plan" below)'
                  }
                  style={{
                    width: '100%',
                    background: '#f8fafc',
                    border: '1px solid rgba(13,47,94,0.05)',
                    borderRadius: 8,
                    padding: '10px 12px',
                    fontSize: 14,
                    fontWeight: 600,
                    color: '#0d2f5e',
                    outline: 'none',
                    minHeight: 40,
                    boxSizing: 'border-box',
                  }}
                />
                {selectedPlan && !planOpen && (
                  <button
                    type="button"
                    onClick={() => {
                      setCurrentPlanId(null);
                      setPlanQuery('');
                      setPlanOpen(true);
                    }}
                    aria-label="Clear current plan"
                    style={{
                      position: 'absolute',
                      right: 8,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'rgba(13,47,94,0.06)',
                      border: 'none',
                      borderRadius: 4,
                      width: 22,
                      height: 22,
                      fontSize: 12,
                      lineHeight: 1,
                      cursor: 'pointer',
                      color: '#64748b',
                    }}
                  >
                    ✕
                  </button>
                )}
                {planOpen && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 4px)',
                      left: 0,
                      right: 0,
                      background: 'white',
                      border: '1px solid rgba(13,47,94,0.12)',
                      borderRadius: 8,
                      boxShadow: '0 4px 16px rgba(13,47,94,0.12)',
                      maxHeight: 320,
                      overflowY: 'auto',
                      zIndex: 50,
                    }}
                  >
                    <button
                      type="button"
                      onClick={selectNoCurrentPlan}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        background: 'transparent',
                        border: 'none',
                        borderBottom: '1px solid #f1f5f9',
                        padding: '10px 12px',
                        fontSize: 12,
                        fontWeight: 700,
                        color: '#0d2f5e',
                        cursor: 'pointer',
                      }}
                    >
                      No current plan / New to Medicare
                    </button>
                    {filteredPlans.length === 0 ? (
                      <div
                        style={{
                          padding: '10px 12px',
                          fontSize: 11,
                          color: '#94a3b8',
                        }}
                      >
                        No plans match — try a carrier name.
                      </div>
                    ) : (
                      filteredPlans.map((p) => {
                        const isSelected = p.id === currentPlanId;
                        return (
                          <button
                            type="button"
                            key={p.id}
                            onClick={() => selectPlan(p)}
                            style={{
                              display: 'block',
                              width: '100%',
                              textAlign: 'left',
                              background: isSelected
                                ? 'rgba(13,47,94,0.04)'
                                : 'transparent',
                              border: 'none',
                              padding: '8px 12px',
                              fontSize: 12,
                              color: '#0d2f5e',
                              cursor: 'pointer',
                              borderBottom: '1px solid #f8fafc',
                            }}
                          >
                            <div style={{ fontWeight: 700, fontSize: 11 }}>
                              {p.carrier}
                            </div>
                            <div style={{ fontWeight: 500, color: '#475569' }}>
                              {p.plan_name}
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </Card>
      <div style={{ marginTop: 14 }}>
        <SnapTrigger capture={capture} />
      </div>

      {/* Dual-eligible + LIS self-report — routes the brain's D-SNP
        * population gate AND applyDualEligibleCostAdjustment (medical
        * cost-sharing zeroing for QMB/FBDE, drug copay caps for LIS
        * tiers). Medicaid category is the primary selector; LIS tier
        * auto-deems via deemLisTier() when Medicaid changes, but the
        * broker can override for LIS-only clients who applied directly
        * without Medicaid. Any Medicaid category (non-'none') also
        * sets dsnpEligible=true so D-SNPs stay in the bench pool. */}
      <Card style={{ marginTop: 14, padding: '14px 16px' }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            color: '#64748b',
            marginBottom: 10,
          }}
        >
          Eligibility
        </div>

        {/* Medicaid category — segmented pill row. Selection auto-deems
            LIS via deemLisTier and marks the client dsnpEligible. */}
        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>
          Medicaid category
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {MEDICAID_LEVEL_CHIPS.map((chip) => {
            const on = (client.medicaidLevel ?? 'none') === chip.key;
            return (
              <SegmentedPill
                key={chip.key}
                on={on}
                label={chip.label}
                onClick={() => {
                  const nextLevel = chip.key;
                  const nextLiving: LivingSetting =
                    client.livingSetting ?? 'community';
                  const nextLis: LisTier = deemLisTier(nextLevel, nextLiving);
                  updateClient({
                    medicaidLevel: nextLevel,
                    lisTier: nextLis,
                    livingSetting: nextLiving,
                    // Any Medicaid category means dual-eligible; 'none'
                    // clears the flag (broker can still flip the manual
                    // dsnpEligible below for edge-case D-SNP allowances).
                    dsnpEligible: nextLevel !== 'none' ? true : undefined,
                    // Legacy compat — kept until every downstream reader
                    // (AgentBase sync, QuoteDelivery ContextField) is
                    // migrated off the boolean.
                    medicaidConfirmed: nextLevel !== 'none',
                  });
                }}
              />
            );
          })}
        </div>

        {/* Living setting — only relevant for FBDE. HCBS/institutional
            promotes LIS to full_institutional ($0/$0 copays). */}
        {client.medicaidLevel === 'fbde' && (
          <>
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>
              Living setting
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {LIVING_SETTING_CHIPS.map((chip) => {
                const on = (client.livingSetting ?? 'community') === chip.key;
                return (
                  <SegmentedPill
                    key={chip.key}
                    on={on}
                    label={chip.label}
                    onClick={() =>
                      updateClient({
                        livingSetting: chip.key,
                        lisTier: deemLisTier('fbde', chip.key),
                      })
                    }
                  />
                );
              })}
            </div>
          </>
        )}

        {/* LIS tier — auto-deemed from Medicaid + living setting, but
            editable for LIS-only clients (no Medicaid, applied for
            Extra Help directly). */}
        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>
          Extra Help (LIS) tier
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {LIS_TIER_CHIPS.map((chip) => {
            const on = (client.lisTier ?? 'none') === chip.key;
            return (
              <SegmentedPill
                key={chip.key}
                on={on}
                label={chip.label}
                onClick={() => updateClient({ lisTier: chip.key })}
              />
            );
          })}
        </div>

        {/* Manual D-SNP override — kept for edge cases (SLMB/QI on
            plans that don't file the standard D-SNP marker, or "not
            sure" cases pre-verification). Auto-checks when Medicaid
            is set; broker can uncheck. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          {(() => {
            const on = client.dsnpEligible === true;
            return (
              <button
                type="button"
                onClick={() => updateClient({ dsnpEligible: !on })}
                aria-pressed={on}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 12px',
                  borderRadius: 999,
                  border: on
                    ? '1.5px solid #0d2f5e'
                    : '1px solid rgba(13,47,94,0.18)',
                  background: on
                    ? 'rgba(131,240,249,0.18)'
                    : 'white',
                  color: '#0d2f5e',
                  fontSize: 12,
                  fontWeight: on ? 700 : 500,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                💳 Dual eligible (Medicaid + Medicare)
                {on && <span aria-hidden>✓</span>}
              </button>
            );
          })()}
        </div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>
          Enables D-SNP plan recommendations on the Compare screen.
        </div>
      </Card>

      {/* Enrollment period — required for compliance documentation and
        * enrollment gating. Brain reads client.enrollmentPeriod +
        * (SEP) sepReasonCode to compute enrollmentGated: outside AEP/
        * OEP windows the UI blocks enrollment CTAs but the brain still
        * runs a full ranking so beneficiaries can window-shop.
        *
        * SEP fraud gate: neither this UI nor the consumer flow exposes
        * raw CMS SEP codes. Broker picks a plain-English life event and
        * sepReasonCode is derived via SEP_LIFE_EVENT_TO_CMS. */}
      <Card style={{ marginTop: 14, padding: '14px 16px' }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            color: '#64748b',
            marginBottom: 4,
          }}
        >
          Enrollment period
        </div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 10 }}>
          Determines whether enrollment is legally permitted right now. Compliance-required.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: client.enrollmentPeriod ? 8 : 0 }}>
          {ENROLLMENT_PERIODS.map((ep) => (
            <SegmentedPill
              key={ep.value}
              on={client.enrollmentPeriod === ep.value}
              label={ep.label}
              onClick={() => onEnrollmentPeriodChange(ep.value)}
            />
          ))}
        </div>
        {client.enrollmentPeriod && (
          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: client.enrollmentPeriod === 'SEP' ? 12 : 0 }}>
            {ENROLLMENT_PERIODS.find((e) => e.value === client.enrollmentPeriod)?.body}
          </div>
        )}
        {client.enrollmentPeriod === 'SEP' && (
          <>
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>
              What qualifies this SEP? <span style={{ color: '#94a3b8' }}>(CMS reason code is derived automatically)</span>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: 8,
              }}
            >
              {SEP_LIFE_EVENT_ORDER.map((key) => {
                const label = SEP_LIFE_EVENT_LABELS[key];
                const on = client.sepLifeEvent === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => onSepLifeEventChange(key)}
                    aria-pressed={on}
                    style={{
                      textAlign: 'left',
                      padding: '10px 12px',
                      borderRadius: 10,
                      border: on
                        ? '1.5px solid #0d2f5e'
                        : '1px solid rgba(13,47,94,0.18)',
                      background: on
                        ? 'rgba(131,240,249,0.18)'
                        : 'white',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: on ? 700 : 600,
                        color: '#0d2f5e',
                      }}
                    >
                      {label.title}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: '#64748b',
                        marginTop: 2,
                        lineHeight: 1.3,
                      }}
                    >
                      {label.subtitle}
                    </div>
                  </button>
                );
              })}
            </div>
            {client.sepLifeEvent && client.sepReasonCode && (
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>
                CMS reason code: <strong style={{ color: '#0d2f5e' }}>{client.sepReasonCode}</strong> (auto-derived, stored for compliance audit)
              </div>
            )}
          </>
        )}
      </Card>

      {/* VA / TRICARE drug coverage — lets the brain include MA-only
        * plans (no Part D) in the pool. These plans often have better
        * extras but no drug coverage, which is fine for veterans who
        * fill Rx through VA or Express Scripts. Default No preserves
        * the standard population's MAPD-only filter. */}
      <Card style={{ marginTop: 14, padding: '14px 16px' }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            color: '#64748b',
            marginBottom: 4,
          }}
        >
          VA or TRICARE drug coverage
        </div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 10 }}>
          Tick yes only if prescriptions are filled through VA or Express Scripts (TRICARE). Includes MA-only plans with better extras but no built-in drug coverage.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <SegmentedPill
            on={client.hasVaDrugCoverage !== true}
            label="No"
            onClick={() => updateClient({ hasVaDrugCoverage: false })}
          />
          <SegmentedPill
            on={client.hasVaDrugCoverage === true}
            label="Yes — VA or TRICARE"
            onClick={() => updateClient({ hasVaDrugCoverage: true })}
          />
        </div>
      </Card>

      {/* Chronic-condition self-report — routes the brain's C-SNP
        * eligibility + reserved-slot path so clients who qualify but
        * don't have qualifying meds (diet-controlled diabetes,
        * recently-diagnosed CHF before scripts) still surface chronic-
        * condition plans. */}
      <Card style={{ marginTop: 14, padding: '14px 16px' }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            color: '#64748b',
            marginBottom: 4,
          }}
        >
          Chronic conditions (optional)
        </div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 10 }}>
          Surfaces C-SNP plans even when the med list doesn&rsquo;t name
          the condition. Skip if none apply.
        </div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          {(
            [
              { key: 'diabetes', label: '🩸 Diabetes' },
              { key: 'cardio', label: '❤️ Heart conditions' },
              { key: 'copd', label: '🫁 COPD' },
              { key: 'esrd', label: '🫘 Kidney / ESRD' },
            ] as const
          ).map((opt) => {
            const on = (client.csnpConditions ?? []).includes(opt.key);
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => {
                  const cur = client.csnpConditions ?? [];
                  const next = cur.includes(opt.key)
                    ? cur.filter((c) => c !== opt.key)
                    : [...cur, opt.key];
                  updateClient({ csnpConditions: next });
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 12px',
                  borderRadius: 999,
                  border: on
                    ? '1.5px solid #0d2f5e'
                    : '1px solid rgba(13,47,94,0.18)',
                  background: on
                    ? 'rgba(131,240,249,0.18)'
                    : 'white',
                  color: '#0d2f5e',
                  fontSize: 12,
                  fontWeight: on ? 700 : 500,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {opt.label}
                {on && <span aria-hidden>✓</span>}
              </button>
            );
          })}
        </div>
      </Card>

      {createError && (
        <div
          role="alert"
          style={{
            marginTop: 12,
            background: '#fef2f2',
            border: '1px solid #fecaca',
            color: '#7f1d1d',
            borderRadius: 8,
            padding: '8px 12px',
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          ⚠ Couldn't create AgentBase client: {createError}
        </div>
      )}
      <Nav
        onNext={handleContinue}
        nextDisabled={!canContinue || creating}
        nextLabel={creating ? 'Saving…' : undefined}
      />
    </Container>
  );
}
