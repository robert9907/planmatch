import type { VercelRequest, VercelResponse } from '@vercel/node';

// Basic Auth gate for the 8 broker-only endpoints locked down in 1703de5.
// Vercel functions here are handler-per-file (not Next.js middleware) — each
// handler imports this helper and calls it after cors() so OPTIONS preflight
// still passes.
//
// Fail-closed: missing PLANMATCH_BROKER_USER / PLANMATCH_BROKER_PASS returns
// 503 in every environment. Any bad or missing Authorization header returns
// 401 with WWW-Authenticate so the broker's browser pops the native prompt
// on first XHR (credential cached per origin+realm for the session).
//
// Returns true when the response has been sent (auth failed or not
// configured) — the handler should return immediately. Returns false when
// auth passed.

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function sendChallenge(res: VercelResponse, status: number, error: string): void {
  res.setHeader('WWW-Authenticate', 'Basic realm="PlanMatch"');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({ error });
}

export function requireBrokerAuth(req: VercelRequest, res: VercelResponse): boolean {
  const expectedUser = process.env.PLANMATCH_BROKER_USER;
  const expectedPass = process.env.PLANMATCH_BROKER_PASS;
  if (!expectedUser || !expectedPass) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(503).json({ error: 'auth_not_configured' });
    return true;
  }

  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) {
    sendChallenge(res, 401, 'unauthorized');
    return true;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    sendChallenge(res, 401, 'unauthorized');
    return true;
  }

  const idx = decoded.indexOf(':');
  if (idx === -1) {
    sendChallenge(res, 401, 'unauthorized');
    return true;
  }

  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  if (!timingSafeEqual(user, expectedUser) || !timingSafeEqual(pass, expectedPass)) {
    sendChallenge(res, 401, 'unauthorized');
    return true;
  }

  return false;
}
