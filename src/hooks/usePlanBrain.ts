// usePlanBrain — React hook that fetches the aggregated Brain data
// payload and runs runPlanBrain() over the supplied plan list.
//
// Stays inside the agent quote screen — no global state. Re-runs when
// the plan ids, medications, providers, or condition profile change.
// Exposes a loading flag and the full PlanBrainResult.

import { useEffect, useMemo, useState } from 'react';
import type { Plan } from '@/types/plans';
import type { Client, Medication, Provider } from '@/types/session';
import { runPlanBrain } from '@/lib/plan-brain';
import type {
  ConditionKey,
  PlanBrainData,
  PlanBrainResult,
  Population,
  WeightProfile,
} from '@/lib/plan-brain-types';

interface Args {
  plans: Plan[];
  client: Client;
  medications: Medication[];
  providers: Provider[];
  conditionProfile?: ConditionKey | null;
  userPriorities?: string[];
  populationOverride?: Population | null;
  weightOverride?: Partial<WeightProfile> | null;
}

interface State {
  result: PlanBrainResult | null;
  loading: boolean;
  error: string | null;
}

export function usePlanBrain(args: Args): State {
  const { plans, client, medications, providers, conditionProfile, userPriorities, populationOverride, weightOverride } = args;

  const planIds = useMemo(() => plans.map((p) => p.id).sort().join(','), [plans]);
  const rxcuis = useMemo(
    () => medications.map((m) => m.rxcui).filter((x): x is string => !!x).sort().join(','),
    [medications],
  );
  const npis = useMemo(
    () => providers.map((p) => p.npi).filter((x): x is string => !!x).sort().join(','),
    [providers],
  );

  const [data, setData] = useState<PlanBrainData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!planIds) {
      setData(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ ids: planIds });
    if (rxcuis) qs.set('rxcuis', rxcuis);
    if (npis) qs.set('npis', npis);
    fetch(`/api/plan-brain-data?${qs.toString()}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`plan-brain-data ${res.status}`);
        return (await res.json()) as PlanBrainData;
      })
      .then((d) => {
        if (!controller.signal.aborted) setData(d);
      })
      .catch((err) => {
        if ((err as { name?: string })?.name === 'AbortError') return;
        setError((err as Error).message);
        // Degrade gracefully — score with empty data rather than render nothing.
        setData({
          benefitsByPlan: {},
          drugCostCache: {},
          formularyByContractPlan: {},
          ndcByRxcui: {},
          networkByPlan: {},
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [planIds, rxcuis, npis]);

  const result = useMemo<PlanBrainResult | null>(() => {
    if (!data) return null;
    return runPlanBrain({
      plans,
      client,
      medications,
      providers,
      data,
      conditionProfile,
      userPriorities,
      populationOverride,
      weightOverride,
    });
  }, [
    data, plans, client, medications, providers,
    conditionProfile, userPriorities, populationOverride, weightOverride,
  ]);

  return { result, loading, error };
}
