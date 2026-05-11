import { useEffect, useRef, useState } from 'react';

// Provider/NPI autocomplete backed by the agent's /api/npi-search
// (NPPES proxy). Mirrors the consumer hook's surface but normalizes
// raw NPPES JSON on the client because the agent endpoint passes
// NPPES through unchanged. Used by the inline add-provider panel on
// agent-v3 ProvidersScreen.

export interface ProviderSearchResult {
  npi: string;
  display_name: string;
  first_name: string | null;
  last_name: string;
  credential: string | null;
  specialty: string | null;
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

const MIN_CHARS = 2;
const DEBOUNCE_MS = 300;

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
  const last = isOrg
    ? (basic.organization_name?.trim() ?? '')
    : (basic.last_name?.trim() ?? '');
  const display = isOrg
    ? (basic.organization_name?.trim() ?? `NPI ${npi}`)
    : [first, last].filter(Boolean).join(' ') || `NPI ${npi}`;
  const primaryTax =
    (raw.taxonomies ?? []).find((t) => t.primary) ?? (raw.taxonomies ?? [])[0];
  const location =
    (raw.addresses ?? []).find((a) => a.address_purpose === 'LOCATION') ??
    (raw.addresses ?? [])[0];
  return {
    npi,
    display_name: display,
    first_name: first,
    last_name: last,
    credential: basic.credential?.trim() || null,
    specialty: primaryTax?.desc?.trim() || null,
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
        const exclude = new Set(excludeRef.current);
        const rows = Array.isArray(body?.results)
          ? (body.results as NppesResult[])
              .map(normalize)
              .filter((r): r is ProviderSearchResult => !!r)
              .filter((r) => !exclude.has(r.npi))
          : [];
        setResults(rows);
        setFallback(body?.fallback === 'last_name_only' ? 'last_name_only' : null);
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
