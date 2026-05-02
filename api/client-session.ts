// GET /api/client-session?clientId=<numeric id>
//
// AgentBase-facing entry point for hydrating an agent-v3 quote with
// real CRM data. The CRM links the broker to
//   https://planmatch.vercel.app/agent-v3?clientId=<id>
// and agent-v3 hits this endpoint on mount to populate useSession.
//
// Returns the same shape as /api/clients/[id] — both are thin wrappers
// over loadClientSession() in api/_lib/clientSession.ts. We keep the
// two routes because:
//   • /api/clients/[id] is the existing internal contract (Step1 +
//     LandingPage picker); changing its URL would ripple.
//   • /api/client-session is the stable name we hand AgentBase, so its
//     deep-link template doesn't have to know about the [id] segment.
//
// AgentBase clients.id is a Postgres bigint, not a UUID — accept any
// string of digits and reject everything else with 400.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, notFound, sendJson, serverError } from './_lib/http.js';
import { loadClientSession } from './_lib/clientSession.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');

  const raw = req.query.clientId;
  const clientId = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : '';
  if (!clientId) return badRequest(res, 'clientId required');
  if (!/^\d+$/.test(clientId)) {
    return badRequest(res, 'clientId must be a numeric AgentBase clients.id');
  }

  try {
    const payload = await loadClientSession(clientId);
    if (!payload) return notFound(res, 'client not found');
    res.setHeader('Cache-Control', 'no-store');
    return sendJson(res, 200, payload);
  } catch (err) {
    return serverError(res, err);
  }
}
