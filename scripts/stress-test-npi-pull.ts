// scripts/stress-test-npi-pull.ts — pull real NPIs per county/specialty
// for the stress-test personas. Writes to ~/Desktop/stress-test-npis.txt
// and prints to console.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

interface Target {
  county: string;
  specialties: string[];
}

const TARGETS: Target[] = [
  { county: 'Durham', specialties: ['Internal Medicine', 'Family Medicine', 'Cardiology', 'Endocrinology', 'Primary Care'] },
  { county: 'Wake', specialties: ['Family Medicine', 'Rheumatology', 'Primary Care'] },
  { county: 'Orange', specialties: ['Cardiology'] },
  { county: 'Mecklenburg', specialties: ['Neurology', 'Endocrinology', 'Primary Care'] },
  { county: 'Buncombe', specialties: ['Pulmonology'] },
  { county: 'Pitt', specialties: ['Cardiology', 'Primary Care'] },
  { county: 'Guilford', specialties: ['Primary Care', 'Internal Medicine'] },
  { county: 'Forsyth', specialties: ['Pulmonology'] },
  { county: 'New Hanover', specialties: ['Oncology'] },
  { county: 'Cumberland', specialties: ['Family Medicine'] },
  { county: 'Alamance', specialties: ['Internal Medicine'] },
  { county: 'Gaston', specialties: ['Rheumatology'] },
  { county: 'Johnston', specialties: ['Endocrinology', 'Primary Care'] },
  { county: 'Henderson', specialties: ['Geriatrics'] },
  { county: 'Catawba', specialties: ['Internal Medicine'] },
  { county: 'Onslow', specialties: ['Orthopedic'] },
];

// Adult-specialty taxonomy strings — picked to avoid pediatric / radiation /
// therapist false-positives that bare ILIKE matches surface in alphabetical
// order.
const ALIASES: Record<string, string[]> = {
  'Pulmonology': ['Pulmonary Disease', 'Pulmonology', 'Pulmonary'],
  'Primary Care': ['Family Medicine', 'Internal Medicine', 'General Practice'],
  'Orthopedic': ['Orthopaedic Surgery', 'Orthopedic Surgery'],
  'Geriatrics': ['Geriatric Medicine', 'Geriatrics'],
  'Cardiology': ['Cardiovascular Disease', 'Interventional Cardiology'],
  'Rheumatology': ['Internal Medicine Rheumatology', 'Rheumatology'],
  'Oncology': ['Hematology Oncology', 'Medical Oncology'],
  'Neurology': ['Neurology'],
  'Endocrinology': ['Endocrinology'],
};

// Per-keyword exclusion words — if `specialties` contains any of these
// (case-insensitive), the row is skipped. Keeps pediatric subspecialists,
// radiation oncologists, and PT-Orthopedic rows out of adult-Medicare picks.
const EXCLUDES: Record<string, string[]> = {
  'Cardiology': ['Pediatric'],
  'Rheumatology': ['Pediatric'],
  'Pulmonology': ['Pediatric'],
  'Endocrinology': ['Pediatric'],
  'Neurology': ['Pediatric'],
  'Oncology': ['Pediatric', 'Radiation'],
  'Orthopedic': ['Therapist', 'Physical Therapist'],
};

const KNOWN_NPIS: Array<{ name: string; npi: string }> = [
  { name: 'Klein', npi: '1619976297' },
  { name: 'Robin Edwards', npi: '1093029498' },
];

interface ProviderRow {
  npi: string;
  display_name: string;
  specialties: string;
}

async function getZipsForCounty(county: string): Promise<string[]> {
  const { data, error } = await sb
    .from('pm_zip_county')
    .select('zip')
    .eq('state', 'NC')
    .ilike('county', county)
    .limit(1000);
  if (error) {
    console.error(`zip lookup failed for ${county}:`, error);
    return [];
  }
  return (data ?? []).map((r: { zip: string }) => r.zip);
}

async function findProvider(
  zips: string[],
  term: string,
  excludeNpis: Set<string>,
  excludeWords: string[],
): Promise<ProviderRow | null> {
  if (zips.length === 0) return null;
  // Fetch a wider candidate set so post-filter exclusions still leave a hit.
  const { data, error } = await sb
    .from('pm_provider_directory')
    .select('npi, display_name, specialties')
    .in('primary_zip', zips)
    .ilike('specialties', `%${term}%`)
    .order('display_name', { ascending: true })
    .limit(25);
  if (error) {
    console.error(`provider lookup failed [${term}]:`, error.message);
    return null;
  }
  const ex = excludeWords.map((w) => w.toLowerCase());
  for (const r of data ?? []) {
    if (excludeNpis.has(r.npi)) continue;
    const lower = (r.specialties ?? '').toLowerCase();
    if (ex.some((w) => lower.includes(w))) continue;
    return r as ProviderRow;
  }
  return null;
}

async function confirmKnownNpi(npi: string): Promise<{ found: boolean; display_name?: string; specialties?: string; primary_zip?: string }> {
  const { data, error } = await sb
    .from('pm_provider_directory')
    .select('npi, display_name, specialties, primary_zip')
    .eq('npi', npi)
    .limit(1);
  if (error) {
    console.error(`known-NPI lookup failed for ${npi}:`, error.message);
    return { found: false };
  }
  if (!data || data.length === 0) return { found: false };
  return {
    found: true,
    display_name: data[0].display_name,
    specialties: data[0].specialties,
    primary_zip: data[0].primary_zip,
  };
}

async function main() {
  const lines: string[] = [];
  lines.push('# Stress-test NPI pull — plan-match-prod pm_provider_directory');
  lines.push('# COUNTY | SPECIALTY_KEYWORD | NPI | DISPLAY_NAME | ACTUAL_SPECIALTIES');
  lines.push('');

  for (const t of TARGETS) {
    const zips = await getZipsForCounty(t.county);
    if (zips.length === 0) {
      const line = `${t.county} | (no zips) | — | — | —`;
      lines.push(line);
      console.log(line);
      continue;
    }
    const pickedInCounty = new Set<string>();
    for (const sp of t.specialties) {
      const attempts = ALIASES[sp] ?? [sp];
      const excludes = EXCLUDES[sp] ?? [];
      let hit: ProviderRow | null = null;
      let matchedTerm = sp;
      for (const term of attempts) {
        hit = await findProvider(zips, term, pickedInCounty, excludes);
        if (hit) { matchedTerm = term; break; }
      }
      if (hit) {
        pickedInCounty.add(hit.npi);
        const kw = matchedTerm === sp ? sp : `${sp} (as ${matchedTerm})`;
        const line = `${t.county} | ${kw} | ${hit.npi} | ${hit.display_name} | ${hit.specialties}`;
        lines.push(line);
        console.log(line);
      } else {
        const line = `${t.county} | ${sp} | (none) | — | —`;
        lines.push(line);
        console.log(line);
      }
    }
  }

  lines.push('');
  lines.push('# Known NPI confirmations');
  console.log('');
  console.log('# Known NPI confirmations');
  for (const k of KNOWN_NPIS) {
    const r = await confirmKnownNpi(k.npi);
    let line: string;
    if (r.found) {
      line = `KNOWN | ${k.name} | ${k.npi} | ${r.display_name} | ${r.specialties} (zip=${r.primary_zip})`;
    } else {
      line = `KNOWN | ${k.name} | ${k.npi} | NOT FOUND | —`;
    }
    lines.push(line);
    console.log(line);
  }

  const outPath = join(homedir(), 'Desktop', 'stress-test-npis.txt');
  writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
