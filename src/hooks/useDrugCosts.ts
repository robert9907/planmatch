// useDrugCosts — primes Medicare.gov drug-cost data for the v4 Quote
// table.
//
// Fires once per unique (finalists × rxcuis × pharmacy mode) tuple.
// Resolves rxcuis → NDCs (one rep NDC per rxcui) and then asks
// /api/drug-costs for per-plan totals. The `byPlanId` map lets the v4
// table look up a plan's real monthly/annual drug cost and override the
// tier-based fallback rxSummary() produces from the local formulary
// cache.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Plan } from '@/types/plans';
import type { Medication } from '@/types/session';
import {
  fetchDrugCosts,
  resolveRxcuisToNdcs,
  type PharmacyMode,
  type PlanDrugCost,
} from '@/lib/drugCosts';

export interface DrugCostMap {
  byPlanId: Record<string, PlanDrugCost>;
  source: string | null;
  loading: boolean;
  error: string | null;
}

const INITIAL: DrugCostMap = {
  byPlanId: {},
  source: null,
  loading: false,
  error: null,
};

// Plan.id is "H5253-189-000" — parse out segment_id without adding a
// new field to the Plan type.
function segmentIdForPlan(plan: Plan): string {
  const parts = plan.id.split('-');
  return parts[2] ?? '0';
}

export function useDrugCosts(
  finalists: Plan[],
  medications: Medication[],
  mode: PharmacyMode,
): DrugCostMap {
  const [state, setState] = useState<DrugCostMap>(INITIAL);

  // Stable signature — only refetch when the set of plans, set of
  // rxcuis, or pharmacy mode actually changes. Column re-ordering in
  // the v4 table shouldn't cost a network round trip.
  const nonce = useMemo(() => {
    const plansSig = finalists
      .map((p) => `${p.contract_id}-${p.plan_number}-${segmentIdForPlan(p)}`)
      .sort()
      .join('|');
    const rxSig = medications
      .map((m) => m.rxcui ?? '')
      .filter((s) => s.length > 0)
      .sort()
      .join(',');
    return `${plansSig}::${rxSig}::${mode}`;
  }, [finalists, medications, mode]);

  const lastNonceRef = useRef<string>('');

  useEffect(() => {
    if (nonce === lastNonceRef.current) return;
    if (finalists.length === 0) {
      setState(INITIAL);
      return;
    }
    const rxcuis = medications
      .map((m) => m.rxcui)
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (rxcuis.length === 0) {
      setState({ ...INITIAL, source: 'no_meds' });
      return;
    }
    lastNonceRef.current = nonce;

    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    (async () => {
      try {
        const ndcsByRxcui = await resolveRxcuisToNdcs(rxcuis);
        if (cancelled) return;
        const repNdcs = rxcuis
          .map((rx) => ndcsByRxcui[rx]?.[0])
          .filter((s): s is string => typeof s === 'string' && s.length > 0);
        if (repNdcs.length === 0) {
          setState({ ...INITIAL, source: 'no_ndcs' });
          return;
        }
        const contractYear = String(new Date().getFullYear());
        const planInputs = finalists.map((p) => ({
          contract_id: p.contract_id,
          plan_id: p.plan_number,
          segment_id: segmentIdForPlan(p),
          contract_year: contractYear,
        }));
        const result = await fetchDrugCosts({
          plans: planInputs,
          ndcs: repNdcs,
          mode,
        });
        if (cancelled) return;
        const byPlanId: Record<string, PlanDrugCost> = {};
        for (const cost of result.costs) {
          const seg = cost.segment_id || '0';
          // Plan.id in the rest of the app uses "000" padding (see
          // api/plans.ts → `segment_id || '000'`). Index under both
          // normalizations so callers can look up by either shape.
          const idA = `${cost.contract_id}-${cost.plan_id}-${seg}`;
          const idB = `${cost.contract_id}-${cost.plan_id}-${seg.padStart(3, '0')}`;
          const idC = `${cost.contract_id}-${cost.plan_id}`;
          byPlanId[idA] = cost;
          byPlanId[idB] = cost;
          byPlanId[idC] = cost;
        }
        setState({ byPlanId, source: result.source, loading: false, error: null });
      } catch (err) {
        if (cancelled) return;
        const message = (err as Error).message;
        console.warn('[useDrugCosts] fetch failed:', message);
        setState({ byPlanId: {}, source: null, loading: false, error: message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [nonce, finalists, medications, mode]);

  return state;
}

export function lookupPlanCost(
  map: DrugCostMap,
  plan: Plan,
): PlanDrugCost | null {
  const seg = segmentIdForPlan(plan);
  return (
    map.byPlanId[plan.id] ??
    map.byPlanId[`${plan.contract_id}-${plan.plan_number}-${seg}`] ??
    map.byPlanId[`${plan.contract_id}-${plan.plan_number}-${seg.padStart(3, '0')}`] ??
    map.byPlanId[`${plan.contract_id}-${plan.plan_number}`] ??
    null
  );
}
