import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

export interface CaptureItem {
  id: string;
  created_at: string;
  image_url: string;
  extracted: ExtractedItem[];
  raw_response?: string;
  error?: string;
}

export type ExtractedItem = ExtractedMedication | ExtractedProvider | ExtractedUnknown;

export interface ExtractedMedication {
  type: 'medication';
  drug_name: string;
  strength: string | null;
  form: 'tablet' | 'capsule' | 'liquid' | 'injection' | string | null;
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

export interface CaptureSessionRow {
  id: string;
  token: string;
  status: 'waiting' | 'has_results' | 'completed' | 'expired';
  client_name: string | null;
  client_phone: string | null;
  started_by: string | null;
  payload: CaptureItem[];
  item_count: number;
  last_item_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}
