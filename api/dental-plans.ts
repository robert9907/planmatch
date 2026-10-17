// GET /api/dental-plans?state=NC
//
// Off-exchange individual dental plans + every stored rate row for a state,
// for the agent-v3 Dental quote screen. Pricing (ZIP / age / household
// matching) happens client-side in src/lib/dentalPricing.ts so the broker can
// change inputs without a round trip — the whole NC set is ~34 plans and
// ~100 rate rows.
//
// Reads pm_dental_plan + pm_dental_rate (service-role only, RLS on, no
// policies — see supabase/migrations/004_pm_dental.sql).

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';

const PLAN_COLUMNS = [
  'id', 'carrier', 'plan_name', 'state', 'plan_type', 'is_insurance', 'network',
  'annual_max', 'deductible', 'waiting_period', 'preventive', 'basic', 'major', 'orthodontia',
  'implants', 'dentures', 'crowns', 'root_canals', 'periodontics', 'oral_surgery',
  'waiting_waiver', 'missing_tooth_clause', 'eligibility', 'extras',
  'covers_implants', 'covers_major', 'no_waiting',
  'source_doc', 'source_url', 'captured_at',
].join(',');

const RATE_COLUMNS = 'zip,zip_prefixes,age_min,age_max,tier,monthly_premium,is_starting_at';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');
  const state = String(req.query.state ?? 'NC').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) return badRequest(res, 'state must be a 2-letter code');

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return serverError(res, new Error('Supabase env not configured'));
  const base = url.replace(/\/$/, '');

  try {
    const p = new URLSearchParams();
    p.set('state', `eq.${state}`);
    p.set('select', `${PLAN_COLUMNS},rates:pm_dental_rate(${RATE_COLUMNS})`);
    p.set('order', 'carrier.asc,plan_name.asc');
    const r = await fetch(`${base}/rest/v1/pm_dental_plan?${p}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`pm_dental_plan ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const plans = (await r.json()) as Array<{ rates: Array<{ monthly_premium: number | string }> }>;
    // numeric(8,2) arrives as a string from PostgREST — normalize once here.
    for (const plan of plans) {
      for (const rate of plan.rates ?? []) rate.monthly_premium = Number(rate.monthly_premium);
    }
    res.setHeader('Cache-Control', 'private, max-age=300');
    return sendJson(res, 200, { state, plans });
  } catch (err) {
    return serverError(res, err);
  }
}
