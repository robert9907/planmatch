// useManufacturerAssistance — fetches /api/manufacturer-assistance
// once per medication set and indexes the rows by medication id so
// the v4 quote table can show "assistance available" markers next to
// drugs that came back not_covered or tier 4-5 expensive.
//
// One round trip per agent session — the seed table is ~20 rows so
// we don't bother with brand-filtered fetches.

import { useEffect, useMemo, useState } from 'react';
import type { Medication } from '@/types/session';

export interface AssistanceRow {
  id: number;
  drug_name: string;
  brand_name: string;
  manufacturer: string;
  program_name: string;
  program_type: 'PAP' | 'copay_card' | 'foundation';
  eligibility_summary: string | null;
  income_limit_individual: number | null;
  income_limit_couple: number | null;
  requires_m3p_enrollment: boolean | null;
  application_url: string | null;
  phone_number: string | null;
  covers_medicare: boolean | null;
}

interface State {
  rows: AssistanceRow[];
  byMedicationId: Record<string, AssistanceRow[]>;
  loading: boolean;
  error: string | null;
}

export function useManufacturerAssistance(medications: Medication[]): State {
  const [rows, setRows] = useState<AssistanceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/manufacturer-assistance')
      .then(async (r) => {
        if (!r.ok) throw new Error(`manufacturer-assistance ${r.status}`);
        return (await r.json()) as { rows: AssistanceRow[] };
      })
      .then((body) => {
        if (!cancelled) setRows(body.rows ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError((err as Error).message);
        setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Index assistance rows per medication id. A medication matches an
  // assistance row when the brand_name (or drug_name) appears in the
  // medication's free-text name. Match is case-insensitive and word-
  // boundary aware so "Humalog 100 unit/ml" hits the Humalog row but
  // "Trulicity" doesn't accidentally match a hypothetical "Trulicityol".
  const byMedicationId = useMemo<Record<string, AssistanceRow[]>>(() => {
    const out: Record<string, AssistanceRow[]> = {};
    for (const med of medications) {
      // Photo-OCR / AgentBase hydration paths can produce a Medication
      // with a null name even though the TS type says string. A single
      // null here used to crash the QuoteDeliveryV4 quote screen with
      // "Cannot read properties of null (reading 'toLowerCase')" inside
      // this useMemo. Coerce defensively.
      const haystack = (med.name ?? '').toLowerCase();
      if (!haystack) continue;
      const matches: AssistanceRow[] = [];
      for (const row of rows) {
        const brand = (row.brand_name ?? '').toLowerCase();
        const drug = (row.drug_name ?? '').toLowerCase();
        if ((brand && matchesWord(haystack, brand)) ||
            (drug && matchesWord(haystack, drug))) {
          matches.push(row);
        }
      }
      if (matches.length > 0) out[med.id] = matches;
    }
    return out;
  }, [medications, rows]);

  return { rows, byMedicationId, loading, error };
}

function matchesWord(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const idx = haystack.indexOf(needle);
  if (idx < 0) return false;
  const before = idx === 0 ? '' : haystack[idx - 1];
  const after = haystack[idx + needle.length] ?? '';
  return !/\w/.test(before) && !/\w/.test(after);
}
