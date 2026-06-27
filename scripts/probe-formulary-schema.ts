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
  // Try writing to pm_formulary_v2 directly
  for (const tbl of ['pm_formulary_v2', 'pm_formulary_base', 'pm_formulary_raw', 'pm_drug_costs']) {
    const r = await sb.from(tbl).select('*').limit(1);
    if (r.error) {
      console.log(`${tbl}: error: ${r.error.message}`);
    } else {
      console.log(`${tbl}: EXISTS  cols=${r.data?.[0] ? Object.keys(r.data[0]).join(',') : 'empty'}`);
    }
  }
  
  // Sample pm_formulary_v2 for S5601-016
  console.log('\npm_formulary_v2 sample for S5601-016:');
  const { data: v2 } = await sb.from('pm_formulary_v2').select('*').eq('contract_id', 'S5601').eq('plan_id', '016').limit(3);
  for (const r of v2 ?? []) console.log(JSON.stringify(r, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
