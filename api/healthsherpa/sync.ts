// POST /api/healthsherpa/sync
//
// Pre-fills a HealthSherpa Medicare intake by POSTing the agent-v3
// session payload to HealthSherpa's Partner API (/v1/contacts) and
// returning the consumer redirect_url the broker should open in a new
// tab. The frontend hook (openHealthSherpaEnrollment) blocks on this
// route — on success it window.open(redirect_url); on failure it falls
// back to the generic intake URL so the broker is never stuck.
//
// Body: a flat subset of useSession.client; the route is intentionally
// loose so unsynced fields (city, address_1, sex, part A/B effective
// dates) can be added later without a frontend change.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from '../_lib/http.js';

const HEALTHSHERPA_CONTACTS_URL = 'https://api.medicare.healthsherpa.com/v1/contacts';
const AGENT_EMAIL = 'robert@generationhealth.me';
const HEALTHSHERPA_INTAKE_BASE = 'https://medicare.healthsherpa.com/intake/robert-simm';

// Local copy of buildMedicareEnrollLink — api/* can't runtime-import
// from src/ (Vercel serverless TS path resolution), per the precedent
// in api/_lib/brand-generics.ts.
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
  /** Single "name" field, when the caller hasn't pre-split. */
  name?: string;
  birth_date?: string;
  phone?: string;
  email?: string;
  sex?: 'male' | 'female' | string;
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
  /** Optional CMS plan id ("H1036-318-000") — surfaces as a note so the
   *  HealthSherpa agent sees which plan the broker recommended. */
  cms_plan_id?: string;
  /** Optional plan label ("BCBSNC Blue Medicare PPO Standard") — same. */
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

// HealthSherpa's /v1/contacts is strict about phone — it rejects any
// formatting ("555-123-4567", "(555) 123-4567" both 400 with
// "must be a valid phone number"). Brokers type phones in any format,
// so we normalize to digits-only here. <10 digits → omit the field
// entirely so a partial phone doesn't tank the whole sync.
function normalizePhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/\D+/g, '');
  // US numbers: 10 digits, or 11 with leading "1". Drop the country
  // code so HealthSherpa sees the bare 10-digit form.
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length === 10) return digits;
  return undefined;
}

// MBI format per CMS: 11 chars, alphanumeric uppercase, position-based
// pattern (positions 2/5/8/9 letters, 1/4/7/10/11 digits, etc.).
// HealthSherpa enforces this and 422s on bad input. We strip dashes/
// spaces first so brokers can type "1AB2-CD3-EF45" verbatim; only send
// if the result is 11 alphanumeric chars. Skip the strict positional
// regex — HealthSherpa does the final check.
function normalizeMbi(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const stripped = raw.replace(/[\s-]+/g, '').toUpperCase();
  return /^[A-Z0-9]{11}$/.test(stripped) ? stripped : undefined;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  console.log('[healthsherpa-sync] route hit');

  const apiKey = process.env.HEALTHSHERPA_MEDICARE_API_KEY;
  if (!apiKey) {
    console.error('[healthsherpa-sync] missing HEALTHSHERPA_MEDICARE_API_KEY env var');
    return sendJson(res, 500, {
      error: 'HEALTHSHERPA_MEDICARE_API_KEY not configured',
      fallback_url: HEALTHSHERPA_INTAKE_BASE,
    });
  }

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
    ...(Array.isArray(body.notes) ? body.notes.filter((n) => typeof n === 'string' && n.trim()) : []),
  ];

  const contact = clean({
    external_id: externalId,
    first_name: firstName || undefined,
    last_name: lastName || undefined,
    birth_date: body.birth_date,
    phone: normalizePhone(body.phone),
    email: body.email,
    sex: body.sex,
    zip: body.zip,
    state: body.state,
    city: body.city,
    address_1: body.address_1,
    medicare_number: normalizeMbi(body.medicare_number),
    medicare_part_a_effective_date: body.medicare_part_a_effective_date,
    medicare_part_b_effective_date: body.medicare_part_b_effective_date,
    extra_help: typeof body.extra_help === 'boolean' ? body.extra_help : undefined,
    medicaid_eligible: typeof body.medicaid_eligible === 'boolean' ? body.medicaid_eligible : undefined,
    type: 'client',
    notes,
  });

  console.log(
    `[healthsherpa-sync] outbound contact: external_id=${externalId} first=${firstName ? 'y' : 'n'} last=${lastName ? 'y' : 'n'} dob=${contact.birth_date ? 'y' : 'n'} phone=${contact.phone ? 'y' : 'n'} email=${contact.email ? 'y' : 'n'} zip=${contact.zip ?? '?'} state=${contact.state ?? '?'} mbi=${contact.medicare_number ? 'y' : 'n'} plan=${body.cms_plan_id ?? '?'}`,
  );

  res.setHeader('Cache-Control', 'no-store');

  // Fallback URL we hand back on any non-2xx so the frontend always has
  // a usable enrollment link — county/zip preload into the generic
  // intake form even when the Partner API rejects the contact.
  const fallback_url = buildIntakeFallbackUrl({
    cms_plan_id: body.cms_plan_id,
    county: body.county,
    zip_code: body.zip,
  });

  try {
    const upstream = await fetch(HEALTHSHERPA_CONTACTS_URL, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_email: AGENT_EMAIL,
        contact,
      }),
    });

    const text = await upstream.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // upstream returned non-JSON — surface raw text in the error.
    }

    console.log(
      `[healthsherpa-sync] upstream responded status=${upstream.status} body_len=${text.length}`,
    );

    if (!upstream.ok) {
      console.error(
        `[healthsherpa-sync] upstream ${upstream.status}: ${text.slice(0, 500)}`,
      );
      return sendJson(res, 502, {
        error: `HealthSherpa API ${upstream.status}`,
        upstream:
          json && typeof json === 'object'
            ? json
            : text.slice(0, 500) || null,
        fallback_url,
      });
    }

    const data = (json ?? {}) as {
      data?: { redirect_url?: string; contact?: { id?: string | number } };
      redirect_url?: string;
      contact?: { id?: string | number };
    };
    // HealthSherpa's response shape historically wraps under data.*; we
    // also accept top-level keys in case the contract is flatter.
    const redirect_url =
      data.data?.redirect_url ?? data.redirect_url ?? fallback_url;
    const contact_id =
      data.data?.contact?.id ?? data.contact?.id ?? null;
    const usedFallback = redirect_url === fallback_url;

    console.log(
      `[healthsherpa-sync] redirect_url=${usedFallback ? 'FALLBACK' : 'partner-api'} contact_id=${contact_id ?? 'null'}`,
    );

    return sendJson(res, 200, {
      redirect_url,
      contact_id,
      external_id: externalId,
    });
  } catch (err) {
    console.error('[healthsherpa-sync] fetch failed:', err);
    // Network blip: still return a usable URL so the broker isn't stuck.
    return serverError(res, {
      message: err instanceof Error ? err.message : 'HealthSherpa sync failed',
      fallback_url,
    });
  }
}
