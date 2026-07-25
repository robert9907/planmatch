#!/usr/bin/env tsx
// Backfill pm_plan_benefits rows for home_health + meal_benefit on
// MA/MAPD plans in NC/TX/GA where the pre-audit found gaps:
//
//   home_health   — 247 plans missing the row entirely. CMS mandates
//                   MA plans charge no more than Original Medicare
//                   ($0 for the first 100 days of intermittent skilled
//                   care under Part A, per 42 CFR § 422.100(j)). Insert
//                   copay=0 with a "(CMS standard)" description so the
//                   render layer surfaces the federal floor honestly
//                   without pretending it came from a carrier filing.
//
//   meal_benefit  — 361 plan-segments where pbp_benefits.meal_benefit
//                   is populated but pm_plan_benefits.meal_benefit is
//                   missing (systemic import gap — the pbp importer
//                   never populates this category). Mirror the pbp
//                   row's copay + description forward so the consumer
//                   PlanDetail.tsx `case 'meal_benefit'` render path
//                   surfaces "Covered" / the pbp description instead
//                   of "Not available".
//
// Idempotent: DELETE-then-INSERT keyed by (contract, plan, segment,
// benefit_category). Re-running captures new pbp rows without
// duplicates.
//
// Modes:
//   default              → dry-run summary
//   --state NC[,TX,GA]   → scope by state (default NC,TX,GA)
//   --category home_health|meal_benefit  → only that category
//   --write              → execute DELETE + INSERT

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
const categoryArg = args.find((a) => a.startsWith('--category='))?.slice(11)
  ?? (args.includes('--category') ? args[args.indexOf('--category') + 1] : null);
const RUN_HH = !categoryArg || categoryArg === 'home_health';
const RUN_MB = !categoryArg || categoryArg === 'meal_benefit';
const BATCH_SIZE = 500;

function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

interface PlanKey { contract_id: string; plan_id: string; segment_id: string; state: string }

async function loadMaMapdPlans(): Promise<Map<string, PlanKey>> {
  const plans = new Map<string, PlanKey>();
  for (const st of STATES) {
    let from = 0;
    while (true) {
      const r = await sb.from('pm_plans')
        .select('contract_id, plan_id, segment_id, plan_type')
        .eq('state', st)
        .not('plan_type', 'ilike', '%pdp%')
        .range(from, from + 999);
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

async function existingKeys(category: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let from = 0;
  while (true) {
    const r = await sb.from('pm_plan_benefits')
      .select('contract_id, plan_id, segment_id')
      .eq('benefit_category', category)
      .range(from, from + 999);
    const c = r.data ?? [];
    for (const row of c as any[]) keys.add(`${row.contract_id}-${row.plan_id}-${row.segment_id}`);
    if (c.length < 1000) break; from += 1000;
  }
  return keys;
}

// PBP row → pm insert payload. Prefer medicare_gov > sb_ocr > manual > cms_pbp source.
const PBP_RANK: Record<string, number> = { medicare_gov: 5, sb_ocr: 4, manual: 3, cms_pbp: 2, pbp: 2 };
interface PbpMealRow { plan_id: string; copay: number | null; copay_max: number | null; coinsurance: number | null; description: string | null; source: string | null }
async function loadPbpMealBenefit(plans: Map<string, PlanKey>): Promise<Map<string, PbpMealRow>> {
  const combined = [...new Set([...plans.values()].map((p) => `${p.contract_id}-${p.plan_id}`))];
  const bestByPlan = new Map<string, PbpMealRow>();
  for (const slice of chunk(combined, 200)) {
    const r = await sb.from('pbp_benefits')
      .select('plan_id, copay, copay_max, coinsurance, description, source')
      .eq('benefit_type', 'meal_benefit')
      .in('plan_id', slice);
    for (const row of (r.data ?? []) as PbpMealRow[]) {
      const cur = bestByPlan.get(row.plan_id);
      const curRank = cur ? (PBP_RANK[cur.source ?? ''] ?? 0) : -1;
      const newRank = PBP_RANK[row.source ?? ''] ?? 0;
      if (newRank > curRank) bestByPlan.set(row.plan_id, row);
    }
  }
  return bestByPlan;
}

async function writeBatches(category: string, payload: Array<Record<string, unknown>>): Promise<{ del: number; ins: number }> {
  let del = 0, ins = 0;
  for (const batch of chunk(payload, BATCH_SIZE)) {
    // DELETE per-tuple to stay idempotent (natural key = contract+plan+segment+category)
    const orExpr = batch
      .map((r) => `and(contract_id.eq.${r.contract_id},plan_id.eq.${r.plan_id},segment_id.eq.${r.segment_id})`)
      .join(',');
    const d = await sb.from('pm_plan_benefits')
      .delete({ count: 'exact' })
      .eq('benefit_category', category)
      .or(orExpr);
    if (d.error) throw new Error(`DELETE ${category}: ${d.error.message}`);
    del += d.count ?? 0;

    const ins_ = await sb.from('pm_plan_benefits').insert(batch).select('id');
    if (ins_.error) throw new Error(`INSERT ${category}: ${ins_.error.message}`);
    ins += ins_.data?.length ?? 0;
  }
  return { del, ins };
}

async function main() {
  console.log(`=== ${WRITE ? 'WRITE' : 'DRY-RUN'} MODE ===`);
  console.log(`States: ${STATES.join(',')}   Categories: ${categoryArg ?? 'home_health + meal_benefit'}`);
  console.log('');

  const plans = await loadMaMapdPlans();
  console.log(`MA/MAPD plans in scope: ${plans.size}`);

  // ── home_health ────────────────────────────────────────────────────
  if (RUN_HH) {
    console.log('\n── home_health ──');
    const existing = await existingKeys('home_health');
    const missing: PlanKey[] = [];
    for (const [k, p] of plans) if (!existing.has(k)) missing.push(p);
    console.log(`  existing pm rows for scope: ${[...plans.keys()].filter((k) => existing.has(k)).length}`);
    console.log(`  missing (will backfill with $0 CMS default): ${missing.length}`);
    if (missing.length > 0) {
      const payload = missing.map((p) => ({
        contract_id: p.contract_id,
        plan_id: p.plan_id,
        segment_id: p.segment_id,
        benefit_category: 'home_health',
        benefit_description: '$0 copay (CMS standard — 42 CFR § 422.100(j))',
        copay: 0,
        coinsurance: null,
        max_coverage: null,
        coverage_amount: null,
      }));
      if (WRITE) {
        const { del, ins } = await writeBatches('home_health', payload);
        console.log(`  DELETE: ${del}   INSERT: ${ins}`);
      } else {
        console.log(`  (dry-run — would insert ${payload.length} rows)`);
        console.log(`  sample: ${JSON.stringify(payload[0])}`);
      }
    }
  }

  // ── meal_benefit ───────────────────────────────────────────────────
  if (RUN_MB) {
    console.log('\n── meal_benefit ──');
    const existing = await existingKeys('meal_benefit');
    const pbpMap = await loadPbpMealBenefit(plans);
    const payload: Array<Record<string, unknown>> = [];
    let pbpMissing = 0;
    for (const [k, p] of plans) {
      if (existing.has(k)) continue;
      const pbp = pbpMap.get(`${p.contract_id}-${p.plan_id}`);
      if (!pbp) { pbpMissing++; continue; }
      payload.push({
        contract_id: p.contract_id,
        plan_id: p.plan_id,
        segment_id: p.segment_id,
        benefit_category: 'meal_benefit',
        benefit_description: pbp.description
          ?? (pbp.copay === 0 ? 'Post-discharge meal benefit — see plan documentation' : null),
        copay: pbp.copay,
        coinsurance: pbp.coinsurance,
        max_coverage: pbp.copay_max,
        // coverage_amount=1 as the "presence marker" the extras filter
        // uses when there is no ceiling published — mirrors the food-
        // card presence-rescue pattern already in api/plans.ts.
        coverage_amount: pbp.copay === 0 ? 1 : null,
      });
    }
    console.log(`  existing pm rows for scope: ${[...plans.keys()].filter((k) => existing.has(k)).length}`);
    console.log(`  pbp-backed rows to insert: ${payload.length}`);
    console.log(`  plans with no meal_benefit in pbp either (legit gap): ${pbpMissing}`);
    if (payload.length > 0) {
      if (WRITE) {
        const { del, ins } = await writeBatches('meal_benefit', payload);
        console.log(`  DELETE: ${del}   INSERT: ${ins}`);
      } else {
        console.log(`  sample: ${JSON.stringify(payload[0])}`);
      }
    }
  }

  console.log(`\n${WRITE ? 'Write complete.' : 'Dry-run only. Pass --write to execute.'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
