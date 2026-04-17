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

// Note: NPI Registry has CORS enabled for GETs. If browser CORS ever blocks,
// swap this for a /api/npi-search proxy.
const BASE_URL = 'https://npiregistry.cms.hhs.gov/api';

export async function searchProvider(
  input: { name: string; state?: string },
  signal?: AbortSignal,
): Promise<NpiProvider[]> {
  const raw = input.name.trim();
  if (raw.length < 2) return [];

  const tokens = raw.split(/\s+/);
  const params = new URLSearchParams({ version: '2.1', limit: '20' });

  if (tokens.length >= 2) {
    params.set('first_name', tokens[0]);
    params.set('last_name', tokens.slice(1).join(' '));
  } else {
    params.set('last_name', tokens[0]);
  }
  if (input.state) params.set('state', input.state);

  const url = `${BASE_URL}/?${params.toString()}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`NPI ${res.status}`);
  const body = await res.json();

  const results: unknown[] = body?.results ?? [];
  return results.map(normalize).filter((r): r is NpiProvider => !!r);
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
