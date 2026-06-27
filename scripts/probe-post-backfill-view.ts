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
  // Verify pm_formulary view picks up the new values for S5601-016 + S5884-133
  for (const [c, p] of [['S5601','016'],['S5884','133']]) {
    console.log(`\n=== pm_formulary view for ${c}-${p} (5 sample rows per tier) ===`);
    const { data } = await sb.from('pm_formulary').select('rxcui, drug_name, tier, copay, coinsurance').eq('contract_id', c).eq('plan_id', p).limit(1500);
    const byTier = new Map<number, Array<typeof data[number]>>();
    for (const r of data ?? []) {
      const t = r.tier as number;
      const arr = byTier.get(t) ?? [];
      arr.push(r);
      byTier.set(t, arr);
    }
    for (const [t, arr] of [...byTier.entries()].sort()) {
      console.log(`  tier ${t}: ${arr.length} rows`);
      for (const r of arr.slice(0, 2)) console.log(`    rxcui=${r.rxcui} copay=${r.copay} coins=${r.coinsurance} drug="${(r.drug_name as string ?? '').slice(0,40)}"`);
    }
  }

  // Also test the lookup_formulary_coverage RPC if it exists
  console.log('\n=== lookup_formulary_coverage RPC for metformin (6809) at S5601-016 ===');
  const { data: rpc, error } = await sb.rpc('lookup_formulary_coverage', {
    plan_pairs: [{ contract_id: 'S5601', plan_id: '016' }],
    rxcuis: ['6809']
  });
  if (error) console.log('RPC error:', error.message);
  else console.log(JSON.stringify(rpc, null, 2));

  console.log('\n=== lookup_formulary_coverage RPC for Eliquis (1364430) at S5884-133 ===');
  const { data: rpc2, error: e2 } = await sb.rpc('lookup_formulary_coverage', {
    plan_pairs: [{ contract_id: 'S5884', plan_id: '133' }],
    rxcuis: ['1364430']
  });
  if (e2) console.log('RPC error:', e2.message);
  else console.log(JSON.stringify(rpc2, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
