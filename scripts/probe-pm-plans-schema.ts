// scripts/probe-pm-plans-schema.ts
//
// One-off: dump column names + a sample row from pm_plans and
// pm_plan_benefits for Durham/H3449-023-2 (the plan we probed
// Medicare.gov detail for). Used to design the diff mapping in
// cms-secret-shopper.ts.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const url = process.env.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
if (!url || !key) { console.error('Missing env'); process.exit(1); }
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const OUT_DIR = '_tmp/cms-audit';
const PROBE = { contract_id: 'H3449', plan_id: '023', segment_id: '2' };

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  console.log('=== pm_plans sample row (H3449-023) ===');
  const { data: plans, error: pe } = await sb
    .from('pm_plans')
    .select('*')
    .eq('contract_id', PROBE.contract_id)
    .eq('plan_id', PROBE.plan_id)
    .limit(3);
  if (pe) { console.error(pe); process.exit(1); }
  console.log(`rows: ${plans?.length ?? 0}`);
  if (plans && plans[0]) {
    console.log('columns:', Object.keys(plans[0]).sort().join(', '));
    writeFileSync(`${OUT_DIR}/probe-pm-plan-sample.json`, JSON.stringify(plans, null, 2));
  }

  console.log('\n=== pm_plan_benefits for that plan (sample) ===');
  const { data: bens, error: be } = await sb
    .from('pm_plan_benefits')
    .select('*')
    .eq('contract_id', PROBE.contract_id)
    .eq('plan_id', PROBE.plan_id)
    .limit(5);
  if (be) { console.error(be); process.exit(1); }
  console.log(`rows (first 5): ${bens?.length ?? 0}`);
  if (bens && bens[0]) {
    console.log('columns:', Object.keys(bens[0]).sort().join(', '));
    writeFileSync(`${OUT_DIR}/probe-pm-benefit-sample.json`, JSON.stringify(bens, null, 2));
  }

  // Distinct benefit_category values across the table — get full taxonomy.
  console.log('\n=== distinct benefit_category values ===');
  const { data: cats, error: ce } = await sb
    .from('pm_plan_benefits')
    .select('benefit_category')
    .eq('contract_id', PROBE.contract_id)
    .eq('plan_id', PROBE.plan_id);
  if (ce) { console.error(ce); }
  else {
    const unique = Array.from(new Set((cats ?? []).map(r => r.benefit_category))).sort();
    console.log(`distinct categories on this plan: ${unique.length}`);
    for (const c of unique) console.log(`  ${c}`);
  }

  // Sample columns the user mentioned: monthly_premium, annual_deductible, MOOP.
  if (plans && plans[0]) {
    const p = plans[0];
    console.log('\n=== money/scalar fields on pm_plans ===');
    const moneyKeys = Object.keys(p).filter(k =>
      /premium|deductible|moop|out_of_pocket|star|carrier|organization|snp|plan_type|category/i.test(k)
    ).sort();
    for (const k of moneyKeys) console.log(`  ${k} = ${JSON.stringify(p[k])}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
