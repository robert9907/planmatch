// scripts/count-mg-rows.ts
//
// Quick count of medicare_gov-sourced rows in pbp_benefits (for any
// plan_id starting with H). Used to confirm the scraper has actually
// run against Durham/NC plans before assuming missing-benefit gaps
// can be backfilled from this source.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const url = process.env.SUPABASE_URL ?? '';
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  '';
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/ANON_KEY');
  process.exit(1);
}
const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  const { data, count, error } = await sb
    .from('pbp_benefits')
    .select('plan_id, benefit_type, source', { count: 'exact' })
    .eq('source', 'medicare_gov')
    .like('plan_id', 'H%')
    .limit(5);
  if (error) {
    console.error('Query error:', error);
    process.exit(1);
  }
  console.log(`Total medicare_gov rows in pbp_benefits: ${count}`);
  console.table(data ?? []);
}

main().catch(console.error);
