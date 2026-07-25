#!/usr/bin/env tsx
// Phase 2d — probe granular dental/vision/hearing + Rx tier F1 root cause
// + telehealth categories.

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

async function distinctTypes(regex: string) {
  const rows = await sb
    .from('pbp_benefits_v2')
    .select('benefit_type')
    .or(regex)
    .limit(2000);
  const set = new Set<string>();
  for (const r of rows.data ?? []) set.add((r as { benefit_type?: string }).benefit_type ?? '');
  return Array.from(set).sort();
}

async function main() {
  console.log('=== 1. Dental benefit_types ===');
  console.log((await distinctTypes('benefit_type.ilike.%dental%')).join('\n'));

  console.log('\n=== 2. Vision benefit_types ===');
  console.log((await distinctTypes('benefit_type.ilike.%vision%,benefit_type.ilike.%eye%,benefit_type.ilike.%contact%,benefit_type.ilike.%lens%,benefit_type.ilike.%frame%')).join('\n'));

  console.log('\n=== 3. Hearing benefit_types ===');
  console.log((await distinctTypes('benefit_type.ilike.%hearing%,benefit_type.ilike.%audiology%')).join('\n'));

  console.log('\n=== 4. Telehealth benefit_types ===');
  console.log((await distinctTypes('benefit_type.ilike.%telehealth%,benefit_type.ilike.%tele%,benefit_type.ilike.%virtual%,benefit_type.ilike.%remote%')).join('\n'));

  // ─── 5. Rx tier — S4802-143 tier 4 (top F1 fail) all rows in pm_beneficiary_cost_v2 ───
  console.log('\n=== 5. pm_beneficiary_cost_v2 S4802-143 tier 4 all rows ===');
  const bc = await sb
    .from('pm_beneficiary_cost_v2')
    .select('coverage_level, days_supply_code, pharmacy_type, cost_type, cost_amount, cost_min, cost_max, deductible_applies')
    .eq('contract_id', 'S4802').eq('plan_id', '143')
    .eq('tier', 4)
    .order('coverage_level').order('days_supply_code').order('pharmacy_type');
  for (const r of bc.data ?? []) {
    const rr = r as Record<string, unknown>;
    console.log(`  cov=${rr.coverage_level} days=${rr.days_supply_code} pharm=${rr.pharmacy_type} type=${rr.cost_type} amt=${rr.cost_amount} min=${rr.cost_min} max=${rr.cost_max}`);
  }

  // Also for H5296-003 which has non-dual F1 outpatient fails
  console.log('\n=== 6. pm_beneficiary_cost_v2 H5296-003 tier 4 all rows ===');
  const bc2 = await sb
    .from('pm_beneficiary_cost_v2')
    .select('coverage_level, days_supply_code, pharmacy_type, cost_type, cost_amount')
    .eq('contract_id', 'H5296').eq('plan_id', '003')
    .eq('tier', 4)
    .order('coverage_level').order('days_supply_code').order('pharmacy_type');
  for (const r of bc2.data ?? []) {
    const rr = r as Record<string, unknown>;
    console.log(`  cov=${rr.coverage_level} days=${rr.days_supply_code} pharm=${rr.pharmacy_type} type=${rr.cost_type} amt=${rr.cost_amount}`);
  }

  // ─── 7. Dental rows for H9808-010 with granular subcategories ───
  console.log('\n=== 7. All dental rows for H9808-010 (pbp) ===');
  const d = await sb
    .from('pbp_benefits_v2')
    .select('benefit_type, copay, copay_max, coinsurance, coverage_amount, max_coverage, description, source')
    .eq('contract_id', 'H9808').eq('plan_id', '010')
    .ilike('benefit_type', '%dental%');
  for (const r of d.data ?? []) {
    const rr = r as Record<string, unknown>;
    console.log(`  ${String(rr.benefit_type).padEnd(50)} copay=${rr.copay} coins=${rr.coinsurance} cov=${rr.coverage_amount} max=${rr.max_coverage} src=${rr.source}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
