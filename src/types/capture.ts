export type CaptureStatus = 'waiting' | 'has_results' | 'completed' | 'expired';

export interface ExtractedMedication {
  type: 'medication';
  drug_name: string;
  strength: string | null;
  form: string | null;
  dosage_instructions: string | null;
  prescribing_physician: string | null;
  pharmacy_name: string | null;
  pharmacy_phone: string | null;
  /** Pharmacy place as printed — sharpens the NPPES match. */
  pharmacy_city?: string | null;
  pharmacy_state?: string | null;
  pharmacy_zip?: string | null;
  /** Server-added: the label's pharmacy matched to NPPES and filed in
   *  AgentBase's providers directory (pharmacy_id = providers.id). */
  pharmacy_npi?: string | null;
  pharmacy_id?: number | null;
  pharmacy_address?: string | null;
  /** Client answered "Is this your pharmacy?" on the Snap Link page. */
  pharmacy_confirmed?: boolean;
  /** Client said "Not my doctor" for this label's prescriber. */
  prescriber_declined?: boolean;
  refills_remaining: number | string | null;
  last_filled: string | null;
  /** QTY dispensed — usually printed under the barcode. */
  quantity?: number | string | null;
  days_supply?: number | string | null;
  ndc_code: string | null;
  confidence: 'high' | 'medium' | 'low';
}

export interface ExtractedProvider {
  type: 'provider';
  provider_name: string;
  credentials: string | null;
  specialty: string | null;
  practice_name: string | null;
  phone: string | null;
  address: string | null;
  accepting_new_patients: boolean | null;
}

export interface ExtractedUnknown {
  type: 'unknown';
  note: string;
}

export interface ExtractedMedicareCard {
  type: 'medicare_card';
  member_name: string | null;
  /** Always masked ("•••• MK72") by the time it reaches the browser. */
  medicare_number: string | null;
  part_a_effective: string | null;
  part_b_effective: string | null;
}

export type ExtractedItem = ExtractedMedication | ExtractedProvider | ExtractedMedicareCard | ExtractedUnknown;

export interface CaptureItem {
  id: string;
  created_at: string;
  /** Set when the client's pharmacy / doctor answers rewrite this item. */
  updated_at?: string;
  /** @deprecated Capture photos are no longer stored. Present only on
   *  items written before that change. */
  image_url?: string;
  extracted: ExtractedItem[];
  error?: string;
}

export interface CaptureStartResponse {
  token: string;
  link: string;
  status: CaptureStatus;
  created_at: string;
  expires_at: string;
  sms: { sid: string } | { error: string } | null;
}

export interface CapturePollResponse {
  token: string;
  status: CaptureStatus;
  total_items: number;
  new_items: CaptureItem[];
  last_item_at: string | null;
  expires_at: string;
  client_name: string | null;
}

export interface CaptureGuidance {
  /** Medication bottles read in this photo. */
  bottle_count: number;
  /** One bottle, one photo, quantity or fill date missing → ask for one
   *  more picture of the same bottle. */
  needs_more: boolean;
  /** False when nothing usable came off the photo (blurry, too far). */
  readable: boolean;
}

export interface CaptureSubmitResponse {
  ok: true;
  item_id: string;
  extracted: ExtractedItem[];
  guidance?: CaptureGuidance;
  /** What this photo read, for the "Is this your pharmacy / doctor?"
   *  check at the end of the visit. */
  snap?: SnapSummary;
  /** @deprecated Capture photos are no longer stored. Present only on
   *  items written before that change. */
  image_url?: string;
  error?: string;
}

export interface SnapPharmacyRead {
  name: string | null;
  npi: string | null;
  address: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

export interface SnapSummary {
  med_names: string[];
  pharmacy: SnapPharmacyRead | null;
  prescribers: string[];
}

export interface PharmacyChoice {
  npi?: string | null;
  name: string;
  address1?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  phone?: string | null;
  mailOrder?: boolean;
}
