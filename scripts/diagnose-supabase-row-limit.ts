// Confirm whether the pm_plan_benefits fetch in /api/plans is being
// truncated by Supabase's default 1000-row limit when the county
// pool is large.

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
  // Get all Durham plans' contract_id + plan_id
  const { data: plans } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id')
    .eq('state', 'NC')
    .ilike('county_name', '%Durham%');
  if (!plans) return;
  const contractIds = [...new Set(plans.map((p) => p.contract_id))];
  const planIds = [...new Set(plans.map((p) => p.plan_id))];
  console.log(`pm_plans rows: ${plans.length}`);
  console.log(`unique contract_ids: ${contractIds.length}`);
  console.log(`unique plan_ids: ${planIds.length}`);

  // Mirror /api/plans' broad fetch — no .range, default limit
  const { data: defaultFetch } = await sb
    .from('pm_plan_benefits')
    .select('contract_id, plan_id', { count: 'exact' })
    .in('contract_id', contractIds)
    .in('plan_id', planIds);
  console.log(`\npm_plan_benefits (default fetch, no .range):`);
  console.log(`  rows returned: ${defaultFetch?.length ?? 0}`);

  // Same query with explicit large range
  const { data: rangedFetch, count: rangedCount } = await sb
    .from('pm_plan_benefits')
    .select('contract_id, plan_id', { count: 'exact' })
    .in('contract_id', contractIds)
    .in('plan_id', planIds)
    .range(0, 9999);
  console.log(`\npm_plan_benefits (explicit .range(0, 9999)):`);
  console.log(`  rows returned: ${rangedFetch?.length ?? 0}`);
  console.log(`  total count (header): ${rangedCount ?? '?'}`);

  // Specific check: does H3404-004 (BCBS Blue Medicare Freedom+) have
  // primary_care + specialist + emergency + inpatient rows that get
  // dropped by the default fetch?
  const inDefault = (defaultFetch ?? []).filter(
    (b) => b.contract_id === 'H3404' && b.plan_id === '004',
  );
  const inRanged = (rangedFetch ?? []).filter(
    (b) => b.contract_id === 'H3404' && b.plan_id === '004',
  );
  console.log(`\nH3404-004 rows:`);
  console.log(`  in default fetch: ${inDefault.length}`);
  console.log(`  in ranged fetch:  ${inRanged.length}`);

  // Same for pbp_benefits to see if the same truncation bites
  const tripleKeys: string[] = [];
  for (const p of plans) {
    tripleKeys.push(`${p.contract_id}-${p.plan_id}`);
    tripleKeys.push(`${p.contract_id}-${p.plan_id}-0`);
    tripleKeys.push(`${p.contract_id}-${p.plan_id}-000`);
  }
  const { data: pbpDefault } = await sb
    .from('pbp_benefits')
    .select('plan_id', { count: 'exact' })
    .in('plan_id', [...new Set(tripleKeys)])
    .in('source', ['medicare_gov', 'sb_ocr', 'cms_pbp', 'manual']);
  const { data: pbpRanged, count: pbpCount } = await sb
    .from('pbp_benefits')
    .select('plan_id', { count: 'exact' })
    .in('plan_id', [...new Set(tripleKeys)])
    .in('source', ['medicare_gov', 'sb_ocr', 'cms_pbp', 'manual'])
    .range(0, 19999);
  console.log(`\npbp_benefits (broad):`);
  console.log(`  default fetch: ${pbpDefault?.length ?? 0}`);
  console.log(`  ranged fetch:  ${pbpRanged?.length ?? 0}  total: ${pbpCount ?? '?'}`);
}

main().catch(console.error);
