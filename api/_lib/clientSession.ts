// Shared loader for "give me everything I need to start a quote for
// AgentBase client X" — used by both:
//
//   • GET /api/clients/[id]      — internal, called by the LandingPage
//                                  client picker via fetchClientDetail
//   • GET /api/client-session    — AgentBase-facing entry point. The
//                                  CRM links to
//                                  /agent-v3?clientId=<id> and the
//                                  agent-v3 shell hydrates from this.
//
// Both endpoints return the same shape so the frontend hydration code
// can treat them interchangeably. Centralizing the query here also
// keeps the joined select (clients × client_medications × providers)
// from drifting between the two routes.

import { agentbaseSupabase } from './agentbaseSupabase.js';

export interface ClientSessionPayload {
  client: ShapedClient;
  medications: ShapedMedication[];
  providers: ShapedProvider[];
}

export interface ShapedClient {
  id: string;
  first_name: string;
  last_name: string;
  name: string;
  phone: string;
  email: string;
  dob: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  county: string;
  carrier: string;
  plan: string;
  plan_id: string;
  medicare_id: string;
  part_a_effective: string;
  part_b_effective: string;
  year: number | null;
  lead_source: string;
  notes: string;
  next_step: string;
  updated_at: string | null;
  created_at: string | null;
}

export interface ShapedMedication {
  id: string;
  name: string;
  dose: string;
  frequency: string;
  rxcui: string;
  refill_days: string;
  tier: string;
  quantity: string;
  /** Drug dosage form ("Tablet", "Capsule", "Solution"). Added by
   *  Phase 4 migration 032. Empty string when null. */
  form: string;
  /** Foreign key into providers (pharmacy). Number or null. */
  pharmacy_id: number | null;
  /** Next refill date as MM/DD/YYYY. Broker-entered free text. */
  refill_date: string;
  /** Free-text broker notes (prior auth status, side effects, etc.). */
  notes: string;
}

export interface ShapedProvider {
  id: string;
  name: string;
  specialty: string;
  affiliation: string;
  phone: string;
  address: string;
  npi: string;
  // Carried from the client_providers join row (not from providers).
  // Lets agent-v3 pre-seed networkStatus[last_known_plan_id] so the
  // Providers screen doesn't re-flicker "Checking" for a plan we
  // already verified last call.
  last_known_network_status: 'in' | 'out' | 'unknown' | null;
  last_known_plan_id: string;
}

interface ClientRow {
  id: number;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  dob: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  county: string | null;
  carrier: string | null;
  plan_name: string | null;
  plan_id: string | null;
  medicare_id: string | null;
  part_a_month: string | null;
  part_a_year: string | null;
  part_b_month: string | null;
  part_b_year: string | null;
  year: number | null;
  lead_source: string | null;
  notes: string | null;
  next_step: string | null;
  updated_at: string | null;
  created_at: string | null;
}

interface MedicationRow {
  id: number;
  name: string | null;
  dose: string | null;
  frequency: string | null;
  rxcui: string | null;
  refill_days: string | null;
  // Post-migration 031 PostgREST returns tier as a JSON number;
  // the column is smallint. During the migration window or for older
  // deploys it may still be a string. shapeMed coerces to string.
  tier: string | number | null;
  quantity: string | null;
  // Added by Phase 4 migration 032.
  form: string | null;
  // Migration 011 broker-entry columns. Pass through to the agent so
  // the broker sees the CRM-side context (pharmacy, refill date,
  // notes) without re-deriving.
  pharmacy_id: number | null;
  refill_date: string | null;
  notes: string | null;
  created_at: string | null;
}

interface ClientProviderLink {
  provider_id: number;
  last_known_network_status: string | null;
  last_known_plan_id: string | null;
  providers:
    | {
        id: number;
        name: string | null;
        specialty: string | null;
        affiliation: string | null;
        phone: string | null;
        address: string | null;
        npi: string | null;
      }
    | null;
}

/** Returns null when no row matches the id; throws on supabase errors
 *  so the caller can surface a 500 with the underlying message. */
export async function loadClientSession(
  id: string,
): Promise<ClientSessionPayload | null> {
  const sb = agentbaseSupabase();
  // Three parallel queries — saves ~200ms vs sequential and keeps
  // failure modes independent (a flaky providers join doesn't block
  // the client row from loading).
  const [clientRes, medsRes, providersRes] = await Promise.all([
    sb.from('clients').select('*').eq('id', id).maybeSingle(),
    sb
      .from('client_medications')
      .select(
        'id, name, dose, frequency, rxcui, refill_days, tier, quantity, form, pharmacy_id, refill_date, notes, created_at',
      )
      .eq('client_id', id)
      // Phase 5 soft-delete: hide tombstones from the agent.
      // Requires migration 033 (deleted_at column).
      .is('deleted_at', null)
      .order('created_at', { ascending: true }),
    sb
      .from('client_providers')
      .select(
        'provider_id, last_known_network_status, last_known_plan_id, providers:provider_id ( id, name, specialty, affiliation, phone, address, npi )',
      )
      .eq('client_id', id),
  ]);

  if (clientRes.error) throw clientRes.error;
  const client = clientRes.data as ClientRow | null;
  if (!client) return null;

  if (medsRes.error) throw medsRes.error;
  const meds = (medsRes.data ?? []) as MedicationRow[];

  if (providersRes.error) throw providersRes.error;
  const providerLinks = (providersRes.data ?? []) as unknown as ClientProviderLink[];

  return {
    client: shapeClient(client),
    medications: meds.map(shapeMed),
    providers: providerLinks
      .filter(
        (l): l is ClientProviderLink & {
          providers: NonNullable<ClientProviderLink['providers']>;
        } => !!l.providers,
      )
      .map(shapeProvider),
  };
}

function shapeClient(r: ClientRow): ShapedClient {
  const name = [r.first_name, r.last_name]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' ');
  return {
    id: String(r.id),
    first_name: r.first_name ?? '',
    last_name: r.last_name ?? '',
    name: name || '—',
    phone: r.phone ?? '',
    email: r.email ?? '',
    dob: r.dob ?? '',
    address: r.address ?? '',
    city: r.city ?? '',
    state: r.state ?? '',
    zip: r.zip ?? '',
    county: r.county ?? '',
    carrier: r.carrier ?? '',
    plan: r.plan_name ?? '',
    plan_id: r.plan_id ?? '',
    medicare_id: r.medicare_id ?? '',
    part_a_effective: joinMonthYear(r.part_a_month, r.part_a_year),
    part_b_effective: joinMonthYear(r.part_b_month, r.part_b_year),
    year: r.year,
    lead_source: r.lead_source ?? '',
    notes: r.notes ?? '',
    next_step: r.next_step ?? '',
    updated_at: r.updated_at ?? null,
    created_at: r.created_at ?? null,
  };
}

function shapeMed(r: MedicationRow): ShapedMedication {
  return {
    id: String(r.id),
    name: r.name ?? '',
    dose: r.dose ?? '',
    frequency: r.frequency ?? '',
    rxcui: r.rxcui ?? '',
    refill_days: r.refill_days ?? '',
    tier: r.tier != null ? String(r.tier) : '',
    quantity: r.quantity ?? '',
    form: r.form ?? '',
    pharmacy_id: r.pharmacy_id ?? null,
    refill_date: r.refill_date ?? '',
    notes: r.notes ?? '',
  };
}

function shapeProvider(
  l: ClientProviderLink & { providers: NonNullable<ClientProviderLink['providers']> },
): ShapedProvider {
  const r = l.providers;
  const ns = l.last_known_network_status;
  return {
    id: String(r.id),
    name: r.name ?? '',
    specialty: r.specialty ?? '',
    affiliation: r.affiliation ?? '',
    phone: r.phone ?? '',
    address: r.address ?? '',
    npi: r.npi ?? '',
    last_known_network_status:
      ns === 'in' || ns === 'out' || ns === 'unknown' ? ns : null,
    last_known_plan_id: l.last_known_plan_id ?? '',
  };
}

function joinMonthYear(month: string | null, year: string | null): string {
  const m = (month ?? '').trim();
  const y = (year ?? '').trim();
  if (m && y) return `${m} ${y}`;
  if (y) return y;
  if (m) return m;
  return '';
}
