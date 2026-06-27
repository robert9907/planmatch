// scripts/probe-aetna-inpatient.ts — find Aetna NC Durham plans and
// dump their inpatient pm_plan_benefits rows. Goal: confirm whether
// the inpatient row exists, what description format is filed, and
// whether the row has any copay/coinsurance/amount at all.

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
  console.log('=== Supabase project:', url);

  // All Aetna NC plans
  console.log('\n--- All Aetna NC plans (state=NC, carrier LIKE Aetna) ---');
  const { data: aetnaPlans } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, carrier, county_name, monthly_premium, moop')
    .eq('state', 'NC')
    .ilike('carrier', '%Aetna%');
  console.log(`Total Aetna NC rows: ${aetnaPlans?.length ?? 0}`);
  const dedupe = new Map<string, typeof aetnaPlans extends Array<infer T> ? T : never>();
  for (const p of aetnaPlans ?? []) {
    const k = `${p.contract_id}-${p.plan_id}-${p.segment_id ?? ''}`;
    if (!dedupe.has(k)) dedupe.set(k, p);
  }
  const unique = [...dedupe.values()];
  console.log(`Unique contract-plan-segment combos: ${unique.length}`);
  console.table(unique.map((p) => ({
    contract: p.contract_id,
    plan: p.plan_id,
    seg: p.segment_id,
    name: (p.plan_name ?? '').slice(0, 50),
    moop: p.moop,
  })));

  // For each unique Aetna plan, fetch ALL benefit rows whose
  // benefit_category mentions inpatient (covers 'inpatient',
  // 'inpatient_hospital', 'mental_health_inpatient').
  console.log('\n--- Aetna inpatient rows (by plan) ---');
  for (const p of unique) {
    const { data: rows } = await sb
      .from('pm_plan_benefits')
      .select('benefit_category, benefit_description, copay, coinsurance, coverage_amount, max_coverage')
      .eq('contract_id', p.contract_id)
      .eq('plan_id', p.plan_id);
    const inpatient = (rows ?? []).filter((r) =>
      /inpatient/i.test((r as Record<string, unknown>).benefit_category as string ?? ''),
    );
    console.log(`\n${p.contract_id}-${p.plan_id} (${(p.plan_name ?? '').slice(0, 40)}):`);
    if (inpatient.length === 0) {
      console.log('  NO INPATIENT ROWS');
      continue;
    }
    for (const r of inpatient) {
      const row = r as Record<string, unknown>;
      console.log(`  [${row.benefit_category}]`);
      console.log(`    desc: ${row.benefit_description ?? 'NULL'}`);
      console.log(`    copay=${row.copay ?? 'NULL'} coins=${row.coinsurance ?? 'NULL'} cov=${row.coverage_amount ?? 'NULL'} max=${row.max_coverage ?? 'NULL'}`);
    }
  }

  // Also: specifically Durham (county_name='Durham') Aetna plans —
  // those are the ones the test URL surfaces.
  console.log('\n\n--- Aetna Durham plans (county_name=Durham) ---');
  const { data: durhamRows } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name')
    .eq('state', 'NC')
    .eq('county_name', 'Durham')
    .ilike('carrier', '%Aetna%');
  const dedupeD = new Map<string, typeof durhamRows extends Array<infer T> ? T : never>();
  for (const p of durhamRows ?? []) {
    const k = `${p.contract_id}-${p.plan_id}`;
    if (!dedupeD.has(k)) dedupeD.set(k, p);
  }
  console.log(`Unique Aetna Durham plans: ${dedupeD.size}`);
  console.table([...dedupeD.values()]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
