export interface RxNormDrug {
  rxcui: string;
  name: string;
  synonym?: string;
  tty?: string;
  /** Parsed brand/strength/form fields from the server response. Used
   *  for the agent search row display: "Brand · strength · form" when
   *  brand_name is present, "generic · strength · form" otherwise. */
  brand_name?: string;
  generic_name?: string;
  strength?: string;
  dose_form?: string;
  is_brand?: boolean;
}

// Talks to our /api/rxnorm-search proxy. The proxy fans out to two
// rxnav endpoints — approximateTerm.json (fuzzy/prefix) and drugs.json
// (exact-name) — and merges the results. Hitting /drugs.json directly
// (as this module used to) silently returned nothing on any partial
// input because that endpoint is exact-name only.
const PROXY_URL = '/api/rxnorm-search';

interface ProxyError {
  error: string;
  status?: number;
  detail?: string;
}

export async function searchDrug(query: string, signal?: AbortSignal): Promise<RxNormDrug[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  let res: Response;
  try {
    res = await fetch(`${PROXY_URL}?q=${encodeURIComponent(q)}`, {
      method: 'GET',
      signal,
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`RxNorm proxy unreachable — ${reason}`);
  }

  const text = await res.text();
  if (!res.ok) {
    let parsed: ProxyError | null = null;
    try {
      parsed = JSON.parse(text) as ProxyError;
    } catch {
      /* non-JSON */
    }
    const pieces = [`RxNorm ${res.status}`];
    if (parsed?.error) pieces.push(parsed.error);
    if (parsed?.detail) pieces.push(parsed.detail);
    if (!parsed) pieces.push(text.slice(0, 200));
    throw new Error(pieces.join(' — '));
  }

  let body: { drugs?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('RxNorm proxy returned non-JSON.');
  }
  const raw: unknown[] = Array.isArray(body?.drugs) ? (body.drugs as unknown[]) : [];
  return raw.map(normalize).filter((d): d is RxNormDrug => !!d);
}

function normalize(raw: unknown): RxNormDrug | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const rxcui = typeof r.rxcui === 'string' ? r.rxcui : String(r.rxcui ?? '');
  const name = typeof r.name === 'string' ? r.name : '';
  if (!rxcui || !name) return null;
  const str = (k: string): string | undefined => (typeof r[k] === 'string' ? (r[k] as string) : undefined);
  return {
    rxcui,
    name,
    synonym: str('synonym'),
    tty: str('tty'),
    brand_name: str('brand_name'),
    generic_name: str('generic_name'),
    strength: str('strength'),
    dose_form: str('dose_form'),
    is_brand: typeof r.is_brand === 'boolean' ? r.is_brand : undefined,
  };
}

/**
 * Display label for a search-result row. "Brand · Strength · Form"
 * when the concept carries a brand_name; otherwise
 * "generic · strength · form" with sensible fallbacks. Used by the
 * agent MedsPage search dropdown.
 */
export function displayLabel(d: RxNormDrug): string {
  const parts: string[] = [];
  if (d.brand_name) parts.push(d.brand_name);
  else if (d.generic_name) parts.push(d.generic_name);
  else parts.push(d.name);
  if (d.strength) parts.push(d.strength);
  if (d.dose_form) parts.push(d.dose_form);
  return parts.join(' · ');
}
