// POST /api/healthsherpa/sync
//
// Pre-fills a HealthSherpa Medicare intake from the agent-v3 session.
// Search-first dedup:
//   1. If the payload carries an MBI, search by medicare_number.
//   2. Else if first+last+dob are present, search by name+dob.
//   3. If a match exists, PATCH that contact with any new fields and
//      return its redirect_url.
//   4. Otherwise create a new contact.
//   5. On any upstream error, return a county/zip-preloaded fallback
//      URL so the broker is never stranded.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from '../_lib/http.js';
import {
  createContact,
  HealthSherpaError,
  searchContact,
  updateContact,
  type HSContactInput,
} from './client.js';

const HEALTHSHERPA_INTAKE_BASE = 'https://medicare.healthsherpa.com/intake/robert-simm';

function buildIntakeFallbackUrl(params: {
  cms_plan_id?: string;
  county?: string;
  zip_code?: string;
}): string {
  const url = new URL(HEALTHSHERPA_INTAKE_BASE);
  if (params.cms_plan_id) url.searchParams.set('cms_plan_id', params.cms_plan_id);
  if (params.county) url.searchParams.set('county', params.county);
  if (params.zip_code) url.searchParams.set('zip_code', params.zip_code);
  return url.toString();
}

interface SyncBody {
  external_id?: string | number;
  first_name?: string;
  last_name?: string;
  name?: string;
  birth_date?: string;
  phone?: string;
  email?: string;
  sex?: string;
  zip?: string;
  state?: string;
  city?: string;
  address_1?: string;
  county?: string;
  medicare_number?: string;
  medicare_part_a_effective_date?: string;
  medicare_part_b_effective_date?: string;
  extra_help?: boolean;
  medicaid_eligible?: boolean;
  cms_plan_id?: string;
  plan_label?: string;
  notes?: string[];
}

function splitName(full: string | undefined): { first?: string; last?: string } {
  if (!full) return {};
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { first: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(' ') };
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

// Strip non-digits; drop leading "1" country code; require 10 digits.
// HealthSherpa 400s on any formatted phone — see commit 8ea2dbd.
function normalizePhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/\D+/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length === 10) return digits;
  return undefined;
}

// MBI: 11 alphanumeric chars uppercase. HealthSherpa 422s on malformed
// MBIs — drop bad ones rather than tank the whole sync.
function normalizeMbi(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const stripped = raw.replace(/[\s-]+/g, '').toUpperCase();
  return /^[A-Z0-9]{11}$/.test(stripped) ? stripped : undefined;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  console.log('[healthsherpa-sync] route hit');

  const body = (req.body ?? {}) as SyncBody;
  const split = splitName(body.name);
  const firstName = (body.first_name ?? split.first ?? '').trim();
  const lastName = (body.last_name ?? split.last ?? '').trim();
  const externalId =
    body.external_id != null && String(body.external_id).trim() !== ''
      ? String(body.external_id)
      : `pm-${Date.now()}`;

  const planNote =
    body.cms_plan_id || body.plan_label
      ? `Recommended plan: ${[body.plan_label, body.cms_plan_id].filter(Boolean).join(' · ')}`
      : null;
  const notes = [
    'Synced from Plan Match agent-v3',
    ...(planNote ? [planNote] : []),
    ...(Array.isArray(body.notes)
      ? body.notes.filter((n) => typeof n === 'string' && n.trim())
      : []),
  ];

  const normalizedPhone = normalizePhone(body.phone);
  const normalizedMbi = normalizeMbi(body.medicare_number);

  const contact: HSContactInput = clean({
    external_id: externalId,
    first_name: firstName || undefined,
    last_name: lastName || undefined,
    birth_date: body.birth_date,
    phone: normalizedPhone,
    email: body.email,
    sex: body.sex,
    zip: body.zip,
    state: body.state,
    city: body.city,
    address_1: body.address_1,
    medicare_number: normalizedMbi,
    medicare_part_a_effective_date: body.medicare_part_a_effective_date,
    medicare_part_b_effective_date: body.medicare_part_b_effective_date,
    extra_help: typeof body.extra_help === 'boolean' ? body.extra_help : undefined,
    medicaid_eligible:
      typeof body.medicaid_eligible === 'boolean' ? body.medicaid_eligible : undefined,
    type: 'client',
    notes,
  }) as HSContactInput;

  console.log(
    `[healthsherpa-sync] outbound contact: external_id=${externalId} first=${firstName ? 'y' : 'n'} last=${lastName ? 'y' : 'n'} dob=${contact.birth_date ? 'y' : 'n'} phone=${contact.phone ? 'y' : 'n'} email=${contact.email ? 'y' : 'n'} zip=${contact.zip ?? '?'} state=${contact.state ?? '?'} mbi=${contact.medicare_number ? 'y' : 'n'} plan=${body.cms_plan_id ?? '?'}`,
  );

  res.setHeader('Cache-Control', 'no-store');

  const fallback_url = buildIntakeFallbackUrl({
    cms_plan_id: body.cms_plan_id,
    county: body.county,
    zip_code: body.zip,
  });

  // ── Search-first dedup ──────────────────────────────────────────
  // Order: MBI > name+dob > skip. Email/phone alone aren't enough
  // per HealthSherpa search rules.
  const searchable =
    !!normalizedMbi ||
    (!!firstName && !!lastName && !!body.birth_date);

  try {
    let existing = null;
    if (searchable) {
      try {
        if (normalizedMbi) {
          existing = await searchContact({ medicare_number: normalizedMbi });
        } else {
          existing = await searchContact({
            first_name: firstName,
            last_name: lastName,
            date_of_birth: body.birth_date,
          });
        }
      } catch (err) {
        // Search failure shouldn't block the create path. Log and
        // fall through to create — if the contact already exists,
        // HealthSherpa will reject the create with a uniqueness
        // error and we'll surface that to the broker.
        console.warn(
          '[healthsherpa-sync] search failed, falling through to create:',
          err instanceof HealthSherpaError ? `${err.status} ${err.message}` : err,
        );
      }
    } else {
      console.log('[healthsherpa-sync] not enough fields to search; going straight to create');
    }

    let result: { contact: { id?: string }; redirect_url: string };

    if (existing && existing.contact.id) {
      console.log(
        `[healthsherpa-sync] existing contact found id=${existing.contact.id} → updating`,
      );
      const updated = await updateContact(existing.contact.id, contact);
      // 204 No Content path returns an empty redirect_url — fall back
      // to the redirect_url from the search hit, which is still valid.
      result = {
        contact: updated.contact,
        redirect_url: updated.redirect_url || existing.redirect_url,
      };
    } else {
      console.log('[healthsherpa-sync] no existing contact → creating');
      result = await createContact(contact);
    }

    const redirect_url = result.redirect_url || fallback_url;
    const contact_id = result.contact.id ?? null;
    const usedFallback = redirect_url === fallback_url;

    console.log(
      `[healthsherpa-sync] redirect_url=${usedFallback ? 'FALLBACK' : 'partner-api'} contact_id=${contact_id ?? 'null'}`,
    );

    return sendJson(res, 200, {
      redirect_url,
      contact_id,
      external_id: externalId,
      matched_existing: !!existing,
    });
  } catch (err) {
    if (err instanceof HealthSherpaError) {
      console.error(
        `[healthsherpa-sync] partner api ${err.status}: ${err.message}`,
        err.upstream,
      );
      return sendJson(res, 502, {
        error: err.message,
        upstream: err.upstream,
        fallback_url,
      });
    }
    console.error('[healthsherpa-sync] fetch failed:', err);
    return serverError(res, {
      message: err instanceof Error ? err.message : 'HealthSherpa sync failed',
      fallback_url,
    });
  }
}
