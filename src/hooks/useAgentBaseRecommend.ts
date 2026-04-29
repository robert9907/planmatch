// useAgentBaseRecommend — fires /api/agentbase-recommend when the
// broker clicks Recommend on the Quote page. Tracks sync state so
// QuoteDeliveryV4's action row can render "Synced ✓ · Open in
// AgentBase" inline.
//
// State machine:
//   idle      — no recommendation made yet (or after clearing)
//   syncing   — POST in flight
//   synced    — 2xx + ok=true response
//   retrying  — first attempt failed; auto-retry running
//   error     — final error after retry exhausted
//
// The broker NEVER sees a blocking spinner. Sync runs alongside the
// rest of the workflow; failure shows a subtle red status line with a
// manual retry button — the recommendation itself (in the local
// session store) is unaffected.

import { useCallback, useRef, useState } from 'react';
import type { Plan } from '@/types/plans';
import type { Client, Medication, Provider } from '@/types/session';
import type { ScoredPlan, PlanBrainResult } from '@/lib/plan-brain-types';

export type RecommendSyncState = 'idle' | 'syncing' | 'synced' | 'retrying' | 'error';

export interface RecommendSyncResult {
  client_id: string;
  agentbase_url: string;
  created: boolean;
  webhook_forwarded: boolean;
  webhook_error: string | null;
  giveback_flagged: boolean;
}

// Exported so the SaveSessionButton's belt-and-suspenders structured
// sync can read a snapshot of the same input shape from the
// useAgentBaseSyncSnapshot store. Same payload either path.
export interface SyncInput {
  client: Client;
  sessionId: string;
  startedAt: number;
  brokerNpn: string;
  brokerId: string;
  recommendedPlan: Plan;
  recommendedScored: ScoredPlan;
  medications: Medication[];
  providers: Provider[];
  brainResult: PlanBrainResult;
  /** Per-recommended-plan medication context (tier + monthly cost +
   *  PA/ST flags). Caller derives this from the medRows array on the
   *  recommended column. */
  medContext: Array<{
    name: string;
    rxcui: string | null;
    /** Strength from session.Medication.strength (e.g. "10 MG"). */
    dose: string | null;
    /** Free-text dosing instructions (e.g. "1 tablet daily"). */
    frequency: string | null;
    tier_on_recommended_plan: number | null;
    monthly_cost: number | null;
    pa_required: boolean;
    st_required: boolean;
  }>;
  /** Provider-network status on the recommended plan. */
  providerContext: Array<{
    name: string;
    npi: string;
    specialty: string | null;
    network_status: 'in' | 'out' | 'unknown';
  }>;
}

const RETRY_DELAY_MS = 2_000;

export function useAgentBaseRecommend() {
  const [state, setState] = useState<RecommendSyncState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecommendSyncResult | null>(null);
  // Track which planId was last synced so a re-click on Recommend
  // (different plan) re-fires; idempotent re-click on the same plan
  // doesn't.
  const syncedPlanIdRef = useRef<string | null>(null);

  const buildBody = useCallback((input: SyncInput) => {
    const todayIso = new Date().toISOString();
    return {
      client: {
        name: input.client.name,
        phone: input.client.phone,
        dob: input.client.dob,
        zip: input.client.zip,
        county: input.client.county,
        state: input.client.state,
        plan_type: input.client.planType,
        medicaid_confirmed: input.client.medicaidConfirmed,
        email: null,
      },
      recommended_plan: {
        contract_id: input.recommendedPlan.contract_id,
        plan_id: input.recommendedPlan.plan_number,
        // Plan.id has the canonical "H1036-308-0" form; the third
        // dash-separated segment is the segment_id we send to AgentBase.
        segment_id: (input.recommendedPlan.id.split('-')[2] ?? '0'),
        plan_name: input.recommendedPlan.plan_name,
        carrier: input.recommendedPlan.carrier,
        star_rating: input.recommendedPlan.star_rating,
        premium: input.recommendedPlan.premium,
        moop: input.recommendedPlan.moop_in_network,
        rx_deductible: input.recommendedPlan.drug_deductible,
        part_b_giveback: input.recommendedPlan.part_b_giveback,
        ribbon: input.recommendedScored.ribbon,
      },
      medications: input.medContext,
      providers: input.providerContext,
      brain_snapshot: {
        detected_conditions: input.brainResult.detectedConditions.map((d) => ({
          condition: d.condition,
          confidence: d.confidence,
        })),
        client_archetype: input.brainResult.archetype.archetype,
        archetype_label: input.brainResult.archetype.label,
        medication_patterns: input.brainResult.medicationPatterns.map((p) => ({
          id: p.id,
          severity: p.severity,
          summary: p.summary,
        })),
        applied_broker_rules: input.recommendedScored.appliedRules.map((r) => ({
          rule_id: r.ruleId,
          action: r.action,
          points: r.points,
          reason: r.reason,
        })),
        red_flags: input.recommendedScored.redFlags.map((f) => ({
          id: f.id,
          severity: f.severity,
          message: f.message,
        })),
        real_annual_cost: input.recommendedScored.realAnnualCost
          ? {
              premium: input.recommendedScored.realAnnualCost.premium,
              drugs: input.recommendedScored.realAnnualCost.drugs,
              medical_visits: input.recommendedScored.realAnnualCost.medicalVisits,
              supplies: input.recommendedScored.realAnnualCost.supplies,
              er_expected: input.recommendedScored.realAnnualCost.erExpected,
              hospital_expected: input.recommendedScored.realAnnualCost.hospitalExpected,
              giveback_savings: input.recommendedScored.realAnnualCost.givebackSavings,
              net_annual: input.recommendedScored.realAnnualCost.netAnnual,
            }
          : null,
        composite_score: input.recommendedScored.composite,
        weights: input.brainResult.weights,
        finalists_compared: input.brainResult.scored.map((s) => ({
          contract_id: s.plan.contract_id,
          plan_name: s.plan.plan_name,
          composite: s.composite,
        })),
      },
      session: {
        session_token: input.sessionId,
        started_at: new Date(input.startedAt).toISOString(),
        quote_date: todayIso,
        broker_id: input.brokerId,
        broker_npn: input.brokerNpn,
      },
      // Giveback flag drives AgentBase's AEP "Needs Attention" surface.
      // True when the recommended plan has a non-zero Part B giveback —
      // the broker should re-evaluate at next AEP because giveback
      // amounts shift year-over-year.
      giveback_plan_enrolled: (input.recommendedPlan.part_b_giveback ?? 0) > 0,
    };
  }, []);

  const postOnce = useCallback(async (body: unknown) => {
    // Debug log — full payload visibility for the meds/providers sync
    // investigation. Logged just before fetch so the broker (or
    // whoever's tailing the browser console) can see exactly what's
    // sent for any given Recommend click. Pulls counts up front so
    // the line is greppable even when the body itself collapses.
    if (typeof console !== 'undefined') {
      const b = body as {
        medications?: unknown[];
        providers?: unknown[];
        recommended_plan?: { plan_name?: string };
      };
      console.log(
        `[agentbase-recommend] POST body — meds=${b.medications?.length ?? 0} providers=${b.providers?.length ?? 0} plan="${b.recommended_plan?.plan_name ?? '?'}"`,
        body,
      );
    }
    const r = await fetch('/api/agentbase-recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await r.json().catch(() => ({}))) as
      | (RecommendSyncResult & { ok: boolean })
      | { ok: false; error: string };
    if (!r.ok || (json as { ok: boolean }).ok === false) {
      const msg = 'error' in json && typeof json.error === 'string'
        ? json.error
        : `agentbase-recommend ${r.status}`;
      throw new Error(msg);
    }
    return json as RecommendSyncResult & { ok: true };
  }, []);

  const sync = useCallback(async (input: SyncInput) => {
    const planId = input.recommendedPlan.id;
    // Idempotent same-plan re-click — skip the network round trip.
    if (syncedPlanIdRef.current === planId && state === 'synced') return;

    setState('syncing');
    setError(null);
    const body = buildBody(input);
    try {
      const r = await postOnce(body);
      setResult(r);
      setState('synced');
      syncedPlanIdRef.current = planId;
    } catch (err1) {
      console.warn('[agentbase-recommend] first attempt failed:', (err1 as Error).message);
      setState('retrying');
      await new Promise((resolve) => window.setTimeout(resolve, RETRY_DELAY_MS));
      try {
        const r = await postOnce(body);
        setResult(r);
        setState('synced');
        syncedPlanIdRef.current = planId;
      } catch (err2) {
        console.error('[agentbase-recommend] retry failed:', (err2 as Error).message);
        setError((err2 as Error).message);
        setState('error');
      }
    }
  }, [buildBody, postOnce, state]);

  const reset = useCallback(() => {
    setState('idle');
    setError(null);
    setResult(null);
    syncedPlanIdRef.current = null;
  }, []);

  return { state, error, result, sync, reset };
}
