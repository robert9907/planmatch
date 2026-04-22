// GET /api/npi-search — server-side proxy for the CMS NPPES NPI Registry.
//
// The public NPPES endpoint (https://npiregistry.cms.hhs.gov/api) does
// not send Access-Control-Allow-Origin headers on its responses, so any
// direct browser fetch from our app origin fails with an opaque
// "TypeError: Failed to fetch" before we can even read the status.
// Proxying server-side (no CORS rules in a Node runtime) sidesteps
// that and lets us surface real error bodies back to the UI.
//
// Query params:
//   name  required · free-text provider name; either single token
//           (treated as last_name) or multi-token (first + last).
//   state optional · 2-letter state code
//   limit optional · default 20, clamped to [1, 50]
//
// Response shape mirrors NPPES for the fields we use downstream:
//   { results: NppesRecord[] }
// Errors surface as: { error: string, status?: number, detail?: string }
// at HTTP 400/502/504 as appropriate.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';

const NPPES_URL = 'https://npiregistry.cms.hhs.gov/api/';
const NPPES_VERSION = '2.1';
const DEFAULT_TIMEOUT_MS = 12_000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');

  const nameRaw = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  if (nameRaw.length < 2) {
    return badRequest(res, 'name query param must be at least 2 characters');
  }

  const state =
    typeof req.query.state === 'string' && /^[A-Za-z]{2}$/.test(req.query.state)
      ? req.query.state.toUpperCase()
      : null;

  const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20;
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.floor(limitRaw), 1), 50)
    : 20;

  const tokens = nameRaw.split(/\s+/);
  const params = new URLSearchParams({ version: NPPES_VERSION, limit: String(limit) });
  if (tokens.length >= 2) {
    params.set('first_name', tokens[0]);
    params.set('last_name', tokens.slice(1).join(' '));
    params.set('use_first_name_alias', 'true');
  } else {
    // Single token — try last_name first, which matches most agent searches.
    params.set('last_name', tokens[0]);
  }
  // NPPES also supports organization_name; surface both shapes so a
  // search like "Duke Cardiology" returns organization hits too.
  // Note: NPPES doesn't support OR across first_name / organization_name
  // in one call, so we only include organization_name when the input
  // looks like a single token (likely org rather than first+last).
  if (tokens.length === 1) params.set('organization_name', tokens[0]);
  if (state) params.set('state', state);

  // Wildcards are documented for name-style params — agent-typed partial
  // names should still find results. Only append when the token is long
  // enough to be discriminating.
  if (tokens.length === 1 && tokens[0].length >= 3) {
    params.set('last_name', tokens[0] + '*');
  }

  const url = `${NPPES_URL}?${params.toString()}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const upstream = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await upstream.text();

    if (!upstream.ok) {
      return sendJson(res, 502, {
        error: `NPPES ${upstream.status}`,
        status: upstream.status,
        detail: text.slice(0, 400),
      });
    }

    // Short cache so rapid re-types don't hammer NPPES but fresh enough
    // that a correction ("Smith" → "Smyth") reflects immediately.
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(text);
    return;
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      return sendJson(res, 504, {
        error: 'NPPES upstream timed out',
        detail: `Exceeded ${DEFAULT_TIMEOUT_MS} ms — try again or narrow the search.`,
      });
    }
    return serverError(res, err);
  } finally {
    clearTimeout(timeout);
  }
}
