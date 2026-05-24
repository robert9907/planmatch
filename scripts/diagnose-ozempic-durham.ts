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
const RXCUIS = ['1991297','1991302','1991306','1991311','2398842','2599365','2619154','2736944','2736946','2736948'];
async function main() {
  // Get all Durham plans
  const { data: plans } = await sb.from('pm_plans')
    .select('contract_id, plan_id, plan_name, carrier')
    .eq('state', 'NC').ilike('county_name', '%Durham%');
  if (!plans) return;
  const contracts = [...new Set(plans.map(p => p.contract_id))];
  const planIds = [...new Set(plans.map(p => p.plan_id))];

  // Paginated fetch — covers the row-cap
  const all: { contract_id: string; plan_id: string; rxcui: string; tier: number | null; copay: number | null; coinsurance: number | null; prior_auth: boolean | null }[] = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data } = await sb.from('pm_formulary')
      .select('contract_id, plan_id, rxcui, tier, copay, coinsurance, prior_auth')
      .in('contract_id', contracts).in('plan_id', planIds).in('rxcui', RXCUIS)
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
  }
  console.log(`Total Ozempic rows for Durham plans: ${all.length}`);
  // Tier distribution
  const dist: Record<string, number> = {};
  for (const r of all) dist[String(r.tier)] = (dist[String(r.tier)] ?? 0) + 1;
  console.log('Durham tier distribution:', dist);
  // Any Tier 1 / 2 rows? Show them
  const low = all.filter(r => r.tier === 1 || r.tier === 2);
  console.log(`\nTier 1/2 rows in Durham: ${low.length}`);
  if (low.length > 0) {
    for (const r of low) {
      const planName = plans.find(p => p.contract_id === r.contract_id && p.plan_id === r.plan_id);
      console.log(`  ${r.contract_id}-${r.plan_id} (${planName?.carrier} | ${planName?.plan_name}) rxcui=${r.rxcui} tier=${r.tier} copay=${r.copay} coins=${r.coinsurance} pa=${r.prior_auth}`);
    }
  }
  // Plans WITHOUT any Ozempic row
  const planKeys = new Set(all.map(r => `${r.contract_id}-${r.plan_id}`));
  const planTriples = new Set(plans.map(p => `${p.contract_id}-${p.plan_id}`));
  const missing = [...planTriples].filter(k => !planKeys.has(k));
  console.log(`\nDurham plans with NO Ozempic formulary rows: ${missing.length}`);
  for (const k of missing) {
    const [c, p] = k.split('-');
    const pl = plans.find(x => x.contract_id === c && x.plan_id === p);
    console.log(`  ${k} (${pl?.carrier} | ${pl?.plan_name})`);
  }
}
main().catch(console.error);
