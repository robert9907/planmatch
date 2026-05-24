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
import { useSession } from '@/hooks/useSession';
import type { StateCode } from '@/types/session';
import {
  Card,
  Container,
  Field,
  FieldInput,
  GreenDot,
  Header,
  Nav,
} from './atoms';

interface Props {
  /** Plan catalog fetched by AgentV3App for the client's county+state.
   *  Empty array when ZIP hasn't resolved yet — the picker stays hidden
   *  until at least one plan lands. */
  eligiblePlans: Plan[];
  onNext: () => void;
}

export function IntakeScreen({ eligiblePlans, onNext }: Props) {
  const client = useSession((s) => s.client);
  const updateClient = useSession((s) => s.updateClient);
  const currentPlanId = useSession((s) => s.currentPlanId);
  const setCurrentPlanId = useSession((s) => s.setCurrentPlanId);
  const setNoCurrentPlan = useSession((s) => s.setNoCurrentPlan);

  const [zipLoading, setZipLoading] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);
  const zipInFlight = useRef<AbortController | null>(null);

  // Debounced ZIP → county/state lookup. Mirrors the v4 IntakePage
  // wiring — same /api/zip-county route, same abort-on-change behavior
  // so a fast typist doesn't race a stale response over a fresh one.
  useEffect(() => {
    if (!client.zip || !/^\d{5}$/.test(client.zip)) return;
    const ctl = new AbortController();
    zipInFlight.current?.abort();
    zipInFlight.current = ctl;
    const t = window.setTimeout(async () => {
      setZipLoading(true);
      setZipError(null);
      try {
        const res = await fetch(`/api/zip-county?zip=${client.zip}`, {
          signal: ctl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { county?: string; state?: StateCode };
        if (ctl.signal.aborted) return;
        const patch: Partial<typeof client> = {};
        if (body.county && body.county !== client.county) patch.county = body.county;
        if (body.state && body.state !== client.state) patch.state = body.state;
        if (Object.keys(patch).length > 0) updateClient(patch);
      } catch (err) {
        if (!ctl.signal.aborted) setZipError((err as Error).message);
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
  // function without. Email is nice-to-have but not blocking; the
  // broker often captures it mid-call after the SOA. Current plan is
  // optional too — many shoppers are new to Medicare.
  const canContinue = Boolean(
    client.name &&
      client.dob &&
      /^\d{5}$/.test(client.zip) &&
      client.phone,
  );

  // ── Current plan picker state ────────────────────────────────────
  const selectedPlan = useMemo<Plan | null>(
    () =>
      currentPlanId ? eligiblePlans.find((p) => p.id === currentPlanId) ?? null : null,
    [currentPlanId, eligiblePlans],
  );
  const selectedLabel = useMemo<string>(() => {
    if (selectedPlan) return `${selectedPlan.carrier} · ${selectedPlan.plan_name}`;
    return '';
  }, [selectedPlan]);

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

  const showPicker = eligiblePlans.length > 0 && Boolean(client.county);

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
                  {eligiblePlans.length} plans in {client.county} County
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
      <Nav onNext={onNext} nextDisabled={!canContinue} />
    </Container>
  );
}
