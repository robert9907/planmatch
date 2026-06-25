import { useEffect, useRef, useState } from 'react';

import {
  searchProviders,
  type LibraryProviderRow,
} from '@/lib/library-client';

// Provider/NPI autocomplete backed by /api/library/npi-search at
// planmatch.generationhealth.me. The library endpoint normalizes raw
// NPPES JSON server-side, so the agent no longer needs a local
// taxonomy-picker / address-picker / display-name builder — it
// consumes the canonical ProviderRow shape directly. Used by the
// inline add-provider panel on agent-v3 ProvidersScreen.

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
  fallback: 'last_name_only' | 'state_dropped' | null;
}

const MIN_CHARS = 3;
const DEBOUNCE_MS = 300;

interface CachedResponse {
  rows: ProviderSearchResult[];
  fallback: 'last_name_only' | 'state_dropped' | null;
}
const responseCache = new Map<string, CachedResponse>();

function cacheKey(q: string, state: string): string {
  return `${q.toLowerCase()}|${state}`;
}

function toResult(row: LibraryProviderRow): ProviderSearchResult {
  return {
    npi: row.npi,
    enumeration_type: row.enumeration_type,
    display_name: row.display_name,
    first_name: row.first_name,
    last_name: row.last_name,
    credential: row.credential,
    specialty: row.specialty_display ?? row.specialty,
    practice_name: row.practice_name,
    practice_city: row.practice_city,
    practice_state: row.practice_state || null,
    practice_zip: row.practice_zip,
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
  const [fallback, setFallback] = useState<
    'last_name_only' | 'state_dropped' | null
  >(null);

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

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const body = await searchProviders({
          query: q,
          ...(/^[A-Z]{2}$/.test(st) ? { state: st } : {}),
          signal: controller.signal,
        });
        if (cancelled) return;
        const rows = (body.providers ?? []).map(toResult);
        const fb = body.fallback ?? null;
        responseCache.set(key, { rows, fallback: fb });
        const exclude = new Set(excludeRef.current);
        setResults(rows.filter((r) => !exclude.has(r.npi)));
        setFallback(fb);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Search failed');
        setResults([]);
        setFallback(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [rawQuery, state]);

  return { results, loading, error, fallback };
}
