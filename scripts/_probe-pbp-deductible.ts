// Verify pbp_plan_facts_v2 holds the annual_deductible value that
// pm_plans.annual_deductible is null for. Spot-check 5 plans.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
async function main() {
  if (existsSync('.env.local')) {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
    }
  }
  const sb = createClient(process.env.SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY)!, { auth: { persistSession: false, autoRefreshToken: false } });

  const samples = [
    { c: 'H3449', p: '023', s: '2' }, // Margaret Blue Medicare Essential Plus
    { c: 'H3146', p: '004', s: '0' }, // Aetna Medicare Signature
    { c: 'H1036', p: '308', s: '0' }, // Humana Gold Plus
    { c: 'H7849', p: '113', s: '3' }, // Linda's PPO
    { c: 'H1914', p: '007', s: '0' }, // Linda's other PPO
  ];

  for (const x of samples) {
    const { data: pbp } = await sb.from('pbp_plan_facts_v2')
      .select('contract_id, plan_id, segment_id, annual_deductible, rx_deductible, moop_in_network, moop_combined, plan_type, plan_year')
      .eq('contract_id', x.c).eq('plan_id', x.p).eq('plan_year', 2026)
      .limit(5);
    const { data: pm } = await sb.from('pm_plans')
      .select('contract_id, plan_id, segment_id, annual_deductible, moop, drug_deductible, plan_type')
      .eq('contract_id', x.c).eq('plan_id', x.p)
      .limit(5);
    console.log(`\n=== ${x.c}-${x.p}-${x.s} ===`);
    console.log('pbp_plan_facts_v2 (source of truth):');
    for (const r of pbp ?? []) console.log(`  seg=${r.segment_id} year=${r.plan_year} annual_ded=${r.annual_deductible} rx_ded=${r.rx_deductible} moop_in=${r.moop_in_network} moop_comb=${r.moop_combined}`);
    console.log('pm_plans (consumed by audit):');
    for (const r of pm ?? []) console.log(`  seg=${r.segment_id} annual_ded=${r.annual_deductible} moop=${r.moop} drug_ded=${r.drug_deductible}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
