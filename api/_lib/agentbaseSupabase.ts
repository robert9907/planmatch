// Service-role client for the AgentBase CRM Supabase project
// (wyyasqvouvdcovttzfnv.supabase.co). Plan Match's own data lives in
// plan-match-prod (rpcbrkmvalvdmroqzpaq) and is reached via
// api/_lib/supabase.ts — the two projects are separate, so anything
// that reads/writes the clients / client_medications / client_providers
// / providers tables on the AgentBase side must come through here.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function agentbaseSupabase(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.AGENTBASE_SUPABASE_URL;
  const key = process.env.AGENTBASE_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'AGENTBASE_SUPABASE_URL and AGENTBASE_SUPABASE_SERVICE_ROLE_KEY must be set',
    );
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
