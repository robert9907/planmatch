import { useEffect, useRef, useState } from 'react';
import { searchDrugs, type LibraryDrug } from '@/lib/library-client';

// Library-backed drug autocomplete for agent-v3's MedsScreen. We used
// to hit pm_drugs directly via supabaseBrowser — that coupled the agent
// to the consumer's database credentials and duplicated the ranking
// behind the library API. Routing through searchDrugs makes the agent
// and consumer return identical suggestions for the same query and
// removes the browser-exposed Supabase key requirement for this path.

export interface DrugSearchResult {
  rxcui: string;
  name: string;
  displayName: string;
  generic_name: string | null;
  brand_name: string | null;
  strength: string | null;
  dose_form: string | null;
  is_brand: boolean;
}

export interface UseDrugSearch {
  results: DrugSearchResult[];
  loading: boolean;
  error: string | null;
}

const MIN_CHARS = 2;
const DEBOUNCE_MS = 180;
const FETCH_LIMIT = 25;
const DISPLAY_LIMIT = 6;

function formScore(form: string | null): number {
  if (!form) return 5;
  const f = form.trim();
  if (/^Oral Tablet$|^Oral Capsule$/i.test(f)) return 0;
  if (/Oral Tablet|Oral Capsule/i.test(f)) return 1;
  if (/Oral Solution|Oral Suspension/i.test(f)) return 3;
  if (/Injectable|Injector|Pen|Vial|Syringe|Inhaler|Patch/i.test(f)) return 4;
  return 5;
}

function comboPenalty(name: string): number {
  return /\s\/\s|;\s|\s\+\s/.test(name) ? 2 : 0;
}

function nullable(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function useDrugSearch(
  rawQuery: string,
  excludeRxcuis: readonly string[] = [],
): UseDrugSearch {
  const [results, setResults] = useState<DrugSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const excludeRef = useRef<readonly string[]>(excludeRxcuis);
  useEffect(() => {
    excludeRef.current = excludeRxcuis;
  });

  useEffect(() => {
    const q = rawQuery.trim();
    if (q.length < MIN_CHARS) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(async () => {
      try {
        const drugs: LibraryDrug[] = await searchDrugs(
          q,
          FETCH_LIMIT,
          controller.signal,
        );
        if (cancelled) return;

        const qLower = q.toLowerCase();
        const exclude = new Set(excludeRef.current);
        const ranked = drugs
          .filter((d) => !exclude.has(d.rxcui))
          .map((d) => {
            const displayName = nullable(d.brand_name) ?? nullable(d.generic_name) ?? d.name;
            const startsRank = displayName.toLowerCase().startsWith(qLower) ? 0 : 1;
            const combo = comboPenalty(d.name);
            const form = formScore(nullable(d.dose_form));
            return { d, displayName, startsRank, combo, form };
          });
        ranked.sort(
          (a, b) =>
            a.startsRank - b.startsRank ||
            a.combo - b.combo ||
            a.form - b.form ||
            a.displayName.localeCompare(b.displayName),
        );

        const mapped: DrugSearchResult[] = ranked.slice(0, DISPLAY_LIMIT).map((r) => ({
          rxcui: r.d.rxcui,
          name: r.d.name,
          displayName: r.displayName,
          generic_name: nullable(r.d.generic_name),
          brand_name: nullable(r.d.brand_name),
          strength: nullable(r.d.strength),
          dose_form: nullable(r.d.dose_form),
          is_brand: Boolean(r.d.is_brand),
        }));

        setResults(mapped);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Search failed');
        setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [rawQuery]);

  return { results, loading, error };
}
