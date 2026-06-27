// scripts/probe-durham-paginated-landscape.ts — replicate the agent's
// /api/plans Step-3 paginated fetch (Durham NC) and confirm whether
// H6351-004's inpatient row makes it in.

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
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function main() {
  // Step 1: get all Durham NC plans (mirroring the agent's filters)
  const { data: plansRaw } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, county_name')
    .eq('state', 'NC')
    .eq('sanctioned', false)
    .or('county_name.ilike.Durham,county_name.eq.All Counties')
    .limit(2000);
  const seen = new Set<string>();
  const plans = (plansRaw ?? []).filter((p) => {
    const k = `${p.contract_id}-${p.plan_id}-${p.segment_id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log(`Distinct plans in Durham fetch: ${plans.length}`);
  const liberty = plans.find((p) => p.contract_id === 'H6351' && p.plan_id === '004');
  console.log(`H6351-004 in plans list: ${!!liberty}`);

  // Step 2: build contractIds + planIds, do the cross-product fetch
  const contractIds = [...new Set(plans.map((p) => p.contract_id))];
  const planIds = [...new Set(plans.map((p) => p.plan_id))];
  console.log(`contractIds: ${contractIds.length}  planIds: ${planIds.length}`);

  const all: Array<Record<string, unknown>> = [];
  const PAGE = 1000;
  for (let p = 0; p < 20; p++) {
    const from = p * PAGE;
    const to = from + PAGE - 1;
    const { data } = await sb
      .from('pm_plan_benefits')
      .select('contract_id, plan_id, segment_id, benefit_category, benefit_description, copay, coinsurance, coverage_amount, max_coverage')
      .in('contract_id', contractIds)
      .in('plan_id', planIds)
      .range(from, to);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  console.log(`Total benefit rows fetched (paginated): ${all.length}`);

  const h6351 = all.filter((r) => r.contract_id === 'H6351' && r.plan_id === '004');
  console.log(`\nH6351-004 rows in fetched benefitRows: ${h6351.length}`);
  const h6351Inp = h6351.find((r) => r.benefit_category === 'inpatient');
  console.log(`H6351-004 inpatient row: ${h6351Inp ? JSON.stringify(h6351Inp) : 'MISSING'}`);

  // Sanity: also check H3146-006 (known fixed)
  const h3146Inp = all.find((r) => r.contract_id === 'H3146' && r.plan_id === '006' && r.benefit_category === 'inpatient');
  console.log(`H3146-006 inpatient row: ${h3146Inp ? JSON.stringify(h3146Inp) : 'MISSING'}`);

  // Same cross-product issue check: H6351 contract is small (1 Durham plan).
  // But planIds includes '004' which is ALSO used by other contracts.
  // Other contracts that also have plan_id='004' will pull THEIR '004'
  // rows into the IN-filter cross-product, inflating the row count.
  const otherWith004 = all.filter((r) => r.plan_id === '004' && r.contract_id !== 'H6351');
  console.log(`\nOther contracts also matched by planId='004': ${otherWith004.length} rows`);
  const otherContracts004 = new Set(otherWith004.map((r) => r.contract_id));
  console.log(`Distinct other contracts pulling plan_id=004 rows: ${[...otherContracts004].length}`);
  console.log([...otherContracts004]);
}

main().catch((err) => { console.error(err); process.exit(1); });
