// POST /api/quote-send — the only way agent-v3 sends a client quote.
//
// Broker-only: requires a logged-in AgentBase session (requireSession). The
// browser never talks to the consumer quote API directly; this server-side
// hop adds the QUOTE_API_SECRET bearer that robert9907/plan-match
// POST /api/quotes requires (api/_lib/quote-auth.ts there), so the secret
// never reaches the browser.
//
// Fails closed: no secret configured = 503, nothing sent.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendJson } from './_lib/http.js';
import { requireSession } from './_lib/require-session.js';

const QUOTE_API_BASE = 'https://planmatch.generationhealth.me';
const MAX_BODY_BYTES = 64 * 1024;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Same-origin only: no CORS headers, so other sites can't call this with
  // the broker's cookie.
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST required' });
  if (await requireSession(req, res)) return;

  const secret = process.env.QUOTE_API_SECRET;
  if (!secret || secret.length < 32) {
    return sendJson(res, 503, { error: 'Quote sending is not configured (QUOTE_API_SECRET)' });
  }

  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? null);
  if (!body || body === 'null') return sendJson(res, 400, { error: 'JSON body required' });
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) return sendJson(res, 413, { error: 'Quote too large' });

  try {
    const upstream = await fetch(`${QUOTE_API_BASE}/api/quotes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body,
    });
    const text = await upstream.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: `Quote service returned ${upstream.status}` };
    }
    return sendJson(res, upstream.status, data);
  } catch (err) {
    console.error('[api/quote-send] upstream failed:', err);
    return sendJson(res, 502, { error: 'Could not reach the quote service' });
  }
}
