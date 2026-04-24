// Medications — v4 redesign of Step 3.
//
// Preserves every backend behavior of the original: RxNorm typeahead,
// photo-capture SMS, rxcui expansion, bulk formulary priming. The UI
// ports the mockup's chrome — capture bar at top, funnel, funnel-aware
// sticky bottom bar, inline tier-badge row per drug with a coverage
// ratio on the right.
//
// The original CaptureButton/CapturePanel components stay in use for
// the photo-link flow so we don't re-implement the SMS + polling
// plumbing.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '@/hooks/useSession';
import { CaptureButton } from '@/components/capture/CaptureButton';
import { CapturePanel } from '@/components/capture/CapturePanel';
import type { UseCaptureSessionResult } from '@/hooks/useCaptureSession';
import { searchDrug, type RxNormDrug } from '@/lib/rxnorm';
import { fetchPlansForClient } from '@/lib/planCatalog';
import { bulkLookupFormulary, getCachedFormulary } from '@/lib/formularyLookup';
import type { Plan, FormularyTier } from '@/types/plans';
import type { Medication } from '@/types/session';

interface Props {
  capture: UseCaptureSessionResult;
  onBack: () => void;
  onContinue: () => void;
}

export function MedsPage({ capture, onBack, onContinue }: Props) {
  const client = useSession((s) => s.client);
  const medications = useSession((s) => s.medications);
  const addMedication = useSession((s) => s.addMedication);
  const removeMedication = useSession((s) => s.removeMedication);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RxNormDrug[]>([]);
  const [searching, setSearching] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    if (query.trim().length < 2) { setResults([]); setSearching(false); return; }
    const ctl = new AbortController();
    abortRef.current = ctl;
    setSearching(true);
    const t = window.setTimeout(async () => {
      try {
        const list = await searchDrug(query, ctl.signal);
        if (!ctl.signal.aborted) setResults(list);
      } finally {
        if (!ctl.signal.aborted) setSearching(false);
      }
    }, 300);
    return () => { ctl.abort(); window.clearTimeout(t); };
  }, [query]);

  // Eligible plan set drives the funnel counts + per-drug badges. Cap
  // at 15 plans for the inline tier-badge row (readability) but use
  // the full list for the "cover all meds" funnel.
  const [eligiblePlans, setEligiblePlans] = useState<Plan[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchPlansForClient({
      state: client.state,
      county: client.county,
      planType: client.planType,
    }).then((plans) => { if (!cancelled) setEligiblePlans(plans); });
    return () => { cancelled = true; };
  }, [client.state, client.planType, client.county]);

  // Formulary prime. Same pattern Step3Medications uses — nonce rebuilt
  // from sorted rxcuis so late-arriving photo-capture hydration causes
  // a re-prime automatically.
  const [formularyTick, setFormularyTick] = useState(0);
  const primeNonce = useMemo(
    () => `${eligiblePlans.length}:${medications.map((m) => m.rxcui ?? '').sort().join(',')}`,
    [eligiblePlans, medications],
  );
  useEffect(() => {
    if (eligiblePlans.length === 0 || medications.length === 0) return;
    let cancelled = false;
    const contractIds = [...new Set(eligiblePlans.map((p) => p.contract_id))];
    const rxcuis = medications.map((m) => m.rxcui).filter((s): s is string => !!s);
    if (rxcuis.length === 0) return;
    bulkLookupFormulary(contractIds, rxcuis).then(() => {
      if (!cancelled) setFormularyTick((t) => t + 1);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primeNonce]);
  void formularyTick;

  // Funnel numbers.
  const totalPlans = eligiblePlans.length;
  const coverAll = useMemo(() => {
    if (medications.length === 0) return totalPlans;
    const rxs = medications.map((m) => m.rxcui).filter((s): s is string => !!s);
    if (rxs.length === 0) return totalPlans;
    return eligiblePlans.filter((p) =>
      rxs.every((rx) => {
        const hit = getCachedFormulary(`${p.contract_id}_${p.plan_number}`, rx);
        return hit && hit.tier !== 'not_covered' && hit.tier !== 'excluded';
      }),
    ).length;
    // formularyTick keeps coverAll fresh as bulk prime lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligiblePlans, medications, formularyTick]);

  function onSelectDrug(d: RxNormDrug) {
    addMedication({ rxcui: d.rxcui, name: d.name, source: 'manual' });
    setQuery(''); setResults([]);
  }

  return (
    <>
      <div className="scroll">
        <div className="phdr">
          <div className="ptitle">Medications</div>
          <div className="psub">Search RxNorm or photograph pill bottles. Drugs filter the plan pool.</div>
          {client.name && (
            <div className="pclient">
              <strong>{client.name}</strong>
              {dobAgePart(client.dob)}
              {client.county ? ` · ${client.county}, ${client.state}` : ''}
              {client.planType ? ` · ${client.planType}` : ''}
            </div>
          )}
        </div>
        <div className="cnt">
          <div style={{ marginBottom: 12 }}>
            <CaptureButton capture={capture} />
          </div>
          {capture.token && (
            <div style={{ marginBottom: 12 }}>
              <CapturePanel capture={capture} accept="medication" />
            </div>
          )}

          <div className="sb-wrap">
            <div className="si">⌕</div>
            <input
              className="sb"
              placeholder="Search RxNorm — gabapentin, metformin, atorvastatin…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {results.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              {results.slice(0, 8).map((d) => (
                <button
                  key={d.rxcui}
                  type="button"
                  onClick={() => onSelectDrug(d)}
                  className="sr"
                  style={{ alignItems: 'flex-start' }}
                >
                  <div className="sri">
                    <div className="srn">{d.name}</div>
                    <div className="srd">rxcui {d.rxcui}{d.tty ? ` · ${d.tty}` : ''}</div>
                  </div>
                </button>
              ))}
              {searching && <div style={{ padding: 10, fontSize: 11, color: 'var(--v4-g500)' }}>searching…</div>}
            </div>
          )}

          <div className="funnel">
            <div className="fs"><div className="fsn">{totalPlans}</div><div className="fsl">Total Plans</div></div>
            <div className="fa">→</div>
            <div className="fs"><div className="fsn">{coverAll}</div><div className="fsl">Cover All Meds</div></div>
            <div className="fa">→</div>
            <div className="fs act"><div className="fsn">{coverAll}</div><div className="fsl">Remaining</div></div>
          </div>

          <div className="card">
            <div className="chdr">
              <div className="cht">Added Medications</div>
              <div className="chc">
                {medications.length} med{medications.length === 1 ? '' : 's'} · {coverAll} plan{coverAll === 1 ? '' : 's'} pass
              </div>
            </div>
            {medications.length === 0 ? (
              <div style={{ padding: '14px 16px', fontSize: 12, color: 'var(--v4-g500)' }}>
                None yet. Search above, or send a photo-capture link to read bottle labels.
              </div>
            ) : (
              medications.map((m) => (
                <MedRow key={m.id} med={m} plans={eligiblePlans} onRemove={() => removeMedication(m.id)} />
              ))
            )}
          </div>
        </div>
      </div>
      <div className="bbar">
        <div className="bbar-info">
          <strong>{medications.length}</strong> med{medications.length === 1 ? '' : 's'} · <strong>{coverAll}</strong> plan{coverAll === 1 ? '' : 's'} remain
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn out" onClick={onBack}>← Back</button>
          <button type="button" className="btn sea" onClick={onContinue}>Continue to Providers →</button>
        </div>
      </div>
    </>
  );
}

function MedRow({ med, plans, onRemove }: { med: Medication; plans: Plan[]; onRemove: () => void }) {
  // Read each plan's hit from the formulary cache. Sort carriers so
  // the top 3 "carrier-representative" badges get inline placement and
  // the rest collapse into "+N more".
  const hits = plans.map((p) => {
    const hit = med.rxcui ? getCachedFormulary(`${p.contract_id}_${p.plan_number}`, med.rxcui) : null;
    return { plan: p, hit };
  });
  const covered = hits.filter((h) => h.hit && h.hit.tier !== 'not_covered' && h.hit.tier !== 'excluded');
  const paCount = hits.filter((h) => h.hit?.prior_auth).length;

  // One representative badge per unique carrier — keeps the row
  // readable when a carrier has 5+ plans all at the same tier.
  const byCarrier = new Map<string, { tier: FormularyTier | null; copay: number | null; coins: number | null }>();
  for (const h of hits) {
    if (!h.hit || h.hit.tier === 'not_covered' || h.hit.tier === 'excluded') continue;
    if (byCarrier.has(h.plan.carrier)) continue;
    byCarrier.set(h.plan.carrier, {
      tier: typeof h.hit.tier === 'number' ? h.hit.tier : null,
      copay: h.hit.copay,
      coins: h.hit.coinsurance != null ? Math.round(h.hit.coinsurance * 100) : null,
    });
  }
  const carriers = [...byCarrier.entries()];
  const shownCarriers = carriers.slice(0, 3);
  const moreCount = carriers.length - shownCarriers.length;

  return (
    <div className="mi">
      <div className="minfo">
        <div className="mname">{med.name}{med.strength ? ` · ${med.strength}` : ''}</div>
        <div className="mdet">
          {med.rxcui && <span className="mrx">rxcui {med.rxcui}</span>}
          {med.confidence && <span className={`mconf${med.confidence === 'high' ? ' h' : ''}`}>{med.confidence}</span>}
          {med.source === 'capture' && <span className="mphoto">📷 photo</span>}
          <span>30-day</span>
          {paCount > 0 && <span className="tb wrn" style={{ marginLeft: 4 }}>PA on {paCount} plan{paCount === 1 ? '' : 's'}</span>}
        </div>
        <div className="trow">
          {shownCarriers.length === 0 ? (
            <span className="tb not">No coverage yet</span>
          ) : (
            shownCarriers.map(([carrier, info]) => (
              <span key={carrier} className="tb cov">
                {firstWord(carrier)}: T{info.tier ?? '?'} {info.copay != null ? `$${info.copay}` : info.coins != null ? `${info.coins}%` : '—'}
              </span>
            ))
          )}
          {moreCount > 0 && <span className="tb cov">+{moreCount} more</span>}
        </div>
      </div>
      <div className="mact">
        <div style={{ fontFamily: 'var(--v4-fm)', fontSize: 16, fontWeight: 700, color: covered.length > 0 ? 'var(--v4-grn)' : 'var(--v4-red)' }}>
          {covered.length}/{plans.length}
        </div>
        <button type="button" className="mrem" onClick={onRemove}>Remove</button>
      </div>
    </div>
  );
}

function firstWord(s: string): string { return s.split(/\s+/)[0] ?? s; }

function dobAgePart(dob: string): string {
  if (!dob) return '';
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return ` · ${age}`;
}
