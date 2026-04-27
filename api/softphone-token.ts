// GET /api/softphone-token
//
// Mints a Twilio Voice access token for the broker's browser, granting
// outbound-call privileges through the AgentBase TwiML App
// (AP76b408ab9c23b9ef4a68ebaf641ad3be). The TwiML App routes outbound
// dials to the AgentBase Voice URL which returns the <Dial> TwiML —
// PlanMatch never sees the call routing, just the browser endpoint.
//
// Env requirements (already used by api/_lib/twilio.ts for Video):
//   TWILIO_ACCOUNT_SID
//   TWILIO_API_KEY_SID       (Standard API Key, NOT the auth token)
//   TWILIO_API_KEY_SECRET
//
// Optional override (defaults to AgentBase's TwiML App):
//   TWILIO_VOICE_TWIML_APP_SID
//
// Cache-Control: no-store + force-dynamic semantics — tokens carry an
// embedded expiry; we never want a CDN edge serving a stale one.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import Twilio from 'twilio';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';

// AgentBase TwiML App SID. Hardcoded fallback so the broker doesn't
// have to set an extra env var when they want the standard routing.
// Override via TWILIO_VOICE_TWIML_APP_SID for testing.
const DEFAULT_TWIML_APP_SID = 'AP76b408ab9c23b9ef4a68ebaf641ad3be';

// 1-hour default TTL — matches /api/screen-share-token. The hook
// auto-refreshes ~5 minutes before expiry.
const DEFAULT_TTL_SECONDS = 60 * 60;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');

  // No-store on every response. Tokens contain an exp claim; serving
  // a cached one means the broker dials with a token that's already
  // expired the moment Twilio's edge validates it.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const apiKey = process.env.TWILIO_API_KEY_SID;
    const apiSecret = process.env.TWILIO_API_KEY_SECRET;
    const twimlAppSid = process.env.TWILIO_VOICE_TWIML_APP_SID || DEFAULT_TWIML_APP_SID;

    if (!accountSid || !apiKey || !apiSecret) {
      return sendJson(res, 500, {
        error: 'softphone unavailable',
        detail:
          'TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, and TWILIO_API_KEY_SECRET must be set on this Vercel project',
      });
    }

    // Identity should be stable per broker so the AgentBase server can
    // attribute call recordings / logs back to the right user. Default
    // to 'planmatch-broker'; a future multi-broker build can pass an
    // explicit identity from the session.
    const identity =
      typeof req.query.identity === 'string' && req.query.identity.length > 0
        ? req.query.identity.slice(0, 64).replace(/[^a-zA-Z0-9_.-]/g, '')
        : 'planmatch-broker';

    const ttlSeconds = (() => {
      const raw = Number(req.query.ttl);
      if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TTL_SECONDS;
      // Clamp to [60s, 4h] — beyond that Twilio rejects.
      return Math.max(60, Math.min(raw, 4 * 60 * 60));
    })();

    const AccessToken = Twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;
    const token = new AccessToken(accountSid, apiKey, apiSecret, {
      identity,
      ttl: ttlSeconds,
    });
    const grant = new VoiceGrant({
      outgoingApplicationSid: twimlAppSid,
      incomingAllow: true,
    });
    token.addGrant(grant);

    return sendJson(res, 200, {
      token: token.toJwt(),
      identity,
      ttlSeconds,
      twimlAppSid,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
