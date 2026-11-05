// POST /api/agentbase-correct-rxcuis
//
// Body: { clientId: string, updates: { id: string, from: string, to: string }[] }
// Resp: { summary: { requested, updated } }
//
// Persists rxcui CORRECTIONS found by resolveAgentBaseDrugs: a CRM row
// whose stored rxcui provably disagreed with its own filed dose/form and
// was re-resolved to a strength-matched concept. The existing
// /api/agentbase-backfill-rxcuis webhook only fills NULL rxcuis, so a
// bad stored value (Laura Goodman 2026-11-05: 112mcg tablet stored as a
// 0.05 MG capsule) would otherwise be re-loaded wrong on every visit.
//
// Guarded compare-and-set: a row is changed only if it still belongs to
// clientId AND still holds the `from` value, so a broker edit made in
// AgentBase in the meantime is never overwritten.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';
import { requireSession } from './_lib/require-session.js';
import { agentbaseSupabase } from './_lib/agentbaseSupabase.js';

const RX = /^\d{1,10}$/;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (await requireSession(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  const body = (req.body ?? {}) as { clientId?: unknown; updates?: unknown };
  const clientId = typeof body.clientId === 'string' || typeof body.clientId === 'number' ? String(body.clientId) : '';
  if (!/^\d+$/.test(clientId)) return badRequest(res, 'clientId required');
  const updates = Array.isArray(body.updates)
    ? body.updates.filter(
        (u): u is { id: string; from: string; to: string } =>
          !!u &&
          /^\d+$/.test(String((u as { id?: unknown }).id)) &&
          RX.test(String((u as { from?: unknown }).from)) &&
          RX.test(String((u as { to?: unknown }).to)),
      )
    : [];
  if (updates.length === 0 || updates.length > 50) return badRequest(res, 'updates required (1–50)');

  try {
    const sb = agentbaseSupabase();
    let updated = 0;
    for (const u of updates) {
      const { data, error } = await sb
        .from('client_medications')
        .update({ rxcui: String(u.to) })
        .eq('id', String(u.id))
        .eq('client_id', clientId)
        .eq('rxcui', String(u.from))
        .select('id');
      if (error) throw error;
      updated += data?.length ?? 0;
    }
    sendJson(res, 200, { summary: { requested: updates.length, updated } });
  } catch (err) {
    serverError(res, err);
  }
}
