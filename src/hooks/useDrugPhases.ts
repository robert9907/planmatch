// useDrugPhases — hits the agent's POST /api/drug-phases once per
// unique (plans × rxcuis × pharmacy_type) tuple and exposes the result
// as a lookup Map<planKey::rxcui, DrugPhaseHit>. Powers Compare's
// per-drug phase breakdown (deductible / initial / catastrophic
// cost sharing) alongside drug_type + tier_specialty flags.
//
// Different data than useDrugCosts:
//   • useDrugCosts hits Medicare.gov (Playwright) → real annual $
//     that mirrors Plan Compare — subject to LIS enum, retail/mail mode,
//     rate limits.
//   • useDrugPhases hits Supabase directly (pm_formulary_v2 +
//     pm_beneficiary_cost_v2) → CMS-filed cost-sharing per phase per
//     pharmacy_type. Deterministic, no Playwright, no rate limit.
//
// Idle when no plans or no rxcuis. Debounced via a nonce string so
// column re-orders in the Compare grid don't re-fetch.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Plan } from '@/types/plans';
import type { Medication } from '@/types/session';

export type PharmacyType = 'pref' | 'nonpref' | 'mail_pref' | 'mail_nonpref';
export type DrugPhaseKey = 'deductible' | 'initial' | 'catastrophic';
export type DrugPhaseType = 'generic' | 'brand' | 'specialty';

/** cost_type semantics (CMS SPUF beneficiary_cost):
 *    0 = not applicable
 *    1 = flat copay      → cost_amount is dollars
 *    2 = coinsurance     → cost_amount is fraction 0..1 */
export interface DrugPhaseCell {
  cost_type: number;
  cost_amount: number | null;
  cost_min: number | null;
  cost_max: number | null;
}

export interface DrugPhaseHit {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  rxcui: string;
  tier: number | null;
  drug_type: DrugPhaseType | null;
  tier_specialty: boolean;
  deductible_applies: boolean;
  phases: Partial<Record<DrugPhaseKey, DrugPhaseCell>>;
}

export interface UseDrugPhasesResult {
  /** Map<`${planId}::${rxcui}`, DrugPhaseHit>. planId is the agent's
   *  triple id (contract-plan-segment as it appears on Plan.id). */
  byPlanIdRxcui: Map<string, DrugPhaseHit>;
  loading: boolean;
  error: string | null;
  source: 'live' | 'cache' | 'idle' | 'empty' | null;
}

const EMPTY: UseDrugPhasesResult = {
  byPlanIdRxcui: new Map(),
  loading: false,
  error: null,
  source: null,
};

// Plan.id is "H5253-189-000" — parse segment_id without a Plan-type add.
function segmentIdForPlan(plan: Plan): string {
  const parts = plan.id.split('-');
  return parts[2] ?? '0';
}

export function useDrugPhases(
  plans: readonly Plan[],
  medications: readonly Medication[],
  pharmacyType: PharmacyType = 'pref',
  daysSupplyCode: 1 | 2 | 3 | 4 = 1,
): UseDrugPhasesResult {
  const [state, setState] = useState<UseDrugPhasesResult>(EMPTY);

  const nonce = useMemo(() => {
    const plansSig = plans
      .map((p) => `${p.contract_id}-${p.plan_number}-${segmentIdForPlan(p)}`)
      .sort()
      .join('|');
    const rxSig = medications
      .map((m) => m.rxcui ?? '')
      .filter((s) => s.length > 0)
      .sort()
      .join(',');
    return `${plansSig}::${rxSig}::${pharmacyType}::${daysSupplyCode}`;
  }, [plans, medications, pharmacyType, daysSupplyCode]);

  const lastNonceRef = useRef<string>('');

  useEffect(() => {
    if (nonce === lastNonceRef.current) return;
    if (plans.length === 0) {
      setState({ ...EMPTY, source: 'idle' });
      return;
    }
    const rxcuis = medications
      .map((m) => m.rxcui)
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (rxcuis.length === 0) {
      setState({ ...EMPTY, source: 'empty' });
      return;
    }
    lastNonceRef.current = nonce;

    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    (async () => {
      try {
        const planInputs = plans.map((p) => ({
          contract_id: p.contract_id,
          plan_id: p.plan_number,
          segment_id: segmentIdForPlan(p),
        }));
        const res = await fetch('/api/drug-phases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            plans: planInputs,
            rxcuis,
            pharmacy_type: pharmacyType,
            days_supply_code: daysSupplyCode,
          }),
        });
        if (cancelled) return;
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`drug-phases ${res.status} — ${text.slice(0, 200)}`);
        }
        const body = (await res.json()) as { results?: DrugPhaseHit[] };
        const byPlanIdRxcui = new Map<string, DrugPhaseHit>();
        const idNormalize = (r: DrugPhaseHit) => {
          // Match how Plan.id is formatted app-wide (contract-plan-segment,
          // segment padded to 3). Index under both padded + raw so
          // callers can look up by either shape.
          const seg = r.segment_id || '0';
          const idPadded = `${r.contract_id}-${r.plan_id}-${seg.padStart(3, '0')}`;
          const idRaw = `${r.contract_id}-${r.plan_id}-${seg}`;
          byPlanIdRxcui.set(`${idPadded}::${r.rxcui}`, r);
          if (idRaw !== idPadded) byPlanIdRxcui.set(`${idRaw}::${r.rxcui}`, r);
        };
        for (const r of body.results ?? []) idNormalize(r);
        setState({
          byPlanIdRxcui,
          loading: false,
          error: null,
          source: 'live',
        });
      } catch (err) {
        if (cancelled) return;
        const message = (err as Error).message;
        console.warn('[useDrugPhases] fetch failed:', message);
        setState({ ...EMPTY, error: message, source: null });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [nonce, plans, medications, pharmacyType, daysSupplyCode]);

  return state;
}
