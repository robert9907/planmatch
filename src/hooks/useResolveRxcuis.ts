import { useEffect, useRef } from 'react';
import { useSession } from './useSession';
import { searchDrug } from '@/lib/rxnorm';

// Background-resolve rxcuis for any medication added to the session
// without one. Photo-captured meds (CapturePanel never hits RxNorm) and
// CRM-hydrated meds (AgentBase records often lack rxcui on old leads)
// land in the session with rxcui === undefined. Those meds can't match
// pm_formulary — their formulary badges render red "not on formulary"
// on every plan. This hook watches the session, picks up un-resolved
// meds, calls /api/rxnorm-search, and writes the best rxcui back via
// updateMedication so formularyLookup can then expand and match.
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

      (async () => {
        try {
          const results = await searchDrug(name);
          if (cancelled) return;
          const best = results[0];
          if (best?.rxcui) {
            updateMedication(med.id, { rxcui: best.rxcui });
          }
        } catch {
          // Leave the id out of the resolved set so the next mount
          // can retry — transient RxNav outages shouldn't permanently
          // block badge rendering for this med.
          resolvedRef.current.delete(med.id);
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [medications, updateMedication]);
}
