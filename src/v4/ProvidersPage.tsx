// Providers — v4 redesign of Step 4.
//
// Preserves the full stack: NPI search via /api/npi-search, per-plan
// FHIR network check, manual override. The UI now matches the mockup:
// capture bar, funnel, provider card with per-carrier network badges
// and a Network Verification summary card at the bottom.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '@/hooks/useSession';
import { CaptureButton } from '@/components/capture/CaptureButton';
import { CapturePanel } from '@/components/capture/CapturePanel';
import type { UseCaptureSessionResult } from '@/hooks/useCaptureSession';
import { searchProvider, type NpiProvider } from '@/lib/npi';
import { checkNetwork } from '@/lib/networkCheck';
import { fetchPlansForClient } from '@/lib/planCatalog';
import type { Plan } from '@/types/plans';
import type { Provider } from '@/types/session';

interface Props {
  capture: UseCaptureSessionResult;
  onBack: () => void;
  onContinue: () => void;
}

export function ProvidersPage({ capture, onBack, onContinue }: Props) {
  const client = useSession((s) => s.client);
  const providers = useSession((s) => s.providers);
  const addProvider = useSession((s) => s.addProvider);
  const updateProvider = useSession((s) => s.updateProvider);
  const removeProvider = useSession((s) => s.removeProvider);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NpiProvider[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    if (query.trim().length < 2) { setResults([]); setSearching(false); return; }
    const ctl = new AbortController();
    abortRef.current = ctl;
    setSearching(true); setError(null);
    const t = window.setTimeout(async () => {
      try {
        const out = await searchProvider({ name: query, state: client.state ?? undefined }, ctl.signal);
        if (!ctl.signal.aborted) setResults(out.providers);
      } catch (err) {
        if (!ctl.signal.aborted) setError((err as Error).message);
      } finally {
        if (!ctl.signal.aborted) setSearching(false);
      }
    }, 350);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [query, client.state]);

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

  // Funnel: plans-with-all-meds (assume full pool here — the medications
  // page already filtered upstream) minus any plan where any added
  // provider is confirmed out-of-network.
  const inNetworkPlans = useMemo(() => {
    if (providers.length === 0) return eligiblePlans.length;
    return eligiblePlans.filter((p) =>
      providers.every((pr) => {
        if (pr.manuallyConfirmed) return true;
        const s = pr.networkStatus?.[p.id];
        return s !== 'out';
      }),
    ).length;
  }, [providers, eligiblePlans]);

  async function onSelectProvider(p: NpiProvider) {
    const id = addProvider({
      npi: p.npi,
      name: p.name + (p.credential ? `, ${p.credential}` : ''),
      specialty: p.specialty ?? undefined,
      address: [p.address, p.city, p.state, p.zip].filter(Boolean).join(', '),
      phone: p.phone ?? undefined,
      source: 'manual',
      networkStatus: {},
    });
    setQuery(''); setResults([]);
    await runChecks(id, p.npi, eligiblePlans, updateProvider);
  }

  async function recheck(prov: Provider) {
    if (!prov.npi) return;
    updateProvider(prov.id, { networkStatus: {} });
    await runChecks(prov.id, prov.npi, eligiblePlans, updateProvider);
  }

  function toggleManualOverride(prov: Provider) {
    updateProvider(prov.id, { manuallyConfirmed: !prov.manuallyConfirmed });
  }

  return (
    <>
      <div className="scroll">
        <div className="phdr">
          <div className="ptitle">Providers</div>
          <div className="psub">Search NPI Registry or photograph business cards. Network status checked per plan.</div>
          {client.name && (
            <div className="pclient">
              <strong>{client.name}</strong>
              {client.county ? ` · ${client.county}, ${client.state}` : ''}
              {client.planType ? ` · ${client.planType}` : ''}
            </div>
          )}
        </div>
        <div className="cnt">
          <div style={{ marginBottom: 12 }}>
            <CaptureButton capture={capture} label="Send photo capture link (bottles or provider cards)" />
          </div>
          {capture.token && (
            <div style={{ marginBottom: 12 }}>
              <CapturePanel capture={capture} accept="any" />
            </div>
          )}

          <div className="sb-wrap">
            <div className="si">⌕</div>
            <input
              className="sb"
              placeholder="Search NPI Registry — first + last name or organization…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {error && (
            <div style={{ padding: 10, background: 'var(--v4-red-bg)', color: 'var(--v4-red)', borderRadius: 8, fontSize: 12, marginBottom: 12 }}>
              NPI error: {error}
            </div>
          )}
          {results.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              {results.slice(0, 8).map((p) => (
                <button key={p.npi} type="button" onClick={() => onSelectProvider(p)} className="sr">
                  <div className="sri">
                    <div className="srn">{p.name}{p.credential ? `, ${p.credential}` : ''}</div>
                    <div className="srd">
                      {p.specialty ?? '—'}
                      {p.city ? ` · ${p.city}, ${p.state}` : ''}
                    </div>
                  </div>
                  <div className="srr">
                    <div className="srt">NPI {p.npi}</div>
                  </div>
                </button>
              ))}
              {searching && <div style={{ padding: 10, fontSize: 11, color: 'var(--v4-g500)' }}>searching…</div>}
            </div>
          )}

          <div className="funnel">
            <div className="fs"><div className="fsn">{eligiblePlans.length}</div><div className="fsl">After Meds</div></div>
            <div className="fa">→</div>
            <div className="fs"><div className="fsn">{inNetworkPlans}</div><div className="fsl">In-Network</div></div>
            <div className="fa">→</div>
            <div className="fs act"><div className="fsn">{inNetworkPlans}</div><div className="fsl">Remaining</div></div>
          </div>

          <div className="card">
            <div className="chdr">
              <div className="cht">Added Providers</div>
              <div className="chc">
                {providers.length} provider{providers.length === 1 ? '' : 's'} · {inNetworkPlans} plan{inNetworkPlans === 1 ? '' : 's'} in-network
              </div>
            </div>
            {providers.length === 0 ? (
              <div style={{ padding: '14px 16px', fontSize: 12, color: 'var(--v4-g500)' }}>
                None yet. Search above or send a photo-capture link.
              </div>
            ) : (
              providers.map((pr) => (
                <ProviderCard
                  key={pr.id}
                  provider={pr}
                  plans={eligiblePlans}
                  onRecheck={() => recheck(pr)}
                  onOverride={() => toggleManualOverride(pr)}
                  onRemove={() => removeProvider(pr.id)}
                />
              ))
            )}
          </div>

          <NetworkSummary providers={providers} plans={eligiblePlans} inNet={inNetworkPlans} />
        </div>
      </div>
      <div className="bbar">
        <div className="bbar-info">
          <strong>{providers.length}</strong> provider{providers.length === 1 ? '' : 's'} · <strong>{inNetworkPlans}</strong> plan{inNetworkPlans === 1 ? '' : 's'} in-network
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn out" onClick={onBack}>← Back</button>
          <button type="button" className="btn sea" onClick={onContinue}>Continue to Extras →</button>
        </div>
      </div>
    </>
  );
}

function ProviderCard({
  provider, plans, onRecheck, onOverride, onRemove,
}: {
  provider: Provider; plans: Plan[];
  onRecheck: () => void; onOverride: () => void; onRemove: () => void;
}) {
  // One badge per carrier — collapse duplicate plans (a carrier with
  // 5 plans all in-network renders as one green "Humana ✓").
  const byCarrier = new Map<string, 'in' | 'out' | 'unknown'>();
  for (const p of plans) {
    const s = provider.networkStatus?.[p.id] ?? 'unknown';
    const prev = byCarrier.get(p.carrier);
    // A single "in" wins the carrier; otherwise keep worst-case.
    if (s === 'in' || prev === 'in') byCarrier.set(p.carrier, 'in');
    else if (s === 'out' || prev === 'out') byCarrier.set(p.carrier, 'out');
    else byCarrier.set(p.carrier, 'unknown');
  }
  const inCount = [...byCarrier.values()].filter((v) => v === 'in').length;
  const outCount = [...byCarrier.values()].filter((v) => v === 'out').length;
  const initials = provider.name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');

  const badges = [...byCarrier.entries()].slice(0, 4);
  const hiddenCarriers = byCarrier.size - badges.length;

  return (
    <div className="pi">
      <div className="pav">{initials || '—'}</div>
      <div className="pinfo">
        <div className="pname">{provider.name}</div>
        {provider.specialty && <div className="pspec">{provider.specialty}</div>}
        {provider.address && <div className="paddr">{provider.address}</div>}
        {provider.npi && (
          <div className="pnpi">NPI <span>{provider.npi}</span>{provider.manuallyConfirmed ? ' · MANUAL' : ''}</div>
        )}
        <div className="nrow">
          {badges.length === 0 ? (
            <span className="nb ot">Checking…</span>
          ) : (
            badges.map(([carrier, status]) => (
              <span key={carrier} className={`nb ${status === 'in' ? 'in' : status === 'out' ? 'ot' : 'ot'}`}>
                {firstWord(carrier)} {status === 'in' ? '✓' : status === 'out' ? '✗' : '?'}
              </span>
            ))
          )}
          {hiddenCarriers > 0 && inCount > 0 && <span className="nb in">+{hiddenCarriers} more</span>}
        </div>
        {provider.manuallyConfirmed && (
          <div className="mo">
            <div className="moc">✓</div>
            Confirmed in-network manually — overrides FHIR check.
          </div>
        )}
      </div>
      <div className="mact">
        <div style={{ fontFamily: 'var(--v4-fm)', fontSize: 13, fontWeight: 700, color: outCount > inCount ? 'var(--v4-red)' : 'var(--v4-grn)' }}>
          {inCount}/{byCarrier.size} in
        </div>
        <button type="button" className="btn out" style={{ fontSize: 10, padding: '4px 8px' }} onClick={onRecheck}>Recheck</button>
        <button type="button" className="btn out" style={{ fontSize: 10, padding: '4px 8px' }} onClick={onOverride}>
          {provider.manuallyConfirmed ? 'Remove override' : 'Manual override'}
        </button>
        <button type="button" className="mrem" onClick={onRemove}>Remove</button>
      </div>
    </div>
  );
}

function NetworkSummary({ providers, plans, inNet }: { providers: Provider[]; plans: Plan[]; inNet: number }) {
  const carrierCount = new Set(plans.map((p) => p.carrier)).size;
  const confirmedIn = providers.reduce((acc, pr) => {
    const carriers = new Set(
      plans.filter((p) => pr.networkStatus?.[p.id] === 'in').map((p) => p.carrier),
    );
    return acc + carriers.size;
  }, 0);
  const confirmedOut = providers.reduce((acc, pr) => {
    const carriers = new Set(
      plans.filter((p) => pr.networkStatus?.[p.id] === 'out').map((p) => p.carrier),
    );
    return acc + carriers.size;
  }, 0);
  return (
    <div className="fsm">
      <div className="fst">Network Verification</div>
      <div className="fsr"><div className="fsc p">✓</div><div className="fsx">FHIR checked <strong>{carrierCount}</strong> carrier{carrierCount === 1 ? '' : 's'}</div></div>
      <div className="fsr"><div className="fsc p">✓</div><div className="fsx"><strong>{confirmedIn}</strong> confirmed in-network</div></div>
      {confirmedOut > 0 && (
        <div className="fsr"><div className="fsc f">✗</div><div className="fsx"><strong>{confirmedOut}</strong> out-of-network</div></div>
      )}
      <div className="fsr"><div className="fsc p">✓</div><div className="fsx"><strong>{inNet}</strong> plan{inNet === 1 ? '' : 's'} remain</div></div>
    </div>
  );
}

async function runChecks(
  providerId: string,
  npi: string,
  plans: Plan[],
  updateProvider: (id: string, patch: Partial<Provider>) => void,
) {
  // Stagger checks so we don't stampede each carrier's FHIR endpoint
  // all at once.
  for (const plan of plans) {
    try {
      const result = await checkNetwork(npi, plan);
      const curr = useSession.getState().providers.find((p) => p.id === providerId);
      if (!curr) return;
      updateProvider(providerId, {
        networkStatus: { ...(curr.networkStatus ?? {}), [plan.id]: result.status },
      });
    } catch {
      // non-fatal — keep going with remaining plans
    }
  }
}

function firstWord(s: string): string { return s.split(/\s+/)[0] ?? s; }
