// Phase 2 final verification — Wake NC D-SNPs under QI + QMB+ filters
// against the fixed dsnp_accepted_populations column. No writes.
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local','utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

const NORMALIZE: Record<string, string> = {
  'FBDE': 'fbde', 'QMB+': 'qmb_plus', 'QMB': 'qmb',
  'SLMB+': 'slmb_plus', 'SLMB': 'slmb', 'QI': 'qi', 'QDWI': 'qdwi',
};

async function main() {
  console.log('\n═══ Phase 2 final verify — Wake NC 27603 → county=Wake ═══');
  const { data: wake } = await sb.from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, parent_organization, carrier, snp_type, dsnp_accepted_populations, dsnp_eligible_tiers, dsnp_integration_status, dsnp_partial_duals')
    .eq('state', 'NC')
    .ilike('county_name', 'Wake')
    .eq('snp_type', 'D-SNP');

  // Non-comm strip
  const nc = await sb.from('pm_non_commissionable_contracts').select('contract_id, plan_number');
  const contractOnly = new Set((nc.data ?? []).filter((n: any) => n.plan_number == null).map((n: any) => n.contract_id));
  const perPlan = new Set((nc.data ?? []).filter((n: any) => n.plan_number != null).map((n: any) => `${n.contract_id}-${n.plan_number}`));

  const dsnp = (wake ?? []).filter((p: any) => !contractOnly.has(p.contract_id) && !perPlan.has(`${p.contract_id}-${p.plan_id}`));
  console.log(`  Wake NC D-SNPs after non-comm strip: ${dsnp.length}`);
  console.log(`\n  Full list (verify dropdown count):`);
  for (const p of dsnp) {
    console.log(`    ${p.contract_id}-${p.plan_id}-${p.segment_id ?? '0'} | ${(p.parent_organization ?? p.carrier ?? '?').padEnd(30)} | pop=${JSON.stringify(p.dsnp_accepted_populations)} | tiers=${JSON.stringify(p.dsnp_eligible_tiers)} | ${p.plan_name}`);
  }
  console.log(`\n  → SNP dropdown "D-SNP (N)" count should read: ${dsnp.length}`);

  // ═══ Simulate filterPlanPool for QI ═══
  console.log('\n═══ Simulated: medicaidLevel = "qi" filter ═══');
  const filterFor = (level: string) => (p: any) => {
    const pops = p.dsnp_accepted_populations ?? [];
    const normalized = pops.map((v: string) => NORMALIZE[v] ?? v.toLowerCase());
    return normalized.includes(level);
  };
  const qi = dsnp.filter(filterFor('qi'));
  console.log(`  Plans that pass QI filter: ${qi.length}`);
  for (const p of qi) console.log(`    ✓ ${p.contract_id}-${p.plan_id} ${p.plan_name}`);
  const qiDropped = dsnp.filter((p) => !filterFor('qi')(p));
  console.log(`  Plans dropped: ${qiDropped.length}`);
  for (const p of qiDropped) console.log(`    ✗ ${p.contract_id}-${p.plan_id} ${p.plan_name}  pop=${JSON.stringify(p.dsnp_accepted_populations)}`);

  // Ground-truth plans present + gated correctly under QI
  const ground = ['H5296-004', 'H5253-041', 'H4073-003'];
  console.log(`\n  Ground-truth D-SNP presence + gating (QI):`);
  for (const g of ground) {
    const [c, p] = g.split('-');
    const hit = qi.find((r: any) => r.contract_id === c && r.plan_id === p);
    const inPool = dsnp.find((r: any) => r.contract_id === c && r.plan_id === p);
    if (!inPool) { console.log(`    ✗ ${g}: NOT in Wake pool`); continue; }
    if (hit) console.log(`    ✓ ${g}: present in pool AND passes QI filter (pop=${JSON.stringify(inPool.dsnp_accepted_populations)})`);
    else console.log(`    ✗ ${g}: in pool but FAILS QI filter (pop=${JSON.stringify(inPool.dsnp_accepted_populations)})`);
  }

  // ═══ Simulate filterPlanPool for QMB+ ═══
  console.log('\n═══ Simulated: medicaidLevel = "qmb_plus" filter ═══');
  const qmbPlus = dsnp.filter(filterFor('qmb_plus'));
  console.log(`  Plans that pass QMB+ filter: ${qmbPlus.length}`);
  const qmbPlusDropped = dsnp.filter((p) => !filterFor('qmb_plus')(p));
  console.log(`  Plans dropped: ${qmbPlusDropped.length}`);
  for (const p of qmbPlusDropped) console.log(`    ✗ ${p.contract_id}-${p.plan_id} ${p.plan_name}  pop=${JSON.stringify(p.dsnp_accepted_populations)}`);

  console.log(`\n  Ground-truth gating under QMB+:`);
  for (const g of ground) {
    const [c, p] = g.split('-');
    const hit = qmbPlus.find((r: any) => r.contract_id === c && r.plan_id === p);
    const inPool = dsnp.find((r: any) => r.contract_id === c && r.plan_id === p);
    if (!inPool) { console.log(`    ✗ ${g}: NOT in Wake pool`); continue; }
    if (hit) console.log(`    ✓ ${g}: present in pool AND passes QMB+ filter (pop=${JSON.stringify(inPool.dsnp_accepted_populations)})`);
    else console.log(`    ⊘ ${g}: in pool, correctly EXCLUDED by QMB+ filter (pop=${JSON.stringify(inPool.dsnp_accepted_populations)})`);
  }

  // ═══ Set change confirmation ═══
  console.log('\n═══ Set change: QI → QMB+ ═══');
  const qiSet = new Set(qi.map((p: any) => `${p.contract_id}-${p.plan_id}`));
  const qmbPlusSet = new Set(qmbPlus.map((p: any) => `${p.contract_id}-${p.plan_id}`));
  const removedGoingToQmbPlus = [...qiSet].filter((k) => !qmbPlusSet.has(k));
  const addedGoingToQmbPlus = [...qmbPlusSet].filter((k) => !qiSet.has(k));
  console.log(`  Removed (was-in-QI, now-out-of-QMB+): ${removedGoingToQmbPlus.length}  ${removedGoingToQmbPlus.join(', ')}`);
  console.log(`  Added (now-in-QMB+, not-in-QI): ${addedGoingToQmbPlus.length}`);
  console.log(`  QI set size: ${qiSet.size}`);
  console.log(`  QMB+ set size: ${qmbPlusSet.size}`);
}
main().catch(e => { console.error(e); process.exit(1); });
