// scripts/probe-pm-benefits-detail.ts
//
// Dump all pm_plan_benefits rows for H3449-023 (the plan we have a full
// CMS detail probe for), grouped by benefit_category, so we can see:
//   - Is there ONE row per (plan, category) or multiple?
//   - When CMS reports a coinsurance-only benefit (DME = 20%), how
//     does PM encode it — coinsurance column? copay=0?
//   - How are dental/hearing collapsed (CMS splits, PM single row)?

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

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

async function main() {
  const { data, error } = await sb
    .from('pm_plan_benefits')
    .select('benefit_category, copay, coinsurance, coverage_amount, max_coverage, benefit_description')
    .eq('contract_id', 'H3449')
    .eq('plan_id', '023');
  if (error) { console.error(error); process.exit(1); }

  // Group by category to see if there are multiples.
  const byCat = new Map<string, typeof data>();
  for (const r of data ?? []) {
    const arr = byCat.get(r.benefit_category) ?? [];
    arr.push(r);
    byCat.set(r.benefit_category, arr);
  }
  console.log(`Total rows: ${data?.length ?? 0}`);
  console.log(`Distinct categories: ${byCat.size}`);
  console.log(`\nRows per category:`);
  for (const [cat, rows] of [...byCat.entries()].sort()) {
    if (rows.length > 1) console.log(`  ${cat}: ${rows.length} ROWS ←`);
  }

  console.log('\nFull dump:');
  for (const [cat, rows] of [...byCat.entries()].sort()) {
    for (const r of rows) {
      const cp = r.copay !== null ? `copay=$${r.copay}` : '';
      const co = r.coinsurance !== null ? `coins=${r.coinsurance}%` : '';
      const cv = r.coverage_amount !== null ? `cov=$${r.coverage_amount}` : '';
      const mx = r.max_coverage !== null ? `max=$${r.max_coverage}` : '';
      const desc = r.benefit_description ? `desc="${String(r.benefit_description).slice(0, 50)}"` : '';
      console.log(`  ${cat.padEnd(36)} ${[cp, co, cv, mx, desc].filter(Boolean).join(' ')}`);
    }
  }
  writeFileSync('_tmp/cms-audit/probe-pm-benefits-h3449-023.json', JSON.stringify(data, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
