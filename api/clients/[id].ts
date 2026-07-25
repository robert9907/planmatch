// GET /api/clients/[id] — full AgentBase client record + joins.
//
// Thin wrapper over loadClientSession() in api/_lib/clientSession.ts.
// Kept as the canonical internal route consumed by the v4 LandingPage
// client picker (via fetchClientDetail in src/lib/agentbase). The
// AgentBase-facing equivalent is /api/client-session?clientId= — same
// loader, different entry point.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, notFound, sendJson, serverError } from '../_lib/http.js';
import { loadClientSession } from '../_lib/clientSession.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Locked down 2026-07-25 — 410 Gone until Phase 3 restores this behind auth.
  // No CORS on the 410 response (early return, before cors()).
  if (true as boolean) {
    res.status(410).json({ error: 'gone' });
    return;
  }

  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');

  const idRaw = req.query.id;
  const id = typeof idRaw === 'string' ? idRaw : Array.isArray(idRaw) ? idRaw[0] : '';
  if (!id || !/^\d+$/.test(id)) return badRequest(res, 'id must be a numeric client id');

  try {
    const payload = await loadClientSession(id);
    if (!payload) return notFound(res, 'client not found');
    res.setHeader('Cache-Control', 'no-store');
    return sendJson(res, 200, payload);
  } catch (err) {
    return serverError(res, err);
  }
}
