// GET /api/clients/[id] — full AgentBase client record + joins.
//
// Returns the client row plus:
//   · linked providers via client_providers × providers
//   · medications via client_medications
// Shape is designed to pre-populate Step 2 intake / Step 3 meds /
// Step 4 providers of the agent tool in one request, so the
// ClientLookup.tsx select handler does a single fetch then a
// session.updateClient + session.addMedication/Provider loop.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, notFound, sendJson, serverError } from '../_lib/http.js';
import { agentbaseSupabase } from '../_lib/agentbaseSupabase.js';

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
  created_at: string | null;
}

interface ClientProviderLink {
  provider_id: number;
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');

  const idRaw = req.query.id;
  const id = typeof idRaw === 'string' ? idRaw : Array.isArray(idRaw) ? idRaw[0] : '';
  if (!id || !/^\d+$/.test(id)) return badRequest(res, 'id must be a numeric client id');

  try {
    const sb = agentbaseSupabase();
    // Three parallel queries — saves ~200ms vs sequential fetches and
    // keeps the failure modes independent (a flaky providers table
    // doesn't block the client row from loading).
    const [clientRes, medsRes, providersRes] = await Promise.all([
      sb.from('clients').select('*').eq('id', id).maybeSingle(),
      sb
        .from('client_medications')
        .select('id, name, dose, frequency, rxcui, refill_days, created_at')
        .eq('client_id', id)
        .order('created_at', { ascending: true }),
      sb
        .from('client_providers')
        .select(
          'provider_id, providers:provider_id ( id, name, specialty, affiliation, phone, address, npi )',
        )
        .eq('client_id', id),
    ]);

    if (clientRes.error) throw clientRes.error;
    const client = clientRes.data as ClientRow | null;
    if (!client) return notFound(res, 'client not found');

    if (medsRes.error) throw medsRes.error;
    const meds = (medsRes.data ?? []) as MedicationRow[];

    if (providersRes.error) throw providersRes.error;
    const providerLinks = (providersRes.data ?? []) as unknown as ClientProviderLink[];

    res.setHeader('Cache-Control', 'no-store');
    return sendJson(res, 200, {
      client: shapeClient(client),
      medications: meds.map(shapeMed),
      providers: providerLinks
        .map((l) => l.providers)
        .filter((p): p is NonNullable<ClientProviderLink['providers']> => !!p)
        .map(shapeProvider),
    });
  } catch (err) {
    return serverError(res, err);
  }
}

function shapeClient(r: ClientRow) {
  const name = [r.first_name, r.last_name].map((s) => (s ?? '').trim()).filter(Boolean).join(' ');
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

function shapeMed(r: MedicationRow) {
  return {
    id: String(r.id),
    name: r.name ?? '',
    dose: r.dose ?? '',
    frequency: r.frequency ?? '',
    rxcui: r.rxcui ?? '',
    refill_days: r.refill_days ?? '',
  };
}

function shapeProvider(r: NonNullable<ClientProviderLink['providers']>) {
  return {
    id: String(r.id),
    name: r.name ?? '',
    specialty: r.specialty ?? '',
    affiliation: r.affiliation ?? '',
    phone: r.phone ?? '',
    address: r.address ?? '',
    npi: r.npi ?? '',
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
