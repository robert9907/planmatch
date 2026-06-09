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
import type { StateCode } from '@/types/session';
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
      callRecordingDisclosed,
  );

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
