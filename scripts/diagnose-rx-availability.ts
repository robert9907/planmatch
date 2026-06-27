// Probe: for each Anderson TX plan, count rx_tier_* + rx_deductible rows in
// pm_plan_benefits + pbp_benefits. Identifies which plan would render
// "Not available" for tiers/Part-D-ded on the agent compare screen.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  const { data: plans } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, plan_type, drug_deductible')
    .eq('state', 'TX')
    .ilike('county_name', 'Anderson')
    .limit(20);
  if (!plans) return;

  const rows: Array<Record<string, unknown>> = [];
  for (const p of plans) {
    const { data: pmRx } = await sb
      .from('pm_plan_benefits')
      .select('benefit_category, copay, coinsurance')
      .eq('contract_id', p.contract_id)
      .eq('plan_id', p.plan_id)
      .or('benefit_category.like.rx_tier_%,benefit_category.eq.rx_deductible,benefit_category.eq.part_d_deductible');

    const cid = `${p.contract_id}-${p.plan_id}`;
    const triple = `${cid}-${(p.segment_id ?? '0').toString().padStart(3, '0')}`;
    const { data: pbpRx } = await sb
      .from('pbp_benefits')
      .select('benefit_type, tier_id, copay, coinsurance, source')
      .in('plan_id', [cid, triple])
      .or('benefit_type.like.rx_tier_%,benefit_type.eq.rx_deductible');

    rows.push({
      triple: `${p.contract_id}-${p.plan_id}-${p.segment_id}`,
      type: p.plan_type,
      drug_ded: p.drug_deductible,
      pm_rx_rows: pmRx?.length ?? 0,
      pm_tiers: [...new Set((pmRx ?? []).map((r) => r.benefit_category))].sort().join(','),
      pbp_rx_rows: pbpRx?.length ?? 0,
      pbp_tiers: [...new Set((pbpRx ?? []).map((r) => r.benefit_type))].sort().join(','),
    });
  }
  console.table(rows);
}
main().catch((e) => { console.error(e); process.exit(1); });
