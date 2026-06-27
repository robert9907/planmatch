// scripts/audit-exact-gaps.ts
//
// Pinpoints exact missing pm_plan_benefits categories for the 4 Durham
// plans flagged in audit-carrier-gaps as having <16 medical coverage,
// and also reports which pbp_benefits benefit_types exist for each
// (so we can tell if a re-scrape of medicare_gov would fill the gap
// via the broad PBP merge).

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const url = process.env.SUPABASE_URL ?? '';
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  '';
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/ANON_KEY');
  process.exit(1);
}
const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const TARGET_PLAN_NAMES = [
  'HealthSpring TotalCare Plus',
  'HealthSpring TotalCare',
  'HealthTeam Advantage Vitality',
  'HealthTeam Advantage Eagle',
];

const MEDICAL_CATS = [
  'primary_care',
  'specialist',
  'urgent_care',
  'emergency',
  'inpatient',
  'outpatient_surgery',
  'asc',
  'outpatient_observation',
  'lab',
  'advanced_imaging',
  'diagnostic_procedures',
  'xray',
  'mental_health_outpatient_individual',
  'mental_health_outpatient_group',
  'physical_speech_therapy',
  'telehealth',
];

async function main() {
  for (const nameFragment of TARGET_PLAN_NAMES) {
    const { data: plans } = await sb
      .from('pm_plans')
      .select('contract_id, plan_id, plan_name, carrier')
      .eq('state', 'NC')
      .ilike('county_name', '%Durham%')
      .ilike('plan_name', `%${nameFragment}%`)
      .limit(1);
    const p = plans?.[0];
    if (!p) {
      console.log(`\n— No match for "${nameFragment}"`);
      continue;
    }
    const triple2 = `${p.contract_id}-${p.plan_id}`;
    console.log(`\n══════════════════════════════════════════════════════`);
    console.log(`${p.carrier} | ${p.plan_name}`);
    console.log(`triple: ${triple2}`);
    console.log(`══════════════════════════════════════════════════════`);

    // pm_plan_benefits categories present
    const { data: pmRows } = await sb
      .from('pm_plan_benefits')
      .select('benefit_category')
      .eq('contract_id', p.contract_id)
      .eq('plan_id', p.plan_id);
    const pmCats = new Set(pmRows?.map((r) => r.benefit_category) ?? []);

    const missingMedical = MEDICAL_CATS.filter((c) => !pmCats.has(c));
    console.log(`\npm_plan_benefits — missing ${missingMedical.length}/${MEDICAL_CATS.length} medical cats:`);
    missingMedical.forEach((c) => console.log(`  ✗ ${c}`));

    // pbp_benefits benefit_types present per source
    const { data: pbpRows } = await sb
      .from('pbp_benefits')
      .select('benefit_type, source')
      .in('plan_id', [triple2, `${triple2}-0`, `${triple2}-000`]);
    const bySource = new Map<string, Set<string>>();
    for (const r of pbpRows ?? []) {
      const set = bySource.get(r.source) ?? new Set<string>();
      set.add(r.benefit_type);
      bySource.set(r.source, set);
    }
    console.log(`\npbp_benefits coverage by source:`);
    for (const [src, set] of bySource) {
      console.log(`  ${src}: ${set.size} types — ${[...set].sort().join(', ')}`);
    }
    if (bySource.size === 0) console.log('  (no pbp_benefits rows)');
  }
}

main().catch(console.error);
