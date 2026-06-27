// Probe follow-up: ~half of inpatient/SNF/MH-inpatient rows in
// pm_plan_benefits have a non-null benefit_description that the
// formatInpatientLadder regex misses. Dump samples of the misses so
// we can see the shape and decide whether to fix the regex or the
// importer.

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
const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const TIER_RE = /Days?\s+(\d+)\s*[–-]\s*(\d+)\s*:\s*\$\s*(\d+(?:\.\d+)?)\s*\/\s*day/gi;

interface Row {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  benefit_category: string;
  benefit_description: string | null;
  copay: number | null;
  coinsurance: number | null;
}

async function dumpMissesFor(label: string, categories: string[]) {
  console.log('='.repeat(72));
  console.log(`${label}  categories=${JSON.stringify(categories)}`);
  console.log('='.repeat(72));

  // Pull 1000 rows with descriptions, partition into match / miss.
  const { data, error } = await sb
    .from('pm_plan_benefits')
    .select(
      'contract_id, plan_id, segment_id, benefit_category, benefit_description, copay, coinsurance',
    )
    .in('benefit_category', categories)
    .not('benefit_description', 'is', null)
    .limit(1000);
  if (error || !data) {
    console.error('query failed', error);
    return;
  }

  const matches: Row[] = [];
  const misses: Row[] = [];
  for (const r of data as Row[]) {
    TIER_RE.lastIndex = 0;
    if (TIER_RE.test(r.benefit_description ?? '')) matches.push(r);
    else misses.push(r);
  }
  console.log(`\n  with-description rows fetched: ${data.length}`);
  console.log(`    regex MATCH: ${matches.length}`);
  console.log(`    regex MISS:  ${misses.length}\n`);

  // Bucket misses by description shape so we can see how many DISTINCT
  // formats are in the miss pile.
  const shapes = new Map<string, number>();
  for (const r of misses) {
    const desc = (r.benefit_description ?? '').trim();
    const shape = desc
      .replace(/\d+/g, '#')
      .replace(/\s+/g, ' ')
      .slice(0, 120);
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  }
  const shapeList = [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log('  TOP 10 MISS DESCRIPTION SHAPES (digits → #, truncated 120 chars):');
  for (const [shape, n] of shapeList) {
    console.log(`    ${String(n).padStart(4)}× ${JSON.stringify(shape)}`);
  }

  console.log('\n  10 RAW MISS ROW SAMPLES:');
  for (const r of misses.slice(0, 10)) {
    console.log(`\n    plan: ${r.contract_id}-${r.plan_id}-${r.segment_id}  category=${r.benefit_category}`);
    console.log(`      copay=${r.copay ?? '∅'}  coinsurance=${r.coinsurance ?? '∅'}`);
    console.log(`      description: ${JSON.stringify(r.benefit_description)}`);
  }

  // Also confirm null-description count for the category.
  const { count: nullCount } = await sb
    .from('pm_plan_benefits')
    .select('contract_id', { count: 'exact', head: true })
    .in('benefit_category', categories)
    .is('benefit_description', null);
  console.log(`\n  rows with NULL benefit_description: ${nullCount ?? '?'}`);
}

async function main() {
  await dumpMissesFor('INPATIENT HOSPITAL', ['inpatient', 'inpatient_acute']);
  await dumpMissesFor('SKILLED NURSING (SNF)', ['skilled_nursing', 'snf']);
  await dumpMissesFor('INPATIENT MENTAL HEALTH', ['mental_health_inpatient', 'inpatient_psych']);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
