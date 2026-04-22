// agentbase — live AgentBase CRM client lookup via /api/clients/*.
//
// Phase 4 (deleted) shipped a 6-row mock catalog inlined here. This
// module now proxies to the server routes which query the shared
// Supabase project (clients + client_medications + client_providers).
// The return shapes match what Step1ClientLookup.tsx needs to
// pre-populate Steps 2–6 in one go.

import type { StateCode, PlanType } from '@/types/session';

// Summary row returned by /api/clients/search — rendered in the
// dropdown and used to decide which mode (annual review / new quote)
// the session starts in.
export interface AgentBaseClient {
  id: string;
  first_name: string;
  last_name: string;
  name: string;
  phone: string;
  email: string;
  dob: string;
  zip: string;
  city: string;
  state: StateCode | null;
  county: string;
  carrier: string;
  plan: string;
  plan_id: string;
  medicare_id: string;
  part_a_effective: string;
  part_b_effective: string;
  year: number | null;
  lead_source: string;
  last_contact_at: string | null;
  // Derived client-side so existing UI that reads these doesn't break.
  plan_type: PlanType;
  medicaid_confirmed: boolean;
  current_plan_id: string | null;
  notes_summary: string;
  source: 'agentbase';
}

// Full record returned by /api/clients/[id], with the joined
// medications + providers the session pre-populator needs.
export interface AgentBaseClientDetail {
  client: AgentBaseClient & {
    address: string;
    notes: string;
    next_step: string;
    updated_at: string | null;
    created_at: string | null;
  };
  medications: Array<{
    id: string;
    name: string;
    dose: string;
    frequency: string;
    rxcui: string;
    refill_days: string;
  }>;
  providers: Array<{
    id: string;
    name: string;
    specialty: string;
    affiliation: string;
    phone: string;
    address: string;
    npi: string;
  }>;
}

interface ApiClientsResponse {
  clients: unknown[];
}

export async function searchClients(query: string, signal?: AbortSignal): Promise<AgentBaseClient[]> {
  const qs = new URLSearchParams();
  if (query.trim()) qs.set('q', query.trim());
  try {
    const res = await fetch(`/api/clients/search?${qs.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!res.ok) {
      console.warn('[agentbase] search failed with', res.status);
      return [];
    }
    const body = (await res.json()) as ApiClientsResponse;
    return (body.clients ?? []).map(deriveSummary);
  } catch (err) {
    if ((err as { name?: string })?.name !== 'AbortError') {
      console.warn('[agentbase] search errored:', err);
    }
    return [];
  }
}

export async function fetchClientDetail(
  id: string,
  signal?: AbortSignal,
): Promise<AgentBaseClientDetail | null> {
  try {
    const res = await fetch(`/api/clients/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!res.ok) {
      console.warn('[agentbase] detail failed with', res.status);
      return null;
    }
    const body = (await res.json()) as {
      client: unknown;
      medications: unknown[];
      providers: unknown[];
    };
    return {
      client: deriveDetail(body.client),
      medications: (body.medications ?? []) as AgentBaseClientDetail['medications'],
      providers: (body.providers ?? []) as AgentBaseClientDetail['providers'],
    };
  } catch (err) {
    if ((err as { name?: string })?.name !== 'AbortError') {
      console.warn('[agentbase] detail errored:', err);
    }
    return null;
  }
}

// ─── Shape coercion ──────────────────────────────────────────────
// The API layer returns clients with no plan_type / medicaid flags —
// those don't live on the AgentBase clients table directly. Derive
// plan_type from lead_source + plan string; leave medicaid_confirmed
// false unless the notes mention it. Users can edit in Step 2.

function deriveSummary(raw: unknown): AgentBaseClient {
  const r = (raw ?? {}) as Record<string, unknown>;
  const state = typeof r.state === 'string' && /^[A-Z]{2}$/.test(r.state.toUpperCase())
    ? (r.state.toUpperCase() as StateCode)
    : null;
  const planType = inferPlanType(String(r.plan ?? ''), String(r.lead_source ?? ''));
  const planId = typeof r.plan_id === 'string' ? r.plan_id.trim() : '';
  const notesBits: string[] = [];
  if (r.carrier) notesBits.push(String(r.carrier));
  if (r.plan) notesBits.push(String(r.plan));
  return {
    id: String(r.id ?? ''),
    first_name: String(r.first_name ?? ''),
    last_name: String(r.last_name ?? ''),
    name: String(r.name ?? ''),
    phone: String(r.phone ?? ''),
    email: String(r.email ?? ''),
    dob: String(r.dob ?? ''),
    zip: String(r.zip ?? ''),
    city: String(r.city ?? ''),
    state,
    county: String(r.county ?? ''),
    carrier: String(r.carrier ?? ''),
    plan: String(r.plan ?? ''),
    plan_id: planId,
    medicare_id: String(r.medicare_id ?? ''),
    part_a_effective: String(r.part_a_effective ?? ''),
    part_b_effective: String(r.part_b_effective ?? ''),
    year: typeof r.year === 'number' ? r.year : null,
    lead_source: String(r.lead_source ?? ''),
    last_contact_at: typeof r.last_contact_at === 'string' ? r.last_contact_at : null,
    plan_type: planType,
    medicaid_confirmed: planType === 'DSNP',
    current_plan_id: planId || null,
    notes_summary: notesBits.join(' · '),
    source: 'agentbase',
  };
}

function deriveDetail(raw: unknown): AgentBaseClientDetail['client'] {
  const summary = deriveSummary(raw);
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    ...summary,
    address: String(r.address ?? ''),
    notes: String(r.notes ?? ''),
    next_step: String(r.next_step ?? ''),
    updated_at: typeof r.updated_at === 'string' ? r.updated_at : null,
    created_at: typeof r.created_at === 'string' ? r.created_at : null,
  };
}

function inferPlanType(plan: string, leadSource: string): PlanType {
  const text = `${plan} ${leadSource}`.toLowerCase();
  if (/dsnp|d-snp|dual\s*special|dual\s*eligible/.test(text)) return 'DSNP';
  if (/medigap|medsupp|medicare\s*supplement/.test(text)) return 'MEDSUPP';
  if (/\bpdp\b|part\s*d(?!\w)/.test(text)) return 'PDP';
  if (/\bmapd\b|part\s*c|medicare\s*advantage/.test(text)) return 'MAPD';
  // Default to MAPD — the most common Medicare-Advantage bucket;
  // users can correct in Step 2.
  return 'MAPD';
}

// Kept for compatibility with any residual caller — forwards to the
// new search endpoint. No direct phone-index lookup server-side yet;
// returns the first hit whose digits match.
export async function clientByPhone(phone: string): Promise<AgentBaseClient | null> {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return null;
  const hits = await searchClients(digits);
  const want = digits.slice(-10);
  return hits.find((c) => c.phone.replace(/\D/g, '').slice(-10) === want) ?? null;
}
