// GET /api/clients/search?q=... — live AgentBase client search.
//
// Matches on first_name / last_name / phone digits / zip with a
// case-insensitive ilike. Empty q returns the 20 most recently
// updated clients so the agent has something in the dropdown on
// first mount. Phone-number queries auto-normalize to digits before
// matching so "(828) 761-3326" and "8287613326" both hit.
//
// Returns a compact row shape — enough to render the Step 1 dropdown
// + decide whether to show "annual review" vs "new quote" eyebrow.
// Full client details (meds, providers, part_a/b) come from
// /api/clients/[id] on select.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from '../_lib/http.js';
import { agentbaseSupabase } from '../_lib/agentbaseSupabase.js';

interface ClientSearchRow {
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

const MAX_LIMIT = 20;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  const columns =
    'id, first_name, last_name, phone, email, dob, zip, city, state, county, ' +
    'carrier, plan_name, plan_id, medicare_id, part_a_month, part_a_year, ' +
    'part_b_month, part_b_year, year, lead_source, updated_at';

  try {
    const sb = agentbaseSupabase();
    let query = sb.from('clients').select(columns);

    if (q) {
      // Build a broad OR across name / phone / zip. PostgREST's or()
      // takes a comma-separated list of "col.op.value" tokens. ZIP is
      // a 5-digit exact match; everything else uses ilike with
      // wildcards around the term. Phone normalization drops dashes/
      // parens/spaces so typed formats don't miss stored formats.
      const safe = q.replace(/[,%*()]/g, ' ').trim();
      const digits = q.replace(/\D/g, '');
      const parts: string[] = [
        `first_name.ilike.%${safe}%`,
        `last_name.ilike.%${safe}%`,
      ];
      if (digits.length >= 3) {
        parts.push(`phone.ilike.%${digits}%`);
      }
      if (/^\d{5}$/.test(q)) {
        parts.push(`zip.eq.${q}`);
      } else if (/^\d{3,5}$/.test(q)) {
        parts.push(`zip.ilike.${q}%`);
      }
      query = query.or(parts.join(','));
    }

    const { data, error } = await query
      .order('last_name', { ascending: true, nullsFirst: false })
      .limit(MAX_LIMIT);
    if (error) throw error;

    const clients = ((data ?? []) as unknown as ClientSearchRow[]).map(toSummary);
    res.setHeader('Cache-Control', 'no-store');
    return sendJson(res, 200, { clients });
  } catch (err) {
    return serverError(res, err);
  }
}

function toSummary(r: ClientSearchRow) {
  const name = [r.first_name, r.last_name].map((s) => (s ?? '').trim()).filter(Boolean).join(' ');
  const partA = joinMonthYear(r.part_a_month, r.part_a_year);
  const partB = joinMonthYear(r.part_b_month, r.part_b_year);
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
    part_a_effective: partA,
    part_b_effective: partB,
    year: r.year,
    lead_source: r.lead_source ?? '',
    last_contact_at: r.updated_at ?? null,
  };
}

// Convert ("April", "2026") → "April 2026", or "2026" if only year
// present. Returns '' when neither set.
function joinMonthYear(month: string | null, year: string | null): string {
  const m = (month ?? '').trim();
  const y = (year ?? '').trim();
  if (m && y) return `${m} ${y}`;
  if (y) return y;
  if (m) return m;
  return '';
}
