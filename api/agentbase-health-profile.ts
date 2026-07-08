// Server-side proxy that reads client_health_profiles from the CRM's
// Supabase (project wyyasqvouvdcovttzfnv). Plan Match's own data lives
// in plan-match-prod, so this uses agentbaseSupabase() — same pattern
// as api/agentbase-clients.ts. Browser-side agent-v3 sync builder
// fetches this endpoint (same-origin) instead of the CRM domain
// directly to avoid CORS.
//
// GET ?client_id=<n> → { profile: <row> | null }
// Returns only saved rows. The CRM's own /api/client-health-profile
// synthesizes an inferred profile when none is saved, but plan-match
// intentionally does NOT — an inferred profile round-tripped through
// agentbase-recommend would get persisted as if the broker had saved
// it, which we don't want. When no saved row exists, healthContext
// stays undefined in the sync payload and the recommend endpoint's
// write branch no-ops.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';
import { agentbaseSupabase } from './_lib/agentbaseSupabase.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');

  const raw = req.query.client_id;
  const clientId = Array.isArray(raw) ? raw[0] : raw;
  if (!clientId || !/^\d+$/.test(clientId)) {
    return badRequest(res, 'client_id (numeric) required');
  }

  try {
    const sb = agentbaseSupabase();
    const { data, error } = await sb
      .from('client_health_profiles')
      .select('*')
      .eq('client_id', Number(clientId))
      .maybeSingle();

    if (error) return serverError(res, error);
    return sendJson(res, 200, { profile: data ?? null });
  } catch (err) {
    return serverError(res, err);
  }
}
