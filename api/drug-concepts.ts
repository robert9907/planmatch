// POST /api/drug-concepts
//
// Body: { rxcuis: string[] }
// Resp: { concepts: Record<rxcui, rxnormName> }
//
// Lets the AgentBase hydration path check a CRM row's stored rxcui
// against its filed dose/form (resolveAgentBaseDrugs). Read-only lookup
// on plan-match-prod pm_drugs.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';
import { requireSession } from './_lib/require-session.js';
import { supabase } from './_lib/supabase.js';

const MAX_RXCUIS = 200;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (await requireSession(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  const body = (req.body ?? {}) as { rxcuis?: unknown };
  const rxcuis = Array.isArray(body.rxcuis)
    ? [...new Set(body.rxcuis.filter((x): x is string => typeof x === 'string' && /^\d{1,10}$/.test(x)))]
    : [];
  if (rxcuis.length === 0) return badRequest(res, 'rxcuis required (non-empty numeric string array)');
  if (rxcuis.length > MAX_RXCUIS) return badRequest(res, `at most ${MAX_RXCUIS} rxcuis`);

  try {
    const { data, error } = await supabase().from('pm_drugs').select('rxcui,name').in('rxcui', rxcuis);
    if (error) throw error;
    const concepts: Record<string, string> = {};
    for (const row of data ?? []) concepts[row.rxcui as string] = row.name as string;
    sendJson(res, 200, { concepts });
  } catch (err) {
    serverError(res, err);
  }
}
