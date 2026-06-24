// useHealthSherpaEnroll — shared enrollment hook for every "Enroll"
// surface in agent-v3 (CompareScreen slot cards + summary bar + H2H,
// ComplianceScreen gate, EnrollScreen final CTA).
//
// Flow:
//   click  →  status='syncing'  →  POST /api/healthsherpa/sync
//          →  on 2xx: window.open(redirect_url)         status='opened'
//          →  on error: window.open(fallback_url)       status='error'
//
// The fallback_url comes back from the route itself — even when the
// Partner API rejects the contact, the route hands back the
// county/zip-preloaded generic intake URL so the broker is never
// stranded.

import { useState } from 'react';
import type { Client } from '@/types/session';
import type { Plan } from '@/types/plans';
import { buildMedicareEnrollLink } from './healthsherpa-medicare-link';

export type EnrollStatus = 'idle' | 'syncing' | 'opened' | 'error';

interface SyncResponse {
  redirect_url?: string;
  contact_id?: string | number | null;
  error?: string;
  fallback_url?: string;
}

interface EnrollOptions {
  client: Client;
  /** Plan being enrolled — optional (compliance gate has no plan yet). */
  plan?: Plan | null;
  /** AgentBase clientId pinned in the URL by IntakeScreen — used as
   *  HealthSherpa's external_id so we can re-sync the same contact on
   *  subsequent recommendations without creating duplicates. */
  externalId?: string | number | null;
}

function readClientIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const v = new URLSearchParams(window.location.search).get('clientId');
  return v && v.trim() ? v.trim() : null;
}

function splitName(full: string): { first?: string; last?: string } {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { first: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function buildSyncBody(opts: EnrollOptions): Record<string, unknown> {
  const { client, plan } = opts;
  const { first, last } = splitName(client.name);
  const externalId = opts.externalId ?? readClientIdFromUrl() ?? undefined;
  return {
    external_id: externalId,
    first_name: first,
    last_name: last,
    birth_date: client.dob || undefined,
    phone: client.phone || undefined,
    email: client.email || undefined,
    zip: client.zip || undefined,
    state: client.state || undefined,
    county: client.county || undefined,
    medicare_number: client.mbi || undefined,
    medicaid_eligible:
      client.dsnpEligible === true || client.medicaidConfirmed === true
        ? true
        : undefined,
    cms_plan_id: plan?.id,
    plan_label: plan ? `${plan.carrier} · ${plan.plan_name}` : undefined,
  };
}

/** Local fallback when the route itself is unreachable (network down).
 *  The route's response includes its own fallback_url; this is the
 *  last-resort when fetch() throws. */
function localFallbackUrl(opts: EnrollOptions): string {
  return buildMedicareEnrollLink({
    cms_plan_id: opts.plan?.id,
    county: opts.client.county || undefined,
    zip_code: opts.client.zip || undefined,
  });
}

export interface UseHealthSherpaEnrollResult {
  status: EnrollStatus;
  error: string | null;
  openEnrollment: (opts: EnrollOptions) => Promise<{ url: string; ok: boolean }>;
  reset: () => void;
}

export function useHealthSherpaEnroll(): UseHealthSherpaEnrollResult {
  const [status, setStatus] = useState<EnrollStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  async function openEnrollment(opts: EnrollOptions) {
    setStatus('syncing');
    setError(null);

    const body = buildSyncBody(opts);

    try {
      const r = await fetch('/api/healthsherpa/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await r.json().catch(() => ({}))) as SyncResponse;

      if (r.ok && json.redirect_url) {
        window.open(json.redirect_url, '_blank', 'noopener,noreferrer');
        setStatus('opened');
        return { url: json.redirect_url, ok: true };
      }

      const url = json.fallback_url ?? localFallbackUrl(opts);
      window.open(url, '_blank', 'noopener,noreferrer');
      setStatus('error');
      setError(json.error ?? `HealthSherpa sync ${r.status}`);
      return { url, ok: false };
    } catch (err) {
      const url = localFallbackUrl(opts);
      window.open(url, '_blank', 'noopener,noreferrer');
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Network error');
      return { url, ok: false };
    }
  }

  function reset() {
    setStatus('idle');
    setError(null);
  }

  return { status, error, openEnrollment, reset };
}
