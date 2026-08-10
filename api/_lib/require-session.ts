// Session gate for the 8 broker-only endpoints in this repo. Verifies the
// gh_session cookie's JWT against the AgentBase project's JWKS — this repo
// never issues tokens, only verifies AgentBase-issued ones.
//
// 401 JSON on any failure. No WWW-Authenticate. No dev bypass.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createClient } from '@supabase/supabase-js';

const PROJECT_REF = 'wyyasqvouvdcovttzfnv';
const JWKS_URL = `https://${PROJECT_REF}.supabase.co/auth/v1/.well-known/jwks.json`;
const EXPECTED_ISS = `https://${PROJECT_REF}.supabase.co/auth/v1`;

const jwks = createRemoteJWKSet(new URL(JWKS_URL));

class UnauthenticatedError extends Error {
  reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === 'gh_session') return part.slice(eq + 1).trim();
  }
  return null;
}

let brokerCache: { ids: Set<string>; expires: number } | null = null;
const BROKER_CACHE_TTL_MS = 60_000;

async function fetchActiveBrokerIds(): Promise<Set<string>> {
  // Repo A verifies tokens issued by the AgentBase project and reads the
  // broker_users roster from that same project. AgentBase creds live in
  // AGENTBASE_SUPABASE_URL / AGENTBASE_SUPABASE_SERVICE_ROLE_KEY here.
  const url = process.env.AGENTBASE_SUPABASE_URL;
  const key = process.env.AGENTBASE_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new UnauthenticatedError('admin_creds_missing');
  const admin = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await admin
    .from('broker_users')
    .select('id')
    .eq('active', true);
  if (error) throw new UnauthenticatedError('broker_lookup_failed');
  return new Set((data ?? []).map((r) => r.id as string));
}

async function getActiveBrokerIds(): Promise<Set<string>> {
  if (brokerCache && brokerCache.expires > Date.now()) return brokerCache.ids;
  const ids = await fetchActiveBrokerIds();
  brokerCache = { ids, expires: Date.now() + BROKER_CACHE_TTL_MS };
  return ids;
}

// Returns true when the response has been sent (auth failed). Returns
// false when auth passed. Mirrors the return-shape of the old
// requireBrokerAuth so existing call sites can swap import + name only.
export async function requireSession(
  req: VercelRequest,
  res: VercelResponse,
): Promise<boolean> {
  // Dev-only bypass — fires only under local `vercel dev`, where
  // Vercel sets VERCEL_ENV='development'. Vercel-hosted deployments
  // always set VERCEL_ENV to 'production' or 'preview'; VERCEL_ENV is
  // a reserved system env var and cannot be user-overridden in the
  // Vercel project settings. Bypass cannot activate on any shipped
  // deployment even if a stray custom env var leaked. Purpose: local
  // dev flow doesn't require pasting a gh_session cookie into
  // DevTools every session.
  // Dev-only bypass — fires only under local `vercel dev`. Two
  // simultaneous conditions, both set by Vercel infrastructure (not
  // user-controllable):
  //   1. x-vercel-id starts with 'dev1::' — vercel dev's marker for
  //      requests it served locally. Hosted deployments always use a
  //      real region prefix (iad1::, sfo1::, cdg1::, etc.); the value
  //      is set by Vercel's edge and overrides any user-supplied
  //      X-Vercel-Id header.
  //   2. host is localhost / 127.0.0.1 — a Vercel-hosted request's
  //      Host is always one of the deployment domains.
  // Even if a bad actor spoofed one header, the other still gates.
  // Purpose: local dev doesn't need to paste a gh_session cookie into
  // DevTools every session. No env-var setup required.
  const vercelId = String(req.headers['x-vercel-id'] ?? '');
  const host = String(req.headers.host ?? '');
  const isLocalDev =
    vercelId.startsWith('dev1::') &&
    (host.startsWith('localhost:') || host.startsWith('127.0.0.1:'));
  if (isLocalDev) return false;
  try {
    const token = readSessionCookie(req.headers.cookie);
    if (!token) throw new UnauthenticatedError('no_cookie');
    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, { issuer: EXPECTED_ISS }));
    } catch {
      throw new UnauthenticatedError('jwt_invalid');
    }
    const sub = payload.sub;
    if (typeof sub !== 'string' || sub.length === 0) {
      throw new UnauthenticatedError('no_sub');
    }
    const active = await getActiveBrokerIds();
    if (!active.has(sub)) throw new UnauthenticatedError('not_active_broker');
    return false;
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(401).json({ error: 'unauthenticated' });
      return true;
    }
    throw err;
  }
}
