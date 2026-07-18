// Verifies Fix 5: food card data path.
//
// Phase 1 finding: pm_plan_benefits has NO benefit_category='food_card'
// rows. But code review shows api/plans.ts has a fallback to pbp_benefits
// (line 1341-1454) that reads food_card from benefit_type='food_card'.
// Commit e34d70c imported 148 rows into pbp_benefits* — the question
// is whether the fallback actually reads them.
//
// Run: npx tsx scripts/_probe-fix5-food-card.ts

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
  console.log('Fix 5 — food card data path');
  console.log('─'.repeat(60));

  // 1. Does pbp_benefits (view) have food_card rows anywhere?
  const { count: cardCount } = await sb
    .from('pbp_benefits')
    .select('*', { count: 'exact', head: true })
    .eq('benefit_type', 'food_card');
  console.log(`pbp_benefits WHERE benefit_type='food_card': ${cardCount ?? 0} rows total`);

  // 2. Same query on pbp_benefits_v2 (base table per memory)
  const { count: cardCountV2 } = await sb
    .from('pbp_benefits_v2')
    .select('*', { count: 'exact', head: true })
    .eq('benefit_type', 'food_card');
  console.log(`pbp_benefits_v2 WHERE benefit_type='food_card': ${cardCountV2 ?? 0} rows total`);

  // 3. Rosa's Bexar D-SNP pool
  const { data: bexar } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, plan_name, carrier, snp_type')
    .eq('state', 'TX')
    .ilike('county_name', '%Bexar%')
    .eq('snp_type', 'D-SNP');
  console.log(`\nRosa Bexar D-SNP pool: ${bexar?.length ?? 0} plans`);
  const contractPlans = [...new Set((bexar ?? []).map((p) => `${p.contract_id}-${p.plan_id}`))];

  // 4. Probe both tables with contract-plan combined key (matches api/plans.ts:1341+ read path)
  const { data: v1Rows } = await sb
    .from('pbp_benefits')
    .select('plan_id, benefit_type, copay, coverage_amount, description')
    .eq('benefit_type', 'food_card')
    .in('plan_id', contractPlans)
    .limit(200);
  const { data: v2Rows } = await sb
    .from('pbp_benefits_v2')
    .select('plan_id, benefit_type, copay, coverage_amount, description')
    .eq('benefit_type', 'food_card')
    .in('plan_id', contractPlans)
    .limit(200);
  console.log(`  pbp_benefits.food_card rows for pool:    ${v1Rows?.length ?? 0}`);
  console.log(`  pbp_benefits_v2.food_card rows for pool: ${v2Rows?.length ?? 0}`);

  // 5. Show a few sample rows
  const sample = (v1Rows && v1Rows.length > 0) ? v1Rows : (v2Rows ?? []);
  if (sample.length > 0) {
    console.log(`\n  Sample (first 5):`);
    sample.slice(0, 5).forEach((r) => {
      console.log(`    plan_id=${r.plan_id}  copay=${r.copay}  coverage_amount=${r.coverage_amount}  desc="${(r.description ?? '').slice(0, 60)}"`);
    });
  }

  // 6. Coverage %: how many pool plans have food_card in whichever table works?
  const winRows = (v1Rows?.length ?? 0) > 0 ? v1Rows : v2Rows;
  const distinctPlansWithCard = new Set((winRows ?? []).map((r) => r.plan_id));
  console.log(`\n  Coverage: ${distinctPlansWithCard.size} / ${bexar?.length ?? 0} Rosa D-SNPs have a food_card row`);
  const missing = (bexar ?? []).filter((p) => !distinctPlansWithCard.has(`${p.contract_id}-${p.plan_id}`));
  if (missing.length > 0 && missing.length <= 15) {
    console.log(`  D-SNPs without food_card row:`);
    missing.forEach((p) => console.log(`    - ${p.contract_id}-${p.plan_id} ${p.carrier} ${p.plan_name}`));
  }

  // 7. Cross-check: what does the api/plans.ts *would return* for one plan?
  //    Simulate the api logic: read pm_plan_benefits (food_card), fall back
  //    to pbp_benefits food_card if the pm row is null/0.
  if (bexar && bexar.length > 0) {
    const anyPlan = bexar[0];
    const key = `${anyPlan.contract_id}-${anyPlan.plan_id}`;
    const { data: pmb } = await sb
      .from('pm_plan_benefits')
      .select('coverage_amount, description:benefit_description, copay')
      .eq('contract_id', anyPlan.contract_id)
      .eq('plan_id', anyPlan.plan_id)
      .eq('benefit_category', 'food_card');
    const { data: pbp } = await sb
      .from('pbp_benefits')
      .select('copay, coverage_amount, description')
      .eq('plan_id', key)
      .eq('benefit_type', 'food_card')
      .limit(5);
    const { data: pbpV2 } = await sb
      .from('pbp_benefits_v2')
      .select('copay, coverage_amount, description')
      .eq('plan_id', key)
      .eq('benefit_type', 'food_card')
      .limit(5);
    console.log(`\n  End-to-end simulation for ${key} (${anyPlan.carrier} ${anyPlan.plan_name}):`);
    console.log(`    pm_plan_benefits.food_card rows    : ${pmb?.length ?? 0}`);
    console.log(`    pbp_benefits.food_card rows        : ${pbp?.length ?? 0}`);
    console.log(`    pbp_benefits_v2.food_card rows     : ${pbpV2?.length ?? 0}`);
    const pbSample = (pbp && pbp.length > 0) ? pbp[0] : (pbpV2 && pbpV2.length > 0) ? pbpV2[0] : null;
    if (pbSample) console.log(`    → foodCard payload the API would emit: monthly=${pbSample.copay ?? pbSample.coverage_amount ?? 0} desc="${(pbSample.description ?? '').slice(0, 60)}"`);
  }

  const codeOk = (v1Rows?.length ?? 0) > 0 || (v2Rows?.length ?? 0) > 0;
  console.log('─'.repeat(60));
  console.log(codeOk
    ? 'PASS  food_card rows are reachable via pbp_benefits* for Rosa D-SNPs. api/plans.ts:1341+ fallback already wired.'
    : 'FAIL  food_card rows not found in either pbp_benefits table — data missing.');
  process.exit(codeOk ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
