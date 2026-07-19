// useHealthSherpaEnroll — shared enrollment hook for every "Enroll"
// surface in agent-v3 (CompareScreen slot cards + summary bar + H2H,
// ComplianceScreen gate, EnrollScreen final CTA).
//
// Flow:
//   click  →  status='syncing'  →  POST /api/healthsherpa/sync
//          →  server returns 200 with redirect_url (public consumer
//             intake URL) plus best-effort partner_sync_ok flag
//          →  window.open(redirect_url)                status='opened'
//          →  network / server 5xx failure             status='error'
//
// The redirect_url is always the public consumer intake page
// (medicare.healthsherpa.com/intake/robert-simm?...), which does not
// require broker login. Partner API contact creation runs server-side
// as a best-effort side-effect for CRM linkage; its failure is logged
// to the console but does not block the tab from opening.

import { useState } from 'react';
import type { Client } from '@/types/session';
import type { Plan } from '@/types/plans';

export type EnrollStatus = 'idle' | 'syncing' | 'opened' | 'error';

interface SyncResponse {
  redirect_url?: string;
  contact_id?: string | number | null;
  external_id?: string;
  matched_existing?: boolean;
  partner_sync_ok?: boolean;
  partner_sync_error?: string | null;
  error?: string;
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

export interface EnrollResult {
  ok: boolean;
  url?: string;
  error?: string;
  /** True when the tab opened AND the Partner API contact sync also
   *  succeeded. False (with ok=true) means the tab opened but the
   *  contact did not land in Rob's HealthSherpa CRM. */
  partner_sync_ok?: boolean;
  partner_sync_error?: string | null;
}

export interface UseHealthSherpaEnrollResult {
  status: EnrollStatus;
  error: string | null;
  openEnrollment: (opts: EnrollOptions) => Promise<EnrollResult>;
  reset: () => void;
}

export function useHealthSherpaEnroll(): UseHealthSherpaEnrollResult {
  const [status, setStatus] = useState<EnrollStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  async function openEnrollment(opts: EnrollOptions): Promise<EnrollResult> {
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
        if (json.partner_sync_error) {
          // Contact didn't land in HealthSherpa CRM — surface via
          // console for the broker's dev-tools view without blocking
          // the enrollment tab that just opened.
          console.warn(
            '[healthsherpa-enroll] tab opened, but partner API contact sync failed:',
            json.partner_sync_error,
          );
        }
        return {
          ok: true,
          url: json.redirect_url,
          partner_sync_ok: json.partner_sync_ok ?? false,
          partner_sync_error: json.partner_sync_error ?? null,
        };
      }

      const errMsg = json.error ?? `HealthSherpa sync ${r.status}`;
      setStatus('error');
      setError(errMsg);
      return { ok: false, error: errMsg };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Network error';
      setStatus('error');
      setError(errMsg);
      return { ok: false, error: errMsg };
    }
  }

  function reset() {
    setStatus('idle');
    setError(null);
  }

  return { status, error, openEnrollment, reset };
}
