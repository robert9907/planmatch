// ProviderNetworkProof — Compliance screen panel.
//
// Shows, for the exact plan being enrolled and its plan year, each doctor's
// network answer, where it came from, and when that source last checked —
// the same database answer the enroll endpoint stamps into
// pm_enrollment_provider_evidence. A doctor with no confirmed answer is
// flagged red so the broker calls the office before checking "network
// explained". Never blocks enrollment.

import { useEffect, useMemo, useState } from 'react';
import type { Plan } from '@/types/plans';
import type { Provider } from '@/types/session';
import { checkProviderNetwork, type LibraryProviderPlan } from '@/lib/library-client';

type Row = {
  key: string;
  name: string;
  npi: string | null;
  status: 'in_network' | 'out_of_network' | 'not_confirmed';
  sourceLabel: string;
  checkedAt: string | null;
};

const SOURCE_LABEL: Record<LibraryProviderPlan['source'], string> = {
  fhir_live: 'Carrier directory',
  medicare_gov: 'Medicare Plan Finder',
  cache: 'Saved verification',
  unknown: 'No directory answer',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function ProviderNetworkProof({
  plan,
  providers,
  state,
  county,
  planYear,
}: {
  plan: Plan;
  providers: Provider[];
  state: string | null;
  county: string | null;
  planYear: number;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const npiKey = useMemo(
    () => providers.map((p) => `${p.npi ?? ''}|${p.name}`).join(','),
    [providers],
  );

  useEffect(() => {
    if (providers.length === 0) { setRows([]); return; }
    let cancelled = false;
    setRows(null);
    setError(null);
    const npis = [...new Set(providers.map((p) => (p.npi ?? '').trim()).filter((n) => /^\d{10}$/.test(n)))];
    const base: Row[] = providers.map((p) => ({
      key: p.id,
      name: p.name,
      npi: p.npi ?? null,
      status: 'not_confirmed',
      sourceLabel: p.npi ? 'No directory answer' : 'No NPI on file',
      checkedAt: null,
    }));
    if (npis.length === 0 || !state || !county) { setRows(base); return; }
    (async () => {
      try {
        const resp = await checkProviderNetwork({
          npis, state, county, plan_ids: [plan.id], plan_year: planYear,
        });
        if (cancelled) return;
        setRows(base.map((r) => {
          if (!r.npi) return r;
          const hit = resp.by_npi?.[r.npi]?.plans?.find((x) => x.plan_id === plan.id)
            ?? resp.by_npi?.[r.npi]?.plans?.[0];
          if (!hit || hit.status === 'unknown') return r;
          return {
            ...r,
            status: hit.status,
            sourceLabel: SOURCE_LABEL[hit.source] ?? 'Saved verification',
            checkedAt: hit.last_verified,
          };
        }));
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
        setRows(base);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.id, npiKey, state, county, planYear]);

  if (providers.length === 0) return null;
  const unconfirmed = (rows ?? []).filter((r) => r.status !== 'in_network').length;

  return (
    <div
      style={{
        marginBottom: 16,
        padding: '12px 16px',
        borderRadius: 10,
        background: rows && unconfirmed > 0 ? '#fef2f2' : '#f8fafc',
        border: `1px solid ${rows && unconfirmed > 0 ? '#fecaca' : '#e2e8f0'}`,
      }}
    >
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: '#475569' }}>
        Doctor network proof · {planYear} plan
      </div>
      <div style={{ fontSize: 11, color: '#64748b', marginTop: 2, marginBottom: 8 }}>
        Saved to the record when you enroll.
      </div>
      {rows === null ? (
        <div style={{ fontSize: 12, color: '#64748b' }}>Checking…</div>
      ) : (
        rows.map((r) => {
          const tone =
            r.status === 'in_network' ? { c: '#047857', t: 'In network' }
            : r.status === 'out_of_network' ? { c: '#b91c1c', t: 'Out of network' }
            : { c: '#b91c1c', t: 'Not confirmed — call the office' };
          return (
            <div
              key={r.key}
              style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderTop: '1px solid #e2e8f0', fontSize: 12 }}
            >
              <div style={{ color: '#0d2f5e', fontWeight: 600 }}>
                {r.name}
                {r.npi ? <span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: 6, fontFamily: 'monospace' }}>{r.npi}</span> : null}
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ color: tone.c, fontWeight: 700 }}>{tone.t}</div>
                <div style={{ color: '#64748b', fontSize: 11 }}>
                  {r.sourceLabel}{r.checkedAt ? ` · checked ${fmtDate(r.checkedAt)}` : ''}
                </div>
              </div>
            </div>
          );
        })
      )}
      {error ? (
        <div style={{ fontSize: 11, color: '#b45309', marginTop: 6 }}>
          Couldn't reach the network check ({error}). Treat every doctor as not confirmed.
        </div>
      ) : null}
    </div>
  );
}
