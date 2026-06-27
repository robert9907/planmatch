// scripts/probe-pdp-backfill-dryrun.ts — narrow dry-run scoped to
// the 12 NC PDPs. Reports what the migration would update.

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
    .select('contract_id, plan_id, plan_name, carrier')
    .eq('state', 'NC')
    .eq('plan_type', 'PDP');
  const seen = new Set<string>();
  const unique = (pdps ?? []).filter((p) => {
    const k = `${p.contract_id}-${p.plan_id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log(`NC PDPs to check: ${unique.length}`);

  // 2. For each PDP, compare pm_formulary tier cost-share to
  //    pbp_benefits medicare_gov rx_tier candidates.
  for (const p of unique) {
    // Distinct tiers in pm_formulary + their current cost-share
    const { data: pmTiers } = await sb
      .from('pm_formulary')
      .select('tier, copay, coinsurance')
      .eq('contract_id', p.contract_id)
      .eq('plan_id', p.plan_id)
      .limit(1000);
    const tierState = new Map<number, { copay: number | null; coins: number | null; count: number }>();
    for (const r of pmTiers ?? []) {
      const t = r.tier as number;
      const ex = tierState.get(t);
      if (ex) ex.count++;
      else tierState.set(t, { copay: r.copay as number | null, coins: r.coinsurance as number | null, count: 1 });
    }

    // medicare_gov rx_tier candidates
    const { data: mg } = await sb
      .from('pbp_benefits')
      .select('benefit_type, copay, coinsurance')
      .eq('source', 'medicare_gov')
      .like('benefit_type', 'rx_tier_%')
      .eq('plan_id', `${p.contract_id}-${p.plan_id}`);
    const mgByTier = new Map<number, { copay: number | null; coins: number | null }>();
    for (const r of mg ?? []) {
      const m = /^rx_tier_(\d+)$/.exec(r.benefit_type as string);
      if (!m) continue;
      mgByTier.set(Number(m[1]), {
        copay: r.copay as number | null,
        coins: r.coinsurance == null ? null : (r.coinsurance as number) / 100,
      });
    }

    // What would the backfill change?
    const updates: Array<{ tier: number; rows: number; copay: number | null; coins: number | null }> = [];
    let totalUpdate = 0;
    for (const [tier, st] of tierState) {
      if (st.copay != null || st.coins != null) continue;
      const cand = mgByTier.get(tier);
      if (!cand) continue;
      if (cand.copay == null && cand.coins == null) continue;
      const rowsForTier = (pmTiers ?? []).filter((r) => r.tier === tier).length;
      // Count properly via head:count to be sure (pmTiers limit is 1000)
      const { count } = await sb
        .from('pm_formulary')
        .select('rxcui', { count: 'exact', head: true })
        .eq('contract_id', p.contract_id)
        .eq('plan_id', p.plan_id)
        .eq('tier', tier)
        .is('copay', null)
        .is('coinsurance', null);
      updates.push({ tier, rows: count ?? rowsForTier, copay: cand.copay, coins: cand.coins });
      totalUpdate += count ?? rowsForTier;
    }

    if (updates.length === 0 && [...tierState.values()].some((s) => s.copay != null || s.coins != null)) {
      // populated already; no need to print
      continue;
    }
    console.log(`\n${p.contract_id}-${p.plan_id}  [${p.carrier}]  "${p.plan_name?.slice(0, 50)}"`);
    if (updates.length === 0) {
      console.log(`  NO UPDATES — either pm_formulary already populated or no medicare_gov rx_tier rows`);
    } else {
      console.log(`  total rows to update: ${totalUpdate}`);
      for (const u of updates) {
        console.log(`    tier ${u.tier}: ${u.rows} rows → copay=${u.copay} coins=${u.coins}`);
      }
    }
  }

  // 3. Also report nationwide scope (count buckets)
  console.log('\n=== Nationwide scope ===');
  let totalBuckets = 0;
  let totalRows = 0;
  // Quick check: count distinct (plan_id) in pbp_benefits medicare_gov rx_tier
  for (let pg = 0; pg < 5; pg++) {
    const from = pg * 1000;
    const to = from + 999;
    const { data } = await sb
      .from('pbp_benefits')
      .select('plan_id')
      .eq('source', 'medicare_gov')
      .like('benefit_type', 'rx_tier_%')
      .order('plan_id', { ascending: true })
      .range(from, to);
    if (!data || data.length === 0) break;
    totalBuckets += data.length;
    if (data.length < 1000) break;
  }
  console.log(`medicare_gov rx_tier rows (paginated up to 5k): ${totalBuckets}`);
  console.log(`Migration is scoped to ANY plan with a medicare_gov rx_tier row AND null pm_formulary cost-share.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
