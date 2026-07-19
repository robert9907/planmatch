// Step 1: find all pm_plan_benefits rows where max_coverage AND
// coverage_amount both hold non-null > 0 values that DIFFER. The
// nullish coalescing in api/plans.ts:1441-1445 (and elsewhere) picks
// max_coverage, silently shadowing coverage_amount. If they disagree,
// one of them is wrong — determine which via CMS truth.
//
// Also list rows where only max_coverage exists (would-be shadow if
// coverage_amount gets filled by a future data pass without clearing
// max_coverage). Belt-and-suspenders sync target.
//
// Read-only. Prints category breakdown + a diagnostic per row.
//
// Run: npx tsx scripts/_discover-shadowed.ts

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

async function paginate<T>(fn: (from: number, to: number) => any): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await fn(p * 1000, p * 1000 + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

async function main() {
  // 1. Both columns non-null > 0, values differ  → SHADOWED
  const bothSet = await paginate<any>((from, to) =>
    sb.from('pm_plan_benefits')
      .select('id, contract_id, plan_id, segment_id, benefit_category, copay, coverage_amount, max_coverage, benefit_description')
      .not('max_coverage', 'is', null)
      .not('coverage_amount', 'is', null)
      .gt('max_coverage', 0)
      .gt('coverage_amount', 0)
      .range(from, to)
  );
  console.log(`Rows where both max and cov are non-null and > 0: ${bothSet.length}`);
  const trueShadowed = bothSet.filter((r) => r.max_coverage !== r.coverage_amount);
  console.log(`SHADOWED rows (max != cov, both > 0): ${trueShadowed.length}`);

  // Group by category
  const byCat: Record<string, any[]> = {};
  for (const r of trueShadowed) {
    (byCat[r.benefit_category] ||= []).push(r);
  }
  console.log('\nGrouped by benefit_category:');
  for (const cat of Object.keys(byCat).sort()) {
    const list = byCat[cat];
    console.log(`  ${cat.padEnd(30)} ${list.length} rows`);
    // Sample first 3
    for (const r of list.slice(0, 3)) {
      console.log(`     ${r.contract_id}-${r.plan_id}-${r.segment_id ?? '?'}  max=$${r.max_coverage}  cov=$${r.coverage_amount}  (agent sees $${r.max_coverage})`);
    }
    if (list.length > 3) console.log(`     …+${list.length - 3} more`);
  }

  // 2. max_coverage set, coverage_amount null/0 → would-be shadow
  const maxOnly = await paginate<any>((from, to) =>
    sb.from('pm_plan_benefits')
      .select('id, contract_id, plan_id, segment_id, benefit_category, max_coverage, coverage_amount')
      .not('max_coverage', 'is', null).gt('max_coverage', 0)
      .or('coverage_amount.is.null,coverage_amount.eq.0')
      .range(from, to)
  );
  console.log(`\n\nOnly-max_coverage rows (potential future shadows): ${maxOnly.length}`);
  const maxOnlyByCat: Record<string, number> = {};
  for (const r of maxOnly) maxOnlyByCat[r.benefit_category] = (maxOnlyByCat[r.benefit_category] ?? 0) + 1;
  for (const cat of Object.keys(maxOnlyByCat).sort((a, b) => maxOnlyByCat[b] - maxOnlyByCat[a])) {
    console.log(`  ${cat.padEnd(30)} ${maxOnlyByCat[cat]} rows`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
