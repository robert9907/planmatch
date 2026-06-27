// One-shot applier for migrations/2026-06-27-h3449-027-xray-coinsurance.sql
// via the Supabase JS client. Run once, then deleted (or kept for audit).
//
// What it does:
//   1. Before: log current state of H3449-027 xray rows
//   2. UPDATE coinsurance = 20 WHERE coinsurance IS NULL
//   3. After: log new state + count rows changed
//
// Run: npx tsx scripts/_apply-h3449-027-xray-fix.ts

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

async function main() {
  if (existsSync('.env.local')) {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
    }
  }
  const sb = createClient(
    process.env.SUPABASE_URL!,
    (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY)!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  console.log('=== Before ===');
  const before = await sb.from('pm_plan_benefits')
    .select('id, segment_id, copay, coinsurance')
    .eq('contract_id', 'H3449').eq('plan_id', '027').eq('benefit_category', 'xray');
  for (const r of before.data ?? []) {
    console.log(`  id=${r.id} seg=${r.segment_id} copay=${r.copay} coins=${r.coinsurance}`);
  }

  const { data, error } = await sb.from('pm_plan_benefits')
    .update({ coinsurance: 20 })
    .eq('contract_id', 'H3449').eq('plan_id', '027').eq('benefit_category', 'xray')
    .is('coinsurance', null)
    .select('id, segment_id, coinsurance');
  if (error) { console.error('UPDATE failed:', error); process.exit(1); }
  console.log(`\n=== Update returned ${data?.length ?? 0} rows ===`);
  for (const r of data ?? []) console.log(`  id=${r.id} seg=${r.segment_id} coins=${r.coinsurance}`);

  console.log('\n=== After ===');
  const after = await sb.from('pm_plan_benefits')
    .select('id, segment_id, copay, coinsurance')
    .eq('contract_id', 'H3449').eq('plan_id', '027').eq('benefit_category', 'xray');
  for (const r of after.data ?? []) {
    console.log(`  id=${r.id} seg=${r.segment_id} copay=${r.copay} coins=${r.coinsurance}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
