// scripts/probe-drug-resolution.ts — diagnostic for three Meds-screen
// resolution failures: Repatha Sureclick / Pramipexole 1MG / Fluoxetine
// 40mcg. Hits the live /api/library/drug-search + /api/formulary
// endpoints exactly the way the agent's MedsScreen does, then probes
// pm_drugs / pm_formulary directly to confirm the data shape underneath.
//
// Usage:  npx tsx scripts/probe-drug-resolution.ts

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

const LIBRARY_URL = 'https://planmatch.generationhealth.me';

interface LibraryDrug {
  rxcui: string;
  name: string;
  generic_name: string | null;
  brand_name: string | null;
  strength: string | null;
  dose_form: string | null;
  is_brand: boolean;
}

async function librarySearch(query: string, limit = 6): Promise<LibraryDrug[]> {
  const r = await fetch(`${LIBRARY_URL}/api/library/drug-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit }),
  });
  if (!r.ok) {
    console.error(`  drug-search ${r.status}: ${await r.text()}`);
    return [];
  }
  const body = (await r.json()) as { drugs?: LibraryDrug[] };
  return body.drugs ?? [];
}

async function probePmDrugs(stem: string, cap = 20): Promise<unknown[]> {
  const { data, error } = await sb
    .from('pm_drugs')
    .select('rxcui,name,generic_name,brand_name,strength,dose_form,is_brand,is_prescribable')
    .ilike('search_text', `%${stem.toLowerCase()}%`)
    .limit(cap);
  if (error) throw error;
  return data ?? [];
}

async function probePmFormularyByRxcui(rxcui: string): Promise<number> {
  const { count, error } = await sb
    .from('pm_formulary')
    .select('*', { count: 'exact', head: true })
    .eq('rxcui', rxcui);
  if (error) throw error;
  return count ?? 0;
}

async function probePmFormularyByDrugName(stem: string): Promise<{ rxcui: string; drug_name: string }[]> {
  const { data, error } = await sb
    .from('pm_formulary')
    .select('rxcui,drug_name')
    .ilike('drug_name', `%${stem}%`)
    .limit(20);
  if (error) throw error;
  // Dedup by rxcui
  const seen = new Set<string>();
  const out: { rxcui: string; drug_name: string }[] = [];
  for (const r of (data ?? []) as Array<{ rxcui: string; drug_name: string }>) {
    const key = String(r.rxcui);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ rxcui: key, drug_name: r.drug_name });
  }
  return out;
}

function dump(label: string, drugs: LibraryDrug[]): void {
  console.log(`  /api/library/drug-search "${label}" → ${drugs.length} rows`);
  for (const d of drugs.slice(0, 5)) {
    console.log(
      `    rxcui=${d.rxcui}  name=${d.name}  brand=${d.brand_name ?? '-'}  generic=${d.generic_name ?? '-'}  strength=${d.strength ?? '-'}  form=${d.dose_form ?? '-'}`,
    );
  }
}

async function probeBug1Repatha() {
  console.log('\n══════════════ Bug 1: Repatha Sureclick ══════════════');
  const variants = [
    'Repatha Sureclick SOLN AUTO-INJ 140MG/ML',
    'Repatha Sureclick SOLN AUTO-INJ',
    'Repatha Sureclick',
    'Repatha',
    'evolocumab',
    'evolocumab 140',
  ];
  for (const v of variants) {
    const drugs = await librarySearch(v);
    dump(v, drugs);
  }
  console.log('\n  pm_drugs probe for "repatha":');
  const repathaRows = await probePmDrugs('repatha');
  console.log(`    ${repathaRows.length} rows in pm_drugs`);
  if (repathaRows.length > 0) console.log('   ', JSON.stringify(repathaRows[0]));
  console.log('  pm_drugs probe for "evolocumab":');
  const evoloRows = await probePmDrugs('evolocumab');
  console.log(`    ${evoloRows.length} rows in pm_drugs`);
  if (evoloRows.length > 0) console.log('   ', JSON.stringify(evoloRows[0]));
  console.log('  pm_formulary scan for drug_name~"evolocumab":');
  const fmEvolo = await probePmFormularyByDrugName('evolocumab');
  console.log(`    ${fmEvolo.length} distinct rxcuis in pm_formulary`);
  for (const r of fmEvolo.slice(0, 5)) console.log(`     rxcui=${r.rxcui}  name=${r.drug_name}`);
}

async function probeBug2Pramipexole() {
  console.log('\n══════════════ Bug 2: Pramipexole 1MG ══════════════');
  const variants = [
    'Pramipexole Dihydrochloride TAB 1MG',
    'Pramipexole Dihydrochloride 1MG',
    'Pramipexole Dihydrochloride',
    'Pramipexole 1MG',
    'Pramipexole',
  ];
  let firstHitRxcui: string | null = null;
  for (const v of variants) {
    const drugs = await librarySearch(v);
    dump(v, drugs);
    if (!firstHitRxcui && drugs.length > 0) firstHitRxcui = drugs[0].rxcui;
  }

  console.log('\n  pm_drugs probe for "pramipexole":');
  const rows = await probePmDrugs('pramipexole', 30);
  console.log(`    ${rows.length} rows in pm_drugs`);
  for (const r of rows.slice(0, 10)) console.log('   ', JSON.stringify(r));

  console.log('\n  pm_formulary probe for drug_name~"pramipexole":');
  const fm = await probePmFormularyByDrugName('pramipexole');
  console.log(`    ${fm.length} distinct rxcuis covered`);
  for (const r of fm.slice(0, 8)) console.log(`     rxcui=${r.rxcui}  name=${r.drug_name}`);

  if (firstHitRxcui) {
    const count = await probePmFormularyByRxcui(firstHitRxcui);
    console.log(`\n  direct rxcui ${firstHitRxcui} pm_formulary count: ${count}`);
  }
}

async function probeBug3Fluoxetine() {
  console.log('\n══════════════ Bug 3: Fluoxetine 40 ══════════════');
  const variants = [
    'Fluoxetine HCL CAP 40mcg',
    'Fluoxetine HCL CAP 40mg',
    'Fluoxetine 40',
    'Fluoxetine',
  ];
  for (const v of variants) {
    const drugs = await librarySearch(v);
    dump(v, drugs);
  }
  console.log('\n  pm_drugs probe for "fluoxetine":');
  const rows = await probePmDrugs('fluoxetine', 30);
  console.log(`    ${rows.length} rows in pm_drugs`);
  // Show any 40 entries
  const fortyish = (rows as Array<{ name: string; strength?: string | null; rxcui: string; dose_form?: string | null }>).filter(
    (r) => /\b40\b/.test(r.name) || /\b40\b/.test(r.strength ?? ''),
  );
  for (const r of fortyish) console.log('   ', JSON.stringify(r));
  console.log('\n  pm_formulary probe for drug_name~"fluoxetine 40":');
  const fm = await probePmFormularyByDrugName('fluoxetine 40');
  console.log(`    ${fm.length} distinct rxcuis covered`);
  for (const r of fm.slice(0, 8)) console.log(`     rxcui=${r.rxcui}  name=${r.drug_name}`);
}

async function main() {
  await probeBug1Repatha();
  await probeBug2Pramipexole();
  await probeBug3Fluoxetine();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
