// Phase 2.1 full audit — paginated fetch of every NC/TX/GA D-SNP row
// to get authoritative distinct-array counts (defeats PostgREST 1000-
// row cap that made Phase 1.2 a 1000-row sample). No writes.
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local','utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

async function paginate<T>(fn: (from: number, to: number) => any): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let i = 0; i < 30; i++) {
    const { data, error } = await fn(i * PAGE, i * PAGE + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...(data as T[]));
    if (data.length < PAGE) break;
  }
  return out;
}

async function main() {
  console.log('\n═══ Full NC/TX/GA D-SNP row audit (paginated) ═══');
  const rows = await paginate<{
    contract_id: string; plan_id: string; state: string;
    dsnp_accepted_populations: string[] | null;
    dsnp_eligible_tiers: string[] | null;
    dsnp_partial_duals: boolean | null;
    dsnp_integration_status: string | null;
  }>((from, to) =>
    sb.from('pm_plans')
      .select('contract_id, plan_id, state, dsnp_accepted_populations, dsnp_eligible_tiers, dsnp_partial_duals, dsnp_integration_status')
      .eq('snp_type', 'D-SNP')
      .in('state', ['NC','TX','GA'])
      .range(from, to)
  );
  console.log(`  Total NC/TX/GA D-SNP rows: ${rows.length}`);

  const popsBucket = new Map<string, { rows: number; plans: Set<string>; partial: Map<string, number> }>();
  const tiersBucket = new Map<string, { rows: number; plans: Set<string> }>();
  const consistencyByPop = new Map<string, { partialTrue: number; partialFalse: number; coordOnly: number }>();
  for (const r of rows) {
    const pk = JSON.stringify(r.dsnp_accepted_populations);
    const tk = JSON.stringify(r.dsnp_eligible_tiers);
    const planKey = `${r.contract_id}-${r.plan_id}`;
    if (!popsBucket.has(pk)) popsBucket.set(pk, { rows: 0, plans: new Set(), partial: new Map() });
    if (!tiersBucket.has(tk)) tiersBucket.set(tk, { rows: 0, plans: new Set() });
    const p = popsBucket.get(pk)!;
    p.rows += 1; p.plans.add(planKey);
    const pv = String(r.dsnp_partial_duals);
    p.partial.set(pv, (p.partial.get(pv) ?? 0) + 1);
    const t = tiersBucket.get(tk)!;
    t.rows += 1; t.plans.add(planKey);
    if (!consistencyByPop.has(pk)) consistencyByPop.set(pk, { partialTrue: 0, partialFalse: 0, coordOnly: 0 });
    const c = consistencyByPop.get(pk)!;
    if (r.dsnp_partial_duals === true) c.partialTrue += 1;
    if (r.dsnp_partial_duals === false) c.partialFalse += 1;
    if (r.dsnp_integration_status === 'Coordination Only') c.coordOnly += 1;
  }
  console.log(`  Distinct dsnp_accepted_populations arrays: ${popsBucket.size}`);
  for (const [k, v] of [...popsBucket.entries()].sort((a, b) => b[1].rows - a[1].rows)) {
    console.log(`    ${k}  rows=${v.rows}  plans=${v.plans.size}  partial-flag=${JSON.stringify(Object.fromEntries(v.partial))}`);
  }
  console.log(`\n  Distinct dsnp_eligible_tiers arrays: ${tiersBucket.size}`);
  for (const [k, v] of [...tiersBucket.entries()].sort((a, b) => b[1].rows - a[1].rows)) {
    console.log(`    ${k}  rows=${v.rows}  plans=${v.plans.size}`);
  }

  // Coordination-Only consistency check across FULL row set
  console.log('\n═══ Coordination-Only consistency (FULL row set) ═══');
  let selfContradict = 0;
  const contradictPlans = new Set<string>();
  for (const r of rows) {
    if (r.dsnp_integration_status !== 'Coordination Only') continue;
    const pops = r.dsnp_accepted_populations ?? [];
    const missing = ['QMB','SLMB','QI'].filter(p => !pops.includes(p));
    if (missing.length > 0) {
      selfContradict += 1;
      contradictPlans.add(`${r.contract_id}-${r.plan_id}`);
    }
  }
  console.log(`  Coordination-Only rows: ${rows.filter(r => r.dsnp_integration_status === 'Coordination Only').length}`);
  console.log(`  Self-contradicting rows: ${selfContradict}`);
  console.log(`  Distinct self-contradicting plans: ${contradictPlans.size}`);

  // ═══ Sample Partial Dual=Yes plans by carrier ═══
  console.log('\n═══ Partial Dual=Yes plans by carrier (from pm_plans) ═══');
  const partialYesPlans = new Set(rows.filter(r => r.dsnp_partial_duals === true).map(r => `${r.contract_id}-${r.plan_id}`));
  console.log(`  Distinct Partial Dual=Yes plans: ${partialYesPlans.size}`);
  const { data: pySample } = await sb.from('pm_plans')
    .select('contract_id, plan_id, plan_name, state, parent_organization, carrier')
    .in('state', ['NC','TX','GA'])
    .eq('snp_type', 'D-SNP')
    .eq('dsnp_partial_duals', true)
    .limit(50);
  const seen = new Set<string>();
  for (const r of pySample ?? []) {
    const k = `${r.contract_id}-${r.plan_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`    ${r.state} ${k} | ${(r.parent_organization ?? r.carrier ?? '?').padEnd(28)} | ${r.plan_name}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
