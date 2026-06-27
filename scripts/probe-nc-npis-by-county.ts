// scripts/probe-nc-npis-by-county.ts
// Stress-test persona helper: pull real NPIs from pm_provider_directory
// for Durham / Wake / Mecklenburg / Buncombe / Pitt, one per specialty,
// plus an NPI-count-per-county summary across NC.
//
// pm_provider_directory has no county column — only primary_zip.
// pm_zip_county maps zip→county. We resolve county zips first, then
// filter the provider table by primary_zip IN (zips).
//
// PostgREST has no DISTINCT ON, so we over-fetch sorted by specialty +
// display_name and dedupe by specialty in JS.

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

type ProviderRow = {
  npi: string;
  display_name: string | null;
  specialties: string | null;
  primary_zip: string | null;
};

async function zipsForCounty(countyLike: string): Promise<string[]> {
  const { data, error } = await sb
    .from('pm_zip_county')
    .select('zip, county')
    .eq('state', 'NC')
    .ilike('county', `%${countyLike}%`);
  if (error) throw error;
  return [...new Set((data ?? []).map((r) => r.zip))];
}

async function distinctBySpecialty(countyLabel: string, take: number) {
  const zips = await zipsForCounty(countyLabel);
  if (zips.length === 0) {
    console.log(`(no zips found for ${countyLabel})`);
    return [];
  }

  // Over-fetch in chunks — .in() with large zip arrays still hits the
  // 1000-row cap. We page through results sorted by specialty so the
  // first occurrence per specialty is the alphabetically-first name,
  // matching the SQL's DISTINCT ON (specialty) ORDER BY specialty,
  // provider_name.
  const seen = new Set<string>();
  const out: ProviderRow[] = [];
  const PAGE = 1000;
  for (let p = 0; p < 10 && out.length < take; p += 1) {
    const { data, error } = await sb
      .from('pm_provider_directory')
      .select('npi, display_name, specialties, primary_zip')
      .eq('primary_state', 'NC')
      .in('primary_zip', zips)
      .not('specialties', 'is', null)
      .order('specialties', { ascending: true })
      .order('display_name', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data as ProviderRow[]) {
      const sp = r.specialties ?? '';
      if (seen.has(sp)) continue;
      seen.add(sp);
      out.push(r);
      if (out.length >= take) break;
    }
    if (data.length < PAGE) break;
  }
  return out;
}

async function npiCountByCounty() {
  // Pull every NC zip→county row, build zip→county map.
  const { data: zc, error: zcErr } = await sb
    .from('pm_zip_county')
    .select('zip, county')
    .eq('state', 'NC');
  if (zcErr) throw zcErr;
  const zipToCounty = new Map<string, string>();
  for (const r of zc ?? []) zipToCounty.set(r.zip, r.county);

  // Page through all NC providers; tally distinct NPIs per county.
  const PAGE = 1000;
  const MAX_PAGES = 500;
  const byCounty = new Map<string, Set<string>>();
  for (let p = 0; p < MAX_PAGES; p += 1) {
    const { data, error } = await sb
      .from('pm_provider_directory')
      .select('npi, primary_zip')
      .eq('primary_state', 'NC')
      .range(p * PAGE, p * PAGE + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data as { npi: string; primary_zip: string | null }[]) {
      const c = zipToCounty.get(r.primary_zip ?? '') ?? '(unknown)';
      if (!byCounty.has(c)) byCounty.set(c, new Set());
      byCounty.get(c)!.add(r.npi);
    }
    if (data.length < PAGE) break;
  }
  return [...byCounty.entries()]
    .map(([county, set]) => ({ county, npi_count: set.size }))
    .sort((a, b) => b.npi_count - a.npi_count);
}

async function main() {
  const counties: Array<{ name: string; take: number }> = [
    { name: 'Durham', take: 10 },
    { name: 'Wake', take: 5 },
    { name: 'Mecklenburg', take: 5 },
    { name: 'Buncombe', take: 5 },
    { name: 'Pitt', take: 5 },
  ];

  for (const c of counties) {
    console.log(`\n=== ${c.name} (top ${c.take} specialties) ===`);
    const rows = await distinctBySpecialty(c.name, c.take);
    console.table(rows);
  }

  console.log('\n=== NPI count per NC county (top 20) ===');
  const counts = await npiCountByCounty();
  console.table(counts.slice(0, 20));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
