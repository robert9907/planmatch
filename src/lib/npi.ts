export interface NpiProvider {
  npi: string;
  name: string;
  credential: string | null;
  specialty: string | null;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string | null;
}

export interface ProviderSearchResult {
  providers: NpiProvider[];
  fallback: 'last_name_only' | null;
}

// The browser talks to our own Vercel function, which proxies NPPES
// server-side. NPPES itself doesn't send Access-Control-Allow-Origin
// on its responses — a direct browser fetch fails with an opaque
// "TypeError: Failed to fetch" before we can read any status or body.
// The /api/npi-search proxy returns either a NPPES-shaped body or a
// structured { error, status?, detail? } JSON error we can surface.
const PROXY_URL = '/api/npi-search';

interface ProxyError {
  error: string;
  status?: number;
  detail?: string;
}

export async function searchProvider(
  input: { name: string; state?: string },
  signal?: AbortSignal,
): Promise<ProviderSearchResult> {
  const raw = input.name.trim();
  if (raw.length < 2) return { providers: [], fallback: null };

  const params = new URLSearchParams({ name: raw, limit: '20' });
  if (input.state) params.set('state', input.state);

  let res: Response;
  try {
    res = await fetch(`${PROXY_URL}?${params.toString()}`, {
      method: 'GET',
      signal,
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    // Network-level failure (offline, DNS, proxy down) — bubble a
    // useful message instead of the stock "Failed to fetch".
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`NPI proxy unreachable — ${reason}`);
  }

  const text = await res.text();
  if (!res.ok) {
    let parsed: ProxyError | null = null;
    try {
      parsed = JSON.parse(text) as ProxyError;
    } catch {
      /* non-JSON body */
    }
    const pieces = [`NPI ${res.status}`];
    if (parsed?.error) pieces.push(parsed.error);
    if (parsed?.detail) pieces.push(parsed.detail);
    if (!parsed) pieces.push(text.slice(0, 200));
    throw new Error(pieces.join(' — '));
  }

  let body: { results?: unknown[]; fallback?: string };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('NPI proxy returned non-JSON response.');
  }

  const results: unknown[] = Array.isArray(body?.results) ? body.results! : [];
  const providers = results.map(normalize).filter((r): r is NpiProvider => !!r);
  const fallback = body?.fallback === 'last_name_only' ? 'last_name_only' : null;
  return { providers, fallback };
}

function normalize(raw: unknown): NpiProvider | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const npi = String(r.number ?? '').trim();
  if (!npi) return null;

  const basic = (r.basic ?? {}) as Record<string, unknown>;
  const first = String(basic.first_name ?? '').trim();
  const last = String(basic.last_name ?? '').trim();
  const org = String(basic.organization_name ?? '').trim();
  const name = org || [first, last].filter(Boolean).join(' ') || 'Unknown provider';
  const credential = basic.credential ? String(basic.credential) : null;

  const addrs = Array.isArray(r.addresses) ? (r.addresses as Record<string, unknown>[]) : [];
  const location = addrs.find((a) => a.address_purpose === 'LOCATION') ?? addrs[0] ?? {};
  const street = String(location.address_1 ?? '').trim();
  const city = String(location.city ?? '').trim();
  const state = String(location.state ?? '').trim();
  const zip = String(location.postal_code ?? '').slice(0, 5);
  const phone = location.telephone_number ? String(location.telephone_number) : null;

  const taxonomies = Array.isArray(r.taxonomies) ? (r.taxonomies as Record<string, unknown>[]) : [];
  const primaryTax = taxonomies.find((t) => t.primary) ?? taxonomies[0];
  const specialty = primaryTax?.desc ? String(primaryTax.desc) : null;

  return {
    npi,
    name,
    credential,
    specialty,
    address: street,
    city,
    state,
    zip,
    phone,
  };
}
