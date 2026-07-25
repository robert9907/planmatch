#!/usr/bin/env tsx
// Broadened: dump ALL pm_plan_benefits + pbp_benefits_v2 rows for H9808-009
// so we can see where PM's diagnostic-labs=10 and radiology=10 actually
// originate. Also spot-check pm_plans for part_b_giveback column.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const sb = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function main() {
  const plans = [
    { c: 'H9808', p: '009' },
    { c: 'H1036', p: '335' },
  ];

  for (const { c, p } of plans) {
    console.log(`\n=== ${c}-${p} — pm_plan_benefits (ALL rows any segment) ===`);
    const b = await sb
      .from('pm_plan_benefits')
      .select('*')
      .eq('contract_id', c)
      .eq('plan_id', p);
    if (b.error) console.error(b.error);
    else if (!b.data?.length) console.log('  (no rows)');
    else {
      console.log(`  ${b.data.length} rows`);
      for (const r of b.data) {
        console.log(`  seg=${(r as {segment_id?: string}).segment_id} cat=${(r as {benefit_category?: string}).benefit_category} copay=${(r as {copay?: number|null}).copay} coins=${(r as {coinsurance?: number|null}).coinsurance} cov=${(r as {coverage_amount?: number|null}).coverage_amount}`);
      }
    }

    console.log(`\n=== ${c}-${p} — pbp_benefits_v2 (ALL rows any segment/type) ===`);
    const pbp = await sb
      .from('pbp_benefits_v2')
      .select('segment_id, benefit_type, copay, coinsurance, coverage_amount, description')
      .eq('contract_id', c)
      .eq('plan_id', p)
      .order('benefit_type');
    if (pbp.error) console.error(pbp.error);
    else if (!pbp.data?.length) console.log('  (no rows)');
    else {
      console.log(`  ${pbp.data.length} rows`);
      for (const r of pbp.data) {
        const desc = (r.description ?? '').slice(0, 50);
        console.log(`  seg=${r.segment_id} ${(r.benefit_type ?? '').padEnd(28)} copay=${r.copay} coins=${r.coinsurance} cov=${r.coverage_amount} ${desc}`);
      }
    }
  }

  // Verify pm_plans has part_b_giveback column
  console.log('\n=== pm_plans column probe (H9808-009) ===');
  const pl = await sb
    .from('pm_plans')
    .select('*')
    .eq('contract_id', 'H9808')
    .eq('plan_id', '009')
    .limit(1)
    .maybeSingle();
  if (pl.error) console.error(pl.error);
  else if (pl.data) {
    const cols = Object.keys(pl.data);
    console.log(`  columns (${cols.length}):`, cols.filter((k) => /giveback|deduct|premium|reduc/i.test(k)).join(', '));
    console.log(`  giveback-related row:`, JSON.stringify(Object.fromEntries(cols.filter((k) => /giveback|deduct|premium|reduc/i.test(k)).map((k) => [k, (pl.data as Record<string, unknown>)[k]]))));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
