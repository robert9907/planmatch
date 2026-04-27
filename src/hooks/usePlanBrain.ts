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
  /** Raw aggregated Brain data — exposes per-drug, per-medical, and
   *  per-network rows so a consumer (e.g. the v4 quote table) can
   *  render exact dollar values instead of just the composite score.
   *  Null until the first fetch lands. */
  data: PlanBrainData | null;
  loading: boolean;
  error: string | null;
  /** True when (a) plans, (b) /api/plan-brain-data has returned, and
   *  (c) we're not currently fetching. The brain runs ONCE per stable
   *  input set after this is true; consumers should show a loading
   *  state until then to avoid rendering a partial scoring pass that
   *  flickers as provider-network rows arrive late. */
  ready: boolean;
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

  // Determinism gate: brain runs ONLY when (a) plans is non-empty,
  // (b) data has loaded, and (c) we're not mid-fetch. The mid-fetch
  // guard prevents a brief race where plans/medications change,
  // useEffect kicks off a new fetch, but the old `data` is still set
  // — without the guard the brain runs once on the stale `data`,
  // then again on the new `data`, producing two ranking outputs in
  // quick succession. With the guard the consumer sees ONE result
  // per stable input set.
  const ready = !loading && data !== null && plans.length > 0;

  const result = useMemo<PlanBrainResult | null>(() => {
    if (!ready || !data) return null;
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
    ready, data, plans, client, medications, providers,
    conditionProfile, userPriorities, populationOverride, weightOverride,
  ]);

  return { result, data, loading, error, ready };
}
