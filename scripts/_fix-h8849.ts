import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
async function main() {
  const write = process.argv.includes('--write');
  // 1. All non-seg-3 segments: coverage_amount=$125 (already have max=125)
  const { data: nonSeg3 } = await sb.from('pm_plan_benefits')
    .select('id, segment_id, coverage_amount, max_coverage')
    .eq('contract_id', 'H8849').eq('plan_id', '011').eq('benefit_category', 'vision')
    .neq('segment_id', '3');
  console.log('Non-seg-3 rows (should set coverage_amount=125):');
  (nonSeg3 ?? []).forEach(r => console.log(' ', JSON.stringify(r)));
  // 2. Seg 3: set both to $350
  const { data: seg3 } = await sb.from('pm_plan_benefits')
    .select('id, segment_id, coverage_amount, max_coverage')
    .eq('contract_id', 'H8849').eq('plan_id', '011').eq('benefit_category', 'vision')
    .eq('segment_id', '3');
  console.log('Seg-3 row (should set both to $350):');
  (seg3 ?? []).forEach(r => console.log(' ', JSON.stringify(r)));
  if (!write) { console.log('\n(dry-run) --write to execute'); return; }
  // Execute
  const { data: r1 } = await sb.from('pm_plan_benefits')
    .update({ coverage_amount: 125 })
    .eq('contract_id', 'H8849').eq('plan_id', '011').eq('benefit_category', 'vision')
    .neq('segment_id', '3').select('id');
  console.log(`✓ non-seg-3 updated: ${r1?.length ?? 0} rows to coverage_amount=$125`);
  const { data: r2 } = await sb.from('pm_plan_benefits')
    .update({ coverage_amount: 350, max_coverage: 350 })
    .eq('contract_id', 'H8849').eq('plan_id', '011').eq('benefit_category', 'vision')
    .eq('segment_id', '3').select('id');
  console.log(`✓ seg-3 updated: ${r2?.length ?? 0} rows to $350`);
}
main();
