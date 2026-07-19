// POST /api/healthsherpa/sync
//
// Two independent effects:
//
//   (1) Consumer intake URL (ALWAYS returned):
//       medicare.healthsherpa.com/intake/robert-simm?first_name=&...
//       Public page — no broker login required, so brokers can hand this
//       URL to a client (or open it themselves) without landing on
//       /sessions/new when their HealthSherpa session is expired.
//
//   (2) Partner API contact sync (best-effort side-effect):
//       Creates or updates the contact in Rob's HealthSherpa CRM so it
//       shows up in his agent dashboard with external_id linkage back to
//       AgentBase. This uses the search-first dedup path (MBI or
//       name+dob). Failure here does NOT block (1) — the intake URL is
//       independent of the Partner API and always works.
//
// Why not use the Partner API's returned `redirect_url`? Because that
// URL is `/agents/robert-simm/plans/{contact_hash}` — an agent-facing
// plan browser that requires broker login. When the broker's session
// has expired (common), HealthSherpa bounces to /sessions/new, which
// looks like a broken button from planmatch. The v1/v2 API does not
// expose a consumer-facing redirect option (verified in docs).

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson } from '../_lib/http.js';
import {
  createContact,
  HealthSherpaError,
  searchContact,
  updateContact,
  type HSContactInput,
} from './client.js';

const HEALTHSHERPA_INTAKE_BASE = 'https://medicare.healthsherpa.com/intake/robert-simm';

// Build Rob's public consumer intake URL with every pre-fill query param
// we have. HealthSherpa's intake page reads a subset — unknown params
// are ignored, so best-effort inclusion is safe. Empty/undefined values
// are dropped so the URL stays tidy.
function buildConsumerIntakeUrl(params: Record<string, string | undefined | null>): string {
  const url = new URL(HEALTHSHERPA_INTAKE_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    const trimmed = String(v).trim();
    if (!trimmed) continue;
    url.searchParams.set(k, trimmed);
  }
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

  // Consumer intake URL — always returned regardless of Partner API
  // outcome. This is the URL the caller opens; it works whether or not
  // the broker is logged into HealthSherpa.
  const redirect_url = buildConsumerIntakeUrl({
    first_name: firstName || undefined,
    last_name: lastName || undefined,
    birth_date: contact.birth_date,
    phone: contact.phone,
    email: contact.email,
    zip_code: contact.zip,
    state: contact.state,
    county: body.county,
    city: contact.city,
    sex: contact.sex,
    medicare_number: contact.medicare_number,
    cms_plan_id: body.cms_plan_id,
    external_id: externalId,
  });

  // ── Partner API sync (best-effort side-effect) ──────────────────
  // Search-first dedup: MBI > name+dob > skip. Any failure here logs
  // and continues — the consumer intake URL above is independent and
  // does not require the Partner API to succeed.
  const searchable =
    !!normalizedMbi ||
    (!!firstName && !!lastName && !!body.birth_date);

  let contact_id: string | null = null;
  let matched_existing = false;
  let partner_sync_ok = false;
  let partner_sync_error: string | null = null;

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
        // HealthSherpa will reject the create with a uniqueness error
        // which we'll catch below.
        console.warn(
          '[healthsherpa-sync] search failed, falling through to create:',
          err instanceof HealthSherpaError ? `${err.status} ${err.message}` : err,
        );
      }
    } else {
      console.log('[healthsherpa-sync] not enough fields to search; going straight to create');
    }

    if (existing && existing.contact.id) {
      console.log(
        `[healthsherpa-sync] existing contact found id=${existing.contact.id} → updating`,
      );
      const updated = await updateContact(existing.contact.id, contact);
      contact_id = updated.contact.id ?? existing.contact.id;
      matched_existing = true;
    } else {
      console.log('[healthsherpa-sync] no existing contact → creating');
      const created = await createContact(contact);
      contact_id = created.contact.id ?? null;
    }
    partner_sync_ok = true;
    console.log(
      `[healthsherpa-sync] partner sync ok contact_id=${contact_id ?? 'null'} matched=${matched_existing}`,
    );
  } catch (err) {
    if (err instanceof HealthSherpaError) {
      partner_sync_error = `${err.status}: ${err.message}`;
      console.error(
        `[healthsherpa-sync] partner sync failed ${err.status}: ${err.message}`,
        err.upstream,
      );
    } else {
      partner_sync_error = err instanceof Error ? err.message : 'unknown';
      console.error('[healthsherpa-sync] partner sync threw:', err);
    }
  }

  return sendJson(res, 200, {
    redirect_url,
    contact_id,
    external_id: externalId,
    matched_existing,
    partner_sync_ok,
    partner_sync_error,
  });
}
