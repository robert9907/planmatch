import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '@/hooks/useSession';
import { StepHeader } from './StepHeader';
import { CaptureButton } from '@/components/capture/CaptureButton';
import { CapturePanel } from '@/components/capture/CapturePanel';
import type { UseCaptureSessionResult } from '@/hooks/useCaptureSession';
import { searchProvider, type NpiProvider } from '@/lib/npi';
import { checkNetworkAcross, type NetworkStatus } from '@/lib/fhir';
import { plansForClient } from '@/lib/cmsPlans';
import type { Plan } from '@/types/plans';
import type { Provider } from '@/types/session';

interface Step4Props {
  capture: UseCaptureSessionResult;
  onAdvance: () => void;
}

export function Step4Providers({ capture, onAdvance }: Step4Props) {
  const client = useSession((s) => s.client);
  const providers = useSession((s) => s.providers);
  const addProvider = useSession((s) => s.addProvider);
  const updateProvider = useSession((s) => s.updateProvider);
  const removeProvider = useSession((s) => s.removeProvider);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NpiProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const eligiblePlans = useMemo(
    () => plansForClient({ state: client.state, planType: client.planType, county: client.county }),
    [client.state, client.planType, client.county],
  );

  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    if (query.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);

    const timer = setTimeout(async () => {
      try {
        const list = await searchProvider(
          { name: query, state: client.state ?? undefined },
          controller.signal,
        );
        if (!controller.signal.aborted) setResults(list);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Search failed');
        setResults([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 350);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, client.state]);

  async function onSelectProvider(p: NpiProvider) {
    const providerId = addProvider({
      npi: p.npi,
      name: p.name + (p.credential ? `, ${p.credential}` : ''),
      specialty: p.specialty ?? undefined,
      address: [p.address, p.city, p.state, p.zip].filter(Boolean).join(', '),
      phone: p.phone ?? undefined,
      source: 'manual',
      networkStatus: {},
    });
    setQuery('');
    setResults([]);
    await runNetworkChecks(p.npi, eligiblePlans, (planId, status) => {
      const curr = useSession.getState().providers.find((prov) => prov.id === providerId);
      if (!curr) return;
      updateProvider(providerId, {
        networkStatus: { ...(curr.networkStatus ?? {}), [planId]: status },
      });
    });
  }

  async function recheckProvider(provider: Provider) {
    if (!provider.npi) return;
    updateProvider(provider.id, { networkStatus: {} });
    await runNetworkChecks(provider.npi, eligiblePlans, (planId, status) => {
      const curr = useSession.getState().providers.find((p) => p.id === provider.id);
      if (!curr) return;
      useSession.getState().updateProvider(provider.id, {
        networkStatus: { ...(curr.networkStatus ?? {}), [planId]: status },
      });
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <StepHeader
        number={4}
        title="Providers"
        subtitle="Search NPI Registry or photograph business cards. Network status runs against each plan's FHIR directory in the background — providers flagged out-of-network cut plans from the finalist pool."
        right={
          <div style={{ color: 'var(--i3)', fontSize: 11, textAlign: 'right' }}>
            {providers.length} provider{providers.length === 1 ? '' : 's'}
            <br />
            {eligiblePlans.length} plan{eligiblePlans.length === 1 ? '' : 's'} to verify against
          </div>
        }
      />

      <div className="pm-surface" style={{ padding: 14 }}>
        <CaptureButton
          capture={capture}
          label="Send photo capture link (bottles or provider cards)"
        />
      </div>

      {capture.token && <CapturePanel capture={capture} accept="any" />}

      <div className="pm-surface" style={{ padding: 14 }}>
        <div
          className="flex items-center gap-2"
          style={{
            height: 40,
            padding: '0 12px',
            borderRadius: 10,
            background: 'var(--warm)',
            border: '1px solid var(--w2)',
          }}
        >
          <StethoscopeIcon />
          <input
            type="search"
            placeholder="Search NPI Registry — first + last name or organization…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontSize: 14,
              color: 'var(--ink)',
              fontFamily: 'inherit',
            }}
          />
          {loading && <span style={{ color: 'var(--i3)', fontSize: 11 }}>searching…</span>}
        </div>

        {error && (
          <div
            style={{
              marginTop: 10,
              padding: 10,
              background: 'var(--rt)',
              color: 'var(--red)',
              fontSize: 12,
              borderRadius: 8,
            }}
          >
            NPI error: {error}
          </div>
        )}

        {results.length > 0 && (
          <div className="flex flex-col gap-1" style={{ marginTop: 10 }}>
            {results.map((p) => (
              <button
                key={p.npi}
                type="button"
                onClick={() => onSelectProvider(p)}
                className="text-left"
                style={{
                  padding: '8px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--w2)',
                  background: 'var(--wh)',
                  cursor: 'pointer',
                  color: 'var(--ink)',
                }}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {p.name}
                      {p.credential && `, ${p.credential}`}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--i2)', marginTop: 2 }}>
                      {p.specialty ?? 'Specialty not listed'}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--i3)' }}>
                      {[p.address, p.city, p.state, p.zip].filter(Boolean).join(', ')}
                    </div>
                  </div>
                  <span style={{ fontSize: 10, color: 'var(--i3)' }}>NPI {p.npi}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="pm-surface" style={{ padding: 14 }}>
        <div
          className="uppercase font-semibold"
          style={{ color: 'var(--i3)', fontSize: 10, letterSpacing: '0.08em', marginBottom: 8 }}
        >
          Added providers
        </div>

        {providers.length === 0 ? (
          <div style={{ color: 'var(--i3)', fontSize: 13, padding: '6px 0' }}>
            None yet. Search the NPI registry above, or approve captured provider cards.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {providers.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                plans={eligiblePlans}
                onRemove={() => removeProvider(provider.id)}
                onToggleConfirmed={(v) => updateProvider(provider.id, { manuallyConfirmed: v })}
                onRecheck={() => recheckProvider(provider)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <button type="button" onClick={onAdvance} className="pm-btn pm-btn-primary">
          Continue to filters →
        </button>
      </div>
    </div>
  );
}

async function runNetworkChecks(
  npi: string,
  plans: Plan[],
  onResult: (planId: string, status: NetworkStatus) => void,
) {
  const results = await checkNetworkAcross(npi, plans);
  for (const r of results) onResult(r.plan_id, r.status);
}

function ProviderRow({
  provider,
  plans,
  onRemove,
  onToggleConfirmed,
  onRecheck,
}: {
  provider: Provider;
  plans: Plan[];
  onRemove: () => void;
  onToggleConfirmed: (v: boolean) => void;
  onRecheck: () => void;
}) {
  const inCount = plans.filter((p) => provider.networkStatus?.[p.id] === 'in').length;
  const outCount = plans.filter((p) => provider.networkStatus?.[p.id] === 'out').length;
  const unknownCount = plans.length - inCount - outCount;

  return (
    <div
      style={{
        padding: 12,
        borderRadius: 10,
        border: '1px solid var(--w2)',
        background: 'var(--wh)',
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{provider.name}</div>
          {provider.specialty && (
            <div style={{ fontSize: 12, color: 'var(--i2)', marginTop: 2 }}>{provider.specialty}</div>
          )}
          {provider.address && (
            <div style={{ fontSize: 11, color: 'var(--i3)' }}>{provider.address}</div>
          )}
          <div
            className="flex items-center gap-2"
            style={{ marginTop: 4, fontSize: 11, color: 'var(--i3)' }}
          >
            <ProviderSourceBadge source={provider.source} />
            {provider.npi && <span>NPI {provider.npi}</span>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={onRecheck}
            className="pm-btn"
            style={{ height: 26, padding: '0 8px' }}
            disabled={!provider.npi}
          >
            Recheck
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="pm-btn"
            style={{ height: 26, padding: '0 8px' }}
          >
            Remove
          </button>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <div
          className="flex items-center justify-between"
          style={{ marginBottom: 4 }}
        >
          <span
            className="uppercase font-semibold"
            style={{ color: 'var(--i3)', fontSize: 10, letterSpacing: '0.06em' }}
          >
            FHIR network check · {inCount}/{plans.length} in-network
          </span>
          <span style={{ fontSize: 10, color: 'var(--i3)' }}>
            {outCount > 0 && `${outCount} out · `}
            {unknownCount > 0 && `${unknownCount} unknown`}
          </span>
        </div>
        <div className="flex flex-wrap" style={{ gap: 4 }}>
          {plans.map((plan) => (
            <NetworkBadge
              key={plan.id}
              plan={plan}
              status={provider.networkStatus?.[plan.id] ?? 'unknown'}
            />
          ))}
        </div>
      </div>

      <label
        className="flex items-center gap-2"
        style={{
          marginTop: 10,
          padding: 8,
          borderRadius: 8,
          background: provider.manuallyConfirmed ? 'var(--sl)' : 'var(--warm)',
          border: `1px solid ${provider.manuallyConfirmed ? 'var(--sm)' : 'var(--w2)'}`,
          cursor: 'pointer',
          fontSize: 12,
        }}
      >
        <input
          type="checkbox"
          checked={!!provider.manuallyConfirmed}
          onChange={(e) => onToggleConfirmed(e.target.checked)}
          style={{ width: 16, height: 16, accentColor: 'var(--sage)' }}
        />
        <span>
          <strong>Confirmed in-network manually</strong> — I called the office and they take
          Dorothy's plan. Overrides FHIR result for finalist calculation.
        </span>
      </label>
    </div>
  );
}

function NetworkBadge({ plan, status }: { plan: Plan; status: NetworkStatus }) {
  const map: Record<NetworkStatus, { bg: string; fg: string; border: string; label: string }> = {
    in: { bg: 'var(--sl)', fg: 'var(--sage)', border: 'var(--sage)', label: 'in' },
    out: { bg: 'var(--rt)', fg: 'var(--red)', border: 'var(--red)', label: 'out' },
    unknown: { bg: 'var(--w2)', fg: 'var(--i2)', border: 'var(--w3)', label: '?' },
  };
  const meta = map[status];
  return (
    <span
      title={`${plan.carrier} · ${plan.plan_name} · ${status}`}
      style={{
        fontSize: 10,
        fontWeight: 600,
        padding: '3px 7px',
        borderRadius: 999,
        background: meta.bg,
        color: meta.fg,
        border: `1px solid ${meta.border}`,
        whiteSpace: 'nowrap',
      }}
    >
      {plan.carrier.split(/\s+/)[0]}: {meta.label}
    </span>
  );
}

function ProviderSourceBadge({ source }: { source: 'manual' | 'capture' | 'from_med' }) {
  const meta =
    source === 'capture'
      ? { bg: 'var(--pt)', fg: 'var(--pur)', label: '📷 photo' }
      : source === 'from_med'
        ? { bg: 'var(--bt)', fg: 'var(--blue)', label: 'from Rx' }
        : { bg: 'var(--w2)', fg: 'var(--i2)', label: 'manual' };
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        padding: '1px 5px',
        borderRadius: 4,
        background: meta.bg,
        color: meta.fg,
      }}
    >
      {meta.label}
    </span>
  );
}

function StethoscopeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--i2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 2v2" />
      <path d="M5 2v2" />
      <path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1" />
      <path d="M8 15a6 6 0 0 0 12 0v-3" />
      <circle cx="20" cy="10" r="2" />
    </svg>
  );
}
