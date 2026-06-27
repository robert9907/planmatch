// scripts/probe-aetna-value-plus-inpatient.ts — diagnose why Aetna
// Medicare Value Plus (HMO) inpatient hospital renders as "—" on
// the agent Compare screen for Durham (zip 27701).

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
  console.error('Missing env');
  process.exit(1);
}

const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  console.log('=== Supabase project:', url);

  // STEP 1: find the Aetna Value Plus plan
  console.log('\n=== STEP 1: Aetna Value Plus in Durham (premium 30-35) ===');
  const { data: aetnaPlans } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, monthly_premium, moop')
    .eq('state', 'NC')
    .eq('county_name', 'Durham')
    .ilike('carrier', '%Aetna%')
    .ilike('plan_name', '%Value Plus%')
    .gte('monthly_premium', 30)
    .lte('monthly_premium', 35);
  console.table(aetnaPlans ?? []);

  // Also catch any Aetna Value Plus regardless of premium (in case
  // monthly_premium has been changed since the screenshot)
  console.log('\n--- Any Aetna Value Plus Durham row (any premium) ---');
  const { data: aetnaAll } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, monthly_premium, moop')
    .eq('state', 'NC')
    .eq('county_name', 'Durham')
    .ilike('carrier', '%Aetna%')
    .ilike('plan_name', '%Value Plus%');
  console.table(aetnaAll ?? []);

  const aetnaTarget = (aetnaPlans?.[0] ?? aetnaAll?.[0]) as
    | { contract_id: string; plan_id: string; segment_id: string }
    | undefined;
  if (!aetnaTarget) {
    console.log('ABORT — no Aetna Value Plus row found.');
    return;
  }
  const aContract = aetnaTarget.contract_id;
  const aPlan = aetnaTarget.plan_id;
  console.log(`\nTarget: contract=${aContract} plan=${aPlan} seg=${aetnaTarget.segment_id}`);

  // STEP 2: ALL inpatient-related rows for the Aetna plan
  console.log('\n=== STEP 2: Aetna Value Plus inpatient* rows ===');
  const { data: aetnaInp } = await sb
    .from('pm_plan_benefits')
    .select('id, benefit_category, benefit_description, copay, coinsurance, coverage_amount, max_coverage, segment_id, source')
    .eq('contract_id', aContract)
    .eq('plan_id', aPlan)
    .ilike('benefit_category', '%inpatient%');
  for (const r of aetnaInp ?? []) {
    console.log(JSON.stringify(r, null, 2));
  }
  console.log(`(${aetnaInp?.length ?? 0} rows)`);

  // Check for a 'benefit_type' column (user mentioned it in prompt;
  // schema dump earlier didn't show one, but check defensively)
  console.log('\n=== STEP 2b: pm_plan_benefits column list ===');
  const { data: anyRow } = await sb
    .from('pm_plan_benefits')
    .select('*')
    .eq('contract_id', aContract)
    .eq('plan_id', aPlan)
    .limit(1);
  if (anyRow?.[0]) {
    console.log('Columns:', Object.keys(anyRow[0]));
  }

  // STEP 3: Wellcare Simple Durham comparison
  console.log('\n=== STEP 3: Wellcare Simple (HMO-POS) Durham ===');
  const { data: wellcarePlans } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, monthly_premium, moop')
    .eq('state', 'NC')
    .eq('county_name', 'Durham')
    .ilike('carrier', '%Wellcare%')
    .ilike('plan_name', '%Simple%')
    .eq('monthly_premium', 0);
  console.table(wellcarePlans ?? []);
  const wellcareTarget = wellcarePlans?.[0] as
    | { contract_id: string; plan_id: string; segment_id: string }
    | undefined;
  if (wellcareTarget) {
    const { data: wcInp } = await sb
      .from('pm_plan_benefits')
      .select('id, benefit_category, benefit_description, copay, coinsurance, coverage_amount, max_coverage, segment_id, source')
      .eq('contract_id', wellcareTarget.contract_id)
      .eq('plan_id', wellcareTarget.plan_id)
      .ilike('benefit_category', '%inpatient%');
    console.log('\n--- Wellcare Simple inpatient rows ---');
    for (const r of wcInp ?? []) console.log(JSON.stringify(r, null, 2));
    console.log(`(${wcInp?.length ?? 0} rows)`);
  }

  // STEP 4: confirm what the Compare reads. From earlier code spelunking
  // the agent reads benefit_category === 'inpatient' (singular). The
  // mh row is benefit_category === 'mental_health_inpatient'. Confirm
  // by listing every category present on the Aetna plan.
  console.log('\n=== STEP 4: Every distinct benefit_category on the Aetna plan ===');
  const { data: allCats } = await sb
    .from('pm_plan_benefits')
    .select('benefit_category')
    .eq('contract_id', aContract)
    .eq('plan_id', aPlan);
  const set = new Set<string>();
  for (const r of allCats ?? []) set.add((r as Record<string, unknown>).benefit_category as string);
  console.log([...set].sort().filter((c) => /inpatient|hospital|snf/i.test(c)));

  // STEP 5: Re-test description against the three live regexes used
  // by formatInpatientLadder (post-widening).
  console.log('\n=== STEP 5: Description regex test ===');
  const RANGE_FIRST = /Days?\s+(\d+)\s*[–-]\s*(\d+)\s*:\s*\$\s*(\d+(?:\.\d+)?)\s*\/\s*day/i;
  const AMOUNT_FIRST = /\$\s*(\d+(?:\.\d+)?)\s*\/\s*day\s*\(\s*days?\s+(\d+)\s*[–-]\s*(\d+)\s*\)/i;
  const PER_DAY_FLAT = /\$\s*(\d+(?:\.\d+)?)\s*per[-\s]?day\s+copay/i;
  for (const r of aetnaInp ?? []) {
    const row = r as Record<string, unknown>;
    if (row.benefit_category !== 'inpatient') continue;
    const desc = row.benefit_description as string | null;
    console.log(`Inpatient description: ${JSON.stringify(desc)}`);
    console.log(`  RANGE_FIRST match: ${desc ? RANGE_FIRST.test(desc) : '(null desc)'}`);
    console.log(`  AMOUNT_FIRST match: ${desc ? AMOUNT_FIRST.test(desc) : '(null desc)'}`);
    console.log(`  PER_DAY_FLAT match: ${desc ? PER_DAY_FLAT.test(desc) : '(null desc)'}`);
    console.log(`  copay = ${row.copay}  coinsurance = ${row.coinsurance}`);
  }

  // STEP 6: Cross-check segment_id of the plan row vs benefit rows.
  console.log('\n=== STEP 6: Segment_id alignment ===');
  console.log(`Plan row segment_id: ${aetnaTarget.segment_id}`);
  for (const r of aetnaInp ?? []) {
    const row = r as Record<string, unknown>;
    if (row.benefit_category === 'inpatient' || row.benefit_category === 'mental_health_inpatient') {
      console.log(`  ${row.benefit_category}: seg=${row.segment_id}`);
    }
  }

  // BONUS: the agent fetches via /api/plans which filters on contract+plan
  // (no segment). Confirm both rows live under the same contract+plan
  // regardless of segment.
  console.log('\n=== BONUS: All inpatient rows for the same contract+plan, across segments ===');
  for (const r of aetnaInp ?? []) {
    const row = r as Record<string, unknown>;
    console.log(
      `  [${row.benefit_category}] seg=${row.segment_id} ` +
      `desc=${JSON.stringify((row.benefit_description as string) ?? null).slice(0, 90)} ` +
      `copay=${row.copay} coins=${row.coinsurance}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
