// ProvidersScreen — agent-v3 screen 3.
//
// Mockup intent: a single provider card with the provider's name and
// group, then a row per recommended plan with a Verified / Checking /
// Queued badge that resolves in sequence. Real wiring uses
// pm_provider_network_cache (the working table behind
// "pm_provider_cache_coverage" in the spec) via checkNetworkBatch —
// same source the v4 ProvidersPage already uses, so the two flows agree
// on coverage truth.
//
// Live wires:
//   • Eligible plans → fetchPlansForClient (state/county/planType)
//   • Sorted by Brain composite (passed in) so the rows lead with the
//     plans most likely to be finalists. We surface the top 3.
//   • Per provider: checkNetworkBatch(npi, eligiblePlans) returns the
//     'in' | 'out' | 'unknown' result keyed by plan.id, which we
//     write back to useSession.providers[].networkStatus so the rest
//     of the workflow (Swipe, Compare, Enroll) can read it.
//   • A staggered display delay (200/600/1000 ms) gives the spec's
//     Queued → Checking → Verified animation feel even when the cache
//     read is instantaneous. The badge always reflects the actual
//     resolved status — if a plan is out-of-network or unknown the
//     final state is the colored badge, not "Verified".

import { useEffect, useMemo, useState } from 'react';
import { useProviderSearch } from '@/hooks/useProviderSearch';
import { useSession } from '@/hooks/useSession';
import { checkNetworkBatch, type NetworkStatus } from '@/lib/networkCheck';
import { fetchPlansForClient } from '@/lib/planCatalog';
import type { Plan } from '@/types/plans';
import type { Provider } from '@/types/session';
import { AgentInsight, Card, Container, Header, Nav } from './atoms';
import { FADE_SLIDE_IN } from './styles';

interface Props {
  onNext: () => void;
  onBack: () => void;
  clientView: boolean;
  /** Plans pre-sorted by brain composite, optional. Falls back to raw
   *  fetchPlansForClient ordering when the brain hasn't run yet. */
  rankedPlanIds?: string[];
}

type RowState = 'queued' | 'checking' | NetworkStatus;

interface PlanRowState {
  plan: Plan;
  state: RowState;
}

export function ProvidersScreen({
  onNext,
  onBack,
  clientView,
  rankedPlanIds,
}: Props) {
  const client = useSession((s) => s.client);
  const providers = useSession((s) => s.providers);
  const updateProvider = useSession((s) => s.updateProvider);
  const addProvider = useSession((s) => s.addProvider);
  const removeProvider = useSession((s) => s.removeProvider);

  const [eligiblePlans, setEligiblePlans] = useState<Plan[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchPlansForClient({
      state: client.state,
      county: client.county,
      planType: client.planType,
    }).then((plans) => {
      if (!cancelled) setEligiblePlans(plans);
    });
    return () => {
      cancelled = true;
    };
  }, [client.state, client.county, client.planType]);

  // Top 3 plans against which we render the in-network rail. Ordered
  // by brain rank when available, otherwise the catalog's natural
  // order.
  const topPlans = useMemo(() => {
    if (eligiblePlans.length === 0) return [];
    if (rankedPlanIds && rankedPlanIds.length > 0) {
      const byId = new Map(eligiblePlans.map((p) => [p.id, p]));
      const ordered = rankedPlanIds
        .map((id) => byId.get(id))
        .filter((p): p is Plan => !!p);
      // Backfill with any plan not already represented, preserving order.
      for (const p of eligiblePlans) {
        if (!ordered.find((q) => q.id === p.id)) ordered.push(p);
      }
      return ordered.slice(0, 3);
    }
    return eligiblePlans.slice(0, 3);
  }, [eligiblePlans, rankedPlanIds]);

  return (
    <Container>
      <Header
        title="Your doctors"
        sub="Verifying network status across all recommended plans…"
      />
      <AddProviderPanel
        state={client.state}
        excludeNpis={providers
          .map((p) => p.npi)
          .filter((n): n is string => !!n)}
        onAdd={(r) => {
          addProvider({
            name: r.display_name,
            npi: r.npi,
            specialty: r.specialty ?? undefined,
            address:
              r.practice_city && r.practice_state
                ? `${r.practice_city}, ${r.practice_state}${r.practice_zip ? ' ' + r.practice_zip : ''}`
                : undefined,
            source: 'manual',
          });
        }}
      />

      {providers.length === 0 ? (
        <Card>
          <div
            style={{
              padding: 12,
              fontSize: 13,
              color: '#64748b',
              textAlign: 'center',
            }}
          >
            Search NPPES above to add providers — network status across
            recommended plans populates per row once added.
          </div>
        </Card>
      ) : (
        providers.map((provider, i) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            topPlans={topPlans}
            onWriteBack={(map) => {
              const prev = provider.networkStatus ?? {};
              const next = { ...prev };
              for (const [planId, status] of map) next[planId] = status;
              updateProvider(provider.id, { networkStatus: next });
            }}
            onRemove={() => removeProvider(provider.id)}
            staggerIndex={i}
          />
        ))
      )}

      {!clientView && providers.length > 0 && (
        <AgentInsight>
          ✅ Provider rail above reflects pm_provider_network_cache. Any
          plan stuck on <b>Unknown</b> means the consumer-side scraper
          hasn't covered it yet — use the per-carrier override on the v4
          Providers page if you've called the office.
        </AgentInsight>
      )}

      <Nav onBack={onBack} onNext={onNext} />
    </Container>
  );
}

function ProviderCard({
  provider,
  topPlans,
  onWriteBack,
  onRemove,
  staggerIndex,
}: {
  provider: Provider;
  topPlans: Plan[];
  onWriteBack: (map: Map<string, NetworkStatus>) => void;
  onRemove: () => void;
  staggerIndex: number;
}) {
  const [rows, setRows] = useState<PlanRowState[]>([]);

  useEffect(() => {
    setRows(topPlans.map((p) => ({ plan: p, state: 'queued' as RowState })));
    if (topPlans.length === 0 || !provider.npi) return;

    let cancelled = false;
    const npi = provider.npi;
    const plans = topPlans;

    // Stagger the visual transitions so the ribbon feels like a queue
    // even when the cache hits return instantly.
    plans.forEach((p, i) => {
      window.setTimeout(() => {
        if (cancelled) return;
        setRows((prev) =>
          prev.map((r) => (r.plan.id === p.id ? { ...r, state: 'checking' } : r)),
        );
      }, 200 + i * 400);
    });

    checkNetworkBatch(npi, plans, {
      county: null,
    })
      .then((map) => {
        if (cancelled) return;
        const writeBack = new Map<string, NetworkStatus>();
        plans.forEach((p, i) => {
          window.setTimeout(() => {
            if (cancelled) return;
            const result = map.get(p.id);
            const status: NetworkStatus = result?.status ?? 'unknown';
            setRows((prev) =>
              prev.map((r) => (r.plan.id === p.id ? { ...r, state: status } : r)),
            );
            writeBack.set(p.id, status);
            if (i === plans.length - 1) onWriteBack(writeBack);
          }, 600 + i * 400);
        });
      })
      .catch((err) => {
        console.warn('[providers] checkNetworkBatch failed:', (err as Error).message);
        if (cancelled) return;
        setRows((prev) => prev.map((r) => ({ ...r, state: 'unknown' })));
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.npi, topPlans.map((p) => p.id).join(',')]);

  return (
    <Card
      style={{
        marginBottom: 12,
        animation: `${FADE_SLIDE_IN} 0.4s ease ${staggerIndex * 0.08}s both`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          marginBottom: 16,
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            background: 'linear-gradient(135deg, #dbeafe, #bfdbfe)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 24,
          }}
        >
          🩺
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 17, color: '#0d2f5e' }}>
            {provider.name}
          </div>
          <div style={{ color: '#64748b', fontSize: 12 }}>
            {[provider.specialty, provider.npi ? `NPI ${provider.npi}` : null]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${provider.name}`}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#94a3b8',
            cursor: 'pointer',
            fontSize: 14,
            padding: '0 4px',
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>

      {rows.length === 0 && (
        <div
          style={{
            padding: 12,
            fontSize: 12,
            color: '#94a3b8',
            textAlign: 'center',
          }}
        >
          {provider.npi
            ? 'Waiting for the eligible-plan list to land…'
            : 'No NPI on file — verify manually on the v4 Providers page.'}
        </div>
      )}

      {rows.map((row) => (
        <div
          key={row.plan.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            borderRadius: 8,
            background: '#f8fafc',
            border: '1px solid rgba(13,47,94,0.04)',
            marginBottom: 5,
          }}
        >
          <div style={{ fontSize: 11, color: '#475569', fontWeight: 600 }}>
            {row.plan.carrier}{' '}
            <span style={{ color: '#94a3b8', fontWeight: 400 }}>
              · {row.plan.plan_name}
            </span>
          </div>
          <RowBadge state={row.state} />
        </div>
      ))}
    </Card>
  );
}

function RowBadge({ state }: { state: RowState }) {
  if (state === 'queued') {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '3px 10px',
          borderRadius: 14,
          fontSize: 11,
          fontWeight: 600,
          background: '#f1f5f9',
          color: '#94a3b8',
        }}
      >
        ⏳ Queued
      </span>
    );
  }
  if (state === 'checking') {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '3px 10px',
          borderRadius: 14,
          fontSize: 11,
          fontWeight: 600,
          background: '#fef3c7',
          color: '#92400e',
        }}
      >
        <span className="pma3-pulsedot" /> Checking…
      </span>
    );
  }
  if (state === 'in') {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '3px 10px',
          borderRadius: 14,
          fontSize: 11,
          fontWeight: 600,
          background: '#d1fae5',
          color: '#065f46',
          animation: `${FADE_SLIDE_IN} 0.3s ease`,
        }}
      >
        ✓ Verified
      </span>
    );
  }
  if (state === 'out') {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '3px 10px',
          borderRadius: 14,
          fontSize: 11,
          fontWeight: 600,
          background: '#fee2e2',
          color: '#991b1b',
        }}
      >
        ✕ Out-of-network
      </span>
    );
  }
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '3px 10px',
        borderRadius: 14,
        fontSize: 11,
        fontWeight: 600,
        background: '#f1f5f9',
        color: '#94a3b8',
      }}
    >
      ? Unknown
    </span>
  );
}

function AddProviderPanel({
  state,
  excludeNpis,
  onAdd,
}: {
  state: string | null;
  excludeNpis: readonly string[];
  onAdd: (r: {
    npi: string;
    display_name: string;
    specialty: string | null;
    practice_city: string | null;
    practice_state: string | null;
    practice_zip: string | null;
  }) => void;
}) {
  const [query, setQuery] = useState('');
  const search = useProviderSearch(query, state, excludeNpis);

  return (
    <Card style={{ marginBottom: 12, padding: '16px 20px' }}>
      <label
        style={{
          display: 'block',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          color: '#64748b',
          marginBottom: 6,
        }}
      >
        Add provider
      </label>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={
          state
            ? `First last name (e.g. jane smith) — ${state} ranked first`
            : 'First last name (e.g. jane smith)'
        }
        style={{
          width: '100%',
          padding: '10px 12px',
          borderRadius: 10,
          border: '1px solid rgba(13,47,94,0.12)',
          fontSize: 14,
          color: '#0d2f5e',
          outline: 'none',
          background: '#f8fafc',
          boxSizing: 'border-box',
        }}
      />
      {search.loading && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#64748b' }}>
          Searching NPPES…
        </div>
      )}
      {search.error && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#a32d2d' }}>
          {search.error}
        </div>
      )}
      {search.fallback === 'last_name_only' && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#92400e' }}>
          No first-name match — showing last-name-only results.
        </div>
      )}
      {search.results.length > 0 && (
        <ul
          style={{
            listStyle: 'none',
            margin: '8px 0 0',
            padding: 0,
            border: '1px solid rgba(13,47,94,0.08)',
            borderRadius: 10,
            overflow: 'hidden',
            background: 'white',
          }}
        >
          {search.results.map((r) => (
            <li
              key={r.npi}
              style={{ borderBottom: '1px solid rgba(13,47,94,0.04)' }}
            >
              <button
                type="button"
                onClick={() => {
                  onAdd(r);
                  setQuery('');
                }}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 12px',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12,
                  fontSize: 13,
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 700, color: '#0d2f5e' }}>
                    {r.display_name}
                  </span>
                  {r.specialty && (
                    <span style={{ marginLeft: 8, fontSize: 11, color: '#64748b' }}>
                      {r.specialty}
                    </span>
                  )}
                  <span style={{ marginLeft: 8, fontSize: 11, color: '#94a3b8' }}>
                    NPI {r.npi}
                    {r.practice_city
                      ? ` · ${r.practice_city}${r.practice_state ? ', ' + r.practice_state : ''}`
                      : ''}
                  </span>
                </span>
                <span style={{ fontSize: 11, color: '#0071e3', fontWeight: 700 }}>
                  Add
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
