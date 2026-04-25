export type SessionMode = 'new_quote' | 'annual_review';

export type StateCode = 'NC' | 'TX' | 'GA';

export type PlanType = 'MA' | 'MAPD' | 'DSNP' | 'PDP' | 'MEDSUPP';

export interface Client {
  name: string;
  phone: string;
  dob: string;
  zip: string;
  county: string;
  state: StateCode | null;
  planType: PlanType | null;
  medicaidConfirmed: boolean;
}

export interface Medication {
  id: string;
  rxcui?: string;
  name: string;
  strength?: string;
  form?: string;
  dosageInstructions?: string;
  prescribingPhysician?: string;
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
  mode: SessionMode;
  client: Client;
  medications: Medication[];
  providers: Provider[];
  notes: SessionNote[];
  plansCompared: string[];
  recommendation: string | null;
  complianceChecked: string[];
  disclaimersConfirmed: string[];
  /**
   * Annual-review mode only: beneficiary's current-year plan, looked up by
   * H-number. Null in new-quote mode.
   */
  currentPlanId: string | null;
  selectedFinalists: string[];
  /**
   * True when the recommended plan (or current plan in annual_review mode)
   * has Part B premium giveback > $0/mo. Surfaces an "RE-EVALUATE AT AEP"
   * badge on the Quote screen and feeds the Landing Needs-Attention list
   * during AEP (Oct 15 – Dec 7). Persists to AgentBase via agentbase-sync.
   */
  givebackPlanEnrolled: boolean;
}
