// Phase 2.4 audit — AgentBase geo payload + confirm 76-vs-77 gap.
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local','utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const pm = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const ab = createClient(process.env.AGENTBASE_SUPABASE_URL!, process.env.AGENTBASE_SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

async function main() {
  console.log('\n═══ 2.4c — AgentBase clients geo payload ═══');
  // Sample the geo shape of AgentBase clients
  const { data: sample, error } = await ab.from('clients')
    .select('id, first_name, last_name, zip, city, state, county')
    .limit(30);
  if (error) { console.error(error); process.exit(1); }
  console.log(`  Sampled ${sample?.length ?? 0} clients`);
  let hasCounty = 0, hasZip = 0, hasBoth = 0, hasNeither = 0, hasZipNotCounty = 0, hasCountyNotZip = 0;
  for (const c of sample ?? []) {
    const county = (c.county ?? '').trim();
    const zip = (c.zip ?? '').trim();
    if (county && zip) hasBoth += 1;
    else if (!county && !zip) hasNeither += 1;
    else if (zip && !county) hasZipNotCounty += 1;
    else if (county && !zip) hasCountyNotZip += 1;
    if (county) hasCounty += 1;
    if (zip) hasZip += 1;
  }
  console.log(`  county set: ${hasCounty}, zip set: ${hasZip}, both: ${hasBoth}, neither: ${hasNeither}`);
  console.log(`  zip-only (needs zip→county resolution): ${hasZipNotCounty}`);
  console.log(`  county-only (needs no resolution): ${hasCountyNotZip}`);

  // Teresa Partin lookup
  console.log('\n  Teresa Partin lookup:');
  const { data: teresa } = await ab.from('clients')
    .select('id, first_name, last_name, zip, city, state, county, plan, plan_id, medicare_id, status')
    .or('first_name.ilike.%Teresa%,last_name.ilike.%Partin%')
    .limit(10);
  for (const c of teresa ?? []) {
    console.log(`    ${c.id} ${c.first_name} ${c.last_name} zip=${JSON.stringify(c.zip)} county=${JSON.stringify(c.county)} state=${JSON.stringify(c.state)} status=${c.status}`);
  }

  // Distribution: how many clients would silently hit the bug?
  const { count: total } = await ab.from('clients').select('*', { count: 'exact', head: true });
  const { count: emptyCounty } = await ab.from('clients').select('*', { count: 'exact', head: true }).or('county.is.null,county.eq.');
  const { count: emptyCountyWithZip } = await ab.from('clients').select('*', { count: 'exact', head: true })
    .or('county.is.null,county.eq.')
    .not('zip', 'is', null).neq('zip', '');
  const { count: emptyBoth } = await ab.from('clients').select('*', { count: 'exact', head: true })
    .or('county.is.null,county.eq.')
    .or('zip.is.null,zip.eq.');
  console.log(`\n  Population impact:`);
  console.log(`    Total AgentBase clients:                ${total}`);
  console.log(`    With empty county (bug hits):           ${emptyCounty}`);
  console.log(`    Empty county but has zip (zip resolves): ${emptyCountyWithZip}`);
  console.log(`    Empty both (must fail loudly):          ${emptyBoth}`);

  // ═══ 2.4-verify — 76 vs 77 gap ═══
  console.log('\n═══ 76 vs 77 gap — pm_plans Wake NC vs /api/plans triples ═══');
  const { data: rawRows } = await pm.from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, snp_type, sanctioned, monthly_premium')
    .eq('state','NC').ilike('county_name','Wake');
  console.log(`  Raw pm_plans rows for Wake NC: ${rawRows?.length ?? 0}`);
  const triples = new Map<string, any[]>();
  for (const r of rawRows ?? []) {
    const k = `${r.contract_id}-${r.plan_id}-${r.segment_id ?? '0'}`;
    if (!triples.has(k)) triples.set(k, []);
    triples.get(k)!.push(r);
  }
  console.log(`  Distinct (contract, plan, segment) triples: ${triples.size}`);
  // Duplicates (same triple, multiple rows)
  const dupes = [...triples.entries()].filter(([_, arr]) => arr.length > 1);
  console.log(`  Triples with >1 row (dedupe collision): ${dupes.length}`);
  for (const [k, arr] of dupes.slice(0, 5)) console.log(`    ${k}: ${arr.length} rows — ${arr.map((r: any) => r.plan_name).join(' | ')}`);

  // Now the api/plans path with 'All Counties' union: any All Counties PDPs?
  const { data: allCounties } = await pm.from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, plan_type, snp_type, state')
    .eq('state','NC').eq('county_name','All Counties');
  console.log(`  NC "All Counties" (PDP) rows: ${allCounties?.length ?? 0}`);
  const acTriples = new Set((allCounties ?? []).map((r: any) => `${r.contract_id}-${r.plan_id}-${r.segment_id ?? '0'}`));
  console.log(`  All Counties distinct triples: ${acTriples.size}`);
  console.log(`  Wake triples + All Counties triples: ${triples.size + acTriples.size}`);
}
main().catch(e => { console.error(e); process.exit(1); });
