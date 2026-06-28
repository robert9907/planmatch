// One-shot migration: UPDATE pm_plans SET annual_deductible = 0
// WHERE annual_deductible IS NULL.
//
// pm_plans treats "no medical deductible" as NULL, but consumers expect
// $0. The CMS Medicare.gov detail endpoint also reports 0 (not NULL) for
// the same plans, which means our audit diff flagged every NULL row as
// a RED mismatch — 176 of 189 REDs (93%) across the six-persona suite.
//
// This migration backfills the column so existing data matches the
// read-side coalesce we just added (planCatalog.ts, plan-brain.ts,
// usePlanBrain.ts, plans.ts). Read-side is the defensive guard; this
// SQL is the data correction.
//
// Idempotent (no-op after first run). Run via:
//   npx tsx scripts/_migrate-annual-deductible-null-to-zero.ts

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const url = process.env.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!url || !key) {
  console.error('Need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function main() {
  // Step 1: preview — count rows about to be touched.
  const { count: beforeNull, error: e1 } = await sb.from('pm_plans')
    .select('*', { count: 'exact', head: true })
    .is('annual_deductible', null);
  if (e1) { console.error(`preview error: ${e1.message}`); process.exit(2); }

  const { count: beforeZero } = await sb.from('pm_plans')
    .select('*', { count: 'exact', head: true })
    .eq('annual_deductible', 0);

  const { count: beforeTotal } = await sb.from('pm_plans')
    .select('*', { count: 'exact', head: true });

  console.log('[preview] before migration:');
  console.log(`  pm_plans total                 = ${beforeTotal}`);
  console.log(`  annual_deductible IS NULL      = ${beforeNull}`);
  console.log(`  annual_deductible = 0          = ${beforeZero}`);
  console.log('');

  if ((beforeNull ?? 0) === 0) {
    console.log('[migrate] no NULL rows — nothing to do.');
    return;
  }

  // Step 2: execute. PostgREST doesn't expose `.update()` over a NULL
  // filter directly via .is() in older clients; supabase-js v2 supports
  // it. Body is `{ annual_deductible: 0 }`.
  console.log(`[migrate] updating ${beforeNull} rows...`);
  const { error: e2 } = await sb.from('pm_plans')
    .update({ annual_deductible: 0 })
    .is('annual_deductible', null);
  if (e2) { console.error(`update error: ${e2.message}`); process.exit(3); }

  // Step 3: verify.
  const { count: afterNull } = await sb.from('pm_plans')
    .select('*', { count: 'exact', head: true })
    .is('annual_deductible', null);
  const { count: afterZero } = await sb.from('pm_plans')
    .select('*', { count: 'exact', head: true })
    .eq('annual_deductible', 0);
  console.log('');
  console.log('[verify] after migration:');
  console.log(`  annual_deductible IS NULL      = ${afterNull}`);
  console.log(`  annual_deductible = 0          = ${afterZero}`);
  console.log('');
  if ((afterNull ?? 0) === 0) {
    console.log(`✓ migration complete. ${(afterZero ?? 0) - (beforeZero ?? 0)} rows moved NULL → 0.`);
  } else {
    console.error(`✗ migration left ${afterNull} NULL rows — something is off.`);
    process.exit(4);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
