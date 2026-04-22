// POST /api/provider-verification-notify
//
// Receives notification from the consumer Plan Match widget when a
// user advances past Step 3 (Providers). The provider_verifications
// rows are already in the shared Supabase by the time this fires —
// the consumer API wrote them before posting here. This endpoint is
// the agent tool's trigger for any out-of-band nudging (drawer
// refresh hint, future SMS/push, etc).
//
// The drawer polls /api/planmatch-verifications every 15s so Rob sees
// new rows either way; this endpoint mostly shortens the worst-case
// latency and is the place to wire push/SMS later.
//
// Request body:
//   {
//     session_id: string,
//     county: string,
//     state: string,
//     provider_count: number,
//     providers: Array<{ name, npi, specialty }>
//   }

import type { VercelRequest, VercelResponse } from '@vercel/node';

const ALLOWED_ORIGINS = new Set([
  'https://generationhealth.me',
  'https://www.generationhealth.me',
  'https://planmatch.generationhealth.me',
  'https://plan-match.vercel.app',
  'https://plan-match-robert9907s-projects.vercel.app',
]);

function corsOrigin(origin: string): string {
  return ALLOWED_ORIGINS.has(origin)
    ? origin
    : 'https://planmatch.generationhealth.me';
}

function setCors(res: VercelResponse, origin: string) {
  res.setHeader('Access-Control-Allow-Origin', corsOrigin(origin));
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = (req.headers.origin as string) || '';
  setCors(res, origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  try {
    const body = (req.body ?? {}) as {
      session_id?: string;
      county?: string;
      state?: string;
      provider_count?: number;
      providers?: Array<{ name?: string }>;
    };
    const sessionId = (body.session_id ?? '').toString().trim();
    const county = (body.county ?? '').toString().trim();
    const stateAbbr = (body.state ?? '').toString().trim().toUpperCase();
    const providerCount = Number.isFinite(body.provider_count as number)
      ? Number(body.provider_count)
      : Array.isArray(body.providers)
        ? body.providers.length
        : 0;
    const providerNames = Array.isArray(body.providers)
      ? body.providers
          .map((p) => (typeof p?.name === 'string' ? p.name.trim() : ''))
          .filter(Boolean)
          .slice(0, 10)
      : [];

    if (!sessionId) {
      return res.status(400).json({ error: 'session_id required' });
    }

    console.log(
      `[provider-verification-notify] session ${sessionId.slice(0, 8)}… · ${county}, ${stateAbbr} · ${providerCount} provider${providerCount === 1 ? '' : 's'}` +
        (providerNames.length > 0 ? ` · ${providerNames.join(', ')}` : ''),
    );

    // Rows are already in Supabase; agent-tool drawer polling surfaces
    // them within 15s. Future: SMS/push to Rob's phone from here.

    return res.status(200).json({
      ok: true,
      session_id: sessionId,
      provider_count: providerCount,
    });
  } catch (err) {
    console.error('[provider-verification-notify] fatal:', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}
