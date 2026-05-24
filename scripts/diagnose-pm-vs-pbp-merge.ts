// Diagnose why /api/plans returns null medical copays for BCBS NC
// when pm_plan_benefits has the data. Dumps pm_plan_benefits rows +
// pbp_benefits rows for primary_care category on one BCBS plan so we
// can see whether a null-valued pbp synth row would overwrite the
// pm row in the broad-merge step.

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

async function main() {
  // Resolve BCBS NC Blue Medicare Freedom+ (PPO) for Durham
  const { data: plans } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, plan_name, carrier')
    .eq('state', 'NC')
    .ilike('county_name', '%Durham%')
    .ilike('plan_name', '%Blue Medicare Freedom+%')
    .limit(1);
  if (!plans?.[0]) {
    console.log('No matching plan');
    return;
  }
  const p = plans[0];
  const triple = `${p.contract_id}-${p.plan_id}`;
  console.log(`\nPlan: ${p.carrier} | ${p.plan_name} (${triple})\n`);

  // pm_plan_benefits — core medical
  const { data: pm } = await sb
    .from('pm_plan_benefits')
    .select('benefit_category, copay, coinsurance, coverage_amount, max_coverage')
    .eq('contract_id', p.contract_id)
    .eq('plan_id', p.plan_id)
    .in('benefit_category', [
      'primary_care',
      'specialist',
      'urgent_care',
      'emergency',
      'inpatient',
    ])
    .order('benefit_category');
  console.log('pm_plan_benefits rows:');
  console.table(pm ?? []);

  // pbp_benefits — equivalent benefit_types across all sources
  const { data: pbp } = await sb
    .from('pbp_benefits')
    .select('benefit_type, source, copay, coinsurance, description')
    .in('plan_id', [triple, `${triple}-0`, `${triple}-000`])
    .in('benefit_type', [
      'primary_care_visit',
      'specialist_visit',
      'urgent_care',
      'emergency_room',
      'inpatient_hospital',
    ])
    .order('benefit_type');
  console.log('\npbp_benefits rows (all sources):');
  console.table(pbp ?? []);

  // Show what the merge would do per (benefit_type, source-priority).
  // SOURCE_PRIORITY: medicare_gov=5, sb_ocr=4, cms_pbp=3, manual=2, pbp_federal=1
  const PRIO: Record<string, number> = {
    medicare_gov: 5, sb_ocr: 4, cms_pbp: 3, manual: 2, pbp_federal: 1,
  };
  const pbpByType = new Map<string, { src: string; copay: number | null; coinsurance: number | null }>();
  for (const r of pbp ?? []) {
    const rank = PRIO[r.source] ?? 0;
    const prior = pbpByType.get(r.benefit_type);
    const priorRank = prior ? PRIO[prior.src] ?? 0 : -1;
    if (!prior || rank > priorRank) {
      pbpByType.set(r.benefit_type, { src: r.source, copay: r.copay, coinsurance: r.coinsurance });
    }
  }
  console.log('\nWinning pbp source per benefit_type:');
  for (const [bt, win] of pbpByType) {
    const hasValue = win.copay != null || win.coinsurance != null;
    console.log(`  ${bt}: source=${win.src} copay=${win.copay} coins=${win.coinsurance} hasValue=${hasValue}`);
  }
}

main().catch(console.error);
