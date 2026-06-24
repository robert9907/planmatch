// POST /api/healthsherpa/update
//
// Standalone PATCH on a HealthSherpa contact by id. Lets AgentBase
// (or any other surface) push field changes without going through the
// full /sync search-then-create flow. Useful when the caller already
// holds the HealthSherpa contact id from a previous /sync response.
//
// Body:
//   { contactId: "abc-123",
//     updates: { phone, email, address_1, city, state, zip,
//                medicare_number, ... } }
//
// Response (200): { contact, redirect_url }
// Response (502): { error, upstream } when HealthSherpa rejects the patch.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from '../_lib/http.js';
import {
  HealthSherpaError,
  updateContact,
  type HSContactInput,
} from './client.js';

interface UpdateBody {
  contactId?: string;
  updates?: Partial<HSContactInput>;
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

function clean<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = v;
  }
  return out as T;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  console.log('[healthsherpa-update] route hit');

  const body = (req.body ?? {}) as UpdateBody;
  if (!body.contactId || typeof body.contactId !== 'string') {
    return badRequest(res, 'contactId required');
  }
  if (!body.updates || typeof body.updates !== 'object') {
    return badRequest(res, 'updates required');
  }

  const updates: Partial<HSContactInput> = clean({
    ...body.updates,
    phone: normalizePhone(body.updates.phone),
    medicare_number: normalizeMbi(body.updates.medicare_number),
  }) as Partial<HSContactInput>;

  if (Object.keys(updates).length === 0) {
    return badRequest(res, 'updates must contain at least one non-empty field');
  }

  console.log(
    `[healthsherpa-update] contactId=${body.contactId} fields=${Object.keys(updates).join(',')}`,
  );

  res.setHeader('Cache-Control', 'no-store');

  try {
    const result = await updateContact(body.contactId, updates);
    return sendJson(res, 200, {
      contact: result.contact,
      redirect_url: result.redirect_url,
    });
  } catch (err) {
    if (err instanceof HealthSherpaError) {
      console.error(
        `[healthsherpa-update] partner api ${err.status}: ${err.message}`,
        err.upstream,
      );
      return sendJson(res, 502, {
        error: err.message,
        upstream: err.upstream,
      });
    }
    console.error('[healthsherpa-update] fetch failed:', err);
    return serverError(res, err);
  }
}
