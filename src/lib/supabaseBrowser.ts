// Browser-side Supabase client (anon key) for plan-match-prod.
//
// Mirrors the consumer repo's apps/web/src/lib/supabase.ts. Used for
// public-read tables (pm_provider_network_cache, pm_provider_directory,
// pm_manufacturer_assistance) that don't need the service-role round
// trip through a Vercel Function.
//
// RLS is set to public-read on those tables in plan-match-prod, so
// anon reads work the same way they do for the consumer-facing app.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function supabaseBrowser(): SupabaseClient {
  if (cached) return cached;
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    console.warn(
      '[planmatch] VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY missing — direct cache reads will fail',
    );
  }
  cached = createClient(url ?? '', key ?? '', {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
