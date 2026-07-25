#!/usr/bin/env tsx
// Backfill pm_plan_benefits for diabetic_supplies / chiropractic /
// acupuncture on MA/MAPD plans in NC/TX/GA where the pre-fix audit
// (audit-diabetes-chiro-acupuncture.ts) found gaps or null-copay
// placeholders that mask real pbp values from the render layer.
//
// Three operations (all source-ranked medicare_gov > sb_ocr > manual
// > cms_pbp when picking the pbp truth):
//
// 1) PM_MISSING_PBP_HAS (INSERT)
//    Any category × plan-segment where pm_plan_benefits has no row
//    but pbp_benefits does. Same pattern as the home_health + meal_
//    benefit mirror.
//
// 2) DIABETIC_SUPPLIES null-copay UPDATE
//    Every pm.diabetic_supplies row in prod today has copay=null and
//    a description-only placeholder ("Diabetic supplies covered ·
//    Part B DME") — the importer wrote presence markers without
//    structured cost sharing. pbp holds the actual copay (usually
//    $0 from medicare_gov). Update pm's copay in-place, preserve
//    description. Skip rows whose description says "not covered".
//
// 3) VALUE_MISMATCH on chiropractic / acupuncture (SKIP)
//    Where both pm and pbp have structured copay values and they
//    disagree, leave pm alone — those are real source-of-truth
//    disputes that need MPF spot-check. Not scoping in.
//
// Idempotent — re-running is safe.
//
// Modes:
//   default              → dry-run summary
//   --state NC[,TX,GA]   → scope by state (default NC,TX,GA)
//   --write              → execute the DB writes

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
const stateArg = args.find((a) => a.startsWith('--state='))?.slice(8)
  ?? (args.includes('--state') ? args[args.indexOf('--state') + 1] : null);
const STATES = (stateArg ?? 'NC,TX,GA').split(',').map((s) => s.trim().toUpperCase());
const BATCH_SIZE = 500;

interface PlanKey { contract_id: string; plan_id: string; segment_id: string; state: string }
interface PmRow { copay: number | null; coinsurance: number | null; benefit_description: string | null }
interface PbpRow { copay: number | null; copay_max: number | null; coinsurance: number | null; description: string | null; source: string | null }

const PBP_RANK: Record<string, number> = { medicare_gov: 5, sb_ocr: 4, manual: 3, cms_pbp: 2, pbp: 2 };

function chunk<T>(a: T[], n: number): T[][] { const o: T[][]=[]; for (let i=0;i<a.length;i+=n) o.push(a.slice(i,i+n)); return o; }

function collapseRange(r: PbpRow): number | null {
  // Same rule as api/plan-benefits.ts range-collapse: copay=0 + copay_max>0 → high end.
  if (r.copay === 0 && r.copay_max != null && r.copay_max > 0) return r.copay_max;
  return r.copay;
}

async function loadPlans(): Promise<Map<string, PlanKey>> {
  const plans = new Map<string, PlanKey>();
  for (const st of STATES) {
    let from = 0;
    while (true) {
      const r = await sb.from('pm_plans').select('contract_id, plan_id, segment_id, plan_type').eq('state', st).not('plan_type', 'ilike', '%pdp%').range(from, from + 999);
      const c = r.data ?? [];
      for (const row of c as any[]) {
        const k = `${row.contract_id}-${row.plan_id}-${row.segment_id}`;
        if (!plans.has(k)) plans.set(k, { contract_id: row.contract_id, plan_id: row.plan_id, segment_id: row.segment_id, state: st });
      }
      if (c.length < 1000) break; from += 1000;
    }
  }
  return plans;
}

async function loadPmRowsByKey(category: string): Promise<Map<string, PmRow>> {
  const out = new Map<string, PmRow>();
  let from = 0;
  while (true) {
    const r = await sb.from('pm_plan_benefits').select('contract_id, plan_id, segment_id, copay, coinsurance, benefit_description').eq('benefit_category', category).range(from, from + 999);
    const c = r.data ?? [];
    for (const row of c as any[]) {
      out.set(`${row.contract_id}-${row.plan_id}-${row.segment_id}`, { copay: row.copay, coinsurance: row.coinsurance, benefit_description: row.benefit_description });
    }
    if (c.length < 1000) break; from += 1000;
  }
  return out;
}

async function loadPbpBest(plans: Map<string, PlanKey>, benefitTypes: string[]): Promise<Map<string, PbpRow>> {
  const combined = [...new Set([...plans.values()].map((p) => `${p.contract_id}-${p.plan_id}`))];
  const bestByPlan = new Map<string, PbpRow>();
  for (const bt of benefitTypes) {
    for (const slice of chunk(combined, 200)) {
      const r = await sb.from('pbp_benefits').select('plan_id, copay, copay_max, coinsurance, description, source').eq('benefit_type', bt).in('plan_id', slice);
      for (const row of (r.data ?? []) as any[]) {
        const cur = bestByPlan.get(row.plan_id);
        const curRank = cur ? (PBP_RANK[cur.source ?? ''] ?? 0) : -1;
        const newRank = PBP_RANK[row.source ?? ''] ?? 0;
        if (newRank > curRank) bestByPlan.set(row.plan_id, row);
      }
    }
  }
  return bestByPlan;
}

async function insertRows(payload: Array<Record<string, unknown>>): Promise<number> {
  let n = 0;
  for (const batch of chunk(payload, BATCH_SIZE)) {
    const ins = await sb.from('pm_plan_benefits').insert(batch).select('id');
    if (ins.error) throw new Error(`INSERT: ${ins.error.message}`);
    n += ins.data?.length ?? 0;
  }
  return n;
}

// Update pm_plan_benefits rows in-place by natural key (contract,
// plan, segment, category). PostgREST supports UPDATE with matching
// filters — one call per row keeps the semantics simple.
async function updateRow(category: string, key: PlanKey, patch: Record<string, unknown>): Promise<boolean> {
  const u = await sb.from('pm_plan_benefits').update(patch)
    .eq('contract_id', key.contract_id).eq('plan_id', key.plan_id).eq('segment_id', key.segment_id)
    .eq('benefit_category', category);
  if (u.error) throw new Error(`UPDATE ${category} ${key.contract_id}-${key.plan_id}-${key.segment_id}: ${u.error.message}`);
  return true;
}

async function processCategory(
  category: string,
  pbpTypes: string[],
  plans: Map<string, PlanKey>,
): Promise<{ inserted: number; updated: number; missingBoth: number }> {
  console.log(`\n── ${category} ──`);
  const pmMap = await loadPmRowsByKey(category);
  const pbpBest = await loadPbpBest(plans, pbpTypes);

  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ key: PlanKey; patch: Record<string, unknown> }> = [];
  let missingBoth = 0;
  let valueDispute = 0;

  for (const [k, plan] of plans) {
    const pm = pmMap.get(k);
    const pbp = pbpBest.get(`${plan.contract_id}-${plan.plan_id}`);
    if (!pm && !pbp) { missingBoth++; continue; }
    if (!pm && pbp) {
      // INSERT (PM_MISSING_PBP_HAS)
      const copay = collapseRange(pbp);
      inserts.push({
        contract_id: plan.contract_id,
        plan_id: plan.plan_id,
        segment_id: plan.segment_id,
        benefit_category: category,
        benefit_description: pbp.description ?? (copay != null ? `$${copay} copay` : null),
        copay,
        coinsurance: pbp.coinsurance,
        max_coverage: pbp.copay_max,
        coverage_amount: null,
      });
      continue;
    }
    if (pm && pbp) {
      const pbpCopay = collapseRange(pbp);
      // Only patch when pm has NO structured value (placeholder-only row).
      // Real disputes (both have different structured values) stay.
      if (pm.copay == null && pm.coinsurance == null && (pbp.copay != null || pbp.coinsurance != null)) {
        // Skip explicit "not covered" placeholders — those are meant
        // to communicate absence, not import gaps.
        if ((pm.benefit_description ?? '').toLowerCase().includes('not covered')) continue;
        updates.push({
          key: plan,
          patch: { copay: pbpCopay, coinsurance: pbp.coinsurance },
        });
      } else if (pm.copay != null && pbpCopay != null && pm.copay !== pbpCopay) {
        valueDispute++;
      }
    }
  }

  console.log(`  INSERTs planned:              ${inserts.length}`);
  console.log(`  UPDATEs (null-copay backfill): ${updates.length}`);
  console.log(`  Value disputes (both filed, differ — skipped): ${valueDispute}`);
  console.log(`  Neither pm nor pbp (legit gap): ${missingBoth}`);

  if (!WRITE) {
    if (inserts.length > 0) console.log(`  sample INSERT: ${JSON.stringify(inserts[0])}`);
    if (updates.length > 0) console.log(`  sample UPDATE: ${JSON.stringify({ key: `${updates[0].key.contract_id}-${updates[0].key.plan_id}-${updates[0].key.segment_id}`, patch: updates[0].patch })}`);
    return { inserted: 0, updated: 0, missingBoth };
  }

  const inserted = inserts.length > 0 ? await insertRows(inserts) : 0;
  let updated = 0;
  let uProgress = 0;
  for (const { key, patch } of updates) {
    await updateRow(category, key, patch);
    updated++;
    uProgress++;
    if (uProgress % 100 === 0) console.log(`  UPDATE progress: ${uProgress}/${updates.length}`);
  }
  console.log(`  DONE: INSERT ${inserted} + UPDATE ${updated}`);
  return { inserted, updated, missingBoth };
}

async function main() {
  console.log(`=== ${WRITE ? 'WRITE' : 'DRY-RUN'} MODE ===`);
  console.log(`States: ${STATES.join(',')}`);
  const plans = await loadPlans();
  console.log(`MA/MAPD plans in scope: ${plans.size}`);

  await processCategory('diabetic_supplies', ['diabetic_supplies'], plans);
  await processCategory('chiropractic', ['chiropractic', 'professional_services__chiropractic'], plans);
  await processCategory('acupuncture', ['acupuncture'], plans);

  console.log(`\n${WRITE ? 'Write complete.' : 'Dry-run only. Pass --write to execute.'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
