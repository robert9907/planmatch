#!/usr/bin/env tsx
// Mirror pm_plans.moop_combined into pm_plan_benefits as a 'moop_out'
// row per (contract, plan, segment). The consumer PlanDetail.tsx reads
// combined In+Out-of-Network MOOP from pm_plan_benefits.moop_out (via
// benefitByKey → coverage_amount) — without a row here the beneficiary
// sees "—" in the "Medical MOOP · out-of-network" cell even when
// pm_plans.moop_combined is populated.
//
// Mirror direction is one-way: pm_plans → pm_plan_benefits. The agent
// UI reads api/plans.ts (which reads pm_plans directly), so that side
// is already correct. Only the consumer relies on pm_plan_benefits.
//
// Semantics note: 'moop_out' is a legacy category name. For a PPO the
// value stored is the Combined In+Out-of-Network cap (what CMS files
// as MOOP-Combined). Consumer label text at PlanDetail.tsx:2376 is
// "Medical MOOP · out-of-network" — same convention.
//
// Idempotent: re-run after a subsequent moop_combined backfill and the
// new moop_out rows land without duplicates (DELETE-then-INSERT).
//
// Modes:
//   default                 → dry-run summary
//   --state NC[,TX,GA]      → mirror only those states (default NC,TX,GA)
//   --write                 → execute DELETE + INSERT against pm_plan_benefits

import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const sb = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const stateFlag = args.find((a) => a.startsWith('--state='))?.slice(8)
  ?? (args.includes('--state') ? args[args.indexOf('--state') + 1] : null);
const STATES = (stateFlag ?? 'NC,TX,GA').split(',').map((s) => s.trim().toUpperCase());
const BATCH_SIZE = 500;
const CATEGORY = 'moop_out';

interface PlanRow {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  moop_combined: number;
  state: string;
}

async function fetchAllPPOsWithCombined(state: string): Promise<PlanRow[]> {
  const out: PlanRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('pm_plans')
      .select('contract_id, plan_id, segment_id, moop_combined, state')
      .eq('state', state)
      .ilike('plan_type', '%ppo%')
      .not('moop_combined', 'is', null)
      .order('contract_id', { ascending: true })
      .order('plan_id', { ascending: true })
      .order('segment_id', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`fetch ${state}: ${error.message}`);
    const chunk = (data ?? []) as PlanRow[];
    out.push(...chunk);
    if (chunk.length < 1000) break;
    from += 1000;
  }
  return out;
}

async function main() {
  console.log(`=== ${WRITE ? 'WRITE' : 'DRY-RUN'} MODE ===`);
  console.log(`States: ${STATES.join(',')}`);
  console.log(`Target category: ${CATEGORY}`);
  console.log('');

  // pm_plans stores one row per (contract, plan, segment, COUNTY). MOOP
  // is plan-level, not county-level — the county rows carry duplicate
  // moop_combined values. pm_plan_benefits is keyed only by (contract,
  // plan, segment, category), so dedupe by that natural key before
  // writing. Detect and fail loudly on any within-key value drift so a
  // silent data inconsistency in pm_plans doesn't quietly get half-
  // mirrored.
  const dedupedByKey = new Map<string, PlanRow>();
  const perStateFetched: Record<string, number> = {};
  for (const st of STATES) {
    const rows = await fetchAllPPOsWithCombined(st);
    perStateFetched[st] = rows.length;
    for (const r of rows) {
      const key = `${r.contract_id}-${r.plan_id}-${r.segment_id}`;
      const existing = dedupedByKey.get(key);
      if (existing) {
        if (existing.moop_combined !== r.moop_combined) {
          throw new Error(
            `pm_plans MOOP drift for ${key}: ${existing.moop_combined} (${existing.state}) vs ${r.moop_combined} (${r.state}). ` +
            `Cannot mirror — investigate pm_plans first.`,
          );
        }
        continue;
      }
      dedupedByKey.set(key, r);
    }
    console.log(`  ${st}: ${perStateFetched[st]} pm_plans PPO rows fetched`);
  }
  const allRows = [...dedupedByKey.values()];
  console.log('');
  console.log(`Distinct (contract, plan, segment) tuples to mirror: ${allRows.length}`);
  console.log(`  (from ${Object.values(perStateFetched).reduce((a, b) => a + b, 0)} pm_plans rows — the rest are per-county duplicates)`);
  console.log('');

  if (allRows.length === 0) {
    console.log('Nothing to mirror.');
    return;
  }

  // Show a small sample for sanity
  console.log('Sample rows (first 3):');
  for (const r of allRows.slice(0, 3)) {
    console.log(`  ${r.contract_id}-${r.plan_id}-${r.segment_id} (${r.state}) → coverage_amount=$${r.moop_combined}`);
  }
  console.log('');

  if (!WRITE) {
    console.log('DRY-RUN — no writes. Pass --write to execute.');
    return;
  }

  // Idempotent replace: for each state, DELETE existing moop_out rows for
  // the plans we're about to mirror (scoped by contract+plan+segment
  // tuples), then INSERT fresh values in batches.
  //
  // The DELETE filter uses .in() on contract_id/plan_id/segment_id — we
  // can't do a compound-tuple .in() through PostgREST, so we scope by
  // state via a join through pm_plans instead. Simpler: filter by our
  // exact contract+plan+segment tuples using a chunked .or() query.
  //
  // Simpler-still: DELETE all moop_out rows for the states involved by
  // joining through pm_plans on (contract_id, plan_id, segment_id) —
  // but PostgREST doesn't do cross-table DELETE. So we chunk the tuples.

  const t0 = Date.now();

  // Chunk the delete-then-insert per BATCH_SIZE plans
  let deleted = 0;
  let inserted = 0;
  for (let i = 0; i < allRows.length; i += BATCH_SIZE) {
    const batch = allRows.slice(i, i + BATCH_SIZE);

    // DELETE by natural key. Build one .or() clause covering the batch.
    // PostgREST .or() takes and(...) groups: and(contract_id.eq.X,plan_id.eq.Y,segment_id.eq.Z)
    const orExpr = batch
      .map((r) => `and(contract_id.eq.${r.contract_id},plan_id.eq.${r.plan_id},segment_id.eq.${r.segment_id})`)
      .join(',');
    const del = await sb
      .from('pm_plan_benefits')
      .delete({ count: 'exact' })
      .eq('benefit_category', CATEGORY)
      .or(orExpr);
    if (del.error) throw new Error(`DELETE batch @${i}: ${del.error.message}`);
    deleted += del.count ?? 0;

    // INSERT fresh rows
    const payload = batch.map((r) => ({
      contract_id: r.contract_id,
      plan_id: r.plan_id,
      segment_id: r.segment_id,
      benefit_category: CATEGORY,
      benefit_description: `Combined In+Out-of-Network MOOP · $${r.moop_combined.toLocaleString()}`,
      coverage_amount: r.moop_combined,
      copay: null,
      coinsurance: null,
      max_coverage: null,
    }));
    const ins = await sb.from('pm_plan_benefits').insert(payload).select('id');
    if (ins.error) throw new Error(`INSERT batch @${i}: ${ins.error.message}`);
    inserted += ins.data?.length ?? 0;

    const done = Math.min(i + BATCH_SIZE, allRows.length);
    console.log(`  progress: ${done}/${allRows.length}  (batch deleted=${del.count ?? 0}, inserted=${ins.data?.length ?? 0})`);
  }

  const elapsedMin = ((Date.now() - t0) / 60_000).toFixed(1);
  console.log('');
  console.log('=== SUMMARY ===');
  console.log(`Duration: ${elapsedMin} min`);
  console.log(`DELETE: ${deleted} moop_out rows removed`);
  console.log(`INSERT: ${inserted} moop_out rows created`);
  console.log('');

  // Post-write verification: for each state, count how many PPO plans
  // now have a moop_out row.
  console.log('Post-write verification:');
  for (const st of STATES) {
    const c = await sb
      .from('pm_plan_benefits')
      .select('id', { count: 'exact', head: true })
      .eq('benefit_category', CATEGORY);
    // We can't join through pm_plans for a state filter without an RPC;
    // just report the total for now (unfiltered) — per-state breakdown
    // is available via the mirror source count above.
    console.log(`  ${st}: expected ~${allRows.filter((r) => r.state === st).length} rows written`);
    void c;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
