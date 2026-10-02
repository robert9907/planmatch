// Snap Link prescribers → provider directory entries.
//
// Every pill-bottle label names the prescriber ("DR. ROBIN ARLENE",
// "Edwards F.N.P."). We add each one to the client's Linked Providers.
// To be useful to Plan Match's network check the provider needs an NPI,
// so we look the name up in the CMS NPPES registry — and only accept the
// answer when exactly ONE individual in the client's state matches.
// Anything less certain (a last name only, several matches) is added by
// name alone, without an NPI, for the broker to finish with Find & Assign.

const NPPES = 'https://npiregistry.cms.hhs.gov/api/';
const TIMEOUT_MS = 4000;

const CREDENTIALS = new Set([
  'MD', 'DO', 'NP', 'FNP', 'FNPC', 'FNPBC', 'APRN', 'ANP', 'AGNP', 'DNP', 'PA', 'PAC',
  'RN', 'CNP', 'PHD', 'PHARMD', 'DPM', 'DDS', 'DMD', 'OD', 'MBBS', 'CRNP', 'PMHNP', 'NPC',
]);

export interface PrescriberName {
  /** Cleaned display name as printed (no "Dr.", credentials kept separately). */
  display: string;
  first: string | null;
  last: string | null;
  credential: string | null;
}

export function parsePrescriber(raw: string | null | undefined): PrescriberName | null {
  let s = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  s = s.replace(/^(dr\.?|doctor)\s+/i, '');
  let first: string | null = null;
  let last: string | null = null;
  let credential: string | null = null;

  // Split off credentials wherever they sit ("Edwards F.N.P.", "Arlene, MD").
  const parts = s.split(/[\s,]+/).filter(Boolean);
  const nameParts: string[] = [];
  for (const p of parts) {
    const key = p.replace(/[.\-]/g, '').toUpperCase();
    if (CREDENTIALS.has(key)) credential = credential ?? p.replace(/[,]+$/, '');
    else nameParts.push(p.replace(/[.,]+$/, ''));
  }
  if (nameParts.length === 0) return null;

  // "LAST, FIRST" — a comma right after the first word.
  if (/^[^,\s]+\s*,/.test(s) && nameParts.length >= 2) {
    last = nameParts[0];
    first = nameParts[1];
  } else if (nameParts.length >= 2) {
    first = nameParts[0];
    last = nameParts[nameParts.length - 1];
  } else {
    last = nameParts[0];
  }
  const tc = (w: string | null) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w);
  first = tc(first);
  last = tc(last);
  const display = [first, last].filter(Boolean).join(' ') + (credential ? `, ${credential}` : '');
  return { display, first, last, credential };
}

export interface ResolvedPrescriber {
  name: string;
  npi: string | null;
  specialty: string | null;
  phone: string | null;
  address: string | null;
}

interface NppesResult {
  number: string;
  basic?: { first_name?: string; last_name?: string; credential?: string };
  taxonomies?: { desc?: string; primary?: boolean }[];
  addresses?: {
    address_purpose?: string;
    address_1?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    telephone_number?: string;
  }[];
}

async function nppes(first: string, last: string, state: string | null): Promise<NppesResult[] | null> {
  const params = new URLSearchParams({
    version: '2.1',
    enumeration_type: 'NPI-1',
    first_name: first,
    last_name: last,
    use_first_name_alias: 'false',
    limit: '5',
  });
  if (state) params.set('state', state);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${NPPES}?${params.toString()}`, { signal: ctl.signal });
    if (!r.ok) return null;
    const body = (await r.json()) as { results?: NppesResult[] };
    return Array.isArray(body.results) ? body.results : [];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function toResolved(r: NppesResult): ResolvedPrescriber {
  const tc = (w?: string) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : '');
  const cred = (r.basic?.credential ?? '').replace(/\./g, '').trim();
  const name = `${tc(r.basic?.first_name)} ${tc(r.basic?.last_name)}`.trim() + (cred ? `, ${cred}` : '');
  const tax = r.taxonomies?.find((t) => t.primary) ?? r.taxonomies?.[0];
  const loc = r.addresses?.find((a) => a.address_purpose === 'LOCATION') ?? r.addresses?.[0];
  const zip = loc?.postal_code ? loc.postal_code.slice(0, 5) : '';
  const address = loc ? [loc.address_1, loc.city, [loc.state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') : null;
  return {
    name,
    npi: r.number ?? null,
    specialty: tax?.desc ?? null,
    phone: loc?.telephone_number ?? null,
    address: address || null,
  };
}

/** One NPPES match in the client's state → full record; otherwise name only. */
export async function resolvePrescriber(
  raw: string | null | undefined,
  clientState: string | null,
): Promise<ResolvedPrescriber | null> {
  const p = parsePrescriber(raw);
  if (!p) return null;
  const nameOnly: ResolvedPrescriber = { name: p.display, npi: null, specialty: null, phone: null, address: null };
  const state = (clientState ?? '').trim().toUpperCase().slice(0, 2) || null;
  if (!p.first || !p.last || !state) return nameOnly;

  // Labels print both "First Last" and "Last First" — try both orders and
  // accept only when exactly one person matches across them.
  const [a, b] = await Promise.all([nppes(p.first, p.last, state), nppes(p.last, p.first, state)]);
  if (a === null || b === null) return nameOnly;
  const byNpi = new Map<string, NppesResult>();
  for (const r of [...a, ...b]) if (r?.number) byNpi.set(r.number, r);
  if (byNpi.size !== 1) return nameOnly;
  return toResolved([...byNpi.values()][0]);
}
