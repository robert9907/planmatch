// scripts/audit-durham-full.ts — read-only full data audit, Durham NC.
// Uses the ACTUAL plan-match-prod schema (not the SQL in the request,
// which referenced columns that don't exist).
//
// Real schema reference:
//   pm_plans                     monthly_premium, moop, annual_deductible,
//                                drug_deductible, snp, snp_type, star_rating
//                                (no premium / moop_in_network / part_b_giveback)
//   pm_plan_benefits             benefit_category, benefit_description,
//                                copay, coinsurance, coverage_amount,
//                                max_coverage, segment_id  (no tier_id)
//   pm_drug_cost_cache           plan_id="H5253-189" combined, segment_id,
//                                ndc, tier, full_cost, covered, phase costs,
//                                estimated_yearly_total  (no drug_name/rxcui)
//   pm_formulary                 per-plan rx (contract_id, plan_id, rxcui,
//                                drug_name, tier, copay, coinsurance,
//                                PA/ST/QL) — THIS is the rx benefit source
//   pm_provider_network_cache    plan_id combined, segment_id, npi, covered,
//                                county_fips, all_locations
//   pm_providers                 npi → first/last/specialty
//   pbp_benefits                 plan_id combined, benefit_type (not
//                                benefit_category), copay, coinsurance,
//                                description, source
//   Durham NC county_fips = 37063
//
// Run with: npx tsx scripts/audit-durham-full.ts

import { createClient, type PostgrestSingleResponse } from '@supabase/supabase-js';
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

async function paginate<T>(
  pageFn: (from: number, to: number) => PromiseLike<PostgrestSingleResponse<T[]>>,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let n = 0; n < 50; n += 1) {
    const from = n * PAGE;
    const to = from + PAGE - 1;
    const { data, error } = await pageFn(from, to);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

type AnyRow = Record<string, unknown>;

function section(title: string) {
  console.log('\n' + '='.repeat(78));
  console.log(title);
  console.log('='.repeat(78));
}
function sub(title: string) {
  console.log('\n— ' + title + ' —');
}

function printRows(rows: AnyRow[], cols?: string[]) {
  if (!rows || rows.length === 0) {
    console.log('  (no rows)');
    return;
  }
  const columns = cols ?? Object.keys(rows[0]);
  const widths: Record<string, number> = {};
  for (const c of columns) {
    widths[c] = c.length;
    for (const r of rows) {
      const v = r[c];
      const s = v == null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      widths[c] = Math.max(widths[c], Math.min(s.length, 60));
    }
  }
  const fmt = (v: unknown) => {
    const s = v == null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.length > 60 ? s.slice(0, 57) + '...' : s;
  };
  console.log('  ' + columns.map((c) => c.padEnd(widths[c])).join(' │ '));
  console.log('  ' + columns.map((c) => '─'.repeat(widths[c])).join('─┼─'));
  for (const r of rows) {
    console.log('  ' + columns.map((c) => fmt(r[c]).padEnd(widths[c])).join(' │ '));
  }
}

const DURHAM_FIPS = 37063;

async function main() {
  // ───────────────────── PART 1: PLANS ─────────────────────
  section('PART 1 — PLANS in Durham County NC (pm_plans)');
  const plans = await paginate<AnyRow>((from, to) =>
    sb
      .from('pm_plans')
      .select(
        'contract_id, plan_id, segment_id, contract_plan_id, plan_name, plan_type, carrier, parent_organization, monthly_premium, moop, annual_deductible, drug_deductible, star_rating, snp, snp_type, sanctioned, enrollment_count, county_name, state',
      )
      .eq('state', 'NC')
      .ilike('county_name', 'Durham')
      .order('parent_organization', { ascending: true })
      .order('plan_name', { ascending: true })
      .range(from, to),
  );
  console.log(`Total Durham plan-segments: ${plans.length}`);
  const distinctContractPlans = new Set(plans.map((p) => `${p.contract_id}-${p.plan_id}`));
  console.log(`Distinct contract-plan pairs (ignoring segment): ${distinctContractPlans.size}`);
  printRows(plans, [
    'contract_id',
    'plan_id',
    'segment_id',
    'plan_name',
    'plan_type',
    'carrier',
    'parent_organization',
    'monthly_premium',
    'moop',
    'annual_deductible',
    'drug_deductible',
    'star_rating',
    'snp_type',
    'enrollment_count',
  ]);

  if (plans.length === 0) {
    console.error('No Durham plans — aborting deep dive.');
    process.exit(0);
  }

  const target = plans[0];
  const contract = String(target.contract_id);
  const plan = String(target.plan_id);
  const seg = String(target.segment_id);
  const combinedPlanId = `${contract}-${plan}`;
  console.log(
    `\nTARGET PLAN for deep dive: ${combinedPlanId} segment=${seg} "${String(target.plan_name)}"`,
  );

  // ───────────────────── PART 2: BENEFITS ─────────────────────
  section('PART 2 — BENEFITS for target plan + global census');

  sub(`pm_plan_benefits where contract_id=${contract} plan_id=${plan} segment_id=0`);
  const benefitsTarget = await paginate<AnyRow>((from, to) =>
    sb
      .from('pm_plan_benefits')
      .select(
        'benefit_category, benefit_description, copay, coinsurance, coverage_amount, max_coverage, segment_id',
      )
      .eq('contract_id', contract)
      .eq('plan_id', plan)
      .eq('segment_id', '0')
      .order('benefit_category', { ascending: true })
      .range(from, to),
  );
  console.log(`Rows: ${benefitsTarget.length}`);
  printRows(benefitsTarget, [
    'benefit_category',
    'copay',
    'coinsurance',
    'coverage_amount',
    'max_coverage',
    'benefit_description',
  ]);

  sub('Distinct benefit_category values across ALL pm_plan_benefits (with row counts)');
  const allBenefits = await paginate<{ benefit_category: string }>((from, to) =>
    sb.from('pm_plan_benefits').select('benefit_category').range(from, to),
  );
  const counts = new Map<string, number>();
  for (const r of allBenefits) {
    counts.set(r.benefit_category, (counts.get(r.benefit_category) ?? 0) + 1);
  }
  const censusRows = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([benefit_category, rows]) => ({ benefit_category, rows }));
  console.log(`Total pm_plan_benefits rows fetched: ${allBenefits.length}`);
  console.log(`Distinct categories: ${censusRows.length}`);
  printRows(censusRows as AnyRow[]);

  // ───────────────────── PART 3: DRUG COSTS ─────────────────────
  section('PART 3 — DRUG COSTS for target plan');

  sub(`pm_formulary (per-plan rx benefit) for ${contract} / ${plan}`);
  const formulary = await paginate<AnyRow>((from, to) =>
    sb
      .from('pm_formulary')
      .select(
        'rxcui, drug_name, tier, copay, coinsurance, prior_auth, step_therapy, quantity_limit, quantity_limit_amount, quantity_limit_days, segment_id, formulary_id',
      )
      .eq('contract_id', contract)
      .eq('plan_id', plan)
      .order('tier', { ascending: true })
      .order('drug_name', { ascending: true })
      .range(from, to),
  );
  console.log(`pm_formulary rows: ${formulary.length}`);
  // Distribution by tier
  const tierCounts = new Map<string, number>();
  for (const f of formulary) {
    const t = String(f.tier ?? '(null)');
    tierCounts.set(t, (tierCounts.get(t) ?? 0) + 1);
  }
  console.log('Tier distribution:');
  printRows(
    [...tierCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([tier, drugs]) => ({ tier, drugs })) as AnyRow[],
  );
  console.log('First 20 formulary rows:');
  printRows(formulary.slice(0, 20));

  sub(`pm_drug_cost_cache where plan_id='${combinedPlanId}' (sample 30)`);
  const drugCosts = await paginate<AnyRow>((from, to) =>
    sb
      .from('pm_drug_cost_cache')
      .select(
        'plan_id, segment_id, ndc, tier, full_cost, covered, has_deductible, coverage_reason, deductible_cost, initial_cost, gap_cost, catastrophic_cost, estimated_yearly_total, lowest_mail_total, scraped_at',
      )
      .eq('plan_id', combinedPlanId)
      .order('ndc', { ascending: true })
      .range(from, Math.min(to, from + 29)),
  );
  console.log(`Sample drug-cost rows for ${combinedPlanId}: ${drugCosts.length}`);
  printRows(drugCosts);

  sub(`pm_plan_benefits rx_tier_* rows for ${contract} / ${plan}`);
  const rxTier = await paginate<AnyRow>((from, to) =>
    sb
      .from('pm_plan_benefits')
      .select('benefit_category, copay, coinsurance, benefit_description, segment_id')
      .eq('contract_id', contract)
      .eq('plan_id', plan)
      .like('benefit_category', 'rx_tier%')
      .order('benefit_category', { ascending: true })
      .range(from, to),
  );
  printRows(rxTier);

  // ───────────────────── PART 4: PROVIDERS ─────────────────────
  section('PART 4 — PROVIDERS');

  sub(`pm_provider_network_cache, county_fips=${DURHAM_FIPS} state=NC (first 30)`);
  const provDurham = await paginate<AnyRow>((from, to) =>
    sb
      .from('pm_provider_network_cache')
      .select(
        'plan_id, segment_id, npi, covered, location_id, state, county_fips, source, checked_at, data_unavailable',
      )
      .eq('state', 'NC')
      .eq('county_fips', DURHAM_FIPS)
      .order('npi', { ascending: true })
      .range(from, Math.min(to, from + 29)),
  );
  console.log(`Sample: ${provDurham.length}`);
  printRows(provDurham);

  // Join up to ~30 NPIs to provider names
  const npis = [...new Set(provDurham.map((r) => Number(r.npi)).filter((n) => !!n))];
  if (npis.length > 0) {
    const { data: provNames } = await sb
      .from('pm_providers')
      .select('npi, first_name, last_name, credential, specialty, practice_city, practice_state')
      .in('npi', npis as number[]);
    sub('Provider names (joined pm_providers by npi)');
    printRows((provNames ?? []) as AnyRow[]);
  }

  sub('pm_provider_network_cache rows by state (coverage census)');
  const provAll = await paginate<{ state: string | null }>((from, to) =>
    sb.from('pm_provider_network_cache').select('state').range(from, to),
  );
  const stateCounts = new Map<string, number>();
  for (const r of provAll) {
    const s = r.state ?? '(null)';
    stateCounts.set(s, (stateCounts.get(s) ?? 0) + 1);
  }
  console.log(`Total provider-network rows: ${provAll.length}`);
  printRows(
    [...stateCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([state, rows]) => ({ state, rows })) as AnyRow[],
  );

  // ─────────────── PART 5: BENEFIT DEEP DIVE ───────────────
  section('PART 5 — BENEFIT DEEP DIVE for target plan (segment_id=0)');

  const dives: Array<{ name: string; cats: string[] | null; like?: string; or?: string }> = [
    {
      name: 'Medical copays',
      cats: [
        'primary_care',
        'specialist',
        'telehealth',
        'urgent_care',
        'emergency',
        'lab',
        'lab_services',
        'xray',
        'advanced_imaging',
        'diagnostic_tests',
        'diagnostic_procedures',
        'diagnostic_radiology',
        'therapeutic_radiology',
        'outpatient_surgery',
        'outpatient_surgery_hospital',
        'outpatient_surgery_asc',
        'outpatient_observation',
        'asc',
        'physical_therapy',
        'physical_speech_therapy',
      ],
    },
    {
      name: 'Inpatient / SNF / Ambulance',
      cats: [
        'inpatient',
        'inpatient_acute',
        'inpatient_psych',
        'mh_inpatient',
        'snf',
        'ambulance',
      ],
    },
    { name: 'Dental', cats: null, like: 'dental' },
    { name: 'Vision', cats: null, like: 'vision' },
    { name: 'Hearing', cats: null, like: 'hearing' },
    { name: 'Transportation', cats: null, like: 'transport' },
    { name: 'OTC', cats: null, like: 'otc' },
    { name: 'Food / Meals', cats: ['food_card', 'meals', 'meal_benefit'] },
    { name: 'Fitness', cats: null, like: 'fitness' },
    {
      name: 'Part B giveback',
      cats: null,
      or: 'benefit_category.like.%partb%,benefit_category.like.%part_b%',
    },
    { name: 'DME / Prosthetics', cats: ['dme', 'prosthetics', 'dme_prosthetics'] },
    {
      name: 'Mental health',
      cats: null,
      or: 'benefit_category.like.%mental%,benefit_category.like.mh_%',
    },
    { name: 'Substance abuse', cats: null, like: 'substance' },
    {
      name: 'Chiropractic / Acupuncture / Podiatry',
      cats: ['chiropractic', 'acupuncture', 'podiatry'],
    },
    {
      name: 'Renal / Dialysis',
      cats: null,
      or: 'benefit_category.like.%renal%,benefit_category.like.%dialysis%',
    },
    {
      name: 'Hospice / Home health / Discharge meals',
      cats: ['hospice', 'home_health', 'discharge_meals'],
    },
  ];

  const seenInDives = new Set<string>();
  for (const dive of dives) {
    sub(dive.name);
    let q: any = sb
      .from('pm_plan_benefits')
      .select(
        'benefit_category, copay, coinsurance, coverage_amount, max_coverage, benefit_description',
      )
      .eq('contract_id', contract)
      .eq('plan_id', plan)
      .eq('segment_id', '0');
    if (dive.cats) q = q.in('benefit_category', dive.cats);
    else if (dive.like) q = q.like('benefit_category', `%${dive.like}%`);
    else if (dive.or) q = q.or(dive.or);
    const { data, error } = await q.order('benefit_category', { ascending: true });
    if (error) {
      console.log('  ERROR:', error.message);
      continue;
    }
    for (const r of (data ?? []) as AnyRow[]) seenInDives.add(String(r.benefit_category));
    printRows((data ?? []) as AnyRow[]);
  }

  // ─────────────── PART 6: UI vs DATA GAPS ───────────────
  section('PART 6 — UI (agent CompareScreen.tsx) vs DATA gap analysis');

  // Categories the agent CompareScreen explicitly surfaces.
  // Source: src/agent-v3/CompareScreen.tsx metric list + planDisplay.ts.
  // Some of these are derived from richer Plan-shape fields (e.g.
  // medical.primary_care) whose mapping back to benefit_category lives
  // in the loader; the names below use the canonical pm_plan_benefits
  // keys when those exist.
  const uiCategories = new Set<string>([
    // medical
    'primary_care',
    'specialist',
    'urgent_care',
    'emergency',
    'inpatient',
    'outpatient_surgery_hospital',
    'outpatient_surgery_asc',
    'outpatient_observation',
    'lab_services',
    'lab',
    'diagnostic_tests',
    'xray',
    'diagnostic_radiology',
    'therapeutic_radiology',
    'mental_health_individual',
    'mental_health_group',
    'physical_therapy',
    'telehealth',
    // rx tiers
    'rx_tier_1',
    'rx_tier_2',
    'rx_tier_3',
    'rx_tier_4',
    'rx_tier_5',
    // dental / vision / hearing (via planDisplay)
    'dental_preventive',
    'dental_comprehensive',
    'vision_exam',
    'vision_eyewear',
    'hearing_exam',
    'hearing_aids',
    // supplemental
    'otc',
    'food_card',
    'transportation',
    'fitness',
    'partb_giveback',
  ]);

  const dataCategories = new Set(censusRows.map((r) => r.benefit_category as string));
  const targetCategories = new Set(benefitsTarget.map((r) => String(r.benefit_category)));

  sub('Categories present in DB but NOT surfaced by CompareScreen');
  const inDbOnly = [...dataCategories].filter((c) => !uiCategories.has(c)).sort();
  console.log(`Count: ${inDbOnly.length}`);
  printRows(
    inDbOnly.map((c) => ({
      benefit_category: c,
      rows_in_db: counts.get(c) ?? 0,
      on_target_plan: targetCategories.has(c) ? 'yes' : 'no',
    })) as AnyRow[],
  );

  sub('UI categories with NO matching benefit_category key in pm_plan_benefits');
  const uiOnly = [...uiCategories].filter((c) => !dataCategories.has(c)).sort();
  printRows(uiOnly.map((c) => ({ ui_category: c })) as AnyRow[]);

  sub('UI categories present on target plan');
  printRows(
    [...uiCategories]
      .filter((c) => targetCategories.has(c))
      .sort()
      .map((c) => ({ benefit_category: c })) as AnyRow[],
  );

  sub('UI categories MISSING from target plan (would render "Not available")');
  printRows(
    [...uiCategories]
      .filter((c) => dataCategories.has(c) && !targetCategories.has(c))
      .sort()
      .map((c) => ({ benefit_category: c })) as AnyRow[],
  );

  // ─────────────── PART 7: PBP vs LANDSCAPE ───────────────
  section('PART 7 — pbp_benefits vs pm_plan_benefits for target plan');

  const pbpRes = await sb
    .from('pbp_benefits')
    .select(
      'plan_id, benefit_type, tier_id, copay, copay_max, coinsurance, coinsurance_max, description, source',
    )
    .eq('plan_id', combinedPlanId)
    .order('benefit_type', { ascending: true });
  if (pbpRes.error) {
    console.log(`pbp_benefits query failed: ${pbpRes.error.message}`);
  } else {
    const pbpRows = (pbpRes.data ?? []) as AnyRow[];
    console.log(`pbp_benefits rows for ${combinedPlanId}: ${pbpRows.length}`);
    printRows(pbpRows);

    sub('Direct name conflicts (same key in both tables, different cost share)');
    // pbp uses benefit_type, pm uses benefit_category. Compare on exact key.
    const pmByKey = new Map<string, AnyRow>();
    for (const r of benefitsTarget) pmByKey.set(String(r.benefit_category), r);
    const conflicts: AnyRow[] = [];
    for (const p of pbpRows) {
      const key = String(p.benefit_type);
      const pm = pmByKey.get(key);
      if (!pm) continue;
      if (pm.copay !== p.copay || pm.coinsurance !== p.coinsurance) {
        conflicts.push({
          key,
          pm_copay: pm.copay,
          pbp_copay: p.copay,
          pm_coinsurance: pm.coinsurance,
          pbp_coinsurance: p.coinsurance,
          pm_desc: pm.benefit_description,
          pbp_desc: p.description,
          pbp_source: p.source,
        });
      }
    }
    console.log(`Exact-key conflicts: ${conflicts.length}`);
    printRows(conflicts);

    sub('Only in pm_plan_benefits (no matching benefit_type in pbp_benefits)');
    const pbpKeys = new Set(pbpRows.map((r) => String(r.benefit_type)));
    const pmOnly = [...targetCategories].filter((c) => !pbpKeys.has(c)).sort();
    printRows(pmOnly.map((c) => ({ benefit_category: c })) as AnyRow[]);

    sub('Only in pbp_benefits (no matching benefit_category in pm_plan_benefits)');
    const pbpOnly = [...pbpKeys].filter((c) => !targetCategories.has(c)).sort();
    printRows(pbpOnly.map((c) => ({ benefit_type: c })) as AnyRow[]);
  }

  void seenInDives;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
