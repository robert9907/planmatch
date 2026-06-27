// scripts/audit-carrier-gaps.ts
//
// Sweeps every Durham County plan and reports which ones have the
// core medical benefit categories filed in pm_plan_benefits. Used to
// triage which carriers/plans need data backfill vs. which already
// have full coverage in the source data.

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

async function main() {
  const { data: plans, error } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, plan_name, carrier, plan_type')
    .eq('state', 'NC')
    .ilike('county_name', '%Durham%')
    .order('carrier');
  if (error) {
    console.error('Query error:', error);
    process.exit(1);
  }
  if (!plans || plans.length === 0) {
    console.log('No plans');
    process.exit(1);
  }

  const medicalCats = [
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

  console.log(
    `\nAuditing ${plans.length} Durham plans for medical benefit data...\n`,
  );

  // Dedup by (contract_id, plan_id) — pm_plans has one row per county
  // per triple, so Durham × 74-ish plans yields many duplicates.
  const seen = new Set<string>();
  const uniquePlans = plans.filter((p) => {
    const k = `${p.contract_id}-${p.plan_id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const gaps: string[] = [];
  const full: string[] = [];

  for (const p of uniquePlans) {
    const { data: benefits } = await sb
      .from('pm_plan_benefits')
      .select('benefit_category')
      .eq('contract_id', p.contract_id)
      .eq('plan_id', p.plan_id);

    const cats = new Set(benefits?.map((b) => b.benefit_category) ?? []);
    const hasMedical = medicalCats.filter((c) => cats.has(c));
    const missingMedical = medicalCats.filter((c) => !cats.has(c));

    if (hasMedical.length < 5) {
      gaps.push(
        `❌ ${p.carrier} | ${p.plan_name} (${p.plan_type}) | ${p.contract_id}-${p.plan_id} | ${cats.size} categories | medical: ${hasMedical.length}/${medicalCats.length} | MISSING: ${missingMedical.join(', ')}`,
      );
    } else {
      full.push(
        `✓ ${p.carrier} | ${p.plan_name} (${p.plan_type}) | ${hasMedical.length}/${medicalCats.length} medical`,
      );
    }
  }

  console.log(`=== PLANS WITH FULL MEDICAL DATA (${full.length}) ===`);
  full.forEach((f) => console.log(f));

  console.log(`\n=== PLANS WITH GAPS (${gaps.length}) ===`);
  gaps.forEach((g) => console.log(g));

  console.log(
    `\nSummary: ${full.length} full, ${gaps.length} gaps, ${uniquePlans.length} unique plans audited.`,
  );
}

main().catch(console.error);
