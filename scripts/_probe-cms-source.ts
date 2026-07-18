// Discover what CMS-authoritative "ground truth" data lives in
// plan-match-prod. We need a source that lists every plan CMS
// Plan Finder shows for a county, so we can diff it against what
// api/plans.ts returns from pm_plans.
//
// Candidates: pm_landscape_2026, pm_landscape, cms_landscape,
// landscape_source, pbp_plan_characteristics, pm_landscape_source,
// plan_landscape, etc.
//
// Also grep information_schema-ish approach via known-good tables.
import { createClient } from '@supabase/supabase-js';
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

const CANDIDATES = [
  'pm_landscape_2026', 'pm_landscape', 'pm_landscape_source',
  'cms_landscape', 'cms_landscape_2026', 'landscape_source',
  'pbp_plan_characteristics', 'pbp_landscape', 'pbp_plans',
  'medicare_gov_plans', 'medicare_gov_source', 'plan_finder_source',
  'pm_cms_plans', 'pm_plans_source', 'pm_plans_raw',
  'pm_landscape_ma', 'pm_landscape_pd', 'pm_ma_landscape',
  'ma_landscape', 'ma_plan_directory', 'cms_plan_finder',
];

async function main() {
  console.log('CMS ground-truth source discovery');
  console.log('─'.repeat(60));
  const hits: string[] = [];
  for (const t of CANDIDATES) {
    const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true });
    if (!error) {
      console.log(`  ✓ ${t}: ${count} rows`);
      hits.push(t);
    }
  }
  if (hits.length === 0) {
    console.log('\nNo candidate landscape tables found. Falling back to grep pm_* / pbp_*.');
  }

  // Broader: list any table starting with pm_ / pbp_ that has 'plan' in the name.
  const knownPmTables = [
    'pm_plans', 'pm_plan_benefits', 'pm_formulary', 'pm_drug_cost_cache',
    'pm_provider_directory', 'pm_provider_network_cache',
    'pm_non_commissionable_contracts', 'pm_county_fips', 'pm_zip_county',
    'pm_drug_ndc', 'pm_supp_carrier_rates',
    'pbp_benefits', 'pbp_benefits_v2',
  ];
  console.log('\nKnown table row-counts (for context):');
  for (const t of knownPmTables) {
    const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true });
    if (!error) console.log(`  ${t}: ${count}`);
  }

  // If any hit had "landscape" in the name, dump its columns.
  const landscape = hits.find((h) => h.includes('landscape')) ?? hits.find((h) => h.includes('cms')) ?? hits[0];
  if (landscape) {
    const { data } = await sb.from(landscape).select('*').limit(2);
    if (data && data[0]) {
      console.log(`\n${landscape} columns:`);
      Object.keys(data[0]).sort().forEach((c) => console.log(`  ${c}`));
      console.log(`\nSample row:`);
      console.log(JSON.stringify(data[0], null, 2));
    }
  }

  // What plan_year is the current pm_plans set on?
  const { data: yearCheck } = await sb.from('pm_plans').select('created_at, contract_id, plan_id').order('created_at', { ascending: false }).limit(1);
  console.log(`\npm_plans most-recent row: ${JSON.stringify(yearCheck?.[0] ?? {})}`);

  // pbp_benefits_v2 has plan_year — see what years it covers
  const { data: pbpYears } = await sb.from('pbp_benefits_v2').select('plan_year').limit(50);
  const yearHist: Record<string, number> = {};
  (pbpYears ?? []).forEach((r) => { yearHist[String(r.plan_year)] = (yearHist[String(r.plan_year)] ?? 0) + 1; });
  console.log(`pbp_benefits_v2 plan_year distribution (first 50 rows): ${JSON.stringify(yearHist)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
