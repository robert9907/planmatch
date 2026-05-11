import { useEffect, useRef, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabaseBrowser';

// Direct pm_drugs autocomplete on plan-match-prod, mirroring the
// consumer's apps/web/src/hooks/useDrugSearch.ts. Agent-v3 uses this
// for the inline add-medication panel on MedsScreen; the existing
// /api/rxnorm-search proxy (RxNav-backed, used by the v4 Step3 page)
// is still around for callers that want fuzzy approximateTerm hits,
// but for typeahead against a pre-imported drug table the direct
// ilike scan is faster and matches the consumer's UX 1:1.

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
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(async () => {
      try {
        const supabase = supabaseBrowser();
        const { data, error: supaErr } = await supabase
          .from('pm_drugs')
          .select(
            'rxcui, name, generic_name, brand_name, strength, dose_form, is_brand',
          )
          .ilike('search_text', `%${q}%`)
          .eq('is_prescribable', true)
          .limit(FETCH_LIMIT);
        if (cancelled) return;
        if (supaErr) throw supaErr;

        const qLower = q.toLowerCase();
        const exclude = new Set(excludeRef.current);
        const ranked = (data ?? [])
          .filter((d) => !exclude.has(d.rxcui as string))
          .map((d) => {
            const displayName = (d.brand_name || d.generic_name || d.name) as string;
            const startsRank = displayName.toLowerCase().startsWith(qLower) ? 0 : 1;
            const combo = comboPenalty(d.name as string);
            const form = formScore(d.dose_form as string | null);
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
          rxcui: r.d.rxcui as string,
          name: r.d.name as string,
          displayName: r.displayName,
          generic_name: (r.d.generic_name as string | null) ?? null,
          brand_name: (r.d.brand_name as string | null) ?? null,
          strength: (r.d.strength as string | null) ?? null,
          dose_form: (r.d.dose_form as string | null) ?? null,
          is_brand: Boolean(r.d.is_brand),
        }));

        setResults(mapped);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Search failed');
        setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [rawQuery]);

  return { results, loading, error };
}
