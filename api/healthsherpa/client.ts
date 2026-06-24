// HealthSherpa Medicare Partner API client.
//
// Shared module used by /api/healthsherpa/{sync,update,search} routes.
// All upstream calls go through here so endpoint paths, headers, and
// response-shape parsing live in one place.
//
// Endpoints (v1):
//   POST /v1/contacts                  — create
//   PATCH /v1/contacts/:id             — update (only fields included
//                                         in body get changed)
//   POST /v1/contacts/search           — search (body wraps params)
//
// Auth: X-API-Key header from env. v1 also requires agent_email in
// every request body (per docs).

const BASE_URL = 'https://api.medicare.healthsherpa.com/v1';
const AGENT_EMAIL = 'robert@generationhealth.me';

// ─── Types ───────────────────────────────────────────────────────

export interface HSContactInput {
  external_id?: string;
  first_name?: string;
  last_name?: string;
  birth_date?: string;
  phone?: string;
  email?: string;
  sex?: string;
  zip?: string;
  state?: string;
  city?: string;
  address_1?: string;
  medicare_number?: string;
  medicare_part_a_effective_date?: string;
  medicare_part_b_effective_date?: string;
  extra_help?: boolean;
  medicaid_eligible?: boolean;
  type?: 'client' | 'lead' | string;
  notes?: string[];
}

export interface HSContact extends HSContactInput {
  /** HealthSherpa system id — path identifier for PATCH/DELETE. */
  id?: string;
  slug?: string;
}

export interface HSResult {
  contact: HSContact;
  redirect_url: string;
}

export interface HSSearchParams {
  /** Search by MBI alone, OR first_name/last_name + one of dob/email/phone. */
  medicare_number?: string;
  first_name?: string;
  last_name?: string;
  /** Docs use `date_of_birth` for search params (vs. `birth_date` on the
   *  contact object itself). The client accepts either input key and
   *  re-keys to `date_of_birth` on the wire. */
  date_of_birth?: string;
  birth_date?: string;
  email?: string;
  phone?: string;
}

export class HealthSherpaError extends Error {
  status: number;
  upstream: unknown;
  constructor(message: string, status: number, upstream: unknown) {
    super(message);
    this.name = 'HealthSherpaError';
    this.status = status;
    this.upstream = upstream;
  }
}

// ─── Internals ───────────────────────────────────────────────────

function getApiKey(): string {
  const k = process.env.HEALTHSHERPA_MEDICARE_API_KEY;
  if (!k) {
    throw new HealthSherpaError(
      'HEALTHSHERPA_MEDICARE_API_KEY not configured',
      500,
      null,
    );
  }
  return k;
}

async function hsFetch(
  path: string,
  init: {
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    body?: unknown;
  },
): Promise<{ status: number; json: unknown; text: string }> {
  const apiKey = getApiKey();
  const url = `${BASE_URL}${path}`;
  console.log(`[healthsherpa-client] ${init.method} ${path}`);
  const upstream = await fetch(url, {
    method: init.method,
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: init.body == null ? undefined : JSON.stringify(init.body),
  });
  const text = await upstream.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON response — leave json as null and surface text in errors.
    }
  }
  console.log(
    `[healthsherpa-client] ${init.method} ${path} → ${upstream.status} (${text.length}b)`,
  );
  return { status: upstream.status, json, text };
}

function parseResult(json: unknown): HSResult | null {
  if (!json || typeof json !== 'object') return null;
  const wrapped = (json as { data?: unknown }).data;
  const root = wrapped && typeof wrapped === 'object' ? wrapped : json;
  const r = root as { contact?: HSContact; redirect_url?: string };
  if (!r.contact || !r.redirect_url) return null;
  return { contact: r.contact, redirect_url: r.redirect_url };
}

// ─── Public API ──────────────────────────────────────────────────

/** Create a new contact. POST /v1/contacts.
 *  Throws HealthSherpaError on non-2xx (validation failures included). */
export async function createContact(contact: HSContactInput): Promise<HSResult> {
  const { status, json, text } = await hsFetch('/contacts', {
    method: 'POST',
    body: { agent_email: AGENT_EMAIL, contact },
  });
  if (status < 200 || status >= 300) {
    throw new HealthSherpaError(
      `createContact ${status}`,
      status,
      json ?? text.slice(0, 500) ?? null,
    );
  }
  const result = parseResult(json);
  if (!result) {
    throw new HealthSherpaError(
      'createContact response missing contact/redirect_url',
      500,
      json,
    );
  }
  console.log(
    `[healthsherpa-client] created contact id=${result.contact.id ?? '?'}`,
  );
  return result;
}

/** Update an existing contact by HealthSherpa id. PATCH /v1/contacts/:id.
 *  Only the fields you pass get changed. A 204 No Content response
 *  (HealthSherpa returns this when the patch is a no-op) is treated as
 *  success — we re-fetch the redirect_url with an empty PATCH if the
 *  body was empty, but in practice the caller always sends at least
 *  one field, so a 204 means "no changes needed; refetch on next sync."
 *  In the 204 path we return the contact id we already know and an
 *  empty redirect_url string so the caller can decide what to do.
 *  Throws on non-2xx. */
export async function updateContact(
  contactId: string,
  contact: Partial<HSContactInput>,
): Promise<HSResult> {
  if (!contactId) {
    throw new HealthSherpaError('updateContact missing contactId', 400, null);
  }
  const { status, json, text } = await hsFetch(
    `/contacts/${encodeURIComponent(contactId)}`,
    {
      method: 'PATCH',
      body: { agent_email: AGENT_EMAIL, contact },
    },
  );
  if (status < 200 || status >= 300) {
    throw new HealthSherpaError(
      `updateContact ${status}`,
      status,
      json ?? text.slice(0, 500) ?? null,
    );
  }
  if (status === 204) {
    // No changes to apply. Hand back a synthetic result so the caller
    // doesn't need to special-case the no-op path.
    console.log(`[healthsherpa-client] update no-op id=${contactId} (204)`);
    return {
      contact: { id: contactId, ...contact },
      redirect_url: '',
    };
  }
  const result = parseResult(json);
  if (!result) {
    throw new HealthSherpaError(
      'updateContact response missing contact/redirect_url',
      500,
      json,
    );
  }
  console.log(
    `[healthsherpa-client] updated contact id=${result.contact.id ?? contactId}`,
  );
  return result;
}

/** Search for an existing contact. POST /v1/contacts/search.
 *  Returns null when HealthSherpa reports no match (404 / 422 with
 *  resource_not_found). Throws on other errors (auth failures, server
 *  errors, validation rejections from bad search params). */
/** Search requires DOB in strict ISO YYYY-MM-DD format — the contact's
 *  stored value is normalized to ISO and HealthSherpa string-compares.
 *  Create accepts MM/DD/YYYY happily, so this only matters here.
 *  Returns the input unchanged when it's already ISO or unparseable
 *  (let HealthSherpa surface the validation error in that case). */
function toIsoDob(raw: string): string {
  // Already ISO (YYYY-MM-DD or YYYY/MM/DD).
  const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) {
    const [, y, m, d] = iso;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // US format MM/DD/YYYY or MM-DD-YYYY.
  const us = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (us) {
    const [, m, d, y] = us;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return raw;
}

export async function searchContact(
  params: HSSearchParams,
): Promise<HSResult | null> {
  const rawDob = params.date_of_birth ?? params.birth_date;
  const dob = rawDob ? toIsoDob(rawDob) : undefined;
  const wireParams: Record<string, string> = {};
  if (params.medicare_number) wireParams.medicare_number = params.medicare_number;
  if (params.first_name) wireParams.first_name = params.first_name;
  if (params.last_name) wireParams.last_name = params.last_name;
  // Public docs say `date_of_birth`, but the live API rejects that key
  // with "birth_date, email, or phone is required". Send birth_date.
  if (dob) wireParams.birth_date = dob;
  if (params.email) wireParams.email = params.email;
  if (params.phone) wireParams.phone = params.phone;

  if (Object.keys(wireParams).length === 0) {
    throw new HealthSherpaError(
      'searchContact requires at least one parameter',
      400,
      null,
    );
  }

  const { status, json, text } = await hsFetch('/contacts/search', {
    method: 'POST',
    body: { agent_email: AGENT_EMAIL, params: wireParams },
  });

  if (status === 404) {
    console.log('[healthsherpa-client] search no match (404)');
    return null;
  }
  if (status === 422) {
    // 422 can mean either "invalid search params" (genuine error) or
    // "no contact found" (resource_not_found code). Distinguish by the
    // error.code field.
    const code =
      (json as { error?: { code?: string } } | null)?.error?.code ?? null;
    if (code === 'resource_not_found' || code === 'not_found') {
      console.log('[healthsherpa-client] search no match (422 resource_not_found)');
      return null;
    }
    throw new HealthSherpaError(
      `searchContact invalid params (${code ?? '422'})`,
      422,
      json ?? text.slice(0, 500),
    );
  }
  if (status < 200 || status >= 300) {
    throw new HealthSherpaError(
      `searchContact ${status}`,
      status,
      json ?? text.slice(0, 500) ?? null,
    );
  }
  const result = parseResult(json);
  if (!result) {
    // 2xx but no contact in body — treat as no match.
    console.log('[healthsherpa-client] search 2xx but no contact in body');
    return null;
  }
  console.log(
    `[healthsherpa-client] search hit id=${result.contact.id ?? '?'}`,
  );
  return result;
}
