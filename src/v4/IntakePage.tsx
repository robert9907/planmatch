// Intake — v4 redesign of Step 2.
//
// Form fields: Name, Phone, DOB (auto age), ZIP (auto county via
// /api/zip-county), State pills, Plan Type cards. Sticky bottom bar
// summarizes the client and advances. Reuses the session store so any
// data hydrated from AgentBase (via Landing → Recent Sessions) shows
// up here pre-filled.

import { useEffect, useRef, useState } from 'react';
import { useSession } from '@/hooks/useSession';
import { CurrentPlanPicker } from '@/components/picker/CurrentPlanPicker';
import type { PlanType, StateCode } from '@/types/session';

const STATE_OPTIONS: StateCode[] = ['NC', 'TX', 'GA'];
const PLAN_TYPES: { value: PlanType; label: string; sub: string }[] = [
  { value: 'DSNP',    label: 'D-SNP',   sub: 'Dual eligible' },
  { value: 'MAPD',    label: 'MAPD',    sub: 'MA with Part D' },
  { value: 'MA',      label: 'MA',      sub: 'No drug coverage' },
  { value: 'PDP',     label: 'PDP',     sub: 'Standalone Part D' },
  { value: 'MEDSUPP', label: 'Medigap', sub: 'Supplement' },
];

interface Props {
  onContinue: () => void;
  onBack: () => void;
}

export function IntakePage({ onContinue, onBack }: Props) {
  const client = useSession((s) => s.client);
  const updateClient = useSession((s) => s.updateClient);
  const age = dobToAge(client.dob);

  const [zipLoading, setZipLoading] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);
  const zipInFlight = useRef<AbortController | null>(null);

  // Debounced zip → county lookup. Guards against zips that haven't
  // hit 5 digits yet so we don't thrash the API. Abort on change so
  // a fast typist doesn't race a stale response over a fresh one.
  useEffect(() => {
    if (!client.zip || !/^\d{5}$/.test(client.zip)) return;
    const ctl = new AbortController();
    zipInFlight.current?.abort();
    zipInFlight.current = ctl;
    const t = window.setTimeout(async () => {
      setZipLoading(true); setZipError(null);
      try {
        const res = await fetch(`/api/zip-county?zip=${client.zip}`, { signal: ctl.signal });
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
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [client.zip]);  // eslint-disable-line react-hooks/exhaustive-deps

  const canContinue = Boolean(client.name && client.zip && client.state && client.planType);

  return (
    <>
      <div className="scroll">
        <div className="phdr">
          <div className="ptitle">Client Intake</div>
          <div className="psub">Enter client info to start the quoting session.</div>
        </div>
        <div className="cnt">
          <div className="card" style={{ padding: 20 }}>
            <div className="form-row" style={{ marginBottom: 14 }}>
              <div className="form-group">
                <label className="form-label">Full Name *</label>
                <input
                  className="form-input"
                  value={client.name}
                  onChange={(e) => updateClient({ name: e.target.value })}
                  placeholder="Marina Burgess"
                />
              </div>
              <div className="form-group">
                <label className="form-label">Phone *</label>
                <input
                  className="form-input"
                  type="tel"
                  value={client.phone}
                  onChange={(e) => updateClient({ phone: e.target.value })}
                  placeholder="(828) 555-0142"
                />
              </div>
            </div>

            <div className="form-row" style={{ marginBottom: 14 }}>
              <div className="form-group">
                <label className="form-label">Date of Birth *</label>
                <input
                  className="form-input"
                  type="date"
                  value={client.dob}
                  onChange={(e) => updateClient({ dob: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Age</label>
                <input
                  className="form-input"
                  value={age != null ? String(age) : ''}
                  disabled
                  placeholder="auto"
                />
              </div>
            </div>

            <div className="form-row" style={{ marginBottom: 14 }}>
              <div className="form-group">
                <label className="form-label">
                  ZIP *
                  {zipLoading && <span className="sub" style={{ marginLeft: 6 }}>looking up…</span>}
                </label>
                <input
                  className="form-input"
                  value={client.zip}
                  onChange={(e) => updateClient({ zip: e.target.value.replace(/\D/g, '').slice(0, 5) })}
                  inputMode="numeric"
                  placeholder="27713"
                />
                {zipError && (
                  <div style={{ color: 'var(--v4-red)', fontSize: 11, marginTop: 4 }}>
                    ZIP lookup failed: {zipError}
                  </div>
                )}
              </div>
              <div className="form-group">
                <label className="form-label">County</label>
                <input className="form-input" value={client.county} disabled placeholder="auto" />
              </div>
            </div>

            <div className="form-group" style={{ marginBottom: 14 }}>
              <label className="form-label">State *</label>
              <div className="spills" style={{ gap: 6 }}>
                {STATE_OPTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`sp${client.state === s ? ' on' : ''}`}
                    style={{ padding: '8px 20px', fontSize: 13 }}
                    onClick={() => updateClient({ state: s })}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Plan Type *</label>
              <div className="plan-types">
                {PLAN_TYPES.map((pt) => (
                  <button
                    key={pt.value}
                    type="button"
                    className={`pt-card${client.planType === pt.value ? ' active' : ''}`}
                    onClick={() => updateClient({ planType: pt.value })}
                  >
                    <div className="ptn">{pt.label}</div>
                    <div className="pts">{pt.sub}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Current plan benchmark — optional. When set, the v4
                Quote table pins this plan as the leftmost gray
                column and computes deltas against it. Hidden until
                the agent has picked a county + plan type so the
                eligible-plan list is meaningful. */}
            {client.county && client.planType && (
              <div className="form-group">
                <label className="form-label">Client's current plan <span style={{ fontWeight: 400, color: '#6b7280' }}>(optional · for comparison)</span></label>
                <CurrentPlanPicker
                  hint="Search by plan name or H-number. Leave blank for a fresh quote."
                />
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="bbar">
        <div className="bbar-info">
          {summarize(client.name, age, client.county, client.state, client.planType)}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn out" onClick={onBack}>← Back</button>
          <button type="button" className="btn sea" disabled={!canContinue} onClick={onContinue}>
            Continue to Medications →
          </button>
        </div>
      </div>
    </>
  );
}

function dobToAge(dob: string): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return age;
}

function summarize(
  name: string, age: number | null, county: string, state: string | null, planType: PlanType | null,
): string {
  const parts = [
    name || 'Add a client',
    age != null ? `${age}` : null,
    county && state ? `${county}, ${state}` : state ?? null,
    planType,
  ].filter(Boolean);
  return parts.join(' · ');
}
