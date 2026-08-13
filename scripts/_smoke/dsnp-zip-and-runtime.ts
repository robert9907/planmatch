import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local','utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

async function main() {
  console.log('\n═══ PHASE 0.4 — ZIP 27603 → county resolution ═══');
  const { data: zip, error: zErr } = await sb.from('pm_zip_county').select('*').eq('zip5', '27603').limit(5);
  console.log('pm_zip_county[zip5=27603]:', JSON.stringify(zip), 'err=', zErr?.message);

  // Try alternate schema (some repos: zip_code)
  const { data: alt } = await sb.from('pm_zip_county').select('*').limit(1);
  console.log('pm_zip_county sample row (schema check):', JSON.stringify(alt));

  const { data: wakeFips } = await sb.from('pm_county_fips').select('*').ilike('county_name','wake').eq('state','NC').limit(5);
  console.log('Wake NC in pm_county_fips:', JSON.stringify(wakeFips));

  // segment_id widths on pm_plans vs pm_plan_benefits (memory says 1-char vs 3-char)
  console.log('\n═══ segment_id width check (memory: pm_plans stores 1-char, pm_plan_benefits 3-char) ═══');
  const { data: pmPlansSegs } = await sb.from('pm_plans').select('segment_id').eq('snp_type','D-SNP').limit(20);
  const segLens = new Set((pmPlansSegs ?? []).map((r: any) => (r.segment_id ?? '').length));
  console.log('pm_plans D-SNP segment_id lengths:', [...segLens]);
  const { data: pmBenSegs } = await sb.from('pm_plan_benefits').select('segment_id').limit(20);
  const benLens = new Set((pmBenSegs ?? []).map((r: any) => (r.segment_id ?? '').length));
  console.log('pm_plan_benefits segment_id lengths:', [...benLens]);

  // ═══ PHASE 1.1 (extended) — three ground-truth plans, Wake row only ═══
  console.log('\n═══ Wake-row detail: H1036-307, H5525-072, H4073-003 ═══');
  const { data: wakeRows } = await sb.from('pm_plans').select('contract_id, plan_id, segment_id, plan_name, snp_type, dsnp_integration_status, zero_cost_sharing, dsnp_accepted_populations, dsnp_eligible_tiers, dsnp_partial_duals, dsnp_only_contract, monthly_premium, sanctioned')
    .in('contract_id', ['H1036','H5525','H4073'])
    .in('plan_id', ['307','072','003'])
    .eq('state', 'NC')
    .ilike('county_name', 'Wake');
  for (const r of wakeRows ?? []) {
    console.log(`  ${r.contract_id}-${r.plan_id}-${r.segment_id}: pop=${JSON.stringify(r.dsnp_accepted_populations)} tiers=${JSON.stringify(r.dsnp_eligible_tiers)} int=${r.dsnp_integration_status} partial=${r.dsnp_partial_duals} onlyD=${r.dsnp_only_contract} ZCS=${r.zero_cost_sharing} prem=${r.monthly_premium} sanct=${r.sanctioned} name=${r.plan_name}`);
  }

  // ═══ PHASE 1.9 — H1036-307 premium: monthly_premium vs consumer_premium ═══
  console.log('\n═══ H1036-307 premium source columns ═══');
  const { data: prem } = await sb.from('pm_plans').select('contract_id, plan_id, monthly_premium, part_c_premium, part_d_premium, part_d_basic_premium, consumer_premium, member_premium, snp_type').eq('contract_id','H1036').eq('plan_id','307').limit(3);
  console.log(JSON.stringify(prem, null, 2));

  // ═══ Also cross-check: how many D-SNPs total in NC/Wake pm_plans have dsnp_accepted_populations NULL ═══
  console.log('\n═══ NC/Wake D-SNPs with NULL populations ═══');
  const { data: nullPop } = await sb.from('pm_plans').select('contract_id, plan_id, plan_name').eq('state','NC').ilike('county_name','Wake').eq('snp_type','D-SNP').is('dsnp_accepted_populations', null);
  console.log(`  NULL population count: ${nullPop?.length ?? 0}`);
  for (const r of nullPop ?? []) console.log(`    ${r.contract_id}-${r.plan_id} ${r.plan_name}`);

  // ═══ NON-COMM impact ═══
  console.log('\n═══ Which Wake D-SNPs does non-comm strip? ═══');
  const { data: wakeAll } = await sb.from('pm_plans').select('contract_id, plan_id, plan_name').eq('state','NC').ilike('county_name','Wake').eq('snp_type','D-SNP');
  const { data: nc } = await sb.from('pm_non_commissionable_contracts').select('contract_id, plan_number');
  const stripped: string[] = [];
  for (const p of wakeAll ?? []) {
    const match = (nc ?? []).find((n: any) => n.contract_id === p.contract_id && (n.plan_number == null || n.plan_number === p.plan_id));
    if (match) stripped.push(`${p.contract_id}-${p.plan_id} (${p.plan_name}) [blk by ${match.contract_id}${match.plan_number ? '-'+match.plan_number : ' contract-wide'}]`);
  }
  console.log(`  Stripped: ${stripped.length}`);
  for (const s of stripped) console.log(`    ${s}`);
  console.log(`  Surviving after non-comm: ${(wakeAll?.length ?? 0) - stripped.length}`);
}
main().catch(e => { console.error(e); process.exit(1); });
