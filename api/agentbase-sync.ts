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
