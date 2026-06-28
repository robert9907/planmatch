// Segment-aware backfill of pm_plans.annual_deductible from
// pbp_benefits_v2.medical_deductible (source=medicare_gov).
//
// Supersedes _migrate-backfill-annual-deductible-from-pbp.ts, which
// joined on a 2-part (contract, plan) key and took min(copay). That
// rule produced consumer-visible drift on multi-segment plans where
// different segments file genuinely different medical deductibles —
// e.g. H7849-113 segments 1/2/3/4 file $820/$570/$710/$675 but every
// pm_plans row landed on $570 (the min), so segments 3 and 4 were
// under-stated by $105–$140.
//
// pbp_benefits_v2 has had a segment_id column since migration 013;
// the data is correctly per-segment at the base table. Only the
// pbp_benefits compatibility view strips it (concat contract||plan).
// This script bypasses the view and joins (contract, plan, segment).
//
// Strategy:
//   1. Pull every pbp_benefits_v2 row with benefit_type='medical_deductible'
//      AND source='medicare_gov'. Bucket by (contract, plan, segment).
//   2. For each (contract, plan, segment) key in pm_plans, look up the
//      authoritative pbp value. UPDATE if pm differs.
//   3. Report the 4 known audit-flagged plans + a population summary.
//
// Idempotent.

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
  for (let p = 0; p < 60; p += 1) {
    const from = p * PAGE;
    const { data, error } = await pageFn(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

function normalizeSeg(seg: string | null | undefined): string {
  // pbp_benefits_v2 stores segment_id as single-char ('0', '1', '2',
  // ...); pm_plans.segment_id is consistent with the same form. Strip
  // leading zeros to be safe — '000' / '00' / '0' all normalize to '0'.
  if (seg == null) return '0';
  const stripped = String(seg).replace(/^0+/, '');
  return stripped || '0';
}

async function main() {
  // Step 1: pull pbp_benefits_v2 medical_deductible rows.
  console.log('[step1] loading pbp_benefits_v2.medical_deductible (source=medicare_gov)...');
  const pbpRows = await paginate<{ contract_id: string; plan_id: string; segment_id: string | null; copay: number | null }>((from, to) =>
    sb.from('pbp_benefits_v2')
      .select('contract_id, plan_id, segment_id, copay')
      .eq('benefit_type', 'medical_deductible')
      .eq('source', 'medicare_gov')
      .not('copay', 'is', null)
      .order('contract_id').order('plan_id').order('segment_id')
      .range(from, to),
  );
  console.log(`         ${pbpRows.length} rows`);

  // Step 2: map (contract, plan, segment) → copay. If a key appears
  // twice (it shouldn't given the unique index), keep the smaller —
  // matches the prior backfill's conservative convention.
  const pbpByKey = new Map<string, number>();
  for (const r of pbpRows) {
    if (r.copay == null) continue;
    const k = `${r.contract_id}-${r.plan_id}-${normalizeSeg(r.segment_id)}`;
    const cur = pbpByKey.get(k);
    if (cur == null || r.copay < cur) pbpByKey.set(k, r.copay);
  }
  console.log(`         ${pbpByKey.size} distinct (contract, plan, segment) keys`);

  // Step 3: for every pm_plans row, look up authoritative pbp value.
  // Only UPDATE when pm differs (avoid no-op writes).
  console.log('[step2] scanning pm_plans for divergence...');
  const pmRows = await paginate<{ contract_id: string; plan_id: string; segment_id: string | null; annual_deductible: number | null }>((from, to) =>
    sb.from('pm_plans')
      .select('contract_id, plan_id, segment_id, annual_deductible')
      .order('contract_id').order('plan_id').order('segment_id')
      .range(from, to),
  );
  console.log(`         ${pmRows.length} pm_plans rows total`);

  // Bucket pm by segment-key — dedupe across denormalized county rows.
  // pm_plans has one row per (plan, county) so the same (contract,
  // plan, segment) tuple recurs 5-60+ times.
  const pmKeyToCurrent = new Map<string, number | null>();
  for (const r of pmRows) {
    const k = `${r.contract_id}-${r.plan_id}-${normalizeSeg(r.segment_id)}`;
    if (!pmKeyToCurrent.has(k)) pmKeyToCurrent.set(k, r.annual_deductible);
  }
  console.log(`         ${pmKeyToCurrent.size} distinct pm segment keys`);

  const updates: { c: string; p: string; seg: string; from: number | null; to: number }[] = [];
  for (const [k, cur] of pmKeyToCurrent) {
    const auth = pbpByKey.get(k);
    if (auth == null) continue;
    if (cur === auth) continue;
    const [c, p, seg] = k.split('-');
    updates.push({ c, p, seg, from: cur, to: auth });
  }
  console.log(`[step3] ${updates.length} segment keys diverge from pbp_benefits_v2`);

  // Distribution
  const byDelta = new Map<string, number>();
  for (const u of updates) {
    const d = u.from == null ? `${u.to}-from-null` : `${u.from}→${u.to}`;
    byDelta.set(d, (byDelta.get(d) ?? 0) + 1);
  }
  const topDelta = [...byDelta.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log('        top deltas (sample):');
  for (const [d, n] of topDelta) console.log(`          ${d.padEnd(20)} ${n}`);

  // Show the 4 audit-flagged keys
  console.log('\n[audit] pre-update state of the 4 known RED plans:');
  const KNOWN = ['H7849-113-3','H7849-113-4','H5216-043-1','H5216-043-6'];
  for (const k of KNOWN) {
    const cur = pmKeyToCurrent.get(k);
    const auth = pbpByKey.get(k);
    console.log(`  ${k}: pm=$${cur ?? 'NULL'}  →  pbp=$${auth ?? '(missing)'}`);
  }
  if (updates.length === 0) {
    console.log('\n  nothing to update.');
    return;
  }

  // Step 4: batch by (new value, contract) to keep query count low.
  console.log('\n[step4] executing updates (batched by value × contract)...');
  const byValueContract = new Map<string, { newVal: number; c: string; planSegs: { p: string; seg: string }[] }>();
  for (const u of updates) {
    const k = `${u.to}|${u.c}`;
    const cur = byValueContract.get(k) ?? { newVal: u.to, c: u.c, planSegs: [] };
    cur.planSegs.push({ p: u.p, seg: u.seg });
    byValueContract.set(k, cur);
  }
  let totalUpdated = 0;
  for (const { newVal, c, planSegs } of byValueContract.values()) {
    // PostgREST has no composite IN. Group by segment then per-segment
    // .in('plan_id', ...). Keeps query count down compared to one
    // UPDATE per (plan, segment).
    const bySeg = new Map<string, string[]>();
    for (const ps of planSegs) {
      const arr = bySeg.get(ps.seg) ?? [];
      arr.push(ps.p);
      bySeg.set(ps.seg, arr);
    }
    for (const [seg, planIds] of bySeg) {
      const { error, count } = await sb.from('pm_plans')
        .update({ annual_deductible: newVal }, { count: 'exact' })
        .eq('contract_id', c)
        .in('plan_id', planIds)
        .eq('segment_id', seg);
      if (error) { console.error(`  $${newVal} contract=${c} seg=${seg}: ${error.message}`); continue; }
      totalUpdated += count ?? 0;
    }
  }
  console.log(`        ${totalUpdated} pm_plans rows updated`);

  // Step 5: verify the 4 audit plans
  console.log('\n[verify] post-update state of the 4 known RED plans:');
  for (const k of KNOWN) {
    const [c, p, seg] = k.split('-');
    const { data } = await sb.from('pm_plans')
      .select('annual_deductible')
      .eq('contract_id', c).eq('plan_id', p).eq('segment_id', seg)
      .limit(1);
    const ad = data?.[0]?.annual_deductible;
    console.log(`  ${k}: annual_deductible = $${ad ?? 'NULL'}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
