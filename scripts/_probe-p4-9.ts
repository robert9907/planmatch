// Read-only probe: show current pm_plan_benefits state for the 9
// Phase 4 real-data failures. Confirms row presence + copay value
// before the fix script writes.
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

const targets: Array<{ contract: string; plan: string; category: string; expected_copay: number }> = [
  { contract: 'H1189', plan: '003', category: 'lab',                                    expected_copay: 0 },
  { contract: 'H1189', plan: '004', category: 'lab',                                    expected_copay: 0 },
  { contract: 'H1189', plan: '008', category: 'lab',                                    expected_copay: 0 },
  { contract: 'H7115', plan: '006', category: 'lab',                                    expected_copay: 0 },
  { contract: 'H7115', plan: '006', category: 'mental_health_outpatient_individual',    expected_copay: 0 },
  { contract: 'H4513', plan: '009', category: 'mental_health_outpatient_individual',    expected_copay: 0 },
  { contract: 'H2593', plan: '031', category: 'snf',                                    expected_copay: 0 },
  { contract: 'H6351', plan: '004', category: 'snf',                                    expected_copay: 0 },
  { contract: 'R2604', plan: '002', category: 'snf',                                    expected_copay: 0 },
];

async function main() {
  console.log('Phase 4 real-data failure probe (read-only)');
  console.log('─'.repeat(80));
  for (const t of targets) {
    const { data, error } = await sb.from('pm_plan_benefits')
      .select('id, contract_id, plan_id, segment_id, benefit_category, copay, coinsurance, coverage_amount, benefit_description')
      .eq('contract_id', t.contract).eq('plan_id', t.plan)
      .eq('benefit_category', t.category);
    if (error) { console.error(`  ${t.contract}-${t.plan} ${t.category}: ERR ${error.message}`); continue; }
    const rows = data ?? [];
    if (rows.length === 0) {
      console.log(`  ${t.contract}-${t.plan}  ${t.category.padEnd(38)}  NO ROW (needs INSERT copay=${t.expected_copay})`);
    } else {
      for (const r of rows) {
        const action = r.copay === t.expected_copay ? 'OK (no change needed)'
          : r.copay == null ? `UPDATE copay=null → ${t.expected_copay}`
          : `UPDATE copay=${r.copay} → ${t.expected_copay}`;
        console.log(`  ${t.contract}-${t.plan}  ${t.category.padEnd(38)}  id=${String(r.id).padEnd(7)} seg=${String(r.segment_id ?? '-').padEnd(3)} copay=${String(r.copay).padEnd(6)} coins=${String(r.coinsurance).padEnd(6)}  → ${action}`);
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
