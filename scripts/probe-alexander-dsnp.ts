// scripts/probe-alexander-dsnp.ts — verify the D-SNP filter for Alexander
// County NC. CompareScreen filter calls `p.snp_type === 'D-SNP'`. If
// pm_plans has zero D-SNP rows for Alexander, the filter is correct.
// If rows exist but snp_type uses a different format ("DSNP" without
// hyphen) the filter is buggy.

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
  console.log('── Alexander County NC plan inventory ──\n');

  // 1. Total plan count for Alexander.
  const { count: totalCount, error: totalErr } = await sb
    .from('pm_plans')
    .select('*', { count: 'exact', head: true })
    .eq('state', 'NC')
    .eq('county_name', 'Alexander');
  if (totalErr) throw totalErr;
  console.log(`Total pm_plans rows (Alexander, NC): ${totalCount ?? 0}`);

  // 2. Distinct snp_type values present in Alexander.
  const { data: snpRows, error: snpErr } = await sb
    .from('pm_plans')
    .select('snp_type')
    .eq('state', 'NC')
    .eq('county_name', 'Alexander');
  if (snpErr) throw snpErr;
  const snpHistogram = new Map<string, number>();
  for (const r of snpRows ?? []) {
    const k = r.snp_type ?? '(null)';
    snpHistogram.set(k, (snpHistogram.get(k) ?? 0) + 1);
  }
  console.log('\nsnp_type histogram for Alexander:');
  console.table(
    [...snpHistogram.entries()].map(([snp_type, count]) => ({ snp_type, count })),
  );

  // 3. Sample D-SNP rows specifically (both hyphenated and unhyphenated forms).
  for (const form of ['D-SNP', 'DSNP']) {
    const { data: sample, error: sErr } = await sb
      .from('pm_plans')
      .select('contract_id, plan_id, plan_name, carrier, snp_type, plan_type')
      .eq('state', 'NC')
      .eq('county_name', 'Alexander')
      .eq('snp_type', form)
      .limit(5);
    if (sErr) throw sErr;
    console.log(`\nsnp_type = "${form}" (Alexander, NC): ${sample?.length ?? 0} sample rows`);
    if (sample && sample.length > 0) console.table(sample);
  }

  // 4. Compare against a known-D-SNP county (Durham) for sanity.
  const { count: durhamCount, error: dErr } = await sb
    .from('pm_plans')
    .select('*', { count: 'exact', head: true })
    .eq('state', 'NC')
    .eq('county_name', 'Durham')
    .eq('snp_type', 'D-SNP');
  if (dErr) throw dErr;
  console.log(`\nSanity check — Durham NC D-SNP count: ${durhamCount ?? 0}`);

  // 5. Statewide NC D-SNP carrier counts so we can see WHO files D-SNPs
  // in NC and whether any of them appear in Alexander.
  const { data: ncDsnp, error: ncErr } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, carrier, county_name')
    .eq('state', 'NC')
    .eq('snp_type', 'D-SNP');
  if (ncErr) throw ncErr;
  const carriers = new Map<string, number>();
  const alexCarriers = new Set<string>();
  for (const r of ncDsnp ?? []) {
    const c = r.carrier ?? '(null)';
    carriers.set(c, (carriers.get(c) ?? 0) + 1);
    if (r.county_name === 'Alexander') alexCarriers.add(c);
  }
  console.log(`\nNC statewide D-SNP rows: ${ncDsnp?.length ?? 0}`);
  console.log(`Distinct carriers filing D-SNP in NC: ${carriers.size}`);
  console.log(`Carriers filing D-SNP in Alexander specifically: ${alexCarriers.size}`);
  if (alexCarriers.size > 0) {
    console.table([...alexCarriers].map((c) => ({ carrier: c })));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
