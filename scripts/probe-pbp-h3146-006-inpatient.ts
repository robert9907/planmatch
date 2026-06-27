// scripts/probe-pbp-h3146-006-inpatient.ts — find every pbp_benefits
// row for Aetna H3146-006 inpatient-related types, so we can prove
// whether a NULL-valued PBP row is silently clobbering the good
// pm_plan_benefits row during the merge in api/plans.ts:885-892.

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
  // pbp_benefits uses 2-part or 3-part keys. Try every shape.
  const keyVariants = ['H3146-006', 'H3146-006-0', 'H3146-006-000'];

  for (const k of keyVariants) {
    const { data } = await sb
      .from('pbp_benefits')
      .select('plan_id, benefit_type, copay, copay_max, coinsurance, tier_id, description, source')
      .eq('plan_id', k);
    if (!data || data.length === 0) continue;
    console.log(`\n=== pbp_benefits rows for plan_id="${k}" — ${data.length} total ===`);
    // Filter to inpatient/MH/SNF
    const interesting = data.filter((r) => {
      const t = (r as Record<string, unknown>).benefit_type as string;
      return /inpat|hosp|snf|skilled/i.test(t ?? '');
    });
    for (const r of interesting) {
      console.log(JSON.stringify(r, null, 2));
    }
    console.log(`(${interesting.length} inpatient/MH/SNF-related rows)`);
    // Also list all distinct benefit_types
    const types = new Set<string>();
    for (const r of data) types.add((r as Record<string, unknown>).benefit_type as string);
    console.log('\nAll distinct benefit_types for this key:');
    console.log([...types].sort());
  }

  // Now look at the PBP_TYPE_TO_CATEGORY mapping to understand which
  // benefit_type maps to 'inpatient' in the synth.
  console.log('\n=== Search for benefit_types that would synthesize as category="inpatient" ===');
  const { data: anyInp } = await sb
    .from('pbp_benefits')
    .select('plan_id, benefit_type, copay, description, source')
    .like('plan_id', 'H3146-006%')
    .limit(50);
  console.log(`(${anyInp?.length ?? 0} H3146-006* rows total)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
