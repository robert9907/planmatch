import type { Client, Medication, Provider, SessionMode, SessionNote } from './session';

/**
 * Payload shape sent from PlanMatch to AgentBase's /api/planmatch-session.
 * Matches the kickoff-brief spec verbatim; mirrored in the AgentBase endpoint
 * so changes on either side need to happen together.
 */
export interface AgentBaseSyncPayload {
  client: {
    name: string;
    phone: string;
    dob: string;
    zip: string;
    county: string;
    state: string | null;
    plan_type: string | null;
    medicaid_confirmed: boolean;
  };
  session: {
    started_at: string;
    mode: SessionMode;
    session_token: string;
  };
  medications: Medication[];
  providers: Provider[];
  plans_compared: string[];
  recommendation: string | null;
  compliance: {
    items_checked: number;
    total: number;
    disclaimers_confirmed: boolean;
    checked_item_ids: string[];
    confirmed_disclaimer_ids: string[];
  };
  notes: SessionNote[];
  /**
   * True when the recommended plan has Part B premium giveback > $0/mo.
   * AgentBase keys its AEP review queue on this flag — it shows up in
   * the Landing Needs-Attention list during Oct 15 – Dec 7 with a
   * "re-evaluate giveback" reminder. Persisted alongside the session
   * record on the AgentBase side.
   */
  giveback_plan_enrolled: boolean;
  status: 'pending';
  source: 'planmatch';
  schema_version: 1;
}

export type AgentBaseSyncStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface AgentBaseSyncResponse {
  ok: boolean;
  session_id?: string;
  error?: string;
}

export function buildSyncPayload(input: {
  client: Client;
  sessionId: string;
  startedAt: number;
  mode: SessionMode;
  medications: Medication[];
  providers: Provider[];
  plansCompared: string[];
  recommendation: string | null;
  complianceChecked: string[];
  disclaimersConfirmed: string[];
  notes: SessionNote[];
  expectedDisclaimerIds: string[];
  givebackPlanEnrolled: boolean;
}): AgentBaseSyncPayload {
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
    },
    session: {
      started_at: new Date(input.startedAt).toISOString(),
      mode: input.mode,
      session_token: input.sessionId,
    },
    medications: input.medications,
    providers: input.providers,
    plans_compared: input.plansCompared,
    recommendation: input.recommendation,
    compliance: {
      items_checked: input.complianceChecked.length,
      total: input.complianceChecked.length + input.expectedDisclaimerIds.length,
      disclaimers_confirmed: input.expectedDisclaimerIds.every((id) =>
        input.disclaimersConfirmed.includes(id),
      ),
      checked_item_ids: input.complianceChecked,
      confirmed_disclaimer_ids: input.disclaimersConfirmed,
    },
    notes: input.notes,
    giveback_plan_enrolled: input.givebackPlanEnrolled,
    status: 'pending',
    source: 'planmatch',
    schema_version: 1,
  };
}
