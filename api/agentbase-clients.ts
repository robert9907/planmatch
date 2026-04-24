// AgentBase clients lookup — multiplexed endpoint for the v4 Landing
// page. SUPABASE_URL and AGENTBASE_SUPABASE_URL point at the same
// project, so this reuses the existing service-role client from
// api/_lib/supabase.ts rather than spinning up a second one.
//
// Modes (mutually exclusive, evaluated in this order):
//   GET ?stats=true        → { stats: { total } }
//   GET ?recent=5          → { clients: [...] } most-recent N by updated_at
//   GET ?q=search_term     → { clients: [...] } match name / phone / zip
//   GET (no args)          → { clients: [...] } 20 most-recent (same as recent=20)
//
// Row shape matches /api/clients/search so the existing AgentBaseClient
// derivation in src/lib/agentbase.ts works unchanged.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';
import { supabase } from './_lib/supabase.js';

interface ClientRow {
  id: number;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  dob: string | null;
  zip: string | null;
  city: string | null;
  state: string | null;
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
  updated_at: string | null;
}

const COLUMNS =
  'id, first_name, last_name, phone, email, dob, zip, city, state, county, ' +
  'carrier, plan_name, plan_id, medicare_id, part_a_month, part_a_year, ' +
  'part_b_month, part_b_year, year, lead_source, updated_at';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');

  res.setHeader('Cache-Control', 'no-store');

  try {
    const sb = supabase();

    if (req.query.stats === 'true' || req.query.stats === '1') {
      const { count, error } = await sb
        .from('clients')
        .select('id', { count: 'exact', head: true });
      if (error) throw error;
      return sendJson(res, 200, { stats: { total: count ?? 0 } });
    }

    if (typeof req.query.recent === 'string' && req.query.recent.length > 0) {
      const limit = clampLimit(req.query.recent);
      const { data, error } = await sb
        .from('clients')
        .select(COLUMNS)
        .order('updated_at', { ascending: false, nullsFirst: false })
        .limit(limit);
      if (error) throw error;
      return sendJson(res, 200, { clients: shapeRows(data) });
    }

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    let query = sb.from('clients').select(COLUMNS);

    if (q) {
      // Strip PostgREST-significant chars so we can't break the OR filter
      // by typing ',' or '%' into the search box. Phone normalization
      // drops formatting so "(828) 761-3326" matches "8287613326".
      const safe = q.replace(/[,%*()]/g, ' ').trim();
      const digits = q.replace(/\D/g, '');
      const parts: string[] = [
        `first_name.ilike.%${safe}%`,
        `last_name.ilike.%${safe}%`,
      ];
      if (digits.length >= 3) parts.push(`phone.ilike.%${digits}%`);
      if (/^\d{5}$/.test(q)) parts.push(`zip.eq.${q}`);
      else if (/^\d{3,5}$/.test(q)) parts.push(`zip.ilike.${q}%`);
      query = query.or(parts.join(','));
      query = query.order('last_name', { ascending: true, nullsFirst: false });
    } else {
      // Empty q behaves like recent=20 — keeps the dropdown populated on
      // first paint without forcing the caller to issue two requests.
      query = query.order('updated_at', { ascending: false, nullsFirst: false });
    }

    const { data, error } = await query.limit(DEFAULT_LIMIT);
    if (error) throw error;
    return sendJson(res, 200, { clients: shapeRows(data) });
  } catch (err) {
    return serverError(res, err);
  }
}

function clampLimit(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function shapeRows(data: unknown): unknown[] {
  return ((data ?? []) as ClientRow[]).map(toSummary);
}

function toSummary(r: ClientRow) {
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
    zip: r.zip ?? '',
    city: r.city ?? '',
    state: r.state ?? '',
    county: r.county ?? '',
    carrier: r.carrier ?? '',
    plan: r.plan_name ?? '',
    plan_id: r.plan_id ?? '',
    medicare_id: r.medicare_id ?? '',
    part_a_effective: joinMonthYear(r.part_a_month, r.part_a_year),
    part_b_effective: joinMonthYear(r.part_b_month, r.part_b_year),
    year: r.year,
    lead_source: r.lead_source ?? '',
    last_contact_at: r.updated_at ?? null,
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
