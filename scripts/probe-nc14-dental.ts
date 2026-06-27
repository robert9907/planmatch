// scripts/probe-nc14-dental.ts — dump pm_plan_benefits for the real
// NC-14 plan (H5253 plan_id 110, "AARP Medicare Advantage Giveback
// from UHC NC-14") to confirm whether it has NULL-valued dental rows
// that would falsely pass Gate 3.

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
  console.log('=== Target: H5253 / plan_id 110 (NC-14 UHC giveback)\n');

  // Sample benefit row to see column shape
  const { data: anyRow } = await sb
    .from('pm_plan_benefits')
    .select('*')
    .eq('contract_id', 'H5253')
    .eq('plan_id', '110')
    .limit(1);
  if (anyRow && anyRow[0]) {
    console.log('pm_plan_benefits columns:', Object.keys(anyRow[0]));
  }

  // ALL benefit rows for H5253-110
  const { data: benefits, error } = await sb
    .from('pm_plan_benefits')
    .select('*')
    .eq('contract_id', 'H5253')
    .eq('plan_id', '110');
  if (error) { console.error('benefits error:', error); }
  console.log(`\nTotal benefit rows for H5253-110: ${benefits?.length ?? 0}`);

  // bucket by benefit_category
  const byCat: Record<string, number> = {};
  for (const r of benefits ?? []) {
    const cat = (r as Record<string, unknown>).benefit_category as string ?? '(missing)';
    byCat[cat] = (byCat[cat] ?? 0) + 1;
  }
  console.log('\nBenefit categories present:');
  console.table(byCat);

  // DENTAL specifically — every row, every column
  console.log('\n--- DENTAL rows (full) ---');
  const dentalRows = (benefits ?? []).filter((r) => {
    const cat = (r as Record<string, unknown>).benefit_category as string ?? '';
    return /dental/i.test(cat);
  });
  for (const r of dentalRows) {
    console.log(JSON.stringify(r, null, 2));
  }
  console.log(`(${dentalRows.length} dental rows)`);

  console.log('\n--- VISION rows (full) ---');
  const visionRows = (benefits ?? []).filter((r) => {
    const cat = (r as Record<string, unknown>).benefit_category as string ?? '';
    return /vision/i.test(cat);
  });
  for (const r of visionRows) {
    console.log(JSON.stringify(r, null, 2));
  }
  console.log(`(${visionRows.length} vision rows)`);

  console.log('\n--- OTC rows (full) ---');
  const otcRows = (benefits ?? []).filter((r) => {
    const cat = (r as Record<string, unknown>).benefit_category as string ?? '';
    return /otc|over.the.counter/i.test(cat);
  });
  for (const r of otcRows) {
    console.log(JSON.stringify(r, null, 2));
  }
  console.log(`(${otcRows.length} OTC rows)`);

  // Also check: does the brain's extractCategoryAnnualValue logic see
  // dental as "present" for this plan? Mimic line 922-924 of plan-brain:
  //   if (s.benefits.some((b) => b.benefit_category === 'dental')) -> passes Gate 3
  //   when threshold = 0
  console.log('\n--- BRAIN SIMULATION (Gate 3 with threshold=0) ---');
  const hasDentalRow = (benefits ?? []).some(
    (b) => (b as Record<string, unknown>).benefit_category === 'dental',
  );
  const hasVisionRow = (benefits ?? []).some(
    (b) => (b as Record<string, unknown>).benefit_category === 'vision',
  );
  const hasOtcRow = (benefits ?? []).some(
    (b) => {
      const cat = (b as Record<string, unknown>).benefit_category as string ?? '';
      return cat === 'otc' || /over.the.counter/i.test(cat);
    },
  );
  console.log({ hasDentalRow, hasVisionRow, hasOtcRow });
  console.log(
    'If hasDentalRow=true and dental row has coverage_amount=NULL, ' +
      'Gate 3 PASSES the plan even with zero filed dental coverage.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
