// One-off probe: diagnose Compare-screen Inpatient $0 + ASC $0 + Rx/PartD blanks.
//
// Probes plan-match-prod for:
//   1) pm_plan_benefits rows for TX Anderson plans — inpatient + asc categories,
//      shows segment_id, copay, coinsurance, description so we can see whether
//      the data is missing, $0, or filed under an unmapped category.
//   2) pbp_benefits rows for same plans — to see what the overlay carries for
//      inpatient_hospital / outpatient_surgery_asc and whether descriptions
//      leak "$0–$X" range strings (the consumer 69f85e5 ASC bug).
//   3) Drug rows for the "right-side" plan: pulls all rx_tier_* + rx_deductible
//      rows. Caller passes a plan id via --rightPlan=H1234-005-000.

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
  console.error('Missing SUPABASE_URL / KEY');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const rightPlanArg = process.argv.find((a) => a.startsWith('--rightPlan='));
const rightPlanId = rightPlanArg?.split('=')[1] ?? null;

async function main() {
  // Pick a few Anderson County, TX plans (or just first 5 TX plans if Anderson
  // isn't in the landscape). Use county_name='Anderson' first.
  const { data: andersonPlans, error: apErr } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, carrier, plan_type, county_name')
    .eq('state', 'TX')
    .ilike('county_name', 'Anderson')
    .limit(10);
  if (apErr) {
    console.error('pm_plans Anderson TX failed:', apErr);
    process.exit(1);
  }
  console.log(`\n=== TX Anderson plans (count=${andersonPlans?.length ?? 0}) ===`);
  console.table(andersonPlans ?? []);

  const plans = andersonPlans ?? [];
  if (plans.length === 0) {
    console.log('No Anderson plans — abort');
    return;
  }
  const contractIds = [...new Set(plans.map((p) => p.contract_id))];
  const planIds = [...new Set(plans.map((p) => p.plan_id))];

  // ── pm_plan_benefits: inpatient + asc rows ────────────────────────
  const { data: pmBen, error: pmErr } = await sb
    .from('pm_plan_benefits')
    .select('contract_id, plan_id, segment_id, benefit_category, copay, coinsurance, coverage_amount, benefit_description')
    .in('contract_id', contractIds)
    .in('plan_id', planIds)
    .in('benefit_category', ['inpatient', 'inpatient_acute', 'asc', 'outpatient_surgery'])
    .limit(200);
  if (pmErr) {
    console.error('pm_plan_benefits err:', pmErr);
  } else {
    console.log(`\n=== pm_plan_benefits inpatient/asc/outpatient_surgery rows (count=${pmBen?.length ?? 0}) ===`);
    console.table((pmBen ?? []).map((r) => ({
      triple: `${r.contract_id}-${r.plan_id}-${r.segment_id}`,
      cat: r.benefit_category,
      copay: r.copay,
      coins: r.coinsurance,
      cov: r.coverage_amount,
      desc: (r.benefit_description ?? '').slice(0, 60),
    })));
  }

  // ── pbp_benefits: inpatient_hospital + outpatient_surgery_asc + asc ──
  const planKeyVariants = new Set<string>();
  for (const p of plans) {
    planKeyVariants.add(`${p.contract_id}-${p.plan_id}`);
    planKeyVariants.add(`${p.contract_id}-${p.plan_id}-${(p.segment_id ?? '0').toString().padStart(3, '0')}`);
  }
  const { data: pbpBen, error: pbpErr } = await sb
    .from('pbp_benefits')
    .select('plan_id, benefit_type, tier_id, copay, copay_max, coinsurance, description, source')
    .in('plan_id', [...planKeyVariants])
    .in('benefit_type', ['inpatient_hospital', 'inpatient_acute', 'outpatient_surgery_asc', 'outpatient_surgery_hospital'])
    .limit(200);
  if (pbpErr) {
    console.error('pbp_benefits err:', pbpErr);
  } else {
    console.log(`\n=== pbp_benefits inpatient/asc rows (count=${pbpBen?.length ?? 0}) ===`);
    console.table((pbpBen ?? []).map((r) => ({
      plan_id: r.plan_id,
      type: r.benefit_type,
      tier: r.tier_id,
      copay: r.copay,
      copay_max: r.copay_max,
      coins: r.coinsurance,
      src: r.source,
      desc: (r.description ?? '').slice(0, 60),
    })));
  }

  // Count ASC range-leak descriptions across whole table for posterity
  const { data: ascLeak, error: ascLeakErr } = await sb
    .from('pbp_benefits')
    .select('plan_id, source, description, copay, copay_max')
    .eq('benefit_type', 'outpatient_surgery_asc')
    .ilike('description', '%$0%')
    .limit(50);
  if (!ascLeakErr) {
    console.log(`\n=== pbp_benefits ASC rows with "$0" in description (sample, count<=${ascLeak?.length ?? 0}) ===`);
    console.table((ascLeak ?? []).slice(0, 20));
  }

  // ── Right-side plan drug data ─────────────────────────────────────
  if (rightPlanId) {
    const parts = rightPlanId.split('-');
    if (parts.length >= 2) {
      const cid = parts[0];
      const pid = parts[1];
      const seg = (parts[2] ?? '0').replace(/^0+/, '') || '0';
      console.log(`\n=== Right-side plan ${rightPlanId} drug rows ===`);
      const { data: rxPm } = await sb
        .from('pm_plan_benefits')
        .select('benefit_category, segment_id, copay, coinsurance, coverage_amount, benefit_description')
        .eq('contract_id', cid)
        .eq('plan_id', pid)
        .or('benefit_category.like.rx_tier_%,benefit_category.eq.rx_deductible,benefit_category.eq.part_d_deductible');
      console.log('pm_plan_benefits rx rows:');
      console.table(rxPm ?? []);

      const { data: rxPbp } = await sb
        .from('pbp_benefits')
        .select('plan_id, benefit_type, tier_id, copay, coinsurance, description, source')
        .or(`plan_id.eq.${cid}-${pid},plan_id.eq.${cid}-${pid}-${seg.padStart(3,'0')}`)
        .or('benefit_type.like.rx_tier_%,benefit_type.eq.rx_deductible');
      console.log('pbp_benefits rx rows:');
      console.table(rxPbp ?? []);

      const { data: planRow } = await sb
        .from('pm_plans')
        .select('contract_id, plan_id, segment_id, plan_name, plan_type, part_d_offered')
        .eq('contract_id', cid)
        .eq('plan_id', pid)
        .limit(5);
      console.log('pm_plans row:');
      console.table(planRow ?? []);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
