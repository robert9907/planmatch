#!/usr/bin/env tsx
// Phase 2c probe — investigate remaining category failures:
//   1. Vision — routine exam benefit_types
//   2. Dental — preventive vs comprehensive rows
//   3. Hearing — routine exam + hearing aid benefit_types
//   4. Ambulance — ground vs air separate rows?
//   5. Urgent care — top failing plan's raw pbp row
//   6. Specialist — top failing plan's raw pbp row
//   7. pm_beneficiary_cost_v2 — verify pharmacy_type filter for
//      preferred vs standard 30-day mapping

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
  // Show all rows for H9808-010 categorized — find dental preventive,
  // vision exam, hearing exam, urgent care, specialist, ambulance
  console.log('=== H9808-010 all pbp rows (filtered to targets) ===');
  const targets = [
    'dental_preventive', 'dental_comprehensive', 'dental',
    'vision_exam', 'vision', 'vision_eyewear', 'vision_contacts',
    'hearing_exam', 'hearing_aid', 'hearing_aid_allowance', 'hearing',
    'urgent_care', 'specialist_visit', 'specialist',
    'ambulance', 'ambulance_ground', 'ambulance_air', 'air_transportation',
    'telehealth',
  ];
  const rows = await sb
    .from('pbp_benefits_v2')
    .select('benefit_type, copay, copay_max, coinsurance, coverage_amount, max_coverage, copay_preferred, coinsurance_preferred, copay_mail_order, description, source')
    .eq('contract_id', 'H9808').eq('plan_id', '010')
    .in('benefit_type', targets)
    .order('benefit_type');
  for (const r of rows.data ?? []) {
    const rr = r as Record<string, unknown>;
    console.log(`  ${(String(rr.benefit_type)).padEnd(22)} copay=${rr.copay} coins=${rr.coinsurance} cov=${rr.coverage_amount} pref=${rr.copay_preferred} mail=${rr.copay_mail_order} src=${rr.source} desc=${(String(rr.description ?? '')).slice(0, 45)}`);
  }

  console.log('\n=== pm_beneficiary_cost_v2 H9808-010 tier 4 (verify pref/std split) ===');
  const tier4 = await sb
    .from('pm_beneficiary_cost_v2')
    .select('tier, days_supply_code, pharmacy_type, cost_type, cost_amount, coverage_level, deductible_applies')
    .eq('contract_id', 'H9808').eq('plan_id', '010')
    .eq('tier', 4)
    .eq('coverage_level', 0)
    .order('days_supply_code').order('pharmacy_type');
  for (const r of tier4.data ?? []) {
    const rr = r as Record<string, unknown>;
    console.log(`  tier=${rr.tier} days=${rr.days_supply_code} pharm=${rr.pharmacy_type} cost_type=${rr.cost_type} amount=${rr.cost_amount}`);
  }

  // Pick a plan with big urgentCareCopay F1 fail to trace
  // (Alignment H5296-003 James's plan was in top failing list)
  console.log('\n=== H5296-003 urgent_care + specialist rows ===');
  const uc = await sb
    .from('pbp_benefits_v2')
    .select('benefit_type, copay, copay_max, coinsurance, copay_preferred, coinsurance_preferred, description, source')
    .eq('contract_id', 'H5296').eq('plan_id', '003')
    .in('benefit_type', ['urgent_care', 'specialist_visit', 'ambulance', 'emergency_room']);
  for (const r of uc.data ?? []) {
    const rr = r as Record<string, unknown>;
    console.log(`  ${(String(rr.benefit_type)).padEnd(20)} copay=${rr.copay} coins=${rr.coinsurance} pref=${rr.copay_preferred} src=${rr.source} desc=${(String(rr.description ?? '')).slice(0, 50)}`);
  }

  console.log('\n=== pm_plan_benefits H5296-003 (urgent_care, specialist, ambulance) ===');
  const pmb = await sb
    .from('pm_plan_benefits')
    .select('benefit_category, copay, coinsurance, coverage_amount, max_coverage, benefit_description')
    .eq('contract_id', 'H5296').eq('plan_id', '003')
    .in('benefit_category', ['urgent_care', 'specialist', 'ambulance', 'air_transportation', 'emergency']);
  for (const r of pmb.data ?? []) {
    const rr = r as Record<string, unknown>;
    console.log(`  ${(String(rr.benefit_category)).padEnd(20)} copay=${rr.copay} coins=${rr.coinsurance} cov=${rr.coverage_amount} max=${rr.max_coverage} desc=${(String(rr.benefit_description ?? '')).slice(0, 50)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
