// Proxy the AgentBase rxcui-backfill webhook. Called fire-and-forget
// by the agent-v3 hydration path after resolveAgentBaseDrugs matches
// free-text CRM medication names to canonical RxNorm concepts — only
// the 'high'-confidence matches are sent here and only for rows whose
// original CRM row had rxcui = NULL.
//
// Thin passthrough (mirrors api/agentbase-sync.ts). Session-gated so
// PLANMATCH_WEBHOOK_SECRET stays server-side and only authenticated
// brokers can fire it.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, serverError } from './_lib/http.js';
import { requireSession } from './_lib/require-session.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (await requireSession(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  try {
    const baseUrl = process.env.AGENTBASE_API_URL;
    const secret = process.env.PLANMATCH_WEBHOOK_SECRET;

    if (!baseUrl) return serverError(res, new Error('AGENTBASE_API_URL not configured'));
    if (!secret) return serverError(res, new Error('PLANMATCH_WEBHOOK_SECRET not configured'));

    const target = `${baseUrl.replace(/\/$/, '')}/planmatch-session/backfill-rxcuis`;

    const upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(req.body ?? {}),
    });

    const text = await upstream.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: 'AgentBase returned non-JSON', raw: text.slice(0, 500) };
    }

    res.status(upstream.status).setHeader('Content-Type', 'application/json').send(JSON.stringify(body));
  } catch (err) {
    serverError(res, err);
  }
}
