// Fix 3-α + 3-β — benefit backfill from cached CMS detail responses.
//
// Fix 3-α: pbp_benefits_v2 food_card presence rescue (125 plans).
//   Source: _tmp/medicare-gov-{snp,mapd}/detail/*.json
//     - plan_card.additional_supplemental_benefits.special_benefits[]
//       SB_CAT_NON_PRIMARILY_HEALTH_RELATED_BENEFITS → SB_FOOD_AND_PRODUCE
//       or SB_MEALS_BEYOND_LIMITED_BASIS with coverage != NOT_COVERED
//     - plan_card.ma_benefits[] BENEFITS_CHRONICALLY_ILL with service
//       FOOD_PRODUCE or MEALS
//   Write: pbp_benefits_v2 (base table for the pbp_benefits view) with
//     benefit_type='food_card', copay=0, description=<CMS-derived>,
//     source='medicare_gov'. copay=0 + non-empty description triggers
//     Phase 1 Fix 5 rescue at api/plans.ts:1362 (foodCardMonthly=1
//     presence marker).
//
// Fix 3-β: pm_plan_benefits.dental max_coverage backfill (48 plans).
//   Source: same detail cache. Extract:
//     max(ma_benefits[cat=BENEFIT_COMPREHENSIVE_DENTAL]
//       .plan_limits_details[COVERAGE, EVERY_YEAR].limit_value)
//   Write: UPDATE pm_plan_benefits SET max_coverage=<CMS value>
//     WHERE benefit_category='dental' AND max_coverage IS NULL
//     (guard so we never clobber non-null values).
//
// Idempotent. --write required to mutate; default dry-run.
// Run: npx tsx scripts/_fix3ab-benefit-backfill.ts           (dry-run)
//      npx tsx scripts/_fix3ab-benefit-backfill.ts --write   (execute)

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const WRITE = process.argv.includes('--write');

// ─── Load Phase 3 mismatch list ─────────────────────────────────
interface Mismatch {
  key: string; name: string; slice: string; field: string;
  cms: any; pm: any; root_cause: string; note?: string;
}
function loadMismatches(field: string, rc: string): Mismatch[] {
  const raw = JSON.parse(readFileSync('_tmp/phase3-mismatches.json', 'utf8'));
  return (raw as Mismatch[]).filter((m) => m.field === field && m.root_cause === rc);
}

// ─── Detail cache lookup ────────────────────────────────────────
function findDetail(contract: string, plan: string): { path: string; card: any; counties: string[] } | null {
  for (const dir of ['_tmp/medicare-gov-snp/detail', '_tmp/medicare-gov-mapd/detail']) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(`${contract}-${plan}-`)) continue;
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (j.response?.plan_card) {
        return { path: join(dir, f), card: j.response.plan_card, counties: j.counties ?? [] };
      }
    }
  }
  return null;
}

// ─── CMS food_card evidence ─────────────────────────────────────
function cmsFoodCardEvidence(card: any): { present: boolean; description: string } {
  // Check asb.special_benefits
  const sb = card.additional_supplemental_benefits?.special_benefits ?? [];
  const nprh = sb.find((c: any) => c.category === 'SB_CAT_NON_PRIMARILY_HEALTH_RELATED_BENEFITS');
  const nprhBenefits = nprh?.benefits ?? [];
  const foodEntry = nprhBenefits.find((b: any) =>
    (b.benefit === 'SB_FOOD_AND_PRODUCE' || b.benefit === 'SB_MEALS_BEYOND_LIMITED_BASIS') &&
    b.coverage && b.coverage !== 'SB_COVERAGE_NOT_COVERED');

  // Check ma_benefits BENEFITS_CHRONICALLY_ILL / FOOD_PRODUCE / MEALS
  const mb = card.ma_benefits ?? [];
  const chronicFood = mb.find((b: any) =>
    b.category === 'BENEFITS_CHRONICALLY_ILL' &&
    (b.service === 'FOOD_PRODUCE' || b.service === 'MEALS' || b.service === 'FOOD'));

  const present = !!foodEntry || !!chronicFood;
  // Description — prefer explicit CMS text; otherwise generic
  const genericDesc = 'Food and produce benefit included (medicare.gov-scraped presence marker; no published $/mo)';
  return { present, description: genericDesc };
}

// ─── CMS dental max ─────────────────────────────────────────────
function cmsDentalAnnualMax(card: any): number | null {
  const mb = card.ma_benefits ?? [];
  const dent = mb.filter((b: any) => b.category === 'BENEFIT_COMPREHENSIVE_DENTAL');
  let max: number | null = null;
  for (const b of dent) {
    for (const d of (b.plan_limits_details ?? [])) {
      if (d.limit_type === 'BENEFIT_LIMIT_TYPE_COVERAGE' &&
          d.limit_period === 'BENEFIT_LIMIT_PERIOD_EVERY_YEAR' &&
          typeof d.limit_value === 'number') {
        if (max == null || d.limit_value > max) max = d.limit_value;
      }
    }
  }
  return max;
}

async function main() {
  const mode = WRITE ? 'WRITE' : 'DRY-RUN';
  console.log(`Fix 3-α + 3-β  (${mode})`);
  console.log(`DB: ${(process.env.SUPABASE_URL ?? '').replace('https://', '').split('.')[0]}`);
  console.log('─'.repeat(70));

  // ═══════════════════════════════════════════════════════════════
  // FIX 3-α — food_card
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── FIX 3-α — pbp_benefits_v2 food_card backfill ──');
  const foodMismatches = loadMismatches('food_card_offered', 'A');
  console.log(`Phase 3 mismatches (food_card A): ${foodMismatches.length}`);

  // Extract per plan (dedupe on contract-plan; scrape may have multiple counties)
  const foodPlans: Array<{
    contract_id: string; plan_id: string; segment_id: string;
    plan_name: string; description: string; slice: string;
  }> = [];
  let foodNoCms = 0, foodNoDetail = 0;
  for (const m of foodMismatches) {
    const [contract, plan] = m.key.split('-');
    const det = findDetail(contract, plan);
    if (!det) { foodNoDetail++; continue; }
    const ev = cmsFoodCardEvidence(det.card);
    if (!ev.present) { foodNoCms++; continue; }
    foodPlans.push({
      contract_id: contract, plan_id: plan,
      segment_id: String(det.card.segment_id ?? '0'),
      plan_name: m.name, description: ev.description, slice: m.slice,
    });
  }
  console.log(`  CMS-confirmed food_card present: ${foodPlans.length}`);
  if (foodNoCms > 0) console.log(`  CMS did NOT confirm (skipping): ${foodNoCms}`);
  if (foodNoDetail > 0) console.log(`  Missing detail cache: ${foodNoDetail}`);

  // Check existing pbp_benefits_v2 rows to avoid duplicates.
  const contractPlanTuples = foodPlans.map((p) => `${p.contract_id}-${p.plan_id}`);
  const uniqueTuples = [...new Set(contractPlanTuples)];
  const existingRows = new Set<string>();
  // Query in batches to avoid oversize IN clauses.
  for (let i = 0; i < uniqueTuples.length; i += 100) {
    const slice = uniqueTuples.slice(i, i + 100);
    const contracts = [...new Set(slice.map((s) => s.split('-')[0]))];
    const planIds = [...new Set(slice.map((s) => s.split('-')[1]))];
    const { data } = await sb.from('pbp_benefits_v2')
      .select('contract_id, plan_id, segment_id')
      .eq('benefit_type', 'food_card')
      .in('contract_id', contracts)
      .in('plan_id', planIds);
    for (const r of data ?? []) existingRows.add(`${r.contract_id}-${r.plan_id}-${r.segment_id ?? '0'}`);
  }
  console.log(`  pbp_benefits_v2 already has food_card rows for: ${existingRows.size} of ${foodPlans.length} target plans`);

  const toInsertFood = foodPlans.filter((p) => !existingRows.has(`${p.contract_id}-${p.plan_id}-${p.segment_id}`));
  console.log(`  Rows to INSERT: ${toInsertFood.length}`);

  if (!WRITE) {
    console.log('  (dry-run) sample of first 5:');
    toInsertFood.slice(0, 5).forEach((p) => console.log(`    ${p.contract_id}-${p.plan_id}-${p.segment_id}  ${p.slice}  ${p.plan_name.slice(0, 60)}`));
    if (toInsertFood.length > 5) console.log(`    …+${toInsertFood.length - 5} more`);
  } else {
    const payload = toInsertFood.map((p) => ({
      contract_id: p.contract_id,
      plan_id: p.plan_id,
      segment_id: p.segment_id,
      plan_year: 2026,
      benefit_type: 'food_card',
      tier_id: '0',
      copay: 0,
      description: p.description,
      source: 'medicare_gov',
    }));
    // Insert in batches of 100.
    let inserted = 0;
    for (let i = 0; i < payload.length; i += 100) {
      const batch = payload.slice(i, i + 100);
      const { data, error } = await sb.from('pbp_benefits_v2').insert(batch).select('id');
      if (error) { console.error('  INSERT batch err:', error.message); break; }
      inserted += (data?.length ?? 0);
    }
    console.log(`  INSERTED: ${inserted} rows into pbp_benefits_v2`);
  }

  // ═══════════════════════════════════════════════════════════════
  // FIX 3-β — dental max_coverage
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── FIX 3-β — pm_plan_benefits.dental max_coverage backfill ──');
  const dentalMismatches = loadMismatches('dental_annual_max', 'A');
  console.log(`Phase 3 mismatches (dental_annual_max A): ${dentalMismatches.length}`);

  const dentalPlans: Array<{
    contract_id: string; plan_id: string;
    plan_name: string; cms_max: number; phase3_cms: any;
  }> = [];
  let dentNoDetail = 0, dentNoCms = 0;
  for (const m of dentalMismatches) {
    const [contract, plan] = m.key.split('-');
    const det = findDetail(contract, plan);
    if (!det) { dentNoDetail++; continue; }
    const cmsMax = cmsDentalAnnualMax(det.card);
    if (cmsMax == null || cmsMax <= 0) { dentNoCms++; continue; }
    dentalPlans.push({
      contract_id: contract, plan_id: plan,
      plan_name: m.name, cms_max: cmsMax, phase3_cms: m.cms,
    });
  }
  console.log(`  CMS-derived dental max available: ${dentalPlans.length}`);
  if (dentNoCms > 0) console.log(`  CMS silent on max (skipping): ${dentNoCms}`);
  if (dentNoDetail > 0) console.log(`  Missing detail cache: ${dentNoDetail}`);

  // Verify PM dental rows exist with max_coverage IS NULL.
  const dentContracts = [...new Set(dentalPlans.map((p) => p.contract_id))];
  const dentPlanIds = [...new Set(dentalPlans.map((p) => p.plan_id))];
  const { data: existingDental } = await sb.from('pm_plan_benefits')
    .select('contract_id, plan_id, max_coverage, coverage_amount, copay')
    .eq('benefit_category', 'dental')
    .in('contract_id', dentContracts)
    .in('plan_id', dentPlanIds);
  const existingByKey = new Map<string, any[]>();
  for (const r of existingDental ?? []) {
    const k = `${r.contract_id}-${r.plan_id}`;
    if (!existingByKey.has(k)) existingByKey.set(k, []);
    existingByKey.get(k)!.push(r);
  }
  let ready = 0, skipHasMax = 0, skipNoRow = 0;
  const readyDental: Array<{ contract_id: string; plan_id: string; cms_max: number; plan_name: string; row_count: number }> = [];
  for (const p of dentalPlans) {
    const rows = existingByKey.get(`${p.contract_id}-${p.plan_id}`) ?? [];
    if (rows.length === 0) { skipNoRow++; continue; }
    const nullMaxRows = rows.filter((r) => r.max_coverage == null);
    if (nullMaxRows.length === 0) { skipHasMax++; continue; }
    ready++;
    readyDental.push({ ...p, row_count: nullMaxRows.length });
  }
  console.log(`  Plans ready to UPDATE:   ${ready}`);
  console.log(`  Plans with max already:  ${skipHasMax} (skipped)`);
  console.log(`  Plans with no dental row: ${skipNoRow} (skipped — different root cause)`);

  if (!WRITE) {
    console.log('  (dry-run) first 8:');
    readyDental.slice(0, 8).forEach((p) => console.log(`    ${p.contract_id}-${p.plan_id}  max=$${p.cms_max}  (${p.row_count} rows)  ${p.plan_name.slice(0, 60)}`));
    if (readyDental.length > 8) console.log(`    …+${readyDental.length - 8} more`);
  } else {
    let totalRowsUpdated = 0;
    for (const p of readyDental) {
      const { data, error } = await sb.from('pm_plan_benefits')
        .update({ max_coverage: p.cms_max })
        .eq('benefit_category', 'dental')
        .eq('contract_id', p.contract_id)
        .eq('plan_id', p.plan_id)
        .is('max_coverage', null)
        .select('id');
      if (error) { console.error(`  UPDATE err ${p.contract_id}-${p.plan_id}:`, error.message); continue; }
      totalRowsUpdated += (data?.length ?? 0);
    }
    console.log(`  UPDATED: ${readyDental.length} plans, ${totalRowsUpdated} pm_plan_benefits rows`);
  }

  console.log('\n─'.repeat(70).slice(1));
  console.log(WRITE ? 'DONE (writes committed)' : 'DRY-RUN complete. Re-run with --write.');
}
main().catch((e) => { console.error(e); process.exit(1); });
