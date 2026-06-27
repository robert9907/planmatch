// scripts/find-4-gaps.ts
//
// Focused audit on the 4 Durham plans with sub-16 medical coverage.
// For each missing pm_plan_benefits.benefit_category, checks whether
// pbp_benefits carries the same name under any source — answers
// "could a re-scrape / cms_pbp merge fill this row?".

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

const TARGETS = [
  { contract: 'H9725', plan: '013', name: 'HealthSpring TotalCare Plus' },
  { contract: 'H9725', plan: '003', name: 'HealthSpring TotalCare' },
  { contract: 'H9808', plan: '010', name: 'HealthTeam Vitality' },
  { contract: 'H9808', plan: '009', name: 'HealthTeam Eagle' },
];

async function main() {
  for (const t of TARGETS) {
    console.log(`\n=== ${t.name} (${t.contract}-${t.plan}) ===`);
    const { data: pm } = await sb
      .from('pm_plan_benefits')
      .select('benefit_category')
      .eq('contract_id', t.contract)
      .eq('plan_id', t.plan);
    const pmCats = new Set(pm?.map((b) => b.benefit_category) ?? []);

    const { data: pbp } = await sb
      .from('pbp_benefits')
      .select('benefit_type, source')
      .in('plan_id', [
        `${t.contract}-${t.plan}`,
        `${t.contract}-${t.plan}-0`,
        `${t.contract}-${t.plan}-000`,
      ]);
    const pbpTypes = new Map<string, string[]>();
    for (const row of pbp ?? []) {
      if (!pbpTypes.has(row.benefit_type)) pbpTypes.set(row.benefit_type, []);
      pbpTypes.get(row.benefit_type)!.push(row.source);
    }

    const missing = MEDICAL_CATS.filter((c) => !pmCats.has(c));
    console.log(`  pm_plan_benefits: ${pmCats.size} categories`);
    console.log(
      `  pbp_benefits: ${pbpTypes.size} types (sources: ${[
        ...new Set((pbp ?? []).map((r) => r.source)),
      ].join(', ')})`,
    );
    console.log(
      `  Missing from pm: ${missing.length > 0 ? missing.join(', ') : 'NONE'}`,
    );

    for (const m of missing) {
      // The cms_pbp benefit_type names that map to these pm categories
      // (mirrors PBP_TYPE_TO_CATEGORY in api/plans.ts after the
      // cms_pbp source addition). We check ALL candidate pbp names.
      const pbpCandidates: Record<string, string[]> = {
        asc: ['asc', 'outpatient_surgery_asc'],
        outpatient_observation: ['outpatient_observation'],
        mental_health_outpatient_individual: [
          'mental_health_outpatient_individual',
          'mental_health_individual',
        ],
        mental_health_outpatient_group: [
          'mental_health_outpatient_group',
          'mental_health_group',
        ],
        physical_speech_therapy: ['physical_speech_therapy', 'physical_therapy'],
        advanced_imaging: ['advanced_imaging', 'imaging'],
        diagnostic_procedures: ['diagnostic_procedures', 'diagnostic_tests'],
      };
      const candidates = pbpCandidates[m] ?? [m];
      const hits = candidates
        .filter((c) => pbpTypes.has(c))
        .map((c) => `${c} (${pbpTypes.get(c)!.join(',')})`);
      const status = hits.length > 0 ? `YES via ${hits.join('; ')}` : 'NO';
      console.log(`    ${m}: in pbp? ${status}`);
    }
  }
}

main().catch(console.error);
