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
  /** Optional CRM health-profile snapshot — passed straight through to
   *  the endpoint so it can upsert client_health_profiles with
   *  synced_to_planmatch_at set. Callers hydrate this from the CRM's
   *  /api/client-health-profile GET when the deep-link carried a
   *  clientId; absent otherwise (endpoint no-ops the write). */
  healthContext?: SyncInput['healthContext'];
}

export async function buildAgentV3SyncInput(args: BuildArgs): Promise<SyncInput | null> {
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
    healthContext: providedHealthContext,
  } = args;
  if (!brainResult) return null;
  // Search both scored (top ranked) and bench (runners-up) — a plan picked
  // by the broker on Compare / Compliance / Enroll can be in either set,
  // and the endpoint just needs the ScoredPlan shape for the CMS audit
  // trail. Restricting to `.scored` was the false-positive source of
  // "Brain ranking not ready — try again in a moment." when the picked
  // plan lived in bench.
  const recommendedScored =
    brainResult.scored.find((s) => s.plan.id === plan.id) ??
    brainResult.bench.find((s) => s.plan.id === plan.id);
  if (!recommendedScored) return null;

  // pa_required / st_required intentionally omitted. The agent-v3
  // path doesn't compute per-drug per-plan PA/ST flags before the
  // Recommend fires; sending hardcoded `false` here was Phase 5 noise
  // that the agentbase-recommend endpoint treated as authoritative.
  // QuoteDeliveryV4 (v4 flow) still sends real values from brain
  // output — those fields are now optional in SyncInput.
  const medContext = medications.map((m) => ({
    name: m.name,
    rxcui: m.rxcui ?? null,
    dose: m.dose ?? null,
    form: m.form ?? null,
    frequency: m.frequency ?? null,
    refill_days: null,
    tier_on_recommended_plan: null,
    monthly_cost: null,
  }));

  const providerContext = providers.map((p) => ({
    name: p.name,
    npi: p.npi ?? '',
    specialty: p.specialty ?? null,
    network_status: providerNetworkStatus(p, plan.id),
  }));

  // Pull the CRM's health profile via the same-origin proxy endpoint
  // (server-side reads client_health_profiles from the CRM Supabase
  // using agentbaseSupabase — see api/agentbase-health-profile.ts).
  // Same-origin so the browser doesn't CORS-block against
  // agentbase-crm.vercel.app. Caller-provided healthContext wins if
  // present — that path is reserved for future flows that hydrate
  // health data alongside the session, so a re-fetch here would be
  // wasted. Fires only when agentbaseClientId is known (deep-linked
  // flow); anonymous sessions have no CRM row to read.
  let healthContext: SyncInput['healthContext'] = providedHealthContext ?? null;
  if (!healthContext && agentbaseClientId != null) {
    try {
      const hpRes = await fetch(
        `/api/agentbase-health-profile?client_id=${agentbaseClientId}`,
      );
      if (hpRes.ok) {
        const hpData = await hpRes.json();
        if (hpData?.profile) {
          healthContext = {
            conditions: hpData.profile.conditions ?? [],
            family_history: hpData.profile.family_history ?? {},
            lifestyle: hpData.profile.lifestyle ?? {},
            utilization: hpData.profile.utilization ?? {},
            complexity_scores: hpData.profile.complexity_scores ?? {},
            risk_flags: hpData.profile.risk_flags ?? [],
          };
        }
      }
    } catch (e) {
      console.error('[agentbaseSync] health profile fetch failed:', e);
    }
  }

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
    healthContext,
  };
}
