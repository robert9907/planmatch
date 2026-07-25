#!/usr/bin/env tsx
// Phase 1b probe — remaining schema questions for the 5-fix batch:
//   1. Vision — contact lens vs eyewear (separate rows or bundled?)
//   2. Rx Tier — mail 90-day + preferred vs standard pharmacy (verify
//      pm_beneficiary_cost_v2 matrix values map to what MPF returns)
//   3. Premium — Part D drug premium separately-filed? tier exception flag?
//   4. Uncommon drugs — Ingrezza, Adakveo, Endari, Deferasirox in pm_formulary?

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  // ─── 1. Vision — contact lens rows ───
  console.log('\n=== 1. Vision — pbp benefit_type inventory (contact + eyewear) ===');
  const visionTypes = await sb
    .from('pbp_benefits_v2')
    .select('benefit_type', { count: 'exact', head: false })
    .or('benefit_type.ilike.%contact%,benefit_type.ilike.%eyewear%,benefit_type.ilike.%vision%,benefit_type.ilike.%lens%,benefit_type.ilike.%frame%')
    .limit(200);
  const types = new Set<string>();
  for (const r of visionTypes.data ?? []) types.add((r as { benefit_type?: string }).benefit_type ?? '');
  console.log(`  benefit_types: ${Array.from(types).sort().join('\n                 ')}`);

  // Sample H9808-010 (Vitality) vision rows to see actual values
  const sample = await sb
    .from('pbp_benefits_v2')
    .select('benefit_type, copay, coinsurance, coverage_amount, max_coverage, description')
    .eq('contract_id', 'H9808').eq('plan_id', '010')
    .ilike('benefit_type', '%vision%');
  console.log(`  H9808-010 vision sample:`, JSON.stringify(sample.data, null, 2));

  // ─── 2. Rx tier — pm_beneficiary_cost_v2 full matrix for H9808-010 tier 1 ───
  console.log('\n=== 2. Rx tier — pm_beneficiary_cost_v2 tier 1 matrix (H9808-010) ===');
  const bcMatrix = await sb
    .from('pm_beneficiary_cost_v2')
    .select('tier, days_supply_code, pharmacy_type, cost_type, cost_amount, cost_min, cost_max, coverage_level')
    .eq('contract_id', 'H9808').eq('plan_id', '010')
    .eq('tier', 1)
    .order('coverage_level')
    .order('days_supply_code')
    .order('pharmacy_type');
  console.log(JSON.stringify(bcMatrix.data, null, 2));

  // ─── 3. Premium & Deductible — pm_plans columns + landscape ───
  console.log('\n=== 3a. pm_plans columns (drug/premium/oon-related) ===');
  const plan = await sb.from('pm_plans').select('*').limit(1).maybeSingle();
  if (plan.data) {
    const cols = Object.keys(plan.data);
    console.log(`  All cols with 'drug'|'premium'|'oon'|'tier':`, cols.filter((c) => /drug|premium|oon|out.of.network|tier|deduct/i.test(c)).join(', '));
  }
  console.log('\n=== 3b. cms_spuf_plan_information sample ===');
  const spufPlan = await sb.from('cms_spuf_plan_information').select('*').limit(1).maybeSingle();
  if (spufPlan.data) {
    const cols = Object.keys(spufPlan.data);
    console.log(`  columns:`, cols.join(', '));
  }
  console.log('\n=== 3c. pbp_plan_information? ===');
  const pbpPlan = await sb.from('pbp_plan_information').select('*', { count: 'exact', head: true });
  console.log(`  count: ${pbpPlan.count ?? 'err: ' + pbpPlan.error?.message}`);
  if (!pbpPlan.error) {
    const s = await sb.from('pbp_plan_information').select('*').limit(1).maybeSingle();
    if (s.data) console.log('  cols:', Object.keys(s.data).join(', '));
  }

  // Also try cms_spuf_pricing for Part D drug premium
  const pricing = await sb.from('cms_spuf_pricing').select('*').limit(1).maybeSingle();
  console.log('\n=== 3d. cms_spuf_pricing sample cols ===');
  if (pricing.data) console.log('  cols:', Object.keys(pricing.data).join(', '));
  else console.log('  none');

  // ─── 4. Uncommon drugs — Ingrezza, Adakveo, Endari, Deferasirox ───
  console.log('\n=== 4. Uncommon drug lookups (should exist for Wellcare S4802-081) ===');
  for (const term of ['ingrezza', 'valbenazine', 'endari', 'l-glutamine', 'deferasirox', 'jadenu', 'adakveo', 'crizanlizumab']) {
    const q = await sb
      .from('pm_formulary')
      .select('contract_id, plan_id, drug_name, tier', { count: 'exact' })
      .eq('contract_id', 'S4802').eq('plan_id', '081')
      .ilike('drug_name', `%${term}%`)
      .limit(3);
    console.log(`  '${term}' in S4802-081: count=${q.count} sample=${JSON.stringify((q.data ?? []).slice(0, 2))}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
