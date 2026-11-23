// Session gate for the broker-only endpoints in this repo. Verifies the
// gh_session cookie's JWT — this repo never issues tokens, only verifies
// AgentBase-issued ones.
//
// Since Nov 2026 AgentBase signs them itself (ES256, public key at
// https://crm.generationhealth.me/api/auth/jwks). The legacy Supabase Auth
// issuer was removed on 2026-11-23 once the old project showed no activity.
//
// 401 JSON on any failure. No WWW-Authenticate. No dev bypass.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import { createClient } from '@supabase/supabase-js';

const AGENTBASE_ISS = 'https://crm.generationhealth.me/auth';
const AGENTBASE_AUD = 'agentbase';
const agentbaseJwks = createRemoteJWKSet(
  new URL('https://crm.generationhealth.me/api/auth/jwks'),
);

function amrHasPasskey(payload: Record<string, unknown>): boolean {
  const amr = payload.amr;
  if (!Array.isArray(amr)) return false;
  return amr.some((e) =>
    e === 'passkey' ||
    (e && typeof e === 'object' && (e as { method?: unknown }).method === 'passkey'),
  );
}

async function verifyToken(token: string) {
  let iss: unknown;
  try {
    iss = decodeJwt(token).iss;
  } catch {
    throw new UnauthenticatedError('jwt_invalid');
  }
  if (iss !== AGENTBASE_ISS) throw new UnauthenticatedError('jwt_invalid');
  try {
    const { payload } = await jwtVerify(token, agentbaseJwks, {
      issuer: AGENTBASE_ISS,
      audience: AGENTBASE_AUD,
      algorithms: ['ES256'],
    });
    if (!amrHasPasskey(payload as Record<string, unknown>)) {
      throw new UnauthenticatedError('amr_not_allowed');
    }
    return payload;
  } catch (e) {
    if (e instanceof UnauthenticatedError) throw e;
    throw new UnauthenticatedError('jwt_invalid');
  }
}

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
    const payload = await verifyToken(token);
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
