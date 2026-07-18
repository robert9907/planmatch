// Verifies Fix 4: pm_drug_cost_cache is queried with the combined
// "contract-plan" key. Code inspection: api/plan-brain-data.ts:172 uses
// contractPlans = [`${contract}-${plan}`, ...]. This probe confirms the
// key format actually returns rows for Margaret's Durham NC pool + 3 meds.
//
// Run: npx tsx scripts/_probe-fix4-drug-cache.ts

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function main() {
  console.log('Fix 4 — pm_drug_cost_cache key format');
  console.log('─'.repeat(60));

  // 1. Margaret's Durham NC MA pool.
  const { data: rawPlans } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, plan_name, carrier, plan_type')
    .eq('state', 'NC')
    .ilike('county_name', '%Durham%');
  const maPlans = (rawPlans ?? []).filter((p) => p.plan_type !== 'PDP');
  const contractPlans = [...new Set(maPlans.map((p) => `${p.contract_id}-${p.plan_id}`))];
  console.log(`Margaret pool (Durham NC MA): ${maPlans.length} plans, ${contractPlans.length} distinct contract-plans`);

  // 2. WRONG key format (just plan_id) — should return 0 rows.
  const planOnly = [...new Set(maPlans.map((p) => p.plan_id))];
  const { data: wrongKey } = await sb
    .from('pm_drug_cost_cache')
    .select('plan_id, ndc, tier, estimated_yearly_total', { count: 'exact', head: false })
    .in('plan_id', planOnly)
    .limit(10);
  console.log(`\nWrong key (plan_id only, e.g. '${planOnly[0]}'): ${(wrongKey ?? []).length} rows`);

  // 3. CORRECT key format (contract-plan) — should return cache rows.
  const { data: rightKey } = await sb
    .from('pm_drug_cost_cache')
    .select('plan_id, ndc, tier, full_cost, covered, estimated_yearly_total', { count: 'exact', head: false })
    .in('plan_id', contractPlans)
    .limit(3000);
  const distinctPlans = new Set((rightKey ?? []).map((r) => r.plan_id));
  const withYearly = (rightKey ?? []).filter((r) => r.estimated_yearly_total !== null).length;
  console.log(`Right key (contract-plan, e.g. '${contractPlans[0]}'): ${(rightKey ?? []).length} rows across ${distinctPlans.size} plans, ${withYearly} with a yearly total`);

  const gapPlans = maPlans.filter((p) => !distinctPlans.has(`${p.contract_id}-${p.plan_id}`));
  console.log(`Plans WITH cache coverage: ${distinctPlans.size} / ${maPlans.length}`);
  console.log(`Plans WITHOUT cache coverage: ${gapPlans.length}`);
  if (gapPlans.length > 0 && gapPlans.length < 30) {
    console.log('  (missing plans, first 10):');
    gapPlans.slice(0, 10).forEach((p) => console.log(`   - ${p.contract_id}-${p.plan_id} ${p.carrier}`));
  }

  // 4. Check Margaret's actual 3 meds — Eliquis (rxcui 1364430), Atorvastatin
  //    (rxcui 617311), Lisinopril (rxcui 314076) are common leading rxcuis.
  //    Try to find NDCs for each and check cache coverage.
  const RXCUIS: Array<{ name: string; rxcui: string }> = [
    { name: 'Eliquis 5mg',      rxcui: '1364430' },
    { name: 'Atorvastatin 40mg', rxcui: '617311' },
    { name: 'Lisinopril 10mg',   rxcui: '314076' },
  ];
  console.log('\nPer-drug cache coverage (using guessed leading rxcuis):');
  for (const d of RXCUIS) {
    const { data: ndcRows } = await sb
      .from('pm_drug_ndc')
      .select('ndc')
      .eq('rxcui', d.rxcui);
    const ndcs = (ndcRows ?? []).map((r) => r.ndc);
    if (ndcs.length === 0) {
      console.log(`   ${d.name.padEnd(20)}  rxcui ${d.rxcui} → 0 NDCs in pm_drug_ndc (may need RxNav expansion)`);
      continue;
    }
    const { data: cache } = await sb
      .from('pm_drug_cost_cache')
      .select('plan_id, estimated_yearly_total, covered')
      .in('plan_id', contractPlans)
      .in('ndc', ndcs)
      .limit(1000);
    const nCovered = (cache ?? []).filter((r) => r.covered === true).length;
    const nWithCost = (cache ?? []).filter((r) => r.estimated_yearly_total !== null).length;
    const distinctPlansForDrug = new Set((cache ?? []).map((r) => r.plan_id));
    console.log(`   ${d.name.padEnd(20)}  ${ndcs.length} NDCs → ${(cache ?? []).length} cache rows across ${distinctPlansForDrug.size}/${maPlans.length} plans; ${nCovered} covered, ${nWithCost} with yearly total`);
  }

  console.log('─'.repeat(60));
  const codeOk = (rightKey ?? []).length > 0 && (wrongKey ?? []).length === 0;
  console.log(codeOk
    ? 'PASS  Combined "contract-plan" key returns rows; plan-only key returns none. Code correct.'
    : 'FAIL  Key format check inconclusive — investigate.');
  process.exit(codeOk ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
