// Round 4: check ALL rows including segment_id format, and look for dupes.

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

  const { data } = await sb.from('pm_plan_benefits')
    .select('id, contract_id, plan_id, segment_id, benefit_category, copay, coinsurance')
    .eq('contract_id', 'H3449').eq('plan_id', '027')
    .in('benefit_category', ['xray', 'advanced_imaging'])
    .order('segment_id').order('benefit_category');
  console.log('ALL H3449-027 xray/AI rows (no segment filter):');
  for (const r of data ?? []) {
    console.log(`  id=${r.id} seg=${JSON.stringify(r.segment_id)} cat=${r.benefit_category.padEnd(18)} copay=${r.copay} coins=${r.coinsurance}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
