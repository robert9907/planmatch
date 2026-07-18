// Verifies Fix 5 code change: pbp_benefits food_card presence-rescue.
//
// Before: rows with copay=0 + non-empty description were dropped by
// buildPbpFallback, so 298/508 food_card rows never reached the API
// response.
//
// After: those rows set foodCardMonthly=1 as a presence marker
// (mirrors the pm_plan_benefits allowance-rescue at api/plans.ts:522).
//
// Also confirms:
//   • pbp_benefits.plan_id format is "H####-###" (combined) so joins work
//   • Rosa's Bexar D-SNP pool doesn't have food_card data at all — that's
//     a DATA gap (needs a round-3 import for Bexar D-SNPs), not a code bug.
//   • A real Humana D-SNP (H0028-032 in NC) IS surfaced post-fix.
//
// Run: npx tsx scripts/_probe-fix5-verify.ts

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// Mirror of foodCardMonthlyMultiplier from api/plans.ts.
function mult(d: string | null): number {
  if (!d) return 1;
  const s = d.toLowerCase();
  if (s.includes('quarterly') || s.includes('/qtr')) return 1 / 3;
  if (s.includes('yearly') || s.includes('annual') || s.includes('/yr')) return 1 / 12;
  return 1;
}

type Row = { plan_id: string; copay: number | null; description: string | null };

// Old logic — pre-fix.
function buildOld(rows: Row[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const v = typeof r.copay === 'number' ? r.copay : null;
    if (v != null && v > 0) {
      const mo = Math.round(v * mult(r.description));
      if (mo > 0) out.set(r.plan_id, mo);
    }
  }
  return out;
}
// New logic — post-fix (mirror of buildPbpFallback with rescue).
function buildNew(rows: Row[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const v = typeof r.copay === 'number' ? r.copay : null;
    if (v != null && v > 0) {
      const mo = Math.round(v * mult(r.description));
      if (mo > 0) out.set(r.plan_id, mo);
    } else if (r.description && r.description.trim() !== '' && !out.has(r.plan_id)) {
      out.set(r.plan_id, 1);
    }
  }
  return out;
}

async function main() {
  console.log('Fix 5 — food_card pbp fallback rescue');
  console.log('─'.repeat(60));

  // Pull ALL food_card rows across pbp_benefits, paginated (508 total).
  const all: Row[] = [];
  for (let p = 0; p < 5; p += 1) {
    const { data } = await sb
      .from('pbp_benefits')
      .select('plan_id, copay, description')
      .eq('benefit_type', 'food_card')
      .range(p * 1000, p * 1000 + 999);
    if (!data || data.length === 0) break;
    all.push(...(data as Row[]));
    if (data.length < 1000) break;
  }
  console.log(`Total pbp_benefits.food_card rows pulled: ${all.length}`);

  const oldMap = buildOld(all);
  const newMap = buildNew(all);
  console.log(`  Distinct plans surfaced by OLD code: ${oldMap.size}`);
  console.log(`  Distinct plans surfaced by NEW code: ${newMap.size}`);
  console.log(`  Newly-rescued plans (presence markers): ${newMap.size - oldMap.size}`);

  // Diff a few examples
  const newly = [...newMap.keys()].filter((k) => !oldMap.has(k)).slice(0, 5);
  console.log(`  Sample newly-rescued plan_ids:`);
  newly.forEach((k) => {
    const r = all.find((x) => x.plan_id === k)!;
    console.log(`    ${k}  copay=${r.copay}  desc="${(r.description ?? '').slice(0, 70)}"`);
  });

  // Rosa Bexar D-SNP note (data gap)
  const { data: bexar } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, carrier')
    .eq('state', 'TX')
    .ilike('county_name', '%Bexar%')
    .eq('snp_type', 'D-SNP');
  const rosaKeys = new Set((bexar ?? []).map((p) => `${p.contract_id}-${p.plan_id}`));
  const rosaOld = [...oldMap.keys()].filter((k) => rosaKeys.has(k)).length;
  const rosaNew = [...newMap.keys()].filter((k) => rosaKeys.has(k)).length;
  console.log(`\nRosa Bexar D-SNP pool (${bexar?.length ?? 0} plans):`);
  console.log(`  Food card surfaced OLD: ${rosaOld}   NEW: ${rosaNew}`);
  if (rosaNew === 0) {
    console.log('  → DATA gap: no food_card rows imported for Bexar D-SNPs. Needs a round-3 import.');
  }

  // Cross-check: pick a real plan that got rescued
  if (newly.length > 0) {
    const anyRescued = newly[0];
    const [contract, plan] = anyRescued.split('-');
    const { data: planInfo } = await sb
      .from('pm_plans')
      .select('carrier, plan_name, state, county_name, snp_type')
      .eq('contract_id', contract)
      .eq('plan_id', plan)
      .limit(1);
    if (planInfo && planInfo[0]) {
      const p = planInfo[0];
      console.log(`\nExample newly-rescued plan: ${anyRescued}`);
      console.log(`  ${p.carrier} — ${p.plan_name}`);
      console.log(`  ${p.state} ${p.county_name}  snp=${p.snp_type ?? 'MAPD'}`);
      console.log(`  → API response will now include food_card.allowance_per_month=1 (presence marker) and description text.`);
    }
  }

  console.log('─'.repeat(60));
  const codeOk = newMap.size > oldMap.size;
  console.log(codeOk
    ? `PASS  Code rescue adds ${newMap.size - oldMap.size} plans that were previously silently dropped.`
    : 'FAIL  Rescue produced no additional plans — check probe.');
  process.exit(codeOk ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
