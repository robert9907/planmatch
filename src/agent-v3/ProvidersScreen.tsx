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

import { useEffect, useState } from 'react';
import type { UseCaptureSessionResult } from '@/hooks/useCaptureSession';
import { useProviderSearch } from '@/hooks/useProviderSearch';
import { useSession } from '@/hooks/useSession';
import { checkNetworkBatch, type NetworkStatus } from '@/lib/networkCheck';
import { fetchPlansForClient } from '@/lib/planCatalog';
import type { Plan } from '@/types/plans';
import type { Provider } from '@/types/session';
import { AgentInsight, Card, Container, Header, Nav } from './atoms';
import { SnapInbox } from './SnapInbox';
import { FADE_SLIDE_IN } from './styles';

interface Props {
  onNext: () => void;
  onBack: () => void;
  clientView: boolean;
  /** Plans pre-sorted by brain composite, optional. Falls back to raw
   *  fetchPlansForClient ordering when the brain hasn't run yet. */
  rankedPlanIds?: string[];
  capture: UseCaptureSessionResult;
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
  capture,
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

  // All eligible plans in the county. The provider rail shows EVERY
  // plan grouped by carrier (was top-3 only pre-fix) so the broker
  // can scan the whole county's network status in one place. Brain
  // rank ordering is ignored here — plans get sorted into carrier
  // groups by ProviderCard, where alphabetical-within-carrier matches
  // the way carriers organize their own directories.
  const allEligiblePlans = eligiblePlans;

  return (
    <Container>
      <Header
        title="Your doctors"
        sub="Network status across every plan in this county — grouped by carrier."
      />

      <SnapInbox capture={capture} accept="provider" />

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
            allPlans={allEligiblePlans}
            onWriteBack={(map) => {
              const prev = provider.networkStatus ?? {};
              const next = { ...prev };
              for (const [planId, status] of map) next[planId] = status;
              updateProvider(provider.id, { networkStatus: next });
            }}
            onMarkInNetwork={(planId) => {
              // Broker-verified manual override. Same channel as the
              // automatic checkNetworkBatch writeback so downstream
              // (CompareScreen, brain pipeline, AgentBase sync) reads
              // a single networkStatus map. Persists for the broker's
              // session; cross-session DB write to
              // pm_provider_network_cache is a follow-up endpoint.
              const prev = provider.networkStatus ?? {};
              updateProvider(provider.id, {
                networkStatus: { ...prev, [planId]: 'in' },
              });
            }}
            onRemove={() => removeProvider(provider.id)}
            staggerIndex={i}
          />
        ))
      )}

      {!clientView && providers.length > 0 && (
        <AgentInsight>
          ✅ Every county plan is listed above. Library API resolves
          UHC / Humana / BCBS NC / Devoted via FHIR; remaining carriers
          come from pm_provider_network_cache. Tap <b>Mark In-Network</b>
          on any <b>⚠ Unverified</b> row after you confirm with the
          carrier office — the override applies across Compare, brain,
          and the AgentBase write-back.
        </AgentInsight>
      )}

      <Nav onBack={onBack} onNext={onNext} />
    </Container>
  );
}

function ProviderCard({
  provider,
  allPlans,
  onWriteBack,
  onMarkInNetwork,
  onRemove,
  staggerIndex,
}: {
  provider: Provider;
  allPlans: Plan[];
  onWriteBack: (map: Map<string, NetworkStatus>) => void;
  onMarkInNetwork: (planId: string) => void;
  onRemove: () => void;
  staggerIndex: number;
}) {
  const [rows, setRows] = useState<PlanRowState[]>([]);
  const cardClient = useSession((s) => s.client);

  // Cap stagger at first 6 plans so an 80-plan county doesn't drag
  // the "Checking…" animation to 30+ seconds. Beyond the cap rows
  // flip straight to their resolved state once the library call lands.
  const STAGGER_CAP = 6;
  const STAGGER_STEP_MS = 250;

  useEffect(() => {
    // Seed rows in carrier-alpha-then-plan-alpha order so the grouped
    // render below has stable section ordering on first paint.
    const seeded = [...allPlans].sort(
      (a, b) =>
        (a.carrier ?? '').localeCompare(b.carrier ?? '') ||
        (a.plan_name ?? '').localeCompare(b.plan_name ?? ''),
    );
    setRows(seeded.map((p) => ({ plan: p, state: 'queued' as RowState })));
    if (allPlans.length === 0 || !provider.npi) return;

    let cancelled = false;
    const npi = provider.npi;

    // Stagger only the first STAGGER_CAP plans visually — past that the
    // queue animation contributes noise without information.
    //
    // The `r.state === 'queued'` guard is load-bearing. For an 80-plan
    // card the library round-trip (~500ms cached) finishes WHILE the
    // stagger timers are still firing (cap × 250ms ≈ 1.5s). Without the
    // guard, the stagger callbacks that fire AFTER the library flush
    // zombie-overwrite resolved rows back to 'checking' — the broker
    // sees plans the library marked in_network as stuck "Checking…",
    // then downgrading to Unverified once the timer queue drains.
    // With the guard, once a row leaves 'queued' (either via this
    // stagger or via the library flush below) it's locked in; pending
    // stagger callbacks see state ≠ 'queued' and no-op.
    seeded.forEach((p, i) => {
      const delay = Math.min(i, STAGGER_CAP) * STAGGER_STEP_MS;
      window.setTimeout(() => {
        if (cancelled) return;
        setRows((prev) =>
          prev.map((r) =>
            r.plan.id === p.id && r.state === 'queued'
              ? { ...r, state: 'checking' }
              : r,
          ),
        );
      }, delay + 80);
    });

    checkNetworkBatch(npi, seeded, {
      state: cardClient.state ?? null,
      county: cardClient.county ?? null,
    })
      .then((map) => {
        if (cancelled) return;

        // Build writeBack DIRECTLY from the resolved map first, before
        // any setRows call. The previous version populated writeBack
        // inside the setRows updater callback — in React 18 / concurrent
        // rendering that callback can run AFTER the surrounding .then
        // continues, so `onWriteBack(writeBack)` could fire with a still-
        // empty Map. updateProvider then merged 80 empty keys onto
        // provider.networkStatus, the CompareScreen provider list saw
        // undefined for every plan, and rendered '⚠ Unverified' across
        // the board even though the rows on this card briefly flashed
        // green before re-rendering.
        const writeBack = new Map<string, NetworkStatus>();
        for (const p of seeded) {
          const result = map.get(p.id);
          writeBack.set(p.id, result?.status ?? 'unknown');
        }

        // Diagnostic: surfaces a one-line summary in devtools so we can
        // confirm without a debugger that the data path is healthy.
        let inN = 0;
        let outN = 0;
        let unkN = 0;
        for (const v of writeBack.values()) {
          if (v === 'in') inN += 1;
          else if (v === 'out') outN += 1;
          else unkN += 1;
        }
        console.log(
          `[providers] writeBack npi=${npi}: in=${inN} out=${outN} unknown=${unkN} (rows=${seeded.length})`,
        );

        setRows((prev) =>
          prev.map((r) => {
            const status = writeBack.get(r.plan.id) ?? 'unknown';
            // Don't downgrade a broker-marked 'in' back to whatever
            // checkNetworkBatch returned mid-session.
            const fromSession = provider.networkStatus?.[r.plan.id];
            if (fromSession === 'in' && status !== 'in') return r;
            return { ...r, state: status };
          }),
        );
        onWriteBack(writeBack);
      })
      .catch((err) => {
        console.warn('[providers] checkNetworkBatch failed:', (err as Error).message);
        if (cancelled) return;
        setRows((prev) => prev.map((r) => ({ ...r, state: 'unknown' })));
      });

    return () => {
      cancelled = true;
    };
    // cardClient.state + .county are in the deps because checkNetworkBatch
    // routes to /api/library/provider-network (with FHIR live fallback)
    // when both are set, and falls back to a direct cache read otherwise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.npi, allPlans.map((p) => p.id).join(','), cardClient.state, cardClient.county]);

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

      {rows.length > 0 && (
        <ProviderRail
          rows={rows}
          onMarkInNetwork={onMarkInNetwork}
        />
      )}
    </Card>
  );
}

// ── Per-provider rail: summary + grouped rows + manual override ────
// Renders one section per carrier with plans alphabetized within. The
// top summary line counts the In-Network / OON / Unverified buckets so
// the broker can see at a glance "12 in / 3 out / 27 to verify" before
// scrolling. The override button is the workflow-critical bit: the
// broker calls Aetna, confirms Daniel Waddell is in-network on plan X,
// taps "Mark In-Network", and the row flips green AND the override
// propagates to CompareScreen + brain + AgentBase sync via the parent
// updateProvider call.
function ProviderRail({
  rows,
  onMarkInNetwork,
}: {
  rows: PlanRowState[];
  onMarkInNetwork: (planId: string) => void;
}) {
  // Counts — terminal states only (queued/checking don't contribute).
  let inCount = 0;
  let outCount = 0;
  let unknownCount = 0;
  for (const r of rows) {
    if (r.state === 'in') inCount += 1;
    else if (r.state === 'out') outCount += 1;
    else if (r.state === 'unknown') unknownCount += 1;
  }
  // Group by carrier — Map preserves insertion order, and rows are
  // already carrier-alpha-sorted in seeded.
  const byCarrier = new Map<string, PlanRowState[]>();
  for (const r of rows) {
    const c = r.plan.carrier || 'Other';
    const slot = byCarrier.get(c) ?? [];
    slot.push(r);
    byCarrier.set(c, slot);
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
          padding: '8px 12px',
          background: '#f8fafc',
          borderRadius: 8,
          marginBottom: 10,
          fontSize: 11,
          fontWeight: 700,
        }}
      >
        <span style={{ color: '#065f46' }}>✓ {inCount} In-Network</span>
        <span style={{ color: '#991b1b' }}>✕ {outCount} Out-of-Network</span>
        <span style={{ color: '#92400e' }}>⚠ {unknownCount} Unverified</span>
        <span style={{ color: '#94a3b8', fontWeight: 500 }}>
          · {rows.length} plans total
        </span>
      </div>

      {Array.from(byCarrier.entries()).map(([carrier, group]) => (
        <div key={carrier} style={{ marginBottom: 12 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.4,
              textTransform: 'uppercase',
              color: '#475569',
              padding: '4px 4px 6px',
              borderBottom: '1px solid rgba(13,47,94,0.06)',
              marginBottom: 4,
              display: 'flex',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <span>{carrier}</span>
            <span style={{ color: '#94a3b8', fontWeight: 500 }}>
              {group.length} plan{group.length === 1 ? '' : 's'}
            </span>
          </div>
          {group.map((row) => {
            const isUnverified = row.state === 'unknown';
            return (
              <div
                key={row.plan.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '7px 10px',
                  borderRadius: 6,
                  background: '#fbfcfd',
                  border: '1px solid rgba(13,47,94,0.04)',
                  marginBottom: 4,
                  gap: 8,
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    color: '#0d2f5e',
                    fontWeight: 600,
                    flex: 1,
                    minWidth: 0,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  title={row.plan.plan_name}
                >
                  {row.plan.plan_name}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <RowBadge state={row.state} />
                  {isUnverified && (
                    <button
                      type="button"
                      onClick={() => onMarkInNetwork(row.plan.id)}
                      style={{
                        background: 'white',
                        color: '#065f46',
                        border: '1px solid #10b981',
                        borderRadius: 14,
                        padding: '2px 8px',
                        fontSize: 10,
                        fontWeight: 700,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                      title="Mark in-network — apply after confirming with the carrier office"
                    >
                      Mark In-Network
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
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
        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            color: '#64748b',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 11,
              height: 11,
              borderRadius: '50%',
              border: '2px solid rgba(13,47,94,0.15)',
              borderTopColor: '#0d2f5e',
              animation: 'npiSearchSpin 0.7s linear infinite',
              display: 'inline-block',
            }}
          />
          Searching NPPES…
          <style>{`@keyframes npiSearchSpin { to { transform: rotate(360deg); } }`}</style>
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
          {search.results.map((r) => {
            const isOrg = r.enumeration_type === 'NPI-2';
            const location = r.practice_city
              ? `${r.practice_city}${r.practice_state ? ', ' + r.practice_state : ''}`
              : null;
            return (
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
                    <span style={{ display: 'block' }}>
                      <span style={{ fontWeight: 700, color: '#0d2f5e' }}>
                        {r.display_name}
                      </span>
                      {isOrg && (
                        <span
                          style={{
                            marginLeft: 6,
                            fontSize: 9.5,
                            fontWeight: 700,
                            letterSpacing: 0.4,
                            textTransform: 'uppercase',
                            color: '#0071e3',
                            background: 'rgba(0,113,227,0.08)',
                            padding: '1px 6px',
                            borderRadius: 999,
                            verticalAlign: 'middle',
                          }}
                        >
                          Practice
                        </span>
                      )}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        marginTop: 1,
                        fontSize: 11,
                        color: '#64748b',
                      }}
                    >
                      {[
                        r.specialty,
                        !isOrg && r.practice_name ? r.practice_name : null,
                        location,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        marginTop: 1,
                        fontFamily:
                          'ui-monospace, SFMono-Regular, Menlo, monospace',
                        fontSize: 9.5,
                        letterSpacing: 0.3,
                        color: '#94a3b8',
                      }}
                    >
                      NPI {r.npi}
                    </span>
                  </span>
                  <span
                    style={{ fontSize: 11, color: '#0071e3', fontWeight: 700 }}
                  >
                    Add
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
