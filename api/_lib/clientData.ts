// Client / shopper records (HIPAA Phase 2, Nov 2026).
//
// Anything that identifies a person — Snap Link capture sessions, provider
// evidence recorded at enrollment, etc. — lives in the AgentBase database on
// Google Cloud (covered by the Google BAA), schema `planmatch`. Plan reference
// data (plans, formularies, network cache) stays in plan-match-prod via
// ./supabase.ts. Same PostgREST API, so callers use the normal supabase-js
// query builder; only the client differs.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// The schema generic must name 'planmatch' or supabase-js types every
// .from() call against 'public'.
type ClientDataDb = SupabaseClient<any, 'planmatch', any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let cached: ClientDataDb | null = null;

export function clientData(): ClientDataDb {
  if (cached) return cached;
  const url = process.env.AGENTBASE_SUPABASE_URL;
  const key = process.env.AGENTBASE_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('AGENTBASE_SUPABASE_URL and AGENTBASE_SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  cached = createClient(url, key, {
    db: { schema: 'planmatch' },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
