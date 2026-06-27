import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '', { auth: { persistSession: false, autoRefreshToken: false } });

async function main() {
  const { data: row } = await sb.from('pm_plans').select('*').limit(1).maybeSingle();
  console.log('pm_plans columns:', row ? Object.keys(row) : 'no rows');
  const { data: pbp } = await sb.from('pbp_benefits_2026').select('*').limit(1).maybeSingle();
  console.log('pbp_benefits_2026 columns:', pbp ? Object.keys(pbp).slice(0, 30) : 'no rows');
  const { data: pcache } = await sb.from('pm_provider_network_cache').select('*').limit(1).maybeSingle();
  console.log('pm_provider_network_cache columns:', pcache ? Object.keys(pcache) : 'no rows');
  const { data: form } = await sb.from('pm_formulary').select('*').limit(1).maybeSingle();
  console.log('pm_formulary columns:', form ? Object.keys(form) : 'no rows');
  const { data: dcc } = await sb.from('pm_drug_cost_cache').select('*').limit(1).maybeSingle();
  console.log('pm_drug_cost_cache columns:', dcc ? Object.keys(dcc) : 'no rows');
  const { data: pbenef } = await sb.from('pm_plan_benefits').select('*').limit(1).maybeSingle();
  console.log('pm_plan_benefits columns:', pbenef ? Object.keys(pbenef) : 'no rows');
}
main().then(() => process.exit(0));
