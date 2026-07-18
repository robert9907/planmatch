import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

async function main() {
  // 1. Global drug_cost_cache size
  const { count: dccCount } = await sb.from('pm_drug_cost_cache').select('*', { count: 'exact', head: true });
  console.log(`pm_drug_cost_cache TOTAL rows: ${dccCount}`);

  // 2. All benefit_category values (distinct)
  const { data: bcRows } = await sb.rpc('exec', { sql: '' }).then(() => ({ data: null })).catch(() => ({ data: null }));
  // Simpler: fetch a sample and dedupe
  const bcAll = new Set<string>();
  let page = 0;
  while (page < 30) {
    const { data, error } = await sb.from('pm_plan_benefits')
      .select('benefit_category')
      .range(page * 1000, page * 1000 + 999);
    if (error) { console.error(error); break; }
    if (!data || data.length === 0) break;
    data.forEach(r => bcAll.add(r.benefit_category));
    if (data.length < 1000) break;
    page++;
  }
  console.log(`\nALL pm_plan_benefits.benefit_category values (${bcAll.size} distinct):`);
  [...bcAll].sort().forEach(c => console.log(`   ${c}`));

  // 3. Check pbp_benefits for dental_preventive / dental_comprehensive taxonomy
  const { data: pbpSample } = await sb.from('pbp_benefits').select('benefit_type').limit(2000);
  const pbpTypes = new Set((pbpSample ?? []).map(r => r.benefit_type));
  console.log(`\npbp_benefits.benefit_type sample distinct: ${pbpTypes.size}`);
  [...pbpTypes].sort().forEach(t => console.log(`   ${t}`));

  // 4. Full non-commissionable table
  const { data: ncFull } = await sb.from('pm_non_commissionable_contracts').select('*').order('contract_id');
  console.log(`\npm_non_commissionable_contracts (${ncFull?.length} rows):`);
  (ncFull ?? []).forEach(r => console.log(`   ${r.contract_id}  plan_number=${r.plan_number ?? '(all)'}  carrier=${r.carrier ?? ''}  notes=${r.notes ?? ''}`));

  // 5. Star rating nulls — check if there is a "too new" flag
  const { data: nullStars } = await sb.from('pm_plans')
    .select('contract_id, plan_id, carrier, plan_name, star_rating')
    .is('star_rating', null)
    .in('state', ['NC', 'TX', 'GA'])
    .limit(15);
  console.log(`\nSample null star_rating plans:`);
  (nullStars ?? []).forEach(r => console.log(`   ${r.contract_id}-${r.plan_id}  ${r.carrier}  ${r.plan_name}`));
}
main();
