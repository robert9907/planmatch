#!/usr/bin/env tsx
// Phase 2e — full dental + vision subcategory inventory, and root-cause probe
// for outpatient F1 (urgent care, specialist).

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
  // 1. FULL dental benefit_type universe (no plan filter)
  console.log('=== 1. All dental benefit_types (with counts) ===');
  const dental = await sb
    .from('pbp_benefits_v2')
    .select('benefit_type')
    .ilike('benefit_type', '%dental%')
    .limit(50000);
  const dCounts: Record<string, number> = {};
  for (const r of dental.data ?? []) {
    const bt = (r as { benefit_type?: string }).benefit_type ?? '';
    dCounts[bt] = (dCounts[bt] ?? 0) + 1;
  }
  for (const [bt, cnt] of Object.entries(dCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cnt.toString().padStart(6)} ${bt}`);
  }

  // 2. FULL vision benefit_type universe
  console.log('\n=== 2. All vision/eye benefit_types (with counts) ===');
  const vision = await sb
    .from('pbp_benefits_v2')
    .select('benefit_type')
    .or('benefit_type.ilike.%vision%,benefit_type.ilike.%eye%,benefit_type.ilike.%eyewear%,benefit_type.ilike.%frame%,benefit_type.ilike.%contact%,benefit_type.ilike.%lens%,benefit_type.ilike.%optical%')
    .limit(50000);
  const vCounts: Record<string, number> = {};
  for (const r of vision.data ?? []) {
    const bt = (r as { benefit_type?: string }).benefit_type ?? '';
    vCounts[bt] = (vCounts[bt] ?? 0) + 1;
  }
  for (const [bt, cnt] of Object.entries(vCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cnt.toString().padStart(6)} ${bt}`);
  }

  // 3. Sample dental rows for a plan that MPF returns rich dental data on
  console.log('\n=== 3. Full dental picture for H9808-010 (all fields) ===');
  const d1 = await sb
    .from('pbp_benefits_v2')
    .select('benefit_type, copay, copay_max, coinsurance, coverage_amount, max_coverage, description')
    .eq('contract_id', 'H9808').eq('plan_id', '010')
    .or('benefit_type.ilike.%dental%')
    .order('benefit_type');
  for (const r of d1.data ?? []) {
    const rr = r as Record<string, unknown>;
    console.log(`  ${(String(rr.benefit_type)).padEnd(55)} copay=${rr.copay} coins=${rr.coinsurance} cov=${rr.coverage_amount} max=${rr.max_coverage} desc=${(String(rr.description ?? '')).slice(0, 40)}`);
  }

  // 4. Vision rows for H9808-010
  console.log('\n=== 4. Full vision picture for H9808-010 ===');
  const v1 = await sb
    .from('pbp_benefits_v2')
    .select('benefit_type, copay, coinsurance, coverage_amount, max_coverage, description')
    .eq('contract_id', 'H9808').eq('plan_id', '010')
    .or('benefit_type.ilike.%vision%,benefit_type.ilike.%eye%,benefit_type.ilike.%contact%,benefit_type.ilike.%frame%,benefit_type.ilike.%lens%')
    .order('benefit_type');
  for (const r of v1.data ?? []) {
    const rr = r as Record<string, unknown>;
    console.log(`  ${(String(rr.benefit_type)).padEnd(55)} copay=${rr.copay} coins=${rr.coinsurance} cov=${rr.coverage_amount} max=${rr.max_coverage} desc=${(String(rr.description ?? '')).slice(0, 40)}`);
  }

  // 5. Urgent care rows across top failing plans (H9808-009, H5296-003, etc.)
  console.log('\n=== 5. Urgent care rows for top failing plans ===');
  for (const p of [['H9808', '009'], ['H5296', '003'], ['H3404', '004'], ['H1036', '335']]) {
    const [c, pl] = p;
    const uc = await sb
      .from('pbp_benefits_v2')
      .select('benefit_type, copay, copay_max, coinsurance, description, source')
      .eq('contract_id', c).eq('plan_id', pl)
      .or('benefit_type.ilike.%urgent%,benefit_type.ilike.%specialist%');
    console.log(`  --- ${c}-${pl} ---`);
    for (const r of uc.data ?? []) {
      const rr = r as Record<string, unknown>;
      console.log(`    ${(String(rr.benefit_type)).padEnd(20)} copay=${rr.copay} copay_max=${rr.copay_max} coins=${rr.coinsurance} src=${rr.source} desc=${(String(rr.description ?? '')).slice(0, 40)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
