import { useEffect, useMemo, useState } from 'react';
import {
  type CarrierOption,
  type VerificationRow,
  type VerificationsQueue,
  fetchCarriersFor,
} from '@/hooks/useVerificationsQueue';

interface Props {
  open: boolean;
  onClose: () => void;
  queue: VerificationsQueue;
}

// Floating right-slide drawer, overlays on top of the workflow so Rob
// can work the verification queue without losing his place in the
// current client's Step 4. Opens from the flashing sidebar pill.
export function ProviderVerificationDrawer({ open, onClose, queue }: Props) {
  // Group rows by session_id so Rob verifies a consumer's whole
  // provider list as a unit.
  const groups = useMemo(() => {
    const map = new Map<string, VerificationRow[]>();
    for (const row of queue.rows) {
      const list = map.get(row.session_id) ?? [];
      list.push(row);
      map.set(row.session_id, list);
    }
    return Array.from(map.entries())
      .map(([session_id, rows]) => ({
        session_id,
        rows,
        county: rows[0]?.county_name ?? null,
        state: rows[0]?.state ?? null,
        newestCreatedAt: rows.reduce(
          (max, r) => (new Date(r.created_at) > new Date(max) ? r.created_at : max),
          rows[0]?.created_at ?? new Date().toISOString(),
        ),
      }))
      .sort(
        (a, b) =>
          new Date(b.newestCreatedAt).getTime() -
          new Date(a.newestCreatedAt).getTime(),
      );
  }, [queue.rows]);

  return (
    <>
      {open && (
        <div
          onClick={onClose}
          aria-hidden
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.35)',
            zIndex: 40,
          }}
        />
      )}
      <aside
        aria-hidden={!open}
        aria-label="Provider verification queue"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(560px, 100vw)',
          background: 'var(--warm)',
          borderLeft: '1px solid var(--w2)',
          boxShadow: open ? '-8px 0 24px rgba(0,0,0,0.08)' : 'none',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 200ms ease',
          zIndex: 41,
          display: 'flex',
          flexDirection: 'column',
          color: 'var(--ink)',
        }}
      >
        <header
          className="flex items-center justify-between gap-2 border-b"
          style={{
            padding: '12px 16px',
            background: 'var(--wh)',
            borderColor: 'var(--w2)',
          }}
        >
          <div>
            <div className="font-lora font-semibold" style={{ fontSize: 16 }}>
              Provider verification
            </div>
            <div style={{ color: 'var(--i2)', fontSize: 11 }}>
              {queue.pendingCount === 0
                ? 'Queue is empty'
                : `${groups.length} session${groups.length === 1 ? '' : 's'} · ${queue.pendingCount} provider${queue.pendingCount === 1 ? '' : 's'} awaiting`}
              {queue.loading ? ' · refreshing…' : ''}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={queue.refresh}
              className="pm-btn"
              style={{ height: 28, padding: '0 10px', fontSize: 11 }}
              title="Refresh queue"
            >
              ↻
            </button>
            <button
              type="button"
              onClick={onClose}
              className="pm-btn"
              style={{ height: 28, padding: '0 10px', fontSize: 11 }}
              aria-label="Close verification drawer"
            >
              ✕
            </button>
          </div>
        </header>

        {queue.error && (
          <div
            style={{
              margin: 12,
              padding: 10,
              borderRadius: 8,
              background: 'var(--rt)',
              color: 'var(--red)',
              border: '1px solid var(--red)',
              fontSize: 12,
            }}
          >
            {queue.error}
          </div>
        )}

        <div
          className="flex-1"
          style={{ overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          {groups.length === 0 && !queue.loading && !queue.error && (
            <div
              className="pm-surface"
              style={{
                padding: 20,
                textAlign: 'center',
                color: 'var(--i3)',
                fontSize: 13,
              }}
            >
              No providers pending verification.
              <div style={{ fontSize: 11, marginTop: 4 }}>
                New rows arrive when a consumer submits Step 3 on the Plan Match widget.
              </div>
            </div>
          )}

          {groups.map((group) => (
            <SessionGroup
              key={group.session_id}
              sessionId={group.session_id}
              county={group.county}
              state={group.state}
              rows={group.rows}
              newestCreatedAt={group.newestCreatedAt}
              onPatch={queue.patch}
            />
          ))}
        </div>
      </aside>
    </>
  );
}

// ─── Session group ──────────────────────────────────────────────────

function SessionGroup({
  sessionId,
  county,
  state,
  rows,
  newestCreatedAt,
  onPatch,
}: {
  sessionId: string;
  county: string | null;
  state: string | null;
  rows: VerificationRow[];
  newestCreatedAt: string;
  onPatch: VerificationsQueue['patch'];
}) {
  const [carriers, setCarriers] = useState<CarrierOption[] | null>(null);
  const [carriersError, setCarriersError] = useState<string | null>(null);

  useEffect(() => {
    if (!county || !state) return;
    let cancelled = false;
    fetchCarriersFor(state, county)
      .then((list) => {
        if (!cancelled) setCarriers(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setCarriersError(err instanceof Error ? err.message : 'Carrier lookup failed');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [state, county]);

  const elapsed = formatElapsed(Date.now() - new Date(newestCreatedAt).getTime());
  const elapsedTone = ageTone(new Date(newestCreatedAt).getTime());

  return (
    <div className="pm-surface" style={{ padding: 12 }}>
      <div className="flex items-center justify-between gap-2" style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: 'var(--i2)', fontFamily: 'ui-monospace, Menlo, monospace' }}>
          Session {sessionId.slice(0, 8)}… · {county ?? '?'}, {state ?? '?'}
        </div>
        <AgeChip label={elapsed} tone={elapsedTone} />
      </div>

      {carriersError && (
        <div style={{ fontSize: 11, color: 'var(--red)', marginBottom: 8 }}>
          Carrier lookup: {carriersError}
        </div>
      )}

      <div className="flex flex-col" style={{ gap: 8 }}>
        {rows.map((row) => (
          <VerificationRowItem
            key={row.id}
            row={row}
            carriers={carriers}
            onPatch={onPatch}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Single row ─────────────────────────────────────────────────────

function VerificationRowItem({
  row,
  carriers,
  onPatch,
}: {
  row: VerificationRow;
  carriers: CarrierOption[] | null;
  onPatch: VerificationsQueue['patch'];
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(row.in_network_carriers ?? []),
  );
  const [busy, setBusy] = useState(false);

  const tone = row.status === 'researching' ? 'amb' : row.status === 'verified' ? 'sage' : 'red';

  function toggle(contractId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(contractId)) next.delete(contractId);
      else next.add(contractId);
      return next;
    });
  }

  async function startResearch() {
    setBusy(true);
    await onPatch(row.id, { status: 'researching' });
    setBusy(false);
  }

  async function goBack() {
    setBusy(true);
    await onPatch(row.id, { status: 'unverified' });
    setBusy(false);
  }

  async function saveVerified() {
    const contracts = Array.from(selected);
    if (contracts.length === 0) return;
    setBusy(true);
    await onPatch(row.id, {
      status: 'verified',
      in_network_carriers: contracts,
    });
    setBusy(false);
  }

  return (
    <div
      style={{
        border: '1px solid var(--w2)',
        background: 'var(--wh)',
        borderRadius: 10,
        padding: 10,
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2" style={{ minWidth: 0, flex: 1 }}>
          <StatusDot tone={tone} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{row.provider_name}</div>
            <div style={{ fontSize: 11, color: 'var(--i2)', marginTop: 2 }}>
              {[
                row.provider_specialty,
                row.provider_npi ? `NPI ${row.provider_npi}` : null,
              ]
                .filter(Boolean)
                .join(' · ') || 'No specialty or NPI'}
            </div>
          </div>
        </div>
        {row.status === 'unverified' && (
          <button
            type="button"
            onClick={startResearch}
            disabled={busy}
            className="pm-btn"
            style={{
              height: 28,
              padding: '0 12px',
              fontSize: 11,
              background: 'var(--amb)',
              color: '#fff',
              border: 'none',
            }}
          >
            Verify
          </button>
        )}
      </div>

      {row.status === 'researching' && (
        <div style={{ marginTop: 10 }}>
          <div
            className="uppercase font-semibold"
            style={{
              color: 'var(--i3)',
              fontSize: 10,
              letterSpacing: '0.06em',
              marginBottom: 6,
            }}
          >
            Tick carriers where SunFire confirms in-network
          </div>

          {!carriers ? (
            <div style={{ fontSize: 11, color: 'var(--i3)', padding: '6px 0' }}>
              Loading carriers…
            </div>
          ) : carriers.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--i3)', padding: '6px 0' }}>
              No carriers found for this county.
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                gap: 6,
              }}
            >
              {carriers.map((c) => {
                const checked = selected.has(c.contract_id);
                return (
                  <label
                    key={c.contract_id}
                    className="flex items-center gap-2"
                    style={{
                      padding: '6px 10px',
                      border: `1px solid ${checked ? 'var(--sage)' : 'var(--w2)'}`,
                      borderRadius: 8,
                      background: checked ? 'var(--sl)' : 'var(--wh)',
                      cursor: 'pointer',
                      userSelect: 'none',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(c.contract_id)}
                      style={{
                        width: 16,
                        height: 16,
                        accentColor: 'var(--sage)',
                        cursor: 'pointer',
                      }}
                    />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>
                        {c.carrier}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--i3)' }}>
                        {c.contract_id}
                        {c.plan_types.length > 0
                          ? ` · ${c.plan_types.join(', ')}`
                          : ''}{' '}
                        · {c.plan_count} plan{c.plan_count === 1 ? '' : 's'}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}

          <div
            className="flex items-center justify-between"
            style={{ marginTop: 10, gap: 8 }}
          >
            <span style={{ fontSize: 11, color: 'var(--i3)' }}>
              {selected.size} carrier{selected.size === 1 ? '' : 's'} selected
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={goBack}
                disabled={busy}
                className="pm-btn"
                style={{ height: 28, padding: '0 10px', fontSize: 11 }}
              >
                Back
              </button>
              <button
                type="button"
                onClick={saveVerified}
                disabled={busy || selected.size === 0}
                className="pm-btn pm-btn-primary"
                style={{
                  height: 28,
                  padding: '0 12px',
                  fontSize: 11,
                  opacity: busy || selected.size === 0 ? 0.5 : 1,
                }}
                title={
                  selected.size === 0
                    ? 'Pick at least one carrier before saving'
                    : 'Save and mark verified'
                }
              >
                ✓ Save ({selected.size})
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Small bits ─────────────────────────────────────────────────────

function StatusDot({ tone }: { tone: 'red' | 'amb' | 'sage' }) {
  const map = {
    red: { bg: 'var(--red)', pulse: false },
    amb: { bg: 'var(--amb)', pulse: true },
    sage: { bg: 'var(--sage)', pulse: false },
  } as const;
  const meta = map[tone];
  return (
    <span
      aria-hidden
      style={{
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: meta.bg,
        flexShrink: 0,
        marginTop: 6,
        animation: meta.pulse ? 'pmVerifyPulse 1.2s ease-in-out infinite' : undefined,
      }}
    />
  );
}

function AgeChip({ label, tone }: { label: string; tone: 'sage' | 'amb' | 'red' }) {
  const map = {
    sage: { bg: 'var(--sl)', fg: 'var(--sage)', border: 'var(--sage)' },
    amb: { bg: 'var(--at)', fg: 'var(--amb)', border: 'var(--amb)' },
    red: { bg: 'var(--rt)', fg: 'var(--red)', border: 'var(--red)' },
  } as const;
  const meta = map[tone];
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        padding: '2px 8px',
        borderRadius: 999,
        background: meta.bg,
        color: meta.fg,
        border: `1px solid ${meta.border}`,
      }}
    >
      {label}
    </span>
  );
}

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h`;
}

function ageTone(createdAtMs: number): 'sage' | 'amb' | 'red' {
  const age = Date.now() - createdAtMs;
  if (age < 60_000) return 'sage';
  if (age < 300_000) return 'amb';
  return 'red';
}
