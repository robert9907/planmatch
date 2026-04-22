export interface RxNormDrug {
  rxcui: string;
  name: string;
  synonym?: string;
  tty?: string;
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
  return {
    rxcui,
    name,
    synonym: typeof r.synonym === 'string' ? r.synonym : undefined,
    tty: typeof r.tty === 'string' ? r.tty : undefined,
  };
}
