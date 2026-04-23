// Proxy Plan Match session writes to the AgentBase webhook. The
// AgentBase side owns the write to clients / client_medications /
// client_providers and enforces a unique index on
// (client_id, lower(trim(name))) to keep re-submissions from inserting
// duplicate rows.
//
// KNOWN LIMITATION — brand/generic collisions:
// The dedup key is lower(name), so "Gabapentin" and "Neurontin" — or
// "Metformin" and "Glucophage" — count as DIFFERENT drugs and both
// land in client_medications even though they're therapeutically
// identical. True drug dedup would have to key on the RxNorm
// ingredient rxcui (or a normalized ingredient name derived from it),
// not the free-text name. When we flip that on we also need to handle
// the mixed case where one row has an rxcui and a duplicate submission
// carries only a name. Until then, an agent may see both a brand and
// its generic attached to the same client — it's cosmetic on this
// screen but can inflate the formulary-check fan-out in Step 3.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, serverError } from './_lib/http.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  try {
    const baseUrl = process.env.AGENTBASE_API_URL;
    const secret = process.env.PLANMATCH_WEBHOOK_SECRET;

    if (!baseUrl) return serverError(res, new Error('AGENTBASE_API_URL not configured'));
    if (!secret) return serverError(res, new Error('PLANMATCH_WEBHOOK_SECRET not configured'));

    const target = `${baseUrl.replace(/\/$/, '')}/planmatch-session`;

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
