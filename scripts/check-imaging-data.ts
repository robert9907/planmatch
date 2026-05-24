// Dump imaging-related pm_plan_benefits rows across 5 Durham plans to
// see which carriers file under which benefit_category names (xray vs
// imaging vs advanced_imaging vs diagnostic_radiology, etc.).

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

const IMAGING_CATS = [
  'advanced_imaging',
  'diagnostic_procedures',
  'xray',
  'lab',
  'imaging',
  'diagnostic_radiology',
  'therapeutic_radiology',
  'diagnostic_tests',
  'x_ray',
];

async function main() {
  const { data: plans } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, plan_name, carrier')
    .eq('state', 'NC')
    .ilike('county_name', '%Durham%')
    .limit(10);

  // Dedup by contract+plan (pm_plans rows are one-per-county-per-plan)
  const seen = new Set<string>();
  const uniq = (plans ?? []).filter((p) => {
    const k = `${p.contract_id}-${p.plan_id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  for (const p of uniq.slice(0, 5)) {
    const { data: bens } = await sb
      .from('pm_plan_benefits')
      .select('benefit_category, copay, coinsurance, benefit_description')
      .eq('contract_id', p.contract_id)
      .eq('plan_id', p.plan_id)
      .in('benefit_category', IMAGING_CATS);
    console.log(`\n${p.carrier} | ${p.plan_name} (${p.contract_id}-${p.plan_id})`);
    console.table(bens ?? []);
  }
}

main().catch(console.error);
