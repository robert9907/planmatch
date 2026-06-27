// scripts/audit-specific-plans.ts
//
// Probes pm_plan_benefits for two specific Durham plans: Wellcare
// Simple HMO-POS and a UHC AARP plan. Useful for spot-checking the
// CATEGORY_ALIAS coverage on plans the broker actually quotes most.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const url = process.env.SUPABASE_URL ?? '';
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  '';
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/ANON_KEY');
  process.exit(1);
}
const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function dumpPlanBenefits(label: string, namePattern: string) {
  console.log(`\n=== ${label} PLANS (Durham, NC) ===`);
  const { data: plans, error: pErr } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, plan_name')
    .eq('state', 'NC')
    .ilike('county_name', '%Durham%')
    .ilike('plan_name', namePattern)
    .limit(3);
  if (pErr) console.error(`${label} plans error:`, pErr);
  console.table(plans ?? []);

  if (!plans?.[0]) return;
  const p = plans[0];
  const { data: ben, error: bErr } = await sb
    .from('pm_plan_benefits')
    .select(
      'benefit_category, copay, coinsurance, coverage_amount, benefit_description',
    )
    .eq('contract_id', p.contract_id)
    .eq('plan_id', p.plan_id)
    .order('benefit_category');
  if (bErr) console.error(`${label} benefits error:`, bErr);
  console.log(
    `\n=== pm_plan_benefits for ${p.contract_id}-${p.plan_id} (${ben?.length ?? 0} rows) ===`,
  );
  console.table(ben ?? []);
}

async function main() {
  await dumpPlanBenefits('WELLCARE SIMPLE HMO-POS', '%Wellcare Simple%HMO%POS%');
  await dumpPlanBenefits('UHC AARP', '%AARP%UHC%');
}

main().catch(console.error);
