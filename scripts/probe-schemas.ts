import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const sb = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function showCols(table: string, filter?: (q: any) => any) {
  let q = sb.from(table).select('*').limit(1);
  if (filter) q = filter(q);
  const { data, error } = await q;
  if (error) {
    console.log(`${table}: ERROR ${error.message}`);
    return;
  }
  const row = (data as any[])?.[0];
  if (!row) {
    console.log(`${table}: (empty)`);
    return;
  }
  console.log(`\n=== ${table} ===`);
  for (const [k, v] of Object.entries(row)) {
    const sample = v == null ? 'null' : typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : String(v).slice(0, 80);
    console.log(`  ${k}: ${sample}`);
  }
}

await showCols('pm_plans', (q) => q.eq('state', 'NC').ilike('county_name', 'Durham'));
await showCols('pm_plan_benefits');
await showCols('pm_drug_cost_cache');
await showCols('pm_provider_network_cache');
await showCols('pbp_benefits');
