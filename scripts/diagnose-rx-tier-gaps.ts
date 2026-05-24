// Diagnose missing rx_tier data: for the 5 carriers showing "Not
// available" on Compare (BCBS NC, Aetna, Longevity, HealthTeam,
// PruittHealth), check whether rx_tier_1..5 rows exist in
// pm_plan_benefits OR pbp_benefits under any source.

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
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const TARGETS = [
  { name: 'BCBS Blue Medicare Freedom+', contract: 'H3404', plan: '004' },
  { name: 'Aetna Medicare Eagle Giveback', carrierIlike: '%Aetna%', planIlike: '%Eagle Giveback%' },
  { name: 'Longevity Health Plan', carrierIlike: '%Longevity%' },
  { name: 'HealthTeam Eagle', carrierIlike: '%HealthTeam%', planIlike: '%Eagle Plan%' },
  { name: 'PruittHealth Premier', carrierIlike: '%PruittHealth%' },
];

async function main() {
  for (const t of TARGETS) {
    let contract = t.contract;
    let plan = t.plan;
    if (!contract || !plan) {
      let q = sb
        .from('pm_plans')
        .select('contract_id, plan_id, plan_name, carrier')
        .eq('state', 'NC')
        .ilike('county_name', '%Durham%');
      if (t.carrierIlike) q = q.ilike('carrier', t.carrierIlike);
      if (t.planIlike) q = q.ilike('plan_name', t.planIlike);
      const { data } = await q.limit(1);
      if (!data?.[0]) {
        console.log(`\n${t.name} — no plan match`);
        continue;
      }
      contract = data[0].contract_id;
      plan = data[0].plan_id;
    }
    console.log(`\n═══ ${t.name} (${contract}-${plan}) ═══`);

    // pm_plan_benefits — does it have any rx_tier_N rows?
    const { data: pm } = await sb
      .from('pm_plan_benefits')
      .select('benefit_category, copay, coinsurance')
      .eq('contract_id', contract)
      .eq('plan_id', plan)
      .ilike('benefit_category', 'rx_%');
    console.log(`pm_plan_benefits rx_% rows: ${pm?.length ?? 0}`);
    for (const r of pm ?? []) {
      console.log(`  ${r.benefit_category}: copay=${r.copay} coins=${r.coinsurance}`);
    }

    // pbp_benefits — rx_tier_N rows across all sources
    const { data: pbp } = await sb
      .from('pbp_benefits')
      .select('benefit_type, source, copay, coinsurance')
      .in('plan_id', [`${contract}-${plan}`, `${contract}-${plan}-0`, `${contract}-${plan}-000`])
      .ilike('benefit_type', 'rx_%');
    console.log(`pbp_benefits rx_% rows: ${pbp?.length ?? 0}`);
    const byType = new Map<string, { source: string; copay: number | null; coinsurance: number | null }[]>();
    for (const r of pbp ?? []) {
      const list = byType.get(r.benefit_type) ?? [];
      list.push({ source: r.source, copay: r.copay, coinsurance: r.coinsurance });
      byType.set(r.benefit_type, list);
    }
    for (const [t, rows] of byType) {
      const summary = rows.map((r) => `${r.source}:cp=${r.copay},co=${r.coinsurance}`).join(' | ');
      console.log(`  ${t}: ${summary}`);
    }
  }
}

main().catch(console.error);
