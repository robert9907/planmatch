// CurrentPlanPicker — search-and-set for session.currentPlanId.
//
// Renders a search input + filtered result list scoped to the client's
// current state/county/planType (via fetchPlansForClient). The user can
// type a plan name fragment ("Gold Plus") or an H-number
// ("H1036-308") and the list narrows to matching plans. Clicking a
// result writes session.currentPlanId, which the v4 Quote table reads
// to pin the gray benchmark column.
//
// Used in two places:
//   1. IntakePage — inline section after Plan Type. Always visible
//      once a county+plan-type is set.
//   2. QuoteDeliveryV4 — opened from the "Add current plan to compare"
//      link above the table when no current plan is set.
//
// The same component is fine for both. The Quote variant just lives
// inside a modal-ish popover; layout is content-sized.

import { useEffect, useMemo, useState } from 'react';
import { useSession } from '@/hooks/useSession';
import { fetchPlansForClient } from '@/lib/planCatalog';
import type { Plan } from '@/types/plans';

interface Props {
  /** Auto-focus the search input on mount. The Quote-page modal sets
   *  this true; the Intake inline form leaves it false. */
  autoFocus?: boolean;
  /** Optional callback fired after a plan is selected — used by the
   *  Quote-page popover to close itself. */
  onSelected?: (planId: string) => void;
  /** Compact prose under the input. */
  hint?: string;
}

export function CurrentPlanPicker({ autoFocus, onSelected, hint }: Props) {
  const client = useSession((s) => s.client);
  const currentPlanId = useSession((s) => s.currentPlanId);
  const setCurrentPlanId = useSession((s) => s.setCurrentPlanId);

  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPlansForClient({
      state: client.state,
      county: client.county,
      planType: client.planType,
    })
      .then((list) => {
        if (!cancelled) setPlans(list);
      })
      .catch((err) => {
        if (cancelled) return;
        setError((err as Error).message);
        setPlans([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client.state, client.county, client.planType]);

  // Substring match on plan_name, carrier, or "<contract>-<plan>"
  // (case-insensitive). H-number queries with or without the dash both
  // hit — "H1036-308", "H1036308", and "h1036 308" all match.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/[\s-]/g, '');
    if (!q) return plans.slice(0, 20);
    return plans
      .filter((p) => {
        const haystack = `${p.plan_name} ${p.carrier} ${p.contract_id}${p.plan_number}`
          .toLowerCase()
          .replace(/[\s-]/g, '');
        return haystack.includes(q);
      })
      .slice(0, 20);
  }, [plans, query]);

  function pick(plan: Plan) {
    setCurrentPlanId(plan.id);
    setQuery('');
    onSelected?.(plan.id);
  }

  function clear() {
    setCurrentPlanId(null);
  }

  const selected = currentPlanId
    ? plans.find((p) => p.id === currentPlanId) ?? null
    : null;

  return (
    <div style={{ fontFamily: "'Inter', system-ui, -apple-system, sans-serif" }}>
      {selected ? (
        <div
          style={{
            padding: 10,
            border: '1px solid #d1d5db',
            borderRadius: 8,
            background: '#f5f4f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            marginBottom: 8,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6b7280' }}>
              Current plan
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#1f2937', marginTop: 2 }}>
              {selected.carrier} · {selected.plan_name}
            </div>
            <div style={{ fontSize: 11, color: '#6b7280', fontFamily: "'JetBrains Mono', monospace" }}>
              {selected.contract_id}-{selected.plan_number} · ${selected.premium}/mo
            </div>
          </div>
          <button
            type="button"
            onClick={clear}
            style={{
              padding: '4px 10px',
              borderRadius: 5,
              border: '1px solid #d1d5db',
              background: '#fff',
              color: '#374151',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Change
          </button>
        </div>
      ) : (
        <input
          autoFocus={autoFocus}
          type="text"
          placeholder={
            client.county
              ? `Search plans in ${client.county}, ${client.state} — name or H-number…`
              : 'Set county on the Intake page first…'
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={!client.county || !client.state}
          style={{
            width: '100%',
            padding: '8px 12px',
            borderRadius: 8,
            border: '1px solid #d1d5db',
            fontSize: 13,
            fontFamily: 'inherit',
            outline: 'none',
            background: client.county ? '#fff' : '#f3f4f6',
          }}
        />
      )}

      {hint && !selected && (
        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>{hint}</div>
      )}

      {!selected && client.county && (
        <div
          style={{
            marginTop: 6,
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            background: '#fff',
            maxHeight: 280,
            overflowY: 'auto',
          }}
        >
          {loading && (
            <div style={{ padding: 10, fontSize: 11, color: '#6b7280' }}>Loading plans…</div>
          )}
          {error && (
            <div style={{ padding: 10, fontSize: 11, color: '#a32d2d' }}>
              Plan list error: {error}
            </div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <div style={{ padding: 10, fontSize: 11, color: '#6b7280' }}>
              {query.trim()
                ? `No matches for "${query}" in ${client.county}.`
                : `No ${client.planType ?? ''} plans found in ${client.county}.`}
            </div>
          )}
          {filtered.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => pick(p)}
              style={{
                display: 'block',
                width: '100%',
                padding: '8px 12px',
                background: 'transparent',
                border: 'none',
                borderBottom: '1px solid #f1f3f5',
                textAlign: 'left',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f8fafc')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: '#1f2937' }}>
                {p.carrier} · {p.plan_name}
              </div>
              <div style={{ fontSize: 10, color: '#6b7280', fontFamily: "'JetBrains Mono', monospace", marginTop: 1 }}>
                {p.contract_id}-{p.plan_number} · ${p.premium}/mo · {p.star_rating}★
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
