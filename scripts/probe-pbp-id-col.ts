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
  const a = await sb.from('pbp_benefits').select('*').limit(1);
  console.log('pbp_benefits cols:', Object.keys(a.data?.[0] ?? {}));
  const b = await sb.from('pm_plan_benefits').select('*').limit(1);
  console.log('pm_plan_benefits cols:', Object.keys(b.data?.[0] ?? {}));
}
main().catch(e => { console.error(e); process.exit(1); });
