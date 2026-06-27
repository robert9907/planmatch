// Probe: pm_plan_benefits.benefit_description format for inpatient
// hospital vs. SNF vs. inpatient mental. SNF renders the full day-tier
// ladder on the agent-v3 Compare screen but Inpatient + Inpatient
// Mental fall back to a flat "$X/day", suggesting their
// benefit_description doesn't carry the "Days N–M: $X/day" shape the
// formatInpatientLadder regex expects.

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
console.log(`Supabase host: ${new URL(url).host}\n`);

const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const TIER_RE = /Days?\s+(\d+)\s*[–-]\s*(\d+)\s*:\s*\$\s*(\d+(?:\.\d+)?)\s*\/\s*day/gi;

async function dumpCategory(label: string, categories: string[]) {
  console.log('='.repeat(72));
  console.log(`${label}  — benefit_category IN (${categories.map((c) => `'${c}'`).join(', ')})`);
  console.log('='.repeat(72));

  const { data, error } = await sb
    .from('pm_plan_benefits')
    .select(
      'contract_id, plan_id, segment_id, benefit_category, benefit_description, copay, coinsurance, coverage_amount',
    )
    .in('benefit_category', categories)
    .not('benefit_description', 'is', null)
    .limit(10);
  if (error) {
    console.error('query failed:', error);
    return;
  }
  if (!data || data.length === 0) {
    console.log('(no rows)');
    return;
  }

  for (const r of data) {
    const desc = r.benefit_description ?? '';
    const tierHits = [...desc.matchAll(TIER_RE)];
    const tagged = tierHits.length > 0
      ? `regex MATCH (${tierHits.length} tier${tierHits.length === 1 ? '' : 's'})`
      : 'regex MISS';
    console.log(`\n  plan: ${r.contract_id}-${r.plan_id}-${r.segment_id}  category=${r.benefit_category}`);
    console.log(`    copay=${r.copay ?? '∅'}  coinsurance=${r.coinsurance ?? '∅'}  coverage_amount=${r.coverage_amount ?? '∅'}`);
    console.log(`    description: ${JSON.stringify(desc)}`);
    console.log(`    ${tagged}`);
  }

  // Quick aggregate — how many rows of this category exist in the DB
  // and how many have a description that the regex matches.
  const { count: totalCount } = await sb
    .from('pm_plan_benefits')
    .select('contract_id', { count: 'exact', head: true })
    .in('benefit_category', categories);
  const { data: descSample } = await sb
    .from('pm_plan_benefits')
    .select('benefit_description')
    .in('benefit_category', categories)
    .not('benefit_description', 'is', null)
    .limit(1000);
  const matches = (descSample ?? []).filter((r) => {
    return TIER_RE.test(r.benefit_description ?? '');
  }).length;
  console.log(`\n  totals: ${totalCount ?? '?'} rows in category; of first 1000 with description, ${matches} match the Days N-M: $X/day regex`);
}

async function main() {
  await dumpCategory('INPATIENT HOSPITAL', ['inpatient', 'inpatient_acute']);
  await dumpCategory('SKILLED NURSING (SNF) — known working', ['skilled_nursing', 'snf']);
  await dumpCategory('INPATIENT MENTAL HEALTH', ['mental_health_inpatient', 'inpatient_psych']);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
