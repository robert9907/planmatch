import { useCallback, useEffect, useRef, useState } from 'react';

// Polling hook that owns the provider_verifications queue state.
// Single source of truth so the Sidebar pill and the drawer stay in
// sync without double-polling.
//
// Supabase Realtime isn't wired into the agent-side app (all DB
// access goes through /api/* endpoints). 15s polling matches what the
// CRM-side component did and is fine for Rob's pace — the consumer
// widget gets Realtime pushes the instant Rob hits Save.

const POLL_MS = 15_000;

export type VerificationStatus = 'unverified' | 'researching' | 'verified';

export interface VerificationRow {
  id: number;
  session_id: string;
  provider_name: string;
  provider_npi: string | null;
  provider_specialty: string | null;
  county_name: string | null;
  state: string | null;
  status: VerificationStatus;
  in_network_carriers: string[];
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
}

export interface VerificationsQueue {
  rows: VerificationRow[];
  pendingCount: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  patch: (
    id: number,
    payload: { status: VerificationStatus; in_network_carriers?: string[] },
  ) => Promise<VerificationRow | null>;
}

export function useVerificationsQueue(): VerificationsQueue {
  const [rows, setRows] = useState<VerificationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/planmatch-verifications', { cache: 'no-store' });
      const body = await r.json().catch(() => ({}));
      if (!mountedRef.current) return;
      if (!r.ok) {
        setError(body?.error || `HTTP ${r.status}`);
        return;
      }
      setRows(Array.isArray(body.verifications) ? body.verifications : []);
      setError(null);
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Network error');
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    timerRef.current = window.setInterval(refresh, POLL_MS);
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, [refresh]);

  const patch = useCallback<VerificationsQueue['patch']>(async (id, payload) => {
    // Optimistic: flip the row locally so the UI responds immediately.
    // Any server error triggers a refresh to reconcile.
    setRows((prev) =>
      prev.map((row) =>
        row.id === id
          ? {
              ...row,
              status: payload.status,
              in_network_carriers:
                payload.in_network_carriers ?? row.in_network_carriers,
            }
          : row,
      ),
    );
    try {
      const r = await fetch('/api/planmatch-verifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...payload }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(body?.error || `HTTP ${r.status}`);
        await refresh();
        return null;
      }
      // Verified rows drop out of the queue feed on next refresh
      // (server filters to unverified + researching). Remove locally
      // now so the UI doesn't flash them for up to 15s.
      if (payload.status === 'verified') {
        setRows((prev) => prev.filter((row) => row.id !== id));
      } else if (body?.verification) {
        setRows((prev) =>
          prev.map((row) => (row.id === id ? body.verification : row)),
        );
      }
      return body?.verification ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
      await refresh();
      return null;
    }
  }, [refresh]);

  const pendingCount = rows.length;

  return { rows, pendingCount, loading, error, refresh, patch };
}

export interface CarrierOption {
  contract_id: string;
  carrier: string;
  plan_types: string[];
  plan_count: number;
}

// One-shot fetch for the carrier checklist. Cached per (state, county)
// so a group with 3 providers in the same session hits the network
// once, not three times.
const carriersCache = new Map<string, CarrierOption[]>();
const carriersInflight = new Map<string, Promise<CarrierOption[]>>();

export async function fetchCarriersFor(
  state: string | null,
  county: string | null,
): Promise<CarrierOption[]> {
  if (!state || !county) return [];
  const key = `${state.toUpperCase()}|${county}`;
  const cached = carriersCache.get(key);
  if (cached) return cached;
  const inflight = carriersInflight.get(key);
  if (inflight) return inflight;

  const p = (async () => {
    const r = await fetch(
      `/api/planmatch-carriers?state=${encodeURIComponent(state)}&county=${encodeURIComponent(county)}`,
      { cache: 'no-store' },
    );
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
    const list = (body.carriers ?? []) as CarrierOption[];
    carriersCache.set(key, list);
    return list;
  })();
  carriersInflight.set(key, p);
  try {
    return await p;
  } finally {
    carriersInflight.delete(key);
  }
}
