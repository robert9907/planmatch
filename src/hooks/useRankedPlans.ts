// useRankedPlans — thin React hook that calls the Plan Match library's
// /api/library/rank-plans endpoint and exposes the response.
//
// This is the agent-side equivalent of "run the brain". Replaces the
// local-brain ranking pipeline for the rank/compare flow (AgentV3App
// → CompareScreen). QuoteDeliveryV4 and the AgentBase recommend sync
// still consume the legacy usePlanBrain hook because they rely on
// brain context the library doesn't yet return (archetype, weights,
// per-plan applied rules, red flags, real-cost breakdown, structured
// formulary rows). Those callers move over once the library response
// is expanded to carry that data.
//
// Inputs: county/zip/state from `client`, the agent's resolved meds
// and providers, and a list of priority keys already mapped to
// library extras strings ("dental", "vision", "hearing", "otc",
// "fitness", "transportation"). The caller owns the PRIORITY_TO_EXTRAS
// translation so the hook stays agnostic of the agent's PriorityKey
// union.
//
// Trade-offs vs. the local-brain hook:
//   • The result is the library's `LibraryRankResult` (top_plans +
//     bench_plans). Per-plan medication coverage, provider network
//     status, benefits, and gate results are pre-computed by the
//     library; the consumer reads them straight off each plan object.
//   • The library brain is pure elimination + cost rank — no weight
//     knobs. usePlanBrain (still used by QuoteDeliveryV4) retains its
//     weightOverride prop for the quote-time preset buttons.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Client, Medication, Provider } from '@/types/session';
import {
  rankPlans,
  type CsnpConditionKey,
  type LibraryRankResult,
} from '@/lib/library-client';

export interface UseRankedPlansArgs {
  client: Client;
  medications: Medication[];
  providers: Provider[];
  /** Already-mapped library extras strings (e.g. ['dental','vision']).
   *  Caller owns the PriorityKey → extras translation. */
  userPriorities?: string[];
  /** Self-reported chronic conditions captured by the broker.
   *  Passed through to the library so the brain's C-SNP routing
   *  fires for users who qualify but have no qualifying meds on
   *  their list. Empty / undefined means med-detection only. */
  csnpConditions?: CsnpConditionKey[];
  /** Optional currentPlanId for annual-review flow — library excludes
   *  it from Top 4 selection. */
  currentPlanId?: string | null;
}

export interface UseRankedPlansState {
  result: LibraryRankResult | null;
  loading: boolean;
  error: string | null;
  /** True once the first successful response has landed. */
  ready: boolean;
  /** Names of providers the agent collected without an NPI. The
   *  library can't network-check these, so consumers should surface
   *  them as "unverified" alongside the result. */
  unresolvedProviderNames: string[];
}

const EMPTY_STATE: UseRankedPlansState = {
  result: null,
  loading: false,
  error: null,
  ready: false,
  unresolvedProviderNames: [],
};

export function useRankedPlans(args: UseRankedPlansArgs): UseRankedPlansState {
  const {
    client,
    medications,
    providers,
    userPriorities,
    csnpConditions,
    currentPlanId,
  } = args;

  const [state, setState] = useState<UseRankedPlansState>(EMPTY_STATE);

  // Aborts the in-flight fetch when args change before it resolves so
  // a slow earlier request can't overwrite a fresher result.
  const abortRef = useRef<AbortController | null>(null);

  // Resolved meds (rxcui present) go to the library; unresolved ones
  // are dropped — library can't look up coverage without an rxcui.
  const resolvedMeds = useMemo(
    () =>
      medications
        .filter((m): m is Medication & { rxcui: string } => !!m.rxcui)
        .map((m) => ({
          rxcui: m.rxcui,
          // Generic-first per Phase 1 audit. Formulary indexes by
          // generic compound; brand names may not match the SPUF
          // formulary key. Falls back to the display name when no
          // generic was resolved.
          name: m.genericName ?? m.name,
          strength: m.dose,
        })),
    [medications],
  );

  // Providers split: NPI-bearing ones are checked by the library;
  // NPI-less ones are surfaced verbatim on the side so the broker
  // knows network status couldn't be verified for them.
  const { resolvedProviders, unresolvedProviderNames } = useMemo(() => {
    const withNpi: { npi: string; name: string }[] = [];
    const unresolved: string[] = [];
    for (const p of providers) {
      if (p.npi) withNpi.push({ npi: p.npi, name: p.name });
      else unresolved.push(p.name);
    }
    return { resolvedProviders: withNpi, unresolvedProviderNames: unresolved };
  }, [providers]);

  const extras = useMemo(
    () =>
      (userPriorities ?? []).map((type) => ({
        type,
        enabled: true,
      })),
    [userPriorities],
  );

  const csnpList = useMemo(
    () => csnpConditions ?? [],
    [csnpConditions],
  );

  // Stable JSON serializations keyed in the dependency array. React's
  // structural equality misses identical-but-rerendered med/provider
  // arrays, which would re-fire the fetch on every parent render.
  const medsKey = useMemo(() => JSON.stringify(resolvedMeds), [resolvedMeds]);
  const provsKey = useMemo(
    () => JSON.stringify(resolvedProviders),
    [resolvedProviders],
  );
  const extrasKey = useMemo(() => JSON.stringify(extras), [extras]);
  const csnpKey = useMemo(() => JSON.stringify(csnpList), [csnpList]);

  const county = client.county;
  const zip = client.zip;
  const state_ = client.state;

  useEffect(() => {
    if (!county || !zip || !state_) {
      setState({
        ...EMPTY_STATE,
        unresolvedProviderNames,
      });
      return;
    }

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setState((prev) => ({
      ...prev,
      loading: true,
      error: null,
      unresolvedProviderNames,
    }));

    rankPlans(
      {
        county,
        zip,
        state: state_,
        medications: resolvedMeds,
        providers: resolvedProviders,
        extras,
        csnpConditions: csnpList,
        current_plan_id: currentPlanId ?? null,
      },
      ctrl.signal,
    )
      .then((result) => {
        if (ctrl.signal.aborted) return;
        setState({
          result,
          loading: false,
          error: null,
          ready: true,
          unresolvedProviderNames,
        });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        const message =
          err instanceof Error ? err.message : 'rank-plans failed';
        setState((prev) => ({
          result: prev.result,
          loading: false,
          error: message,
          ready: prev.ready,
          unresolvedProviderNames,
        }));
      });

    return () => {
      ctrl.abort();
    };
    // medsKey / provsKey / extrasKey deliberately gate on serialized
    // content, not array identity — see notes above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [county, zip, state_, medsKey, provsKey, extrasKey, csnpKey, currentPlanId]);

  return state;
}
