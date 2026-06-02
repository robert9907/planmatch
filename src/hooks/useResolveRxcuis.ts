import { useEffect, useRef } from 'react';
import { useSession } from './useSession';
import { searchDrug, type RxNormDrug } from '@/lib/rxnorm';

// Background-resolve rxcuis for any medication added to the session
// without one. Photo-captured meds (CapturePanel never hits RxNorm) and
// CRM-hydrated meds (AgentBase records often lack rxcui on old leads)
// land in the session with rxcui === undefined. Those meds can't match
// pm_formulary — their formulary badges render red "not on formulary"
// on every plan. This hook watches the session, picks up un-resolved
// meds, calls /api/rxnorm-search, and writes the best rxcui back via
// updateMedication so formularyLookup can then expand and match.
//
// Strength-aware resolution: we pass `name + strength` as the search
// query so the API ranker's strength tiebreaker fires, then filter the
// returned candidates to those whose name actually contains the
// requested strength before picking [0]. Without this filter, a med
// like "Lisinopril 20mg" can resolve to lisinopril 40 MG when the
// 40-MG row lands first in the API's PostgREST page-saturated
// formulary-coverage probe (see api/rxnorm-search.ts rerankByCoverage
// for the upstream cause). Picking strength-first locally keeps the
// agent-v3 seeded meds (Ozempic 1mg/0.75mL, Lisinopril 20mg, etc.)
// resolving against pm_formulary even when coverage signal is noisy.
//
// resolvedRef tracks which medication ids we've attempted so adjacent
// renders don't refire the same searches. A failed search clears the
// id so a future mount can retry.

export function useResolveRxcuis(): void {
  const medications = useSession((s) => s.medications);
  const updateMedication = useSession((s) => s.updateMedication);
  const resolvedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    for (const med of medications) {
      if (med.rxcui) continue;
      const name = med.name.trim();
      if (name.length < 2) continue;
      if (resolvedRef.current.has(med.id)) continue;
      resolvedRef.current.add(med.id);

      const strength = med.strength?.trim() ?? '';
      const queryWithStrength = strength ? `${name} ${strength}` : name;

      (async () => {
        try {
          // First pass: name + strength. Strength tokens don't appear
          // in pm_drugs.search_text (which is lower(name||generic||
          // brand)), so this query usually returns empty when strength
          // is present; the fallback below catches it.
          let results = await searchDrug(queryWithStrength);
          if (cancelled) return;
          if (results.length === 0 && strength) {
            results = await searchDrug(name);
            if (cancelled) return;
          }
          const best = pickBest(results, strength);
          if (best?.rxcui) {
            updateMedication(med.id, { rxcui: best.rxcui });
          } else {
            // Both passes returned empty — leave id retryable so the
            // next mount tries again. Without this the broker's first
            // session-load result ("No RxNorm match") sticks forever
            // even if pm_drugs gets updated mid-session or the broker
            // re-types the name.
            resolvedRef.current.delete(med.id);
          }
        } catch {
          // Leave the id out of the resolved set so the next mount
          // can retry — transient Supabase errors shouldn't
          // permanently block badge rendering for this med.
          resolvedRef.current.delete(med.id);
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [medications, updateMedication]);
}

// Parse a strength string like "20mg", "1mg/0.75mL", "300 MG", "40 MCG"
// into a number normalized to MG. Returns null when nothing parseable
// is found — callers fall back to the raw [0] result.
function parseStrengthMg(raw: string): number | null {
  const m = raw.match(/(\d+(?:\.\d+)?)\s*(MG|MCG|G|ML|%)/i);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const unit = m[2].toUpperCase();
  if (unit === 'MCG') return v / 1000;
  if (unit === 'G') return v * 1000;
  return v;
}

// Pick the best candidate from a search-result list. When a strength
// is supplied, prefer the first candidate whose name parses to the
// same numeric strength; fall back to the raw [0] when no candidate
// matches (search returned nothing strength-relevant — better to
// resolve to something than nothing).
function pickBest(results: RxNormDrug[], rawStrength: string): RxNormDrug | null {
  if (results.length === 0) return null;
  const target = parseStrengthMg(rawStrength);
  if (target == null) return results[0];
  const strengthMatch = results.find((r) => {
    const s = parseStrengthMg(r.name);
    if (s == null) return false;
    return Math.abs(s - target) < 0.0001;
  });
  return strengthMatch ?? results[0];
}
