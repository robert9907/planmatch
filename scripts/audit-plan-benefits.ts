// scripts/audit-plan-benefits.ts
//
// Diagnostic — dumps pm_plan_benefits + pbp_benefits + pm_plans rows
// for Wellcare Simple HMO-POS (H5253-189) so we can see which Plan
// fields land null on the Compare screen because the data genuinely
// isn't filed vs. because of a missing alias.
//
// Mirrors scripts/probe-ozempic-formulary.ts — same inline .env.local
// reader, no extra deps (dotenv isn't installed in this repo).

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
  console.log('\n=== Q1: pm_plan_benefits for H5253-189 ===');
  const { data: q1, error: e1 } = await sb
    .from('pm_plan_benefits')
    .select(
      'benefit_category, copay, coinsurance, coverage_amount, max_coverage, benefit_description',
    )
    .eq('contract_id', 'H5253')
    .eq('plan_id', '189')
    .order('benefit_category');
  if (e1) console.error('Q1 error:', e1);
  console.table(q1 ?? []);

  console.log('\n=== Q2: pbp_benefits for H5253-189 ===');
  const { data: q2, error: e2 } = await sb
    .from('pbp_benefits')
    .select('plan_id, benefit_type, source, tier_id, copay, copay_max, coinsurance, description')
    .in('plan_id', ['H5253-189', 'H5253-189-0', 'H5253-189-000'])
    .in('source', ['medicare_gov', 'sb_ocr', 'manual', 'pbp_federal'])
    .order('benefit_type');
  if (e2) console.error('Q2 error:', e2);
  console.table(q2 ?? []);

  console.log('\n=== Q3: pm_plans for H5253-189 ===');
  const { data: q3, error: e3 } = await sb
    .from('pm_plans')
    .select(
      'contract_id, plan_id, segment_id, plan_name, carrier, plan_type, state, county_name, monthly_premium',
    )
    .eq('contract_id', 'H5253')
    .eq('plan_id', '189')
    .limit(5);
  if (e3) console.error('Q3 error:', e3);
  console.table(q3 ?? []);

  console.log('\n=== Q4: HealthSpring plans (carrier ilike) ===');
  const { data: q4, error: e4 } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, plan_name, carrier')
    .ilike('carrier', '%HealthSpring%')
    .limit(5);
  if (e4) console.error('Q4 error:', e4);
  console.table(q4 ?? []);

  if (q4 && q4.length > 0) {
    const hs = q4[0];
    console.log(
      `\n=== Q5: pm_plan_benefits for ${hs.carrier} ${hs.contract_id}-${hs.plan_id} ===`,
    );
    const { data: q5, error: e5 } = await sb
      .from('pm_plan_benefits')
      .select('benefit_category, copay, coinsurance, coverage_amount, max_coverage')
      .eq('contract_id', hs.contract_id)
      .eq('plan_id', hs.plan_id)
      .order('benefit_category');
    if (e5) console.error('Q5 error:', e5);
    console.table(q5 ?? []);
  }
}

main().catch(console.error);
