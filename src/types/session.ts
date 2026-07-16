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

/** CMS enrollment period the beneficiary is using. Determines whether
 *  enrollment is legally permitted and which compliance language applies. */
export type EnrollmentPeriod = 'IEP' | 'ICEP' | 'SEP' | 'OEP' | 'AEP';

/** The six life-event SEP reasons a beneficiary can select. These are
 *  the ONLY SEP paths exposed in the UI (consumer or agent). The system
 *  auto-maps each to the correct CMS SEP reason code internally.
 *  Full CMS taxonomy is intentionally excluded to prevent SEP fraud. */
export type SepLifeEvent =
  | 'moved'            // → CMS code MOV
  | 'lost_employer'    // → CMS code LEC
  | 'lost_aca'         // → CMS code LCC
  | 'left_facility'    // → CMS code LTC
  | 'new_medicaid'     // → CMS code MCD
  | 'doctor_left';     // → CMS code DIF

/** Internal CMS SEP reason code. Never shown in the UI — auto-derived
 *  from SepLifeEvent. Stored in session and synced to AgentBase for
 *  compliance audit trail. */
export type SepReasonCode = 'MOV' | 'LEC' | 'LCC' | 'LTC' | 'MCD' | 'DIF';

/** Maps a plain-English life event to its CMS SEP reason code. */
export const SEP_LIFE_EVENT_TO_CMS: Record<SepLifeEvent, SepReasonCode> = {
  moved: 'MOV',
  lost_employer: 'LEC',
  lost_aca: 'LCC',
  left_facility: 'LTC',
  new_medicaid: 'MCD',
  doctor_left: 'DIF',
};

/** Display labels for each life event (used in both consumer and agent UI). */
export const SEP_LIFE_EVENT_LABELS: Record<SepLifeEvent, { title: string; subtitle: string }> = {
  moved:          { title: 'I recently moved',                              subtitle: 'New address, might need different plans' },
  lost_employer:  { title: "I'm losing my job's health insurance",          subtitle: "Retiring, laid off, or spouse's plan ending" },
  lost_aca:       { title: "I'm losing my ACA / Marketplace plan",          subtitle: 'Coverage ending or unaffordable' },
  left_facility:  { title: "I'm leaving a nursing home or rehab",           subtitle: 'Being discharged, need a plan' },
  new_medicaid:   { title: 'I just qualified for Medicaid or Extra Help',   subtitle: 'Income changed, now eligible' },
  doctor_left:    { title: "My doctor left my plan's network",              subtitle: "Can't see my doctor without switching" },
};

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
  /** Dual-eligible (Medicaid + Medicare) flag captured by the broker
   *  on the Intake screen. Strict `=== true` everywhere downstream
   *  (plan-brain.ts:isStrictlyDualEligible) — `undefined` / `false`
   *  both mean "treat as standard population." When true, the brain's
   *  filterPlanPool keeps D-SNP plans in the Compare bench pool;
   *  otherwise they're stripped before scoring. Optional so older
   *  session payloads / AgentBase hydrations don't need a backfill. */
  dsnpEligible?: boolean;
  /** Medicaid category — drives the brain's medical cost-sharing
   *  zeroing (QMB or FBDE) and Part C premium payment (QMB+ on
   *  D-SNP). Broker sets on the Intake screen; usePlanBrain forwards
   *  to UserProfile.medicaidLevel. Optional so hydrated sessions
   *  and older AgentBase payloads keep decoding — undefined means
   *  "not yet captured" and the brain treats it as 'none'.
   *  Runs alongside `medicaidConfirmed` during the transition; the
   *  boolean stays until every downstream reader (D-SNP eligibility
   *  gate, AgentBase sync, QuoteDelivery ContextField) is migrated. */
  medicaidLevel?: 'none' | 'qi' | 'slmb' | 'qmb' | 'fbde';
  /** LIS (Extra Help) copay tier — drives the brain's Part D copay
   *  override. Auto-deemed from `medicaidLevel` + `livingSetting`
   *  by IntakeScreen via deemLisTier(); broker can override for
   *  LIS-only clients who applied directly (no Medicaid). Optional
   *  for the same session-decode reason as medicaidLevel. */
  lisTier?: 'none' | 'full_institutional' | 'full_low' | 'full_high';
  /** Living setting — only affects LIS tier for FBDE (community →
   *  full_low, institutional/HCBS → full_institutional). Defaults
   *  to 'community' when omitted. */
  livingSetting?: 'community' | 'institutional_or_hcbs';
  /** Enrollment period the beneficiary is using. Required for compliance
   *  documentation and enrollment gating. Undefined means not yet captured. */
  enrollmentPeriod?: EnrollmentPeriod;
  /** Plain-English life event when enrollmentPeriod === 'SEP'. The system
   *  derives the CMS sepReasonCode from this via SEP_LIFE_EVENT_TO_CMS. */
  sepLifeEvent?: SepLifeEvent;
  /** CMS SEP reason code — auto-derived from sepLifeEvent, NEVER set
   *  directly by the user. Stored for AgentBase sync and compliance. */
  sepReasonCode?: SepReasonCode;
  /** True when the user fills prescriptions through VA or Express Scripts
   *  (TRICARE). Lets the brain include MA-only plans (no Part D) in the
   *  pool — these plans often have better extras but no drug coverage,
   *  which is fine when the beneficiary already has creditable drug
   *  coverage through VA/TRICARE. */
  hasVaDrugCoverage?: boolean;
}

export interface Medication {
  id: string;
  rxcui?: string;
  name: string;
  /** Original free-text drug name as it arrived from an external
   *  source (CRM row, photo capture OCR). Preserved so the agent can
   *  see what was filed and re-search from that starting point when
   *  the RxNorm resolver couldn't map it to a canonical drug. */
  originalName?: string;
  // Canonical-type alignment. Currently not populated by Agent A's
  // hydration path (CRM only stores `name`); kept for the brain
  // input rule `name: m.genericName ?? m.name`, which is a no-op
  // here until a future phase wires brand/generic resolution from
  // the drug-search side.
  genericName?: string;
  brandName?: string;
  brandRxcui?: string;
  // True when the drug-search hit that produced this medication was a
  // branded product (pm_drugs.is_brand, derived from RxNorm TTY = SBD/
  // BPCK at import). Threaded through UserProfile.drugs into the
  // brain's per-drug cost breakdown so the LIS override in
  // dual-eligible.ts (rollout step 3) can pick the correct generic
  // vs. brand copay cap. Optional — capture / AgentBase-hydration
  // paths that don't carry the flag default it to false (safer: LIS
  // generic copay is lower).
  isBrand?: boolean;
  // Renamed from `strength` to align with CanonicalMedication.
  dose?: string;
  form?: string;
  // Renamed from `dosageInstructions`. Free-text dosing schedule
  // (e.g. "Daily", "2x/day", "As needed"). Builders that compose
  // it from dose+schedule still write here.
  frequency?: string;
  prescribingPhysician?: string;
  // Optional fields hydrated from AgentBase client_medications.
  // Quantity stays free text because brokers enter values like
  // "1 box" / "0.5 mL" in the CRM and we want those preserved on
  // hydration. tier moves to numeric (1-6) to match the canonical
  // type; the hydration adapter parses "Tier N" → N during the
  // migration window. refillDays moves to numeric — DB values are
  // all "30"/"60"/"90".
  tier?: number;
  quantity?: string;
  refillDays?: number;
  // Migration 011 broker-entry context, hydrated from AgentBase so a
  // re-quote starts with the same pharmacy / refill date / notes the
  // broker filed in the CRM. Round-trips back on the next sync.
  pharmacyId?: number;
  refillDate?: string;
  notes?: string;
  // Canonical superset per Phase 1 audit. Agent A historically used
  // manual|capture; widened so a hydrated row carrying agentbase/
  // search/import/quick-add/scan doesn't get rewritten to 'manual'
  // at the boundary.
  source: 'manual' | 'capture' | 'search' | 'scan' | 'quick-add' | 'agentbase' | 'import';
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
