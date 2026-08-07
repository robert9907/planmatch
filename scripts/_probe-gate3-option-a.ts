// scripts/_probe-gate3-option-a.ts — Option A sanity probe.
//
// Confirms the aggregated-Plan.benefits reader would produce non-zero
// dollars for plans that CMS files with real dental / vision / hearing
// allowances. Reads from pbp_benefits_v2 (has coverage_amount +
// max_coverage; pbp_benefits view exposes only copay). buildBenefits in
// api/plans.ts uses these fields (with a copay-to-coverage_amount
// promotion for allowance-type rows) to populate Plan.benefits.
// dental.annual_max / vision.eyewear_allowance_year / etc.
//
// Before Option A, the brain read PlanBenefitRow[] via
// extractCategoryAnnualValue. The usePlanBrain adapter (benefitToBrain)
// hardcodes coverage_amount + max_coverage to null → the reader
// returned 0 for every plan regardless of what CMS filed. After Option
// A, the brain reads Plan.benefits.<category>.<allowance-field> which
// carries the real dollars.
//
// This probe validates that CMS DOES file real dollars in the source
// pbp_benefits_v2 rows for Durham NC plans — i.e., the Option A fix has
// something meaningful to read.
//
// Run: fnm exec --using=22 -- npx tsx scripts/_probe-gate3-option-a.ts

import { createClient, type PostgrestSingleResponse } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const url = process.env.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
if (!url || !key) { console.error('Missing env'); process.exit(1); }
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function paginate<T>(fn: (from: number, to: number) => PromiseLike<PostgrestSingleResponse<T[]>>): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let p = 0; p < 20; p++) {
    const { data, error } = await fn(p * PAGE, p * PAGE + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

interface PbpRow {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  benefit_type: string;
  tier_id: string | null;
  coverage_amount: number | null;
  max_coverage: number | null;
  copay: number | null;
  description: string | null;
}

async function main() {
  const plans = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, carrier, snp_type, plan_type')
    .eq('state', 'NC')
    .ilike('county_name', '%Durham%')
    .neq('plan_type', 'PDP')
    .eq('sanctioned', false)
    .limit(20);
  if (plans.error) throw plans.error;
  const pool = plans.data ?? [];
  console.log(`\nDurham NC MA pool sample: ${pool.length} plans`);
  if (pool.length === 0) return;

  const contractIds = [...new Set(pool.map((p) => p.contract_id))];
  const planIds = [...new Set(pool.map((p) => p.plan_id))];

  const pbp = await paginate<PbpRow>((from, to) =>
    sb.from('pbp_benefits_v2')
      .select('contract_id, plan_id, segment_id, benefit_type, tier_id, coverage_amount, max_coverage, copay, description')
      .in('contract_id', contractIds)
      .in('plan_id', planIds)
      .in('benefit_type', [
        'dental', 'dental_comprehensive', 'dental_preventive',
        'vision', 'hearing_aid', 'otc',
        'partb_giveback', 'meals', 'transportation', 'fitness',
      ])
      .range(from, to),
  );
  console.log(`pbp_benefits_v2 rows fetched (dental+vision+hearing+otc+partb+meals+transp+fitness): ${pbp.length}`);

  // Bucket by category, using coverage_amount → max_coverage → copay
  // (for allowance-type rows) as buildBenefits does.
  interface Agg {
    dentalAllow: number;
    dentalCovAmt: number;
    dentalMaxCov: number;
    dentalCopayNumeric: number;
    visionEyewear: number;
    hearingAid: number;
    otcAnyAmt: number;
    partbGiveback: number;
    meals: number;
    transportation: boolean;
    fitness: boolean;
  }
  const emptyAgg = (): Agg => ({
    dentalAllow: 0, dentalCovAmt: 0, dentalMaxCov: 0, dentalCopayNumeric: 0,
    visionEyewear: 0, hearingAid: 0, otcAnyAmt: 0,
    partbGiveback: 0, meals: 0,
    transportation: false, fitness: false,
  });
  const byKey = new Map<string, Agg>();
  for (const r of pbp) {
    const seg = (r.segment_id ?? '0').replace(/^0+/, '') || '0';
    const key = `${r.contract_id}-${r.plan_id}-${seg}`;
    const agg = byKey.get(key) ?? emptyAgg();
    const filed = r.coverage_amount ?? r.max_coverage ?? null;
    if (r.benefit_type === 'dental' || r.benefit_type === 'dental_comprehensive') {
      if (r.coverage_amount != null) agg.dentalCovAmt = Math.max(agg.dentalCovAmt, r.coverage_amount);
      if (r.max_coverage != null) agg.dentalMaxCov = Math.max(agg.dentalMaxCov, r.max_coverage);
      if (typeof r.copay === 'number') agg.dentalCopayNumeric = Math.max(agg.dentalCopayNumeric, r.copay);
      if (filed != null) agg.dentalAllow = Math.max(agg.dentalAllow, filed);
    }
    if (r.benefit_type === 'vision' && filed != null) agg.visionEyewear = Math.max(agg.visionEyewear, filed);
    if (r.benefit_type === 'hearing_aid' && filed != null) agg.hearingAid = Math.max(agg.hearingAid, filed);
    if (r.benefit_type === 'otc' && filed != null) agg.otcAnyAmt = Math.max(agg.otcAnyAmt, filed);
    if (r.benefit_type === 'partb_giveback') {
      const v = filed ?? r.copay;
      if (typeof v === 'number') agg.partbGiveback = Math.max(agg.partbGiveback, v);
    }
    if (r.benefit_type === 'meals' && filed != null) agg.meals = Math.max(agg.meals, filed);
    if (r.benefit_type === 'transportation') agg.transportation = true;
    if (r.benefit_type === 'fitness') agg.fitness = true;
    byKey.set(key, agg);
  }

  const rows: Array<{
    plan: string; carrier: string; snp: string;
    dentalAllow: number; dentalCovAmt: number; dentalCopay: number;
    visionEyewear: number; hearingAid: number; otcAnyAmt: number;
    partbGB: number; meals: number; transp: boolean; fitness: boolean;
  }> = [];
  for (const p of pool) {
    const seg = (p.segment_id ?? '0').replace(/^0+/, '') || '0';
    const key = `${p.contract_id}-${p.plan_id}-${seg}`;
    const a = byKey.get(key) ?? emptyAgg();
    rows.push({
      plan: key,
      carrier: p.carrier?.slice(0, 20) ?? '',
      snp: p.snp_type ?? '-',
      dentalAllow: a.dentalAllow,
      dentalCovAmt: a.dentalCovAmt,
      dentalCopay: a.dentalCopayNumeric,
      visionEyewear: a.visionEyewear,
      hearingAid: a.hearingAid,
      otcAnyAmt: a.otcAnyAmt,
      partbGB: a.partbGiveback,
      meals: a.meals,
      transp: a.transportation,
      fitness: a.fitness,
    });
  }
  console.table(rows);

  const n = rows.length;
  const nz = {
    dental: rows.filter((r) => r.dentalAllow > 0 || r.dentalCovAmt > 0 || r.dentalCopay > 0).length,
    vision: rows.filter((r) => r.visionEyewear > 0).length,
    hearing: rows.filter((r) => r.hearingAid > 0).length,
    otc: rows.filter((r) => r.otcAnyAmt > 0).length,
    partb: rows.filter((r) => r.partbGB > 0).length,
    meals: rows.filter((r) => r.meals > 0).length,
    transportation: rows.filter((r) => r.transp).length,
    fitness: rows.filter((r) => r.fitness).length,
  };
  console.log('\n─── Summary (Durham NC MA pool, 20-plan sample) ───');
  console.log(`  Plans with pbp_benefits_v2 dental allowance signal: ${nz.dental}/${n}`);
  console.log(`  Plans with vision eyewear allowance: ${nz.vision}/${n}`);
  console.log(`  Plans with hearing_aid allowance: ${nz.hearing}/${n}`);
  console.log(`  Plans with OTC amount: ${nz.otc}/${n}`);
  console.log(`  Plans with Part B giveback: ${nz.partb}/${n}`);
  console.log(`  Plans with meals (SNP-only usually): ${nz.meals}/${n}`);
  console.log(`  Plans with transportation row: ${nz.transportation}/${n}`);
  console.log(`  Plans with fitness row: ${nz.fitness}/${n}`);
  console.log('\nThe raw brain path (extractCategoryAnnualValue over benefitToBrain-adapted rows) returned 0 for the dollar-valued categories on ALL of these plans (coverage_amount + max_coverage both hardcoded null in benefitToBrain:428+431). Option A rewires the reader to Plan.benefits.<category>.<field>, which /api/plans buildBenefits populates directly from the pbp_benefits_v2 rows above.');
}

main().catch((err) => { console.error(err); process.exit(1); });
