// GET /api/tpmo-counts?state=NC&county=Durham[&plan_year=2027]
//
// TPMO disclaimer counts — 42 CFR 422.2267(e)(41) count variant. N =
// organizations, M = products, scoped to plans Rob can sell in the county:
// can_enroll = is_appointed AND is_certified (pm_plan_sellability; no row =
// sellable). Same definition as the consumer app (usePlansRanked): pm_plans
// rows for state + county + plan year, sanctioned excluded; N = distinct
// parent_organization (else carrier); M = sellable plan rows.
//
// Fails closed: if sellability can't load, 500 — never a guessed count.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';
import { computeSellable, getSellableRules, getSellableFlags } from './_lib/sellable-rules.js';
import { getSellabilitySets, resolveSellability } from './_lib/sellability.js';
import { parsePlanYearParam, resolvePlanCatalogYear } from './library/planCatalogYear.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');
  const state = String(req.query.state ?? '').trim().toUpperCase();
  const county = String(req.query.county ?? '').trim().replace(/\s+county$/i, '');
  if (!/^[A-Z]{2}$/.test(state)) return badRequest(res, 'state must be a 2-letter code');
  if (!county || county.length > 80) return badRequest(res, 'county is required');
  const planYear = parsePlanYearParam(req.query.plan_year) ?? resolvePlanCatalogYear();

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return serverError(res, new Error('Supabase env not configured'));
  const base = url.replace(/\/$/, '');
  try {
    // Single sellable definition, matching the brain's computeSellable:
    // the appointment gate (is_appointed && is_certified) + the UHC/Devoted
    // flags fire for EVERY plan year; the exclude rules + Wellcare allowlist
    // only engage when a ruleset is wired (2027 — getSellableRules returns []
    // for 2026). Appointment is attached to the ref for every year (same as
    // the consumer), so the one computeSellable call handles both years and
    // the old separate 2026 is_appointed && is_certified check is gone.
    const [rules, flags] = [await getSellableRules(base, key, planYear), getSellableFlags()];
    const appointedSets = await getSellabilitySets(base, key);
    const now = new Date();
    const p = new URLSearchParams();
    p.set('state', `eq.${state}`);
    p.set('county_name', `ilike.${county}`);
    p.set('plan_year', `eq.${planYear}`);
    p.set('sanctioned', 'eq.false');
    p.set('select', 'contract_id,plan_id,segment_id,carrier,parent_organization');
    p.set('limit', '2000');
    const r = await fetch(`${base}/rest/v1/pm_plans?${p}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`pm_plans ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const rows = (await r.json()) as Array<{
      contract_id: string; plan_id: string; segment_id: string | null; carrier: string | null; parent_organization: string | null;
    }>;
    const sellable = rows.filter((x) => {
      // Attach appointment/certification for EVERY year so the appointment
      // gate inside computeSellable fires the same way it does in the brain.
      const f = resolveSellability(appointedSets, x.contract_id, x.plan_id);
      const ref = {
        contract_id: x.contract_id,
        plan_id: x.plan_id,
        segment_id: x.segment_id ?? '0',
        state,
        county_name: county,
        carrier: x.carrier,
        is_appointed: f.is_appointed,
        is_certified: f.is_certified,
      };
      // rules=[] for 2026 ⇒ computeSellable is appointment + flags only there
      // (UHC/Devoted); 2027 adds the exclude rules + Wellcare allowlist.
      return computeSellable(ref, { rules, flags, now });
    });
    const orgCount = new Set(sellable.map((x) => x.parent_organization ?? x.carrier ?? '—')).size;
    res.setHeader('Cache-Control', 'private, max-age=300');
    return sendJson(res, 200, {
      state, county, plan_year: planYear,
      org_count: orgCount, product_count: sellable.length, plans_in_county: rows.length,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
