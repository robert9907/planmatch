// GET /api/export-env-gcp?t=<one-time token> — ONE-TIME, remove right after use.
//
// Copies this project's server settings into ONE Google Secret Manager
// secret (pm-agent-env) as a JSON object, server to server, so the
// values never pass through a laptop, shell or chat. The Google Cloud Run
// copy of agent Plan Match loads that secret at startup.
//
//   • Auth to this route: a one-time token; only its SHA-256 is in the code.
//   • Auth to Google: keyless. This production deployment's Vercel OIDC token
//     is exchanged at Google STS (provider "planmatch-agent", which only accepts
//     this project's production environment) for a 5-minute token as
//     vercel-key-export@…, which can only add versions to pm-agent-env.
//   • Only app settings are copied (allowlisted prefixes below) — never the
//     platform's own AWS_/VERCEL_/LAMBDA_ runtime variables.
//   • Values are never returned or logged — the response lists key names only.

import { createHash, timingSafeEqual } from 'crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const TOKEN_SHA256 = '908a48ba058fa48280316ecd933078baf6d6bd41a3d457515dde0ea3ce9378d9';
const GCP_PROJECT = 'pivotal-surfer-513601-a1';
const WIF_AUDIENCE =
  '//iam.googleapis.com/projects/640236353459/locations/global/workloadIdentityPools/vercel/providers/planmatch-agent';
const EXPORT_SA = `vercel-key-export@${GCP_PROJECT}.iam.gserviceaccount.com`;
const SECRET = 'pm-agent-env';
const KEEP =
  /^(VITE_|SUPABASE_|AGENTBASE_|TWILIO_|ANTHROPIC_|HEALTHSHERPA_|PLANMATCH_|PM_|QUOTE_|APP_URL$)/;

function tokenOk(t: unknown): boolean {
  if (typeof t !== 'string' || !t) return false;
  const a = Buffer.from(createHash('sha256').update(t).digest('hex'));
  const b = Buffer.from(TOKEN_SHA256);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function googleAccessToken(oidc: string): Promise<string> {
  const sts = await fetch('https://sts.googleapis.com/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: WIF_AUDIENCE,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
      subjectToken: oidc,
    }),
  });
  if (!sts.ok) throw new Error(`Google STS refused the Vercel token (${sts.status})`);
  const federated = ((await sts.json()) as { access_token: string }).access_token;
  const imp = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${EXPORT_SA}:generateAccessToken`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${federated}` },
      body: JSON.stringify({ scope: ['https://www.googleapis.com/auth/cloud-platform'], lifetime: '300s' }),
    },
  );
  if (!imp.ok) throw new Error(`Google refused impersonation (${imp.status})`);
  return ((await imp.json()) as { accessToken: string }).accessToken;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!tokenOk(req.query.t)) { res.status(404).json({ error: 'Not found' }); return; }

  const oidc = (req.headers['x-vercel-oidc-token'] as string | undefined) || process.env.VERCEL_OIDC_TOKEN;
  if (!oidc) { res.status(502).json({ ok: false, error: 'no Vercel OIDC token on this deployment' }); return; }

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (KEEP.test(k) && typeof v === 'string' && v !== '') env[k] = v;
  }

  let token: string;
  try {
    token = await googleAccessToken(oidc);
  } catch (e) {
    res.status(502).json({ ok: false, error: (e as Error).message });
    return;
  }

  const r = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${GCP_PROJECT}/secrets/${SECRET}:addVersion`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ payload: { data: Buffer.from(JSON.stringify(env), 'utf8').toString('base64') } }),
    },
  );
  res.status(r.ok ? 200 : 502).json({ ok: r.ok, saved: r.ok ? Object.keys(env).length : 0, keys: Object.keys(env).sort() });
}
