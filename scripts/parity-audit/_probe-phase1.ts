#!/usr/bin/env tsx
// Phase 1 diagnostic — probe Supabase to find data for the 5 gap areas:
//   1. Mail-order 90-day tier rows (tier_id taxonomy)
//   2. Standard vs preferred pharmacy split
//   3. Dental / vision / hearing data quality
//   4. Priority 1-2 columns (medicalDeductibleOON, tier exceptions, cardiac
//      rehab, pulmonary rehab, home health, dialysis, worldwide emergency,
//      nurse hotline)
//   5. Existence of any benefit_category we haven't seen

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
  const testPlans = [
    { c: 'H9808', p: '010' },  // HealthTeam Vitality — MAPD
    { c: 'H1036', p: '335' },  // Humana Gold — MAPD
    { c: 'S4802', p: '081' },  // Wellcare Classic — PDP
    { c: 'H3404', p: '004' },  // Blue Medicare Freedom+
  ];

  // ─── 1. Mail-order taxonomy — full tier_id inventory ───
  console.log('\n=== 1. Rx tier taxonomy (tier_id full inventory) ===');
  const allTiers = await sb
    .from('pbp_benefits_v2')
    .select('contract_id, plan_id, benefit_type, tier_id, copay, coinsurance, description')
    .in('benefit_type', ['rx_tier'])
    .in('contract_id', testPlans.map((p) => p.c))
    .order('contract_id')
    .order('plan_id')
    .order('tier_id');
  const seenTierIds = new Set<string>();
  for (const r of allTiers.data ?? []) {
    seenTierIds.add((r as { tier_id?: string }).tier_id ?? '');
  }
  console.log(`  Unique tier_id values: ${Array.from(seenTierIds).sort().join(', ')}`);
  console.log(`  Sample rows for H9808-010:`);
  for (const r of (allTiers.data ?? []).filter((x) => (x as {contract_id?: string}).contract_id === 'H9808' && (x as {plan_id?: string}).plan_id === '010')) {
    const rr = r as Record<string, unknown>;
    console.log(`    tier_id=${rr.tier_id} copay=${rr.copay} coins=${rr.coinsurance} desc=${(String(rr.description ?? '')).slice(0, 40)}`);
  }

  // ─── 2. Standard vs preferred pharmacy split — check for any hint ───
  console.log('\n=== 2. Preferred vs standard pharmacy — column probes ===');
  // Probe alternative tables that might have preferred/standard split
  for (const t of ['pbp_pharmacy_network', 'pm_pharmacy_network_v2', 'pm_beneficiary_cost_v2', 'cms_spuf_beneficiary_cost']) {
    const q = await sb.from(t).select('*', { count: 'exact', head: true });
    if (!q.error) console.log(`  ${t}: exists, count=${q.count}`);
    else console.log(`  ${t}: ${q.error.message}`);
  }
  // Sample one row from pm_beneficiary_cost_v2 to see its shape
  const bc = await sb.from('pm_beneficiary_cost_v2').select('*').eq('contract_id', 'H9808').eq('plan_id', '010').limit(3);
  console.log(`  pm_beneficiary_cost_v2 sample (H9808-010):`, JSON.stringify(bc.data, null, 2));

  // ─── 3. Dental / vision / hearing rows ───
  console.log('\n=== 3. Dental / vision / hearing benefit_types + categories ===');
  const dvhTypes = await sb
    .from('pbp_benefits_v2')
    .select('benefit_type')
    .or('benefit_type.ilike.%dental%,benefit_type.ilike.%vision%,benefit_type.ilike.%hearing%,benefit_type.ilike.%contact%,benefit_type.ilike.%eyewear%')
    .limit(1000);
  const dvhTypeSet = new Set<string>();
  for (const r of dvhTypes.data ?? []) dvhTypeSet.add((r as {benefit_type?: string}).benefit_type ?? '');
  console.log(`  pbp benefit_types (dental/vision/hearing/contact/eyewear):`, Array.from(dvhTypeSet).sort().join(', '));
  const dvhCat = await sb
    .from('pm_plan_benefits')
    .select('benefit_category')
    .or('benefit_category.ilike.%dental%,benefit_category.ilike.%vision%,benefit_category.ilike.%hearing%,benefit_category.ilike.%contact%,benefit_category.ilike.%eyewear%')
    .limit(1000);
  const dvhCatSet = new Set<string>();
  for (const r of dvhCat.data ?? []) dvhCatSet.add((r as {benefit_category?: string}).benefit_category ?? '');
  console.log(`  pm_plan_benefits benefit_categories:`, Array.from(dvhCatSet).sort().join(', '));

  // Sample H3404-004 (Blue Medicare Freedom+) dental_preventive rows — Margaret's issue was PM=true MPF=false
  const dp = await sb
    .from('pbp_benefits_v2')
    .select('*')
    .eq('contract_id', 'H3404').eq('plan_id', '004')
    .or('benefit_type.eq.dental_preventive,benefit_type.eq.dental_comprehensive,benefit_type.eq.vision_exam,benefit_type.eq.hearing_exam');
  console.log(`  H3404-004 dental/vision/hearing pbp rows:`, JSON.stringify(dp.data, null, 2));

  // ─── 4. Priority 1-2 column existence ───
  console.log('\n=== 4. Priority 1-2 column existence probes ===');
  const catProbes = [
    'medical_deductible_oon', 'deductible_oon', 'oon_deductible',
    'drug_deductible_exceptions', 'tier_exception', 'deductible_tier',
    'cardiac_rehab', 'cardiac_rehabilitation',
    'pulmonary_rehab', 'pulmonary_rehabilitation',
    'home_health', 'home_health_services',
    'dialysis', 'dialysis_services',
    'worldwide_emergency', 'worldwide',
    'nurse_hotline', 'nurse_line', '24_7',
  ];
  const catSets = await sb
    .from('pbp_benefits_v2')
    .select('benefit_type')
    .in('benefit_type', catProbes)
    .limit(500);
  const foundCats = new Set<string>();
  for (const r of catSets.data ?? []) foundCats.add((r as {benefit_type?: string}).benefit_type ?? '');
  console.log(`  pbp_benefits_v2 benefit_types (matched): ${Array.from(foundCats).join(', ') || '(none)'}`);
  const catSets2 = await sb
    .from('pm_plan_benefits')
    .select('benefit_category')
    .in('benefit_category', catProbes)
    .limit(500);
  const foundCats2 = new Set<string>();
  for (const r of catSets2.data ?? []) foundCats2.add((r as {benefit_category?: string}).benefit_category ?? '');
  console.log(`  pm_plan_benefits benefit_categories (matched): ${Array.from(foundCats2).join(', ') || '(none)'}`);
  // Also fuzzy search for cardiac_ / pulmonary_ / etc.
  for (const kw of ['cardiac', 'pulmonary', 'dialysis', 'home_health', 'worldwide', 'nurse']) {
    const q = await sb
      .from('pbp_benefits_v2')
      .select('benefit_type', { count: 'exact', head: true })
      .ilike('benefit_type', `%${kw}%`);
    const q2 = await sb
      .from('pm_plan_benefits')
      .select('benefit_category', { count: 'exact', head: true })
      .ilike('benefit_category', `%${kw}%`);
    console.log(`  ilike '%${kw}%' — pbp count=${q.count} pm count=${q2.count}`);
  }

  // ─── 5. pm_plans column probe — anything about deductibles / rehab / etc. ───
  console.log('\n=== 5. pm_plans column probe (looking for OON deductible + tier exceptions) ===');
  const plan = await sb.from('pm_plans').select('*').eq('contract_id', 'H9808').eq('plan_id', '010').limit(1).maybeSingle();
  if (plan.data) {
    const cols = Object.keys(plan.data);
    console.log(`  Total columns: ${cols.length}`);
    console.log(`  Deductible/OON-related:`, cols.filter((c) => /deduct|oon|out.of.network|exception|tier/i.test(c)).join(', '));
    console.log(`  Rehab/therapy-related:`, cols.filter((c) => /rehab|therapy|home_?health|dialysis/i.test(c)).join(', '));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
