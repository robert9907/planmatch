// agentbaseSync — builds the SyncInput payload that useAgentBaseRecommend
// expects, derived from agent-v3 session state + the brain output.
//
// The v4 quote table builds a richer SyncInput from per-column tier/
// monthly-cost maps the consumer table already computed. Agent v3
// doesn't materialize those columns the same way, so this helper
// constructs a minimal-but-complete SyncInput — enough for the
// /api/agentbase-recommend handler to write client + client_medications
// + client_providers rows and forward the brain snapshot to the
// webhook.
//
// Returns null when the brain hasn't ranked the picked plan (e.g. the
// broker hit Enroll before brain.result landed). Caller should bail.

import type { Plan } from '@/types/plans';
import type { Client, Medication, Provider } from '@/types/session';
import type { PlanBrainResult } from '@/hooks/usePlanBrain';
import type { SyncInput } from '@/hooks/useAgentBaseRecommend';
import { dedupeMedContext, dedupeProviderContext } from '@/lib/agentbaseSyncDedup';

/** Compliance snapshot shape — re-exported off SyncInput so screens
 *  that don't import from the hook can share the contract. */
export type ComplianceSnapshot = NonNullable<SyncInput['compliance']>;

/** Session-summary shape — same re-export pattern. */
export type AgentV3SessionSummary = NonNullable<SyncInput['sessionSummary']>;

// Rob's broker identity. Matches the values surfaced on
// ComplianceScreen + EnrollScreen disclaimers. Hardcoded because
// agent v3 is single-broker (Rob's CRM); when a second broker joins
// this becomes a session.broker selection.
const BROKER_NPN = '10447418';
const BROKER_ID = 'Rob Simm';

function providerNetworkStatus(
  provider: Provider,
  planId: string,
): 'in' | 'out' | 'unknown' {
  const raw = provider.networkStatus?.[planId];
  if (raw === 'in' || raw === 'out' || raw === 'unknown') return raw;
  return 'unknown';
}

interface BuildArgs {
  plan: Plan;
  client: Client;
  medications: Medication[];
  providers: Provider[];
  brainResult: PlanBrainResult | null;
  sessionId: string;
  startedAt: number;
  /** AgentBase clients.id hydrated from the ?clientId= deep-link. When
   *  present, the recommend endpoint skips its phone/dob match. */
  agentbaseClientId?: number | null;
  /** Optional CMS compliance snapshot — only the EnrollScreen call
   *  populates this. Forwarded straight through to the endpoint. */
  compliance?: SyncInput['compliance'];
  /** Optional session summary for the activity log. */
  sessionSummary?: SyncInput['sessionSummary'];
}

export function buildAgentV3SyncInput(args: BuildArgs): SyncInput | null {
  const {
    plan,
    client,
    medications,
    providers,
    brainResult,
    sessionId,
    startedAt,
    agentbaseClientId,
    compliance,
    sessionSummary,
  } = args;
  if (!brainResult) return null;
  const recommendedScored = brainResult.scored.find((s) => s.plan.id === plan.id);
  if (!recommendedScored) return null;

  const medContext = medications.map((m) => ({
    name: m.name,
    rxcui: m.rxcui ?? null,
    dose: m.dose ?? null,
    form: m.form ?? null,
    frequency: m.frequency ?? null,
    refill_days: null,
    tier_on_recommended_plan: null,
    monthly_cost: null,
    pa_required: false,
    st_required: false,
  }));

  const providerContext = providers.map((p) => ({
    name: p.name,
    npi: p.npi ?? '',
    specialty: p.specialty ?? null,
    network_status: providerNetworkStatus(p, plan.id),
  }));

  return {
    client,
    sessionId,
    startedAt,
    brokerNpn: BROKER_NPN,
    brokerId: BROKER_ID,
    recommendedPlan: plan,
    recommendedScored,
    medications,
    providers,
    brainResult,
    medContext: dedupeMedContext(medContext),
    providerContext: dedupeProviderContext(providerContext),
    agentbaseClientId: agentbaseClientId ?? null,
    compliance: compliance ?? null,
    sessionSummary: sessionSummary ?? null,
  };
}
