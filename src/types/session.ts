// Wire-format mode label sent to AgentBase. Internally the session
// stores `isAnnualReview: boolean` — `mode` is derived at the sync
// boundary (see buildSyncPayload). Keep the literal type so the
// AgentBase webhook contract remains explicit.
export type SessionMode = 'new_quote' | 'annual_review';

export type StateCode = 'NC' | 'TX' | 'GA';

export type PlanType = 'MA' | 'MAPD' | 'DSNP' | 'CSNP' | 'ISNP' | 'PDP' | 'MEDSUPP';

/** The 4 CMS C-SNP-qualifying conditions the brain accepts as a
 *  self-report. Matches CsnpConditionKey in lib/library-client.ts. */
export type CsnpConditionCode = 'diabetes' | 'cardio' | 'copd' | 'esrd';

export interface Client {
  name: string;
  phone: string;
  dob: string;
  zip: string;
  county: string;
  state: StateCode | null;
  planType: PlanType | null;
  medicaidConfirmed: boolean;
  // Optional — collected by the agent-v3 IntakeScreen. Existing v4
  // intake doesn't capture these yet, so they stay optional to avoid
  // forcing a backfill across older session payloads / AgentBase
  // hydration paths.
  email?: string;
  mbi?: string;
  /** Self-reported chronic conditions captured by the broker on the
   *  Intake screen. Forwarded to /api/library/rank-plans so the
   *  brain's C-SNP routing fires even when the client's med list has
   *  no qualifying drugs (e.g. diet-controlled diabetes). Optional;
   *  empty / absent means "med-detection only". */
  csnpConditions?: CsnpConditionCode[];
}

export interface Medication {
  id: string;
  rxcui?: string;
  name: string;
  strength?: string;
  form?: string;
  dosageInstructions?: string;
  prescribingPhysician?: string;
  // Optional fields hydrated from AgentBase client_medications.
  // Quantity is per-fill free text ("30", "1 box"); tier is the
  // CRM-side formulary tier text ("Tier 1", "Tier 3 - Preferred Brand").
  // Both pass through unchanged so the broker sees what the CRM filed
  // without re-deriving on this side.
  tier?: string;
  quantity?: string;
  refillDays?: string;
  source: 'manual' | 'capture';
  confidence?: 'high' | 'medium' | 'low';
  addedAt: number;
}

export interface Provider {
  id: string;
  npi?: string;
  name: string;
  specialty?: string;
  address?: string;
  phone?: string;
  source: 'manual' | 'capture' | 'from_med';
  networkStatus?: Record<string, 'in' | 'out' | 'unknown'>;
  manuallyConfirmed?: boolean;
  /**
   * Per-carrier "I verified this is in-network" overrides. Keyed by
   * carrier name (e.g. "UnitedHealthcare"). When set, every plan from
   * that carrier is treated as in-network for this provider regardless
   * of what the directory check returned. The note captures *how* Rob
   * verified — typically "called the office" or "saw provider in the
   * carrier's findcare portal."
   */
  manualOverrides?: Record<string, { status: 'in'; note: string; at: number }>;
  addedAt: number;
}

export type NoteType =
  | 'general'
  | 'concern'
  | 'preference'
  | 'followup'
  | 'question'
  | 'objection'
  | 'decision'
  | 'compliance'
  | 'medical'
  | 'financial';

export interface SessionNote {
  id: string;
  type: NoteType;
  body: string;
  createdAt: number;
  carrier?: string;
  scenario?: string;
}

export interface SessionState {
  sessionId: string;
  startedAt: number;
  /**
   * True when the broker has flipped the workflow into AEP / Annual
   * Review mode (Step6 toggle, or auto-flipped by LandingPage when a
   * hydrated AgentBase client carries a current_plan_id). Drives:
   *   • QuoteDeliveryV4 prompts for the current plan if missing,
   *     pins it as the benchmark column, switches Why-switch copy to
   *     vs-current framing, and computes a stay/switch verdict.
   *   • The printable PDF cover title flips from "Medicare Plan
   *     Comparison" → "Annual Plan Review".
   *   • buildSyncPayload derives the legacy `mode` literal sent to
   *     AgentBase from this flag.
   */
  isAnnualReview: boolean;
  client: Client;
  medications: Medication[];
  providers: Provider[];
  notes: SessionNote[];
  plansCompared: string[];
  recommendation: string | null;
  complianceChecked: string[];
  disclaimersConfirmed: string[];
  /** ISO timestamp captured the moment a checklist item is checked.
   *  Keyed by item id (see src/lib/compliance.ts SECTIONS). Removed
   *  when the item is unchecked. CMS audits require proof of WHEN a
   *  topic was discussed, not just that the checkbox was clicked. */
  complianceTimestamps: Record<string, string>;
  /** ISO timestamp captured when a verbatim disclaimer is confirmed.
   *  Keyed by disclaimer id (tpmo / call_recording / soa). One-way:
   *  confirmDisclaimer is irreversible in the session store, so this
   *  map only grows. */
  disclaimerTimestamps: Record<string, string>;
  /**
   * Annual-review mode only: beneficiary's current-year plan, looked up by
   * H-number. Null in new-quote mode.
   */
  currentPlanId: string | null;
  /**
   * Explicit "no current plan" marker. Distinguishes between
   *   (a) currentPlanId === null && noCurrentPlan === false → unselected (block Continue)
   *   (b) currentPlanId === null && noCurrentPlan === true  → new to Medicare
   *   (c) currentPlanId !== null                            → has a current plan
   * The Quote page reads (c) to render the gray benchmark column;
   * (b) renders a "No current plan to compare" note instead.
   */
  noCurrentPlan: boolean;
  selectedFinalists: string[];
  /**
   * True when the recommended plan (or current plan in annual_review mode)
   * has Part B premium giveback > $0/mo. Surfaces an "RE-EVALUATE AT AEP"
   * badge on the Quote screen and feeds the Landing Needs-Attention list
   * during AEP (Oct 15 – Dec 7). Persists to AgentBase via agentbase-sync.
   */
  givebackPlanEnrolled: boolean;
}
