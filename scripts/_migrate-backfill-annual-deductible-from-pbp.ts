// Backfill pm_plans.annual_deductible from pbp_benefits.medical_deductible
// for plans where pm_plans is currently $0 (post-migration default) but
// pbp_benefits has a real value from source='medicare_gov'.
//
// Why this exists: the previous migration set 27,681 NULL → 0. That was
// correct for the majority (no medical deductible) but masked a smaller
// set where pm_plans never had the value but pbp_benefits does, and
// api/plans.ts:1102 already merges the right number into consumer
// responses. The audit harness reads pm_plans.annual_deductible
// directly, so it sees $0 and reports RED even though consumers see
// the right $250–$820.
//
// Strategy:
//   1. Pull every pbp_benefits row where benefit_type='medical_deductible'
//      AND source='medicare_gov' AND copay > 0.
//   2. Bucket by 2-part plan_id (contract-plan). Multiple rows per plan
//      exist (different segments / tier_ids collapsed in pbp_benefits) —
//      take the MIN(copay) per plan, matching the merge convention at
//      api/plans.ts:904 ("Plan Finder convention").
//   3. For each pm_plans row where annual_deductible = 0 and the map
//      has an entry > 0, UPDATE to the pbp value.
//
// Idempotent — re-running is a no-op once aligned. Run via:
//   npx tsx scripts/_migrate-backfill-annual-deductible-from-pbp.ts

import { createClient, type PostgrestSingleResponse } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const url = process.env.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!url || !key) {
  console.error('Need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function paginate<T>(pageFn: (from: number, to: number) => PromiseLike<PostgrestSingleResponse<T[]>>): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let p = 0; p < 40; p += 1) {
    const from = p * PAGE;
    const { data, error } = await pageFn(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

async function main() {
  // Step 1: pull every medicare_gov medical_deductible row with copay > 0.
  console.log('[step1] loading pbp_benefits medical_deductible rows (source=medicare_gov, copay > 0)...');
  const ddxRows = await paginate<{ plan_id: string; copay: number }>((from, to) =>
    sb.from('pbp_benefits')
      .select('plan_id, copay')
      .eq('benefit_type', 'medical_deductible')
      .eq('source', 'medicare_gov')
      .gt('copay', 0)
      .order('plan_id', { ascending: true })
      .range(from, to),
  );
  console.log(`         ${ddxRows.length} rows total`);

  // Step 2: bucket by 2-part plan_id, take MIN(copay) per plan.
  const minByPlanKey = new Map<string, number>();
  for (const r of ddxRows) {
    const cur = minByPlanKey.get(r.plan_id);
    if (cur == null || r.copay < cur) minByPlanKey.set(r.plan_id, r.copay);
  }
  console.log(`         ${minByPlanKey.size} distinct 2-part plan keys with non-zero deductible`);

  // Step 3: find pm_plans rows where annual_deductible = 0 and we have
  // a pbp value. Need to load them paginated to honor the PostgREST
  // 1000-row cap.
  console.log('[step2] loading pm_plans rows where annual_deductible = 0...');
  const candidates = await paginate<{ contract_id: string; plan_id: string; segment_id: string | null; annual_deductible: number | null }>((from, to) =>
    sb.from('pm_plans')
      .select('contract_id, plan_id, segment_id, annual_deductible')
      .eq('annual_deductible', 0)
      .order('contract_id', { ascending: true })
      .order('plan_id', { ascending: true })
      .range(from, to),
  );
  console.log(`         ${candidates.length} candidate rows`);

  // Step 4: pair candidates with their pbp value.
  const updates: { contract_id: string; plan_id: string; new_value: number }[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const key2 = `${c.contract_id}-${c.plan_id}`;
    const newVal = minByPlanKey.get(key2);
    if (newVal == null) continue;
    if (seen.has(key2)) continue;
    seen.add(key2);
    updates.push({ contract_id: c.contract_id, plan_id: c.plan_id, new_value: newVal });
  }
  console.log(`[step3] ${updates.length} (contract, plan) tuples need backfill`);
  if (updates.length === 0) {
    console.log('        nothing to do.');
    return;
  }

  // Preview top 10
  console.log('        sample:');
  for (const u of updates.slice(0, 10)) {
    console.log(`          ${u.contract_id}-${u.plan_id}  →  $${u.new_value}`);
  }

  // Step 5: execute. UPDATE one (contract, plan) at a time keeps the
  // .eq + .eq combination simple, but a bulk approach via in() per
  // distinct value is much faster. Bucket updates by new_value and
  // batch with .in() on (contract, plan) keys.
  console.log('[step4] executing updates (batched by deductible value)...');
  const byValue = new Map<number, { contract_id: string; plan_id: string }[]>();
  for (const u of updates) {
    const arr = byValue.get(u.new_value) ?? [];
    arr.push({ contract_id: u.contract_id, plan_id: u.plan_id });
    byValue.set(u.new_value, arr);
  }
  let totalUpdated = 0;
  for (const [val, list] of byValue) {
    // PostgREST has no composite IN — split into per-contract batches.
    const byContract = new Map<string, string[]>();
    for (const x of list) {
      const arr = byContract.get(x.contract_id) ?? [];
      arr.push(x.plan_id);
      byContract.set(x.contract_id, arr);
    }
    for (const [cid, planIds] of byContract) {
      const { error, count } = await sb.from('pm_plans')
        .update({ annual_deductible: val }, { count: 'exact' })
        .eq('contract_id', cid)
        .in('plan_id', planIds)
        .eq('annual_deductible', 0);
      if (error) {
        console.error(`  $${val} contract=${cid}: ${error.message}`);
        continue;
      }
      totalUpdated += count ?? 0;
    }
  }
  console.log(`        ${totalUpdated} pm_plans rows updated`);

  // Step 6: verify the 6 audit plans specifically.
  console.log('\n[verify] the 6 originally-flagged audit plans:');
  const targets = ['H5525-050','H1914-010','H5525-083','H5525-035','H7849-113','H5216-211'];
  for (const t of targets) {
    const [c, p] = t.split('-');
    const { data } = await sb.from('pm_plans')
      .select('annual_deductible')
      .eq('contract_id', c)
      .eq('plan_id', p)
      .limit(1);
    const ad = data?.[0]?.annual_deductible;
    console.log(`  ${t}: annual_deductible = ${ad == null ? 'NULL' : `$${ad}`}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
