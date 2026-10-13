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
    // SPLIT sellable set, matching the brain:
    //  • 2027+: the full sellable definition (exclude rules + Wellcare
    //    allowlist + UHC/Devoted flags) via computeSellable.
    //  • 2026: the appointed set (is_appointed && is_certified) MINUS
    //    UHC-after-cutoff and Devoted — Rob can't write those for any
    //    year. getSellableRules returns [] for 2026, so computeSellable
    //    collapses to the flags-only check there.
    const [rules, flags] = [await getSellableRules(base, key, planYear), getSellableFlags()];
    const appointedSets = planYear < 2027 ? await getSellabilitySets(base, key) : null;
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
      const ref = {
        contract_id: x.contract_id,
        plan_id: x.plan_id,
        segment_id: x.segment_id ?? '0',
        state,
        county_name: county,
        carrier: x.carrier,
      };
      // rules=[] for 2026 ⇒ computeSellable is flags-only there (UHC/Devoted).
      const sell = computeSellable(ref, { rules, flags, now });
      if (planYear >= 2027) return sell;
      // 2026: appointed set AND not UHC(post-cutoff)/Devoted.
      const f = resolveSellability(appointedSets!, x.contract_id, x.plan_id);
      return f.is_appointed && f.is_certified && sell;
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
