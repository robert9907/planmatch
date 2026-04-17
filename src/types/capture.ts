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
  refills_remaining: number | string | null;
  last_filled: string | null;
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

export type ExtractedItem = ExtractedMedication | ExtractedProvider | ExtractedUnknown;

export interface CaptureItem {
  id: string;
  created_at: string;
  image_url: string;
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

export interface CaptureSubmitResponse {
  ok: true;
  item_id: string;
  extracted: ExtractedItem[];
  image_url: string;
  error?: string;
}
