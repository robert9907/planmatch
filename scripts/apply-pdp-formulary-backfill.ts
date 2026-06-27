// scripts/apply-pdp-formulary-backfill.ts — apply the backfill
// declared in supabase/migrations/202606181800_backfill_pm_formulary
// _from_medicare_gov.sql.
//
// Scoped to NC PDPs for fast ship-today. The migration SQL itself is
// broader (every plan with a medicare_gov rx_tier row + null
// pm_formulary cost-share) and should be re-run via supabase CLI to
// catch other states. supabase-js can't issue the single SQL UPDATE,
// so we batch one .update() per (plan, tier) bucket — same effect,
// idempotent.

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

async function main() {
  // 1. NC PDPs
  const { data: pdps } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, carrier, plan_name')
    .eq('state', 'NC')
    .eq('plan_type', 'PDP');
  const seen = new Set<string>();
  const uniquePdps = (pdps ?? []).filter((p) => {
    const k = `${p.contract_id}-${p.plan_id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log(`NC PDPs in scope: ${uniquePdps.length}`);

  let totalUpdated = 0;
  const perPlan = new Map<string, number>();

  for (const p of uniquePdps) {
    // medicare_gov rx_tier_N rows for this plan
    const { data: mg } = await sb
      .from('pbp_benefits')
      .select('benefit_type, copay, coinsurance')
      .eq('source', 'medicare_gov')
      .like('benefit_type', 'rx_tier_%')
      .eq('plan_id', `${p.contract_id}-${p.plan_id}`);
    if (!mg?.length) continue;

    for (const r of mg) {
      const m = /^rx_tier_(\d+)$/.exec(r.benefit_type as string);
      if (!m) continue;
      const tier = Number(m[1]);
      const copay = r.copay as number | null;
      const coinsPct = r.coinsurance as number | null;
      if (copay == null && coinsPct == null) continue;
      const coins = coinsPct == null ? null : coinsPct / 100;

      const patch: Record<string, number | null> = {};
      if (copay != null) patch.copay_default = copay;
      if (coins != null) patch.coinsurance_default = coins;

      const { error, count } = await sb
        .from('pm_formulary_v2')
        .update(patch, { count: 'exact' })
        .eq('contract_id', p.contract_id)
        .eq('plan_id', p.plan_id)
        .eq('tier', tier)
        .is('copay_default', null)
        .is('coinsurance_default', null);
      if (error) {
        console.error(`  ❌ ${p.contract_id}-${p.plan_id} tier=${tier}: ${error.message}`);
        continue;
      }
      const n = count ?? 0;
      if (n > 0) {
        const pk = `${p.contract_id}-${p.plan_id}`;
        perPlan.set(pk, (perPlan.get(pk) ?? 0) + n);
        totalUpdated += n;
        console.log(`  ${p.contract_id}-${p.plan_id} tier=${tier}: updated ${n} rows  (copay=${copay}, coins=${coins})`);
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`total pm_formulary rows changed: ${totalUpdated}`);
  for (const [pk, n] of [...perPlan.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pk}: ${n} rows`);
  }

  // Verification: re-query pm_formulary for the affected plans
  console.log(`\n=== Post-fix verification ===`);
  for (const pk of perPlan.keys()) {
    const [c, p] = pk.split('-');
    const { data } = await sb
      .from('pm_formulary_v2')
      .select('tier, copay_default, coinsurance_default')
      .eq('contract_id', c)
      .eq('plan_id', p)
      .limit(1500);
    const tierState = new Map<number, { copay: number | null; coins: number | null; count: number }>();
    for (const r of data ?? []) {
      const t = r.tier as number;
      const ex = tierState.get(t);
      if (ex) ex.count++;
      else tierState.set(t, { copay: r.copay_default as number | null, coins: r.coinsurance_default as number | null, count: 1 });
    }
    console.log(`\n  ${pk}:`);
    for (const [t, v] of [...tierState.entries()].sort()) {
      console.log(`    tier ${t}: copay=${v.copay} coins=${v.coins}  (${v.count} rows sampled)`);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
