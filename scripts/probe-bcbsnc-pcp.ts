// scripts/probe-bcbsnc-pcp.ts — check whether BCBS NC's primary_care
// renders correctly post-fixes (e7d5c5f tombstone, 7b6431b backfill,
// a92b5fa ORDER BY).

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

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

const RANK: Record<string, number> = { medicare_gov: 5, sb_ocr: 4, cms_pbp: 3, manual: 2, pbp_federal: 1 };

async function main() {
  // STEP 1: BCBS NC Durham plans + DB truth for primary_care
  console.log('========== STEP 1: BCBS NC Durham primary_care DB truth ==========');
  const { data: bcbsPlans } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, carrier, monthly_premium, moop, plan_type')
    .eq('state', 'NC')
    .eq('county_name', 'Durham')
    .or('carrier.ilike.%Blue Cross%,carrier.ilike.%BCBS%');
  const seen = new Set<string>();
  const unique = (bcbsPlans ?? []).filter((p) => {
    const k = `${p.contract_id}-${p.plan_id}-${p.segment_id ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log(`BCBS NC Durham plans (deduped): ${unique.length}`);
  console.table(unique.map((p) => ({
    triple: `${p.contract_id}-${p.plan_id}-${p.segment_id}`,
    name: (p.plan_name ?? '').slice(0, 45),
    type: p.plan_type,
    prem: p.monthly_premium,
    moop: p.moop,
  })));

  // DB row for primary_care per plan
  console.log('\n--- pm_plan_benefits primary_care rows ---');
  for (const p of unique) {
    const { data } = await sb
      .from('pm_plan_benefits')
      .select('segment_id, benefit_description, copay, coinsurance, coverage_amount, max_coverage')
      .eq('contract_id', p.contract_id)
      .eq('plan_id', p.plan_id)
      .eq('benefit_category', 'primary_care');
    console.log(`\n${p.contract_id}-${p.plan_id}-${p.segment_id}  ${(p.plan_name ?? '').slice(0,45)}`);
    if (!data?.length) {
      console.log('  NO PRIMARY_CARE LANDSCAPE ROW');
      continue;
    }
    for (const r of data) {
      console.log(`  seg=${r.segment_id}: copay=${r.copay} coins=${r.coinsurance} desc=${JSON.stringify(r.benefit_description)}`);
    }
  }

  // STEP 2: deployed /api/plans wire response
  console.log('\n\n========== STEP 2: deployed /api/plans wire response ==========');
  const r = await fetch(`https://planmatch.vercel.app/api/plans?state=NC&county=Durham&limit=2000&_=${Date.now()}`);
  const body = await r.json() as { plans: Array<Record<string, unknown>> };
  for (const p of unique) {
    const wire = body.plans.find((x) => x.contract_id === p.contract_id && x.plan_number === p.plan_id);
    if (!wire) {
      console.log(`${p.contract_id}-${p.plan_id}: NOT IN WIRE`);
      continue;
    }
    const pc = ((wire.benefits as Record<string, Record<string, unknown>>)?.medical as Record<string, unknown>)?.primary_care as Record<string, unknown> | undefined;
    console.log(`${p.contract_id}-${p.plan_id}: copay=${pc?.copay}  coins=${pc?.coinsurance}  desc=${JSON.stringify(pc?.description)?.slice(0,60)}`);
  }

  // STEP 3: pbp_benefits primary_care_visit rows (the null-bomb candidate)
  console.log('\n\n========== STEP 3: pbp_benefits primary_care_visit rows ==========');
  for (const p of unique) {
    const variants = [
      `${p.contract_id}-${p.plan_id}`,
      `${p.contract_id}-${p.plan_id}-${p.segment_id}`,
    ];
    const { data: pbp } = await sb
      .from('pbp_benefits')
      .select('plan_id, benefit_type, copay, copay_max, coinsurance, tier_id, description, source')
      .in('plan_id', variants)
      .in('source', ['medicare_gov', 'sb_ocr', 'cms_pbp', 'manual'])
      .eq('benefit_type', 'primary_care_visit');
    console.log(`\n${p.contract_id}-${p.plan_id}: pbp primary_care_visit rows = ${pbp?.length ?? 0}`);
    for (const row of pbp ?? []) {
      console.log(`  ${JSON.stringify(row)}`);
    }
    // bestByKey winner per (plan_id, benefit_type, tier_id)
    const best = new Map<string, Record<string, unknown>>();
    for (const row of pbp ?? []) {
      const k = `${row.plan_id}|${row.benefit_type}|${row.tier_id ?? 0}`;
      const cur = best.get(k);
      const curRank = cur ? RANK[(cur.source as string)] ?? 0 : -1;
      const newRank = RANK[(row as Record<string,unknown>).source as string] ?? 0;
      if (!cur || newRank > curRank) best.set(k, row);
    }
    for (const [k, w] of best.entries()) {
      const allNull = w.copay == null && w.copay_max == null && w.coinsurance == null && (w.description == null || (w.description as string).trim() === '');
      const tag = allNull ? 'NULL-BOMB → my-fix-skips' : 'has-data';
      console.log(`  winner ${k}: source=${w.source} copay=${w.copay} desc=${JSON.stringify(w.description)} → ${tag}`);
    }
  }

  // STEP 4 — already covered by step 2. Print a verdict.
  console.log('\n\n========== VERDICT ==========');
  const verdict: string[] = [];
  for (const p of unique) {
    const wire = body.plans.find((x) => x.contract_id === p.contract_id && x.plan_number === p.plan_id);
    if (!wire) { verdict.push(`${p.contract_id}-${p.plan_id}: NOT IN WIRE`); continue; }
    const pc = ((wire.benefits as Record<string, Record<string, unknown>>)?.medical as Record<string, unknown>)?.primary_care as Record<string, unknown> | undefined;
    const copayPresent = pc?.copay != null;
    const coinsPresent = pc?.coinsurance != null;
    const descPresent = pc?.description != null && (pc.description as string).trim() !== '';
    if (copayPresent || coinsPresent || descPresent) {
      verdict.push(`${p.contract_id}-${p.plan_id}: ✅ RENDERS (copay=${pc?.copay} coins=${pc?.coinsurance})`);
    } else {
      verdict.push(`${p.contract_id}-${p.plan_id}: ❌ STILL NULL`);
    }
  }
  for (const v of verdict) console.log(v);
}

main().catch((err) => { console.error(err); process.exit(1); });
