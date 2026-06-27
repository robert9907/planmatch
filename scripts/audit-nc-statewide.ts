// Statewide NC coverage audit — all 100 counties.
// Reports per-county plan count, benefit coverage, drug-cost coverage,
// formulary coverage, and provider coverage. Read-only.
//
// Notes on schema landmines this script handles:
//   • pm_plans.contract_plan_id uses underscores ("H1036_318")
//     while pm_drug_cost_cache.plan_id + pm_provider_network_cache.plan_id
//     use dashes ("H1036-318"). Always join via `${contract_id}-${plan_id}`.
//   • pm_zip_county has no county_fips column — use pm_county_fips for
//     fips ↔ name resolution.
//   • PostgREST caps every query at 1000 rows; use paginate() for
//     anything that could exceed it.
//
// Run with: npx tsx scripts/audit-nc-statewide.ts

import { createClient, type PostgrestSingleResponse } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function paginate<T>(
  pageFn: (from: number, to: number) => PromiseLike<PostgrestSingleResponse<T[]>>,
  maxPages = 500,
): Promise<T[]> {
  const out: T[] = [];
  for (let n = 0; n < maxPages; n += 1) {
    const from = n * 1000;
    const to = from + 999;
    const { data, error } = await pageFn(from, to);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

function section(t: string) { console.log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78)); }

function tablify(rows: any[], cols?: string[]) {
  if (!rows.length) { console.log('  (no rows)'); return; }
  const c = cols ?? Object.keys(rows[0]);
  const w: Record<string, number> = {};
  for (const k of c) {
    w[k] = k.length;
    for (const r of rows) {
      const s = r[k] == null ? 'null' : String(r[k]);
      w[k] = Math.max(w[k], Math.min(s.length, 50));
    }
  }
  console.log('  ' + c.map((k) => k.padEnd(w[k])).join(' │ '));
  console.log('  ' + c.map((k) => '─'.repeat(w[k])).join('─┼─'));
  for (const r of rows) {
    console.log('  ' + c.map((k) => String(r[k] ?? 'null').padEnd(w[k])).join(' │ '));
  }
}

async function main() {
  // ──────────────────────── 0. fips ↔ county lookup ────────────────────────
  // pm_county_fips uses "Durham County" while pm_plans uses "Durham" —
  // normalize by stripping the trailing " County" so the two sources
  // join cleanly.
  const normalize = (s: string) => s.replace(/ County$/i, '').trim();
  const fipsRows = await paginate<{ state: string; fips: number; county_name: string }>((f, t) =>
    sb.from('pm_county_fips').select('state, fips, county_name').eq('state', 'NC').range(f, t),
  );
  const fipsToName = new Map<number, string>();
  const nameToFips = new Map<string, number>();
  for (const r of fipsRows) {
    const norm = normalize(r.county_name);
    fipsToName.set(r.fips, norm);
    nameToFips.set(norm, r.fips);
  }
  console.log(`pm_county_fips NC counties: ${fipsToName.size}`);

  // ──────────────────────── 1. pm_plans by county ────────────────────────
  section('1 — Plans per county (pm_plans, state=NC)');
  const plans = await paginate<{
    contract_id: string; plan_id: string; segment_id: string;
    plan_name: string; county_name: string; county_fips: number;
  }>((f, t) =>
    sb.from('pm_plans')
      .select('contract_id, plan_id, segment_id, plan_name, county_name, county_fips')
      .eq('state', 'NC').range(f, t),
  );
  console.log(`Total NC pm_plans rows: ${plans.length}`);

  // Count distinct contract-plan pairs per county (ignore segment).
  const planPairsByCounty = new Map<string, Set<string>>();
  const planPairsByFips = new Map<number, Set<string>>();
  for (const p of plans) {
    const pair = `${p.contract_id}-${p.plan_id}`;
    const list = planPairsByCounty.get(p.county_name) ?? new Set<string>();
    list.add(pair);
    planPairsByCounty.set(p.county_name, list);
    if (p.county_fips != null) {
      const fl = planPairsByFips.get(p.county_fips) ?? new Set<string>();
      fl.add(pair);
      planPairsByFips.set(p.county_fips, fl);
    }
  }
  const planCountsAsc = [...planPairsByCounty.entries()]
    .sort((a, b) => a[1].size - b[1].size)
    .map(([county_name, set]) => ({ county_name, plans: set.size }));
  console.log(`Counties represented in pm_plans: ${planCountsAsc.length} (of ${fipsToName.size} NC counties)`);
  console.log('\nBottom 10 (sparsest):');
  tablify(planCountsAsc.slice(0, 10));
  console.log('\nTop 5 (densest):');
  tablify(planCountsAsc.slice(-5).reverse());

  const countiesWithZeroPlans = [...fipsToName.values()].filter((n) => !planPairsByCounty.has(n));
  console.log(`\nCounties with ZERO plans: ${countiesWithZeroPlans.length}`);
  if (countiesWithZeroPlans.length > 0) {
    tablify(countiesWithZeroPlans.map((county_name) => ({ county_name })));
  }

  // Build the full distinct contract-plan set for downstream joins.
  const allPairs = new Set<string>();
  for (const set of planPairsByCounty.values()) {
    for (const v of set) allPairs.add(v);
  }
  console.log(`\nTotal distinct contract-plan pairs in NC: ${allPairs.size}`);

  // ──────────────────────── 2. Benefits coverage ────────────────────────
  section('2 — Benefits coverage per county (pm_plan_benefits)');
  // Fetch DISTINCT (contract_id, plan_id) from pm_plan_benefits filtered to NC plans.
  // Build a set of pairs that have benefits — done by querying benefits in chunks.
  const allContractIds = [...new Set(plans.map((p) => p.contract_id))];
  const benRows = await paginate<{ contract_id: string; plan_id: string }>((f, t) =>
    sb.from('pm_plan_benefits')
      .select('contract_id, plan_id')
      .in('contract_id', allContractIds).range(f, t),
  );
  const pairsWithBenefits = new Set(benRows.map((b) => `${b.contract_id}-${b.plan_id}`));
  console.log(`Distinct (contract, plan) pairs with ≥1 benefit row: ${pairsWithBenefits.size}`);

  const benByCounty = [...planPairsByCounty.entries()]
    .map(([county_name, set]) => {
      let withBen = 0;
      for (const p of set) if (pairsWithBenefits.has(p)) withBen += 1;
      return {
        county_name,
        total_plans: set.size,
        plans_with_benefits: withBen,
        gap_plans: set.size - withBen,
      };
    })
    .sort((a, b) => a.plans_with_benefits - b.plans_with_benefits);
  console.log('\nCounties with the most benefit gaps:');
  tablify(benByCounty.slice(0, 10));
  const fullyCovered = benByCounty.filter((r) => r.gap_plans === 0).length;
  console.log(`\nCounties where every plan has benefits: ${fullyCovered}/${benByCounty.length}`);

  // ──────────────────────── 3. Provider coverage by county ────────────────────────
  section('3 — Provider cache rows per county_fips (pm_provider_network_cache, state=NC)');
  const provRows = await paginate<{ npi: string | number; county_fips: number; covered: boolean }>(
    (f, t) =>
      sb.from('pm_provider_network_cache')
        .select('npi, county_fips, covered')
        .eq('state', 'NC').range(f, t),
    500,
  );
  console.log(`Total NC provider-cache rows fetched: ${provRows.length}`);
  const provByFips = new Map<number, { rows: number; coveredRows: number; npis: Set<string> }>();
  for (const r of provRows) {
    if (r.county_fips == null) continue;
    const e = provByFips.get(r.county_fips) ?? { rows: 0, coveredRows: 0, npis: new Set<string>() };
    e.rows += 1;
    if (r.covered) e.coveredRows += 1;
    e.npis.add(String(r.npi));
    provByFips.set(r.county_fips, e);
  }
  const provCountsAsc = [...provByFips.entries()]
    .map(([fips, e]) => ({
      county_name: fipsToName.get(fips) ?? `(fips ${fips})`,
      county_fips: fips,
      providers: e.npis.size,
      covered_rows: e.coveredRows,
      total_rows: e.rows,
    }))
    .sort((a, b) => a.providers - b.providers);
  console.log('\nBottom 10 (sparsest):');
  tablify(provCountsAsc.slice(0, 10));
  console.log('\nTop 5 (densest):');
  tablify(provCountsAsc.slice(-5).reverse());

  const countiesWithNoProviders = [...fipsToName.entries()]
    .filter(([fips]) => !provByFips.has(fips))
    .map(([fips, name]) => ({ county_name: name, county_fips: fips }));
  console.log(`\nCounties with ZERO provider rows: ${countiesWithNoProviders.length}`);
  if (countiesWithNoProviders.length > 0) tablify(countiesWithNoProviders);

  // ──────────────────────── 4. Drug-cost coverage ────────────────────────
  section('4 — Drug cost coverage per county (pm_drug_cost_cache)');
  // pm_drug_cost_cache.plan_id is "H1914-009" — same format as our pair key.
  // Pull distinct plan_ids by fetching plan_id column across the NC plan set.
  const drugRows = await paginate<{ plan_id: string }>((f, t) =>
    sb.from('pm_drug_cost_cache')
      .select('plan_id')
      .in('plan_id', [...allPairs]).range(f, t),
    500,
  );
  const pairsWithDrugCosts = new Set(drugRows.map((d) => d.plan_id));
  console.log(`Distinct plan_ids in pm_drug_cost_cache for NC plans: ${pairsWithDrugCosts.size}`);

  const drugByCounty = [...planPairsByCounty.entries()]
    .map(([county_name, set]) => {
      let withDc = 0;
      for (const p of set) if (pairsWithDrugCosts.has(p)) withDc += 1;
      return {
        county_name,
        total_plans: set.size,
        plans_with_drug_costs: withDc,
        gap_plans: set.size - withDc,
      };
    })
    .sort((a, b) => a.plans_with_drug_costs - b.plans_with_drug_costs);
  console.log('\nCounties with the most drug-cost gaps:');
  tablify(drugByCounty.slice(0, 10));
  const drugFully = drugByCounty.filter((r) => r.gap_plans === 0).length;
  console.log(`\nCounties where every plan has drug costs: ${drugFully}/${drugByCounty.length}`);

  // ──────────────────────── 5. Formulary spot-check ────────────────────────
  section('5 — Formulary spot-check: rural vs urban');
  const smallest = planCountsAsc[0];
  const largest = planCountsAsc[planCountsAsc.length - 1];
  console.log(`Sparsest county: ${smallest.county_name} (${smallest.plans} plans)`);
  console.log(`Densest county: ${largest.county_name} (${largest.plans} plans)`);
  for (const target of [smallest, largest]) {
    const pair = planPairsByCounty.get(target.county_name)!.values().next().value as string;
    const [ci, pi] = pair.split('-');
    const { data, count } = await sb
      .from('pm_formulary')
      .select('rxcui', { count: 'exact', head: true })
      .eq('contract_id', ci).eq('plan_id', pi);
    console.log(`  ${target.county_name} sample plan ${pair} → pm_formulary rows: ${count ?? '(null)'}` + (data ? '' : ''));
  }

  // ──────────────────────── 6. Summary table ────────────────────────
  section('6 — Per-county summary (all NC counties)');
  // Build a normalized per-county view. pm_plans uses bare names
  // ("Durham"); pm_county_fips uses suffixed names ("Durham County").
  // Normalize before joining so we don't double-count.
  const planPairsNorm = new Map<string, Set<string>>();
  const planFipsNorm = new Map<string, number>();
  for (const [k, v] of planPairsByCounty) {
    const norm = normalize(k);
    const existing = planPairsNorm.get(norm) ?? new Set<string>();
    for (const p of v) existing.add(p);
    planPairsNorm.set(norm, existing);
  }
  for (const p of plans) {
    if (p.county_fips != null) planFipsNorm.set(normalize(p.county_name), p.county_fips);
  }
  const allCountyNames = new Set<string>([
    ...fipsToName.values(),
    ...planPairsNorm.keys(),
  ]);
  const summary: any[] = [];
  for (const county of allCountyNames) {
    const planSet = planPairsNorm.get(county) ?? new Set<string>();
    const total = planSet.size;
    let withBen = 0, withDc = 0;
    for (const p of planSet) {
      if (pairsWithBenefits.has(p)) withBen += 1;
      if (pairsWithDrugCosts.has(p)) withDc += 1;
    }
    const fips =
      planFipsNorm.get(county) ?? nameToFips.get(county) ?? null;
    const provEntry = fips != null ? provByFips.get(fips) : undefined;
    const providers = provEntry?.npis.size ?? 0;

    const gaps: string[] = [];
    if (total === 0) gaps.push('no-plans');
    if (total > 0 && withBen < total) gaps.push(`benefits:${total - withBen}`);
    if (total > 0 && withDc < total) gaps.push(`drug-costs:${total - withDc}`);
    if (county !== 'All Counties' && providers === 0) gaps.push('no-providers');

    summary.push({
      county,
      fips,
      plans: total,
      with_benefits: withBen,
      with_drug_costs: withDc,
      provider_npis: providers,
      gaps: gaps.length === 0 ? 'OK' : gaps.join('; '),
    });
  }
  // Sort: gap counties first, by severity
  summary.sort((a, b) => {
    const aOk = a.gaps === 'OK' ? 1 : 0;
    const bOk = b.gaps === 'OK' ? 1 : 0;
    if (aOk !== bOk) return aOk - bOk;
    return a.county.localeCompare(b.county);
  });

  // Show counties with any gap first
  const withGaps = summary.filter((r) => r.gaps !== 'OK');
  const allOk = summary.filter((r) => r.gaps === 'OK');
  console.log(`Counties with gaps: ${withGaps.length} / ${summary.length}`);
  console.log(`Counties fully covered: ${allOk.length} / ${summary.length}`);
  console.log('\nFull table (counties with gaps first):');
  tablify(summary);

  // Headline counts
  console.log('\n── Headline ──');
  console.log(`NC counties in pm_county_fips:       ${fipsToName.size}`);
  console.log(`Counties with ≥1 pm_plans row:       ${planCountsAsc.length}`);
  console.log(`Counties with 0 plans:               ${countiesWithZeroPlans.length}`);
  console.log(`Counties where every plan has benefits:   ${fullyCovered}/${benByCounty.length}`);
  console.log(`Counties where every plan has drug costs: ${drugFully}/${drugByCounty.length}`);
  console.log(`Counties with 0 provider rows:       ${countiesWithNoProviders.length}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
