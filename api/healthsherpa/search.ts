// GET /api/healthsherpa/search
//
// Standalone search wrapping HealthSherpa's POST /v1/contacts/search.
// Frontend-facing route uses GET with query params for simplicity; the
// route converts to the POST body the partner API expects.
//
// Query params:
//   ?medicare_number=...                          (MBI alone), OR
//   ?first_name=...&last_name=...&birth_date=...  (name + dob), OR
//   substitute date_of_birth/email/phone for birth_date.
//
// Response:
//   200 { contact, redirect_url }   — match found
//   200 { found: false }            — no match
//   400 { error }                   — bad search params

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cors, sendJson, serverError } from '../_lib/http.js';
import { HealthSherpaError, searchContact } from './client.js';

function firstString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function normalizePhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/\D+/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length === 10) return digits;
  return undefined;
}

function normalizeMbi(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const stripped = raw.replace(/[\s-]+/g, '').toUpperCase();
  return /^[A-Z0-9]{11}$/.test(stripped) ? stripped : undefined;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    return sendJson(res, 405, { error: 'GET or POST required' });
  }

  console.log('[healthsherpa-search] route hit');

  // Accept both GET (query params) and POST (body) so the route works
  // from a fetch() with a body or a plain link.
  const src: Record<string, unknown> =
    req.method === 'POST' && req.body && typeof req.body === 'object'
      ? (req.body as Record<string, unknown>)
      : (req.query as Record<string, unknown>);

  const medicareNumber = normalizeMbi(firstString(src.medicare_number as never));
  const firstName = firstString(src.first_name as never)?.trim() || undefined;
  const lastName = firstString(src.last_name as never)?.trim() || undefined;
  const dob =
    firstString(src.date_of_birth as never) ??
    firstString(src.birth_date as never) ??
    undefined;
  const email = firstString(src.email as never)?.trim() || undefined;
  const phone = normalizePhone(firstString(src.phone as never));

  const params = {
    medicare_number: medicareNumber,
    first_name: firstName,
    last_name: lastName,
    date_of_birth: dob,
    email,
    phone,
  };

  // HealthSherpa rule: MBI alone OR (first_name|last_name) + (dob|email|phone).
  const hasMbi = !!params.medicare_number;
  const hasNameAndSecondary =
    (!!params.first_name || !!params.last_name) &&
    (!!params.date_of_birth || !!params.email || !!params.phone);
  if (!hasMbi && !hasNameAndSecondary) {
    return sendJson(res, 400, {
      error:
        'Provide medicare_number, OR first_name/last_name plus one of date_of_birth/email/phone.',
    });
  }

  res.setHeader('Cache-Control', 'no-store');

  try {
    const result = await searchContact(params);
    if (!result) {
      console.log('[healthsherpa-search] no match');
      return sendJson(res, 200, { found: false });
    }
    return sendJson(res, 200, {
      found: true,
      contact: result.contact,
      redirect_url: result.redirect_url,
    });
  } catch (err) {
    if (err instanceof HealthSherpaError) {
      console.error(
        `[healthsherpa-search] partner api ${err.status}: ${err.message}`,
        err.upstream,
      );
      return sendJson(res, 502, {
        error: err.message,
        upstream: err.upstream,
      });
    }
    console.error('[healthsherpa-search] fetch failed:', err);
    return serverError(res, err);
  }
}
