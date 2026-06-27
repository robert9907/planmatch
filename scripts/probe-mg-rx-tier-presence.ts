import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', { auth: { persistSession: false, autoRefreshToken: false }});
async function main() {
  for (const [c, p] of [['S5601','016'],['S5884','133'],['S4802','081'],['S5540','002']]) {
    console.log(`\n=== ${c}-${p} pbp rx_tier* rows ===`);
    const variants = [`${c}-${p}`, `${c}-${p}-0`];
    const { data } = await sb
      .from('pbp_benefits')
      .select('plan_id, benefit_type, tier_id, copay, coinsurance, description, source')
      .in('plan_id', variants)
      .like('benefit_type', 'rx_tier%');
    if (!data?.length) {
      console.log('  NO rx_tier* rows');
      continue;
    }
    for (const r of data) console.log(`  ${JSON.stringify(r)}`);

    // Also pm_formulary samples
    console.log(`  --- pm_formulary distinct (tier, copay, coinsurance) for ${c}-${p} ---`);
    const { data: pf } = await sb
      .from('pm_formulary')
      .select('tier, copay, coinsurance')
      .eq('contract_id', c)
      .eq('plan_id', p);
    const seen = new Map<number, { copay: number | null; coins: number | null; count: number }>();
    for (const r of pf ?? []) {
      const k = r.tier as number;
      const existing = seen.get(k);
      if (existing) existing.count++;
      else seen.set(k, { copay: r.copay as number | null, coins: r.coinsurance as number | null, count: 1 });
    }
    for (const [t, v] of [...seen.entries()].sort()) {
      console.log(`    tier=${t}  copay=${v.copay}  coins=${v.coins}  count=${v.count}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
