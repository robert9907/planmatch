// Phase 1.10 trace — reproduce /api/plans behavior for Wake NC + count
// D-SNPs at each stage. No writes.
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
  console.log('\n═══ 1.10c — pm_plans grain in Wake NC ═══');
  // Full unfiltered count of pm_plans rows for Wake NC
  const { count: totalRows } = await sb.from('pm_plans')
    .select('*', { count: 'exact', head: true })
    .eq('state','NC').ilike('county_name','Wake');
  console.log(`  Total pm_plans rows for NC/Wake: ${totalRows}`);

  const { count: totalNonSanct } = await sb.from('pm_plans')
    .select('*', { count: 'exact', head: true })
    .eq('state','NC').ilike('county_name','Wake').eq('sanctioned', false);
  console.log(`  After sanctioned=false: ${totalNonSanct}`);

  // Distinct plans (triple)
  const { data: allRows } = await sb.from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_type, snp_type, snp')
    .eq('state','NC').ilike('county_name','Wake').eq('sanctioned', false)
    .limit(5000);
  console.log(`  Rows returned (limit 5000): ${allRows?.length ?? 0}`);
  const distinct = new Set((allRows ?? []).map((r: any) => `${r.contract_id}-${r.plan_id}-${r.segment_id}`));
  console.log(`  Distinct (contract, plan, segment) tuples: ${distinct.size}`);

  const dsnpTuples = new Set((allRows ?? []).filter((r: any) => r.snp_type === 'D-SNP').map((r: any) => `${r.contract_id}-${r.plan_id}-${r.segment_id}`));
  console.log(`  Distinct D-SNP tuples: ${dsnpTuples.size}`);

  // Non-comm contracts
  const { data: nc } = await sb.from('pm_non_commissionable_contracts').select('contract_id, plan_number');
  const contractOnly = new Set((nc ?? []).filter((n: any) => n.plan_number == null).map((n: any) => n.contract_id));
  const perPlan = new Set((nc ?? []).filter((n: any) => n.plan_number != null).map((n: any) => `${n.contract_id}-${n.plan_number}`));
  console.log(`  Non-comm: ${contractOnly.size} contracts + ${perPlan.size} per-plan`);

  const filteredTuples = [...distinct].filter((t) => {
    const [c, p] = t.split('-');
    return !contractOnly.has(c) && !perPlan.has(`${c}-${p}`);
  });
  console.log(`  After non-comm filter: ${filteredTuples.length} tuples`);
  const filteredDsnp = filteredTuples.filter((t) => dsnpTuples.has(t));
  console.log(`  After non-comm, D-SNP tuples: ${filteredDsnp.length}`);

  // ═══ 1.10a — reproduce /api/plans PostgREST behavior at limit=2000 ═══
  console.log('\n═══ 1.10a — reproduce /api/plans limit=2000 query ═══');
  // Same query api/plans.ts:696-750 assembles:
  const contractExcl = [...contractOnly].join(',');
  let q = sb.from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, state, county_name, snp_type, plan_type, snp, sanctioned', { count: 'exact' })
    .eq('sanctioned', false)
    .limit(2000);
  if (contractExcl) q = q.not('contract_id', 'in', `(${contractExcl})`);
  q = q.eq('state', 'NC').or('county_name.ilike.Wake,county_name.eq.All Counties');
  const { data: apiRows, count: apiCount, error: apiErr } = await q;
  if (apiErr) console.error('  err:', apiErr);
  console.log(`  Actual rows returned: ${apiRows?.length ?? 0} (PostgREST count header claims: ${apiCount})`);
  const apiDistinct = new Set((apiRows ?? []).map((r: any) => `${r.contract_id}-${r.plan_id}-${r.segment_id}`));
  console.log(`  Distinct tuples in api rows: ${apiDistinct.size}`);
  const apiDsnp = new Set((apiRows ?? []).filter((r: any) => r.snp_type === 'D-SNP').map((r: any) => `${r.contract_id}-${r.plan_id}-${r.segment_id}`));
  console.log(`  Distinct D-SNP tuples in api rows: ${apiDsnp.size}`);

  // Check per-plan filter apply (JS-side in api/plans.ts)
  const apiFilteredDsnp = [...apiDsnp].filter((t) => {
    const [c, p] = t.split('-');
    return !perPlan.has(`${c}-${p}`);
  });
  console.log(`  After per-plan non-comm filter: ${apiFilteredDsnp.length} D-SNP tuples`);

  // Which D-SNP tuples are MISSING from the API response?
  const missing = filteredDsnp.filter((t) => !apiDsnp.has(t));
  console.log(`\n  D-SNP tuples that should be in the response but AREN'T:`);
  console.log(`  Missing count: ${missing.length}`);
  for (const t of missing) console.log(`    ${t}`);
  console.log(`\n  D-SNP tuples that ARE in the response:`);
  for (const t of apiDsnp) console.log(`    ${t}`);

  // ═══ Test limit=5000 as sanity check to detect truncation ═══
  console.log('\n═══ Sanity: rerun with limit=5000 ═══');
  let q2 = sb.from('pm_plans').select('contract_id, plan_id, segment_id, snp_type', { count: 'exact' }).eq('sanctioned', false).limit(5000);
  if (contractExcl) q2 = q2.not('contract_id','in',`(${contractExcl})`);
  q2 = q2.eq('state','NC').or('county_name.ilike.Wake,county_name.eq.All Counties');
  const { data: r5k, count: c5k } = await q2;
  console.log(`  Rows returned (limit=5000): ${r5k?.length ?? 0} (count claim: ${c5k})`);
  const d5k = new Set((r5k ?? []).filter((r: any) => r.snp_type === 'D-SNP').map((r: any) => `${r.contract_id}-${r.plan_id}-${r.segment_id}`));
  console.log(`  D-SNP distinct tuples: ${d5k.size}`);

  // ═══ Are the missing rows in the tail (post-1000)? paginated fetch ═══
  console.log('\n═══ Paginated fetch to defeat PostgREST 1000 cap ═══');
  const PAGE = 1000;
  const acc: any[] = [];
  for (let i = 0; i < 5; i++) {
    let qp = sb.from('pm_plans').select('contract_id, plan_id, segment_id, snp_type').eq('sanctioned', false).range(i*PAGE, i*PAGE+PAGE-1);
    if (contractExcl) qp = qp.not('contract_id','in',`(${contractExcl})`);
    qp = qp.eq('state','NC').or('county_name.ilike.Wake,county_name.eq.All Counties');
    const { data } = await qp;
    if (!data || data.length === 0) break;
    acc.push(...data);
    if (data.length < PAGE) break;
  }
  console.log(`  Paginated total: ${acc.length}`);
  const pgDistinct = new Set(acc.map((r: any) => `${r.contract_id}-${r.plan_id}-${r.segment_id}`));
  console.log(`  Paginated distinct tuples: ${pgDistinct.size}`);
  const pgDsnp = new Set(acc.filter((r: any) => r.snp_type === 'D-SNP').map((r: any) => `${r.contract_id}-${r.plan_id}-${r.segment_id}`));
  console.log(`  Paginated D-SNP distinct: ${pgDsnp.size}`);

  console.log('\n═══ Ordering of the returned 1000 rows ═══');
  // What order does PostgREST return? Group by carrier/parent to see if it clusters
  if (apiRows && apiRows.length === 1000) {
    console.log('  Response is EXACTLY 1000 rows → PostgREST cap likely applied.');
    // First and last carrier in the response
    console.log(`  First 3 rows: ${apiRows.slice(0,3).map((r:any) => `${r.contract_id}-${r.plan_id}`).join(', ')}`);
    console.log(`  Last 3 rows:  ${apiRows.slice(-3).map((r:any) => `${r.contract_id}-${r.plan_id}`).join(', ')}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
