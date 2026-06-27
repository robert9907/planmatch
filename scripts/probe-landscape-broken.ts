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
  for (const [c, p] of [['H6351','004'],['H4676','001'],['H9725','015'],['H3146','006']]) {
    const { data } = await sb.from('pm_plan_benefits').select('*').eq('contract_id', c).eq('plan_id', p).eq('benefit_category', 'inpatient');
    console.log(`${c}-${p} landscape inpatient: ${data?.length ?? 0} rows`);
    for (const r of data ?? []) console.log(`  ${JSON.stringify(r)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
