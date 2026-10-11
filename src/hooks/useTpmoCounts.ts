// TPMO (e)(41) counts for the client's county, scoped to plans Rob can sell
// (appointed AND certified). Served by /api/tpmo-counts — same definition as
// the consumer app. null while loading or on error: the disclaimer must not
// be read or confirmed with a guessed number.
import { useEffect, useState } from 'react';
import { useSession } from '@/hooks/useSession';
import { resolvePlanCatalogYear } from '../../api/library/planCatalogYear';

export interface TpmoCounts { orgCount: number; productCount: number }
export type TpmoCountsState =
  | { status: 'loading'; counts: null }
  | { status: 'ready'; counts: TpmoCounts }
  | { status: 'error'; counts: null; error: string };

export function useTpmoCounts(): TpmoCountsState {
  const state = useSession((s) => s.client.state);
  const county = useSession((s) => s.client.county);
  const [out, setOut] = useState<TpmoCountsState>({ status: 'loading', counts: null });
  useEffect(() => {
    if (!state || !county) {
      setOut({ status: 'error', counts: null, error: 'Enter the client’s county first.' });
      return;
    }
    let cancelled = false;
    setOut({ status: 'loading', counts: null });
    const q = new URLSearchParams({ state, county, plan_year: String(resolvePlanCatalogYear()) });
    fetch(`/api/tpmo-counts?${q}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok || typeof body.org_count !== 'number' || typeof body.product_count !== 'number') {
          setOut({ status: 'error', counts: null, error: body.error ?? `HTTP ${r.status}` });
          return;
        }
        if (body.product_count === 0) {
          setOut({ status: 'error', counts: null, error: `No plans you can sell found for ${county} County.` });
          return;
        }
        setOut({ status: 'ready', counts: { orgCount: body.org_count, productCount: body.product_count } });
      })
      .catch((e) => { if (!cancelled) setOut({ status: 'error', counts: null, error: String(e) }); });
    return () => { cancelled = true; };
  }, [state, county]);
  return out;
}
