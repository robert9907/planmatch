import { useEffect, useRef, useState } from 'react';

// Provider/NPI autocomplete backed by the agent's /api/npi-search
// (NPPES proxy). Mirrors the consumer hook's surface but normalizes
// raw NPPES JSON on the client because the agent endpoint passes
// NPPES through unchanged. Used by the inline add-provider panel on
// agent-v3 ProvidersScreen.
//
// The proxy now fires NPI-1 (individuals) + NPI-2 (organizations) in
// parallel so a query like "Duke Primary Care" surfaces practices
// alongside named clinicians. enumeration_type rides through so the
// UI can render org rows differently (no "Dr." prefix, practice chip).

export interface ProviderSearchResult {
  npi: string;
  /** "NPI-1" individual | "NPI-2" organization. */
  enumeration_type: 'NPI-1' | 'NPI-2';
  display_name: string;
  first_name: string | null;
  last_name: string;
  credential: string | null;
  specialty: string | null;
  /** Organization name for NPI-2 rows; null for individuals. */
  practice_name: string | null;
  practice_city: string | null;
  practice_state: string | null;
  practice_zip: string | null;
}

export interface UseProviderSearch {
  results: ProviderSearchResult[];
  loading: boolean;
  error: string | null;
  fallback: 'last_name_only' | null;
}

const MIN_CHARS = 3;
const DEBOUNCE_MS = 300;

// Module-scope cache: keyed by `${q}|${state}`, so re-typing a query
// the user has already issued in this session serves instantly from
// memory instead of refetching NPPES. Lives for the lifetime of the
// page — no TTL because NPPES results are stable within a session.
interface CachedResponse {
  rows: ProviderSearchResult[];
  fallback: 'last_name_only' | null;
}
const responseCache = new Map<string, CachedResponse>();

function cacheKey(q: string, state: string): string {
  return `${q.toLowerCase()}|${state}`;
}

interface NppesAddress {
  address_purpose?: string;
  city?: string;
  state?: string;
  postal_code?: string;
}

interface NppesTaxonomy {
  primary?: boolean;
  desc?: string;
}

interface NppesBasic {
  first_name?: string;
  last_name?: string;
  credential?: string;
  organization_name?: string;
}

interface NppesResult {
  number?: string | number;
  enumeration_type?: string;
  basic?: NppesBasic;
  addresses?: NppesAddress[];
  taxonomies?: NppesTaxonomy[];
}

function normalize(raw: NppesResult): ProviderSearchResult | null {
  const npi = String(raw.number ?? '').trim();
  if (!npi) return null;
  const basic = raw.basic ?? {};
  const isOrg = raw.enumeration_type === 'NPI-2';
  const first = basic.first_name?.trim() || null;
  const orgName = basic.organization_name?.trim() || null;
  const last = isOrg
    ? (orgName ?? '')
    : (basic.last_name?.trim() ?? '');
  const display = isOrg
    ? (orgName ?? `NPI ${npi}`)
    : [first, last].filter(Boolean).join(' ') || `NPI ${npi}`;
  const primaryTax =
    (raw.taxonomies ?? []).find((t) => t.primary) ?? (raw.taxonomies ?? [])[0];
  const location =
    (raw.addresses ?? []).find((a) => a.address_purpose === 'LOCATION') ??
    (raw.addresses ?? [])[0];
  return {
    npi,
    enumeration_type: isOrg ? 'NPI-2' : 'NPI-1',
    display_name: display,
    first_name: first,
    last_name: last,
    credential: basic.credential?.trim() || null,
    specialty: primaryTax?.desc?.trim() || null,
    practice_name: isOrg ? orgName : null,
    practice_city: location?.city?.trim() || null,
    practice_state: location?.state?.trim() || null,
    practice_zip: location?.postal_code?.trim() || null,
  };
}

export function useProviderSearch(
  rawQuery: string,
  state: string | null | undefined,
  excludeNpis: readonly string[] = [],
): UseProviderSearch {
  const [results, setResults] = useState<ProviderSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallback, setFallback] = useState<'last_name_only' | null>(null);

  const excludeRef = useRef<readonly string[]>(excludeNpis);
  useEffect(() => {
    excludeRef.current = excludeNpis;
  });

  useEffect(() => {
    const q = rawQuery.trim();
    const st = (state ?? '').trim().toUpperCase();
    if (q.length < MIN_CHARS) {
      setResults([]);
      setLoading(false);
      setError(null);
      setFallback(null);
      return;
    }

    // Cache hit: serve instantly, skip the debounce + fetch entirely.
    const key = cacheKey(q, st);
    const cached = responseCache.get(key);
    if (cached) {
      const exclude = new Set(excludeRef.current);
      setResults(cached.rows.filter((r) => !exclude.has(r.npi)));
      setFallback(cached.fallback);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ name: q });
        if (/^[A-Z]{2}$/.test(st)) params.set('state', st);
        const resp = await fetch(`/api/npi-search?${params.toString()}`);
        if (cancelled) return;
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          setError(body?.error ?? `HTTP ${resp.status}`);
          setResults([]);
          setFallback(null);
          return;
        }
        const rows = Array.isArray(body?.results)
          ? (body.results as NppesResult[])
              .map(normalize)
              .filter((r): r is ProviderSearchResult => !!r)
          : [];
        const fb = body?.fallback === 'last_name_only' ? 'last_name_only' : null;
        responseCache.set(key, { rows, fallback: fb });
        const exclude = new Set(excludeRef.current);
        setResults(rows.filter((r) => !exclude.has(r.npi)));
        setFallback(fb);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Search failed');
        setResults([]);
        setFallback(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [rawQuery, state]);

  return { results, loading, error, fallback };
}
