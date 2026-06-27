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
  const { data: pm } = await sb.from('pm_plan_benefits').select('*').eq('contract_id','H6351').eq('plan_id','004').ilike('benefit_category','%inpatient%');
  console.log('pm_plan_benefits inpatient* rows:', pm?.length, JSON.stringify(pm, null, 2));
  const { data: pbp } = await sb.from('pbp_benefits').select('plan_id,benefit_type,copay,copay_max,coinsurance,description,source').like('plan_id','H6351-004%');
  const inp = (pbp ?? []).filter(r => /inpatient|hosp|snf/i.test(r.benefit_type as string));
  console.log('\npbp inpatient* rows:', JSON.stringify(inp, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
