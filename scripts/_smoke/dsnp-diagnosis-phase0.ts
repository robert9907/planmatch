// Read-only diagnosis probe for D-SNP dual-population filtering bug.
// Phase 0 + Phase 1 data queries. No writes.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const url = process.env.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
if (!url || !key) { console.error('need SUPABASE_URL + key'); process.exit(1); }

const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const GT_PLANS: Array<[string, string, string?]> = [
  ['H5296', null as any, 'Alignment NC Duals'],
  ['H1036', '307', 'Humana Dual Select 307'],
  ['H5525', '072', 'Humana Dual Select 072'],
  ['H4073', '003', 'Wellcare Dual Reserve 003'],
  ['H2001', null as any, 'UHC Dual Complete NC-D001 (contract varies)'],
];

async function main() {
  console.log('\n═══ PHASE 0.1 — Wake NC D-SNP raw dump ═══');
  const { data: wakeZip } = await sb
    .from('pm_zip_county')
    .select('zip5, county_name, county_fips, primary_state')
    .eq('zip5', '27603');
  console.log('ZIP 27603 → county resolution:', wakeZip);

  const wakeFips = wakeZip?.find((r: any) => r.county_name?.toLowerCase().includes('wake'))?.county_fips
    ?? wakeZip?.[0]?.county_fips ?? '37183';
  console.log('Using Wake county_fips:', wakeFips);

  const cols = 'contract_id, plan_id, segment_id, plan_name, plan_type, snp_type, ' +
    'dsnp_integration_status, zero_cost_sharing, dsnp_accepted_populations, ' +
    'dsnp_eligible_tiers, dsnp_partial_duals, dsnp_only_contract, ' +
    'parent_organization, carrier, monthly_premium, state, county_name, county_fips';

  // Method A: direct county_name match
  const { data: byName, error: e1 } = await sb
    .from('pm_plans')
    .select(cols)
    .eq('state', 'NC')
    .ilike('county_name', 'Wake')
    .eq('snp_type', 'D-SNP');
  if (e1) console.error('byName err', e1);
  console.log(`\nD-SNPs in NC/Wake via county_name ilike: ${byName?.length ?? 0}`);
  for (const p of byName ?? []) {
    console.log(`  ${p.contract_id}-${p.plan_id}-${p.segment_id} | ${(p.parent_organization ?? p.carrier ?? '?').padEnd(14)} | pop=${JSON.stringify(p.dsnp_accepted_populations)} | tiers=${JSON.stringify(p.dsnp_eligible_tiers)} | int=${p.dsnp_integration_status} | ZCS=${p.zero_cost_sharing} | prem=${p.monthly_premium} | ${p.plan_name}`);
  }

  // Method B: via county_fips (memory: county_fips was wiped, so likely empty)
  const { data: byFips } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, county_fips')
    .eq('snp_type', 'D-SNP')
    .eq('county_fips', wakeFips)
    .limit(5);
  console.log(`\nSpot-check via county_fips=${wakeFips}: ${byFips?.length ?? 0} rows (memory says pm_plans.county_fips is 100% NULL)`);

  // ═══ PHASE 0.2 — presence of 5 ground-truth plans in Wake ═══
  console.log('\n═══ PHASE 0.2 — Ground-truth plan presence ═══');
  for (const [contract, plan, label] of GT_PLANS) {
    let q = sb.from('pm_plans').select('contract_id, plan_id, segment_id, county_name, state, snp_type, parent_organization, carrier, plan_name, dsnp_accepted_populations, dsnp_eligible_tiers, dsnp_integration_status, dsnp_partial_duals').eq('contract_id', contract);
    if (plan) q = q.eq('plan_id', plan);
    const { data } = await q;
    const inWake = (data ?? []).filter((r: any) => r.county_name?.toLowerCase() === 'wake' && r.state === 'NC');
    const otherNC = (data ?? []).filter((r: any) => r.state === 'NC' && r.county_name?.toLowerCase() !== 'wake');
    const otherState = (data ?? []).filter((r: any) => r.state !== 'NC');
    const uniqPlans = new Set((data ?? []).map((r: any) => `${r.contract_id}-${r.plan_id}`));
    console.log(`\n  ${label}  [${contract}${plan ? '-'+plan : ''}]  total_rows=${data?.length ?? 0}  distinct_plans=${uniqPlans.size}`);
    console.log(`    Wake NC:      ${inWake.length}  ${inWake.slice(0,3).map((r:any) => r.contract_id+'-'+r.plan_id+'-'+r.segment_id).join(' ')}`);
    console.log(`    Other NC:     ${otherNC.length}`);
    console.log(`    Other states: ${otherState.length}`);
    for (const r of inWake.slice(0, 3)) {
      console.log(`      → ${r.contract_id}-${r.plan_id}-${r.segment_id} | ${r.plan_name} | pop=${JSON.stringify(r.dsnp_accepted_populations)} | tiers=${JSON.stringify(r.dsnp_eligible_tiers)} | int=${r.dsnp_integration_status} | partial=${r.dsnp_partial_duals}`);
    }
  }

  // Also try UHC by different UHC contract prefixes
  console.log('\n  UHC search (broader):');
  const { data: uhc } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, county_name')
    .eq('state', 'NC')
    .ilike('county_name', 'Wake')
    .eq('snp_type', 'D-SNP')
    .or('parent_organization.ilike.%UnitedHealth%,carrier.ilike.%United%,plan_name.ilike.%Dual Complete%');
  console.log(`    Wake NC UHC/DualComplete matches: ${uhc?.length ?? 0}`);
  for (const r of uhc ?? []) console.log(`      ${r.contract_id}-${r.plan_id}-${r.segment_id} | ${r.plan_name}`);

  // Alignment
  console.log('\n  Alignment search (broader):');
  const { data: align } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, county_name, parent_organization, carrier')
    .eq('state', 'NC')
    .ilike('county_name', 'Wake')
    .eq('snp_type', 'D-SNP')
    .or('parent_organization.ilike.%Alignment%,carrier.ilike.%Alignment%');
  console.log(`    Wake NC Alignment matches: ${align?.length ?? 0}`);
  for (const r of align ?? []) console.log(`      ${r.contract_id}-${r.plan_id}-${r.segment_id} | ${r.plan_name}`);

  // Wellcare
  const { data: wellcare } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, county_name')
    .eq('state', 'NC')
    .ilike('county_name', 'Wake')
    .eq('snp_type', 'D-SNP')
    .or('parent_organization.ilike.%Wellcare%,parent_organization.ilike.%Centene%,carrier.ilike.%Wellcare%');
  console.log(`\n  Wellcare/Centene Wake NC D-SNP matches: ${wellcare?.length ?? 0}`);
  for (const r of wellcare ?? []) console.log(`    ${r.contract_id}-${r.plan_id}-${r.segment_id} | ${r.plan_name}`);

  // ═══ PHASE 0.3 — non-commissionable ═══
  console.log('\n═══ PHASE 0.3 — pm_non_commissionable_contracts ═══');
  const { data: nc } = await sb.from('pm_non_commissionable_contracts').select('*');
  console.log(`  Total blacklist rows: ${nc?.length ?? 0}`);
  for (const r of nc ?? []) {
    console.log(`    ${JSON.stringify(r)}`);
  }

  // ═══ PHASE 1.1 — dump 3 ground-truth plans in detail ═══
  console.log('\n═══ PHASE 1.1 — H1036-307, H5525-072, H4073-003 detail ═══');
  const detail = await sb
    .from('pm_plans')
    .select(cols)
    .or('and(contract_id.eq.H1036,plan_id.eq.307),and(contract_id.eq.H5525,plan_id.eq.072),and(contract_id.eq.H4073,plan_id.eq.003)')
    .limit(30);
  console.log(`  ${detail.data?.length ?? 0} rows`);
  for (const r of detail.data ?? []) {
    console.log(`    ${r.state} ${r.county_name?.padEnd(12)} ${r.contract_id}-${r.plan_id}-${r.segment_id} | pop=${JSON.stringify(r.dsnp_accepted_populations)} | tiers=${JSON.stringify(r.dsnp_eligible_tiers)} | int=${r.dsnp_integration_status} | partial=${r.dsnp_partial_duals} | ZCS=${r.zero_cost_sharing} | prem=${r.monthly_premium}`);
  }

  // ═══ PHASE 1.2 — distinct arrays ═══
  console.log('\n═══ PHASE 1.2 — distinct dsnp_accepted_populations across NC/TX/GA D-SNPs ═══');
  const { data: allDsnp } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, state, dsnp_accepted_populations, dsnp_eligible_tiers')
    .eq('snp_type', 'D-SNP')
    .in('state', ['NC', 'TX', 'GA'])
    .limit(15000);
  const popsBucket = new Map<string, { rows: number; plans: Set<string> }>();
  const tiersBucket = new Map<string, { rows: number; plans: Set<string> }>();
  for (const r of allDsnp ?? []) {
    const pk = JSON.stringify(r.dsnp_accepted_populations);
    const tk = JSON.stringify(r.dsnp_eligible_tiers);
    const planKey = `${r.contract_id}-${r.plan_id}`;
    if (!popsBucket.has(pk)) popsBucket.set(pk, { rows: 0, plans: new Set() });
    if (!tiersBucket.has(tk)) tiersBucket.set(tk, { rows: 0, plans: new Set() });
    const p = popsBucket.get(pk)!;
    p.rows += 1; p.plans.add(planKey);
    const t = tiersBucket.get(tk)!;
    t.rows += 1; t.plans.add(planKey);
  }
  console.log(`  Total NC/TX/GA D-SNP rows scanned: ${allDsnp?.length ?? 0}`);
  console.log(`  Distinct dsnp_accepted_populations arrays: ${popsBucket.size}`);
  for (const [k, v] of [...popsBucket.entries()].sort((a, b) => b[1].rows - a[1].rows)) {
    console.log(`    ${k}  rows=${v.rows}  plans=${v.plans.size}`);
  }
  console.log(`  Distinct dsnp_eligible_tiers arrays: ${tiersBucket.size}`);
  for (const [k, v] of [...tiersBucket.entries()].sort((a, b) => b[1].rows - a[1].rows)) {
    console.log(`    ${k}  rows=${v.rows}  plans=${v.plans.size}`);
  }

  // ═══ PHASE 1.5 — Coordination-Only consistency check ═══
  console.log('\n═══ PHASE 1.5 — Coordination-Only w/ populations excluding QMB/SLMB/QI ═══');
  const { data: cordOnly } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, state, dsnp_accepted_populations, dsnp_integration_status')
    .eq('snp_type', 'D-SNP')
    .eq('dsnp_integration_status', 'Coordination Only')
    .in('state', ['NC','TX','GA'])
    .limit(15000);
  let cordSelfContradict = 0;
  const cordPlans = new Set<string>();
  for (const r of cordOnly ?? []) {
    const pops: string[] = r.dsnp_accepted_populations ?? [];
    const missing = ['QMB','SLMB','QI'].filter((p) => !pops.includes(p));
    if (missing.length > 0) {
      cordSelfContradict += 1;
      cordPlans.add(`${r.contract_id}-${r.plan_id}`);
    }
  }
  console.log(`  Coordination-Only rows scanned: ${cordOnly?.length ?? 0}`);
  console.log(`  Self-contradicting rows (pop missing >=1 of QMB/SLMB/QI): ${cordSelfContradict}`);
  console.log(`  Distinct self-contradicting plans: ${cordPlans.size}`);

  // ZCS in Wake
  console.log('\n  Wake NC D-SNP zero_cost_sharing count:');
  const { data: zcsWake } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, plan_name, zero_cost_sharing')
    .eq('state', 'NC')
    .ilike('county_name', 'Wake')
    .eq('snp_type', 'D-SNP');
  const zcsTrue = (zcsWake ?? []).filter((r: any) => r.zero_cost_sharing === true);
  console.log(`    Total Wake D-SNP rows: ${zcsWake?.length ?? 0}; ZCS=true: ${zcsTrue.length}`);
  for (const r of zcsWake ?? []) console.log(`      ${r.contract_id}-${r.plan_id} ZCS=${r.zero_cost_sharing} ${r.plan_name}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
