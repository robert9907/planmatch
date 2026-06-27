// scripts/audit-scrape-target-gap.ts
//
// Confirm the root-cause hypothesis for the 113-plan commissionable
// gap: the --state target builder in scripts/scrape-medicare-gov.mjs
// derives its (zip, fips) target list from pm_plans (counties that
// already have plans), so any FIPS missing from pm_plans is silently
// skipped. The 113 missed plans should mostly serve those FIPS.
//
// Output:
//   _tmp/scrape-target-gap.md       — per-state missing-fips + 113-plan correlation
//   _tmp/scrape-target-gap.json     — structured
//   _tmp/scrape-targets-missing.txt — zip/fips lines for a retry run

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import yauzl, { type Entry } from 'yauzl';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const url = process.env.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
if (!url || !key) { console.error('Missing env'); process.exit(1); }
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const STATES = ['NC', 'TX', 'GA'] as const;
const STATE_FIPS_TO_USPS: Record<string, string> = {
  '01': 'AL', '13': 'GA', '37': 'NC', '48': 'TX',
};
function stripCountySuffix(name: string): string {
  return name.replace(/\s+(county|parish|borough|census area|municipality)\s*$/i, '').trim();
}
function normalizeCountyName(name: string): string {
  return stripCountySuffix(name).toLowerCase().trim();
}

async function paginate<T>(table: string, select: string, eq: [string, string][]): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let p = 0; p < 200; p += 1) {
    let q = sb.from(table).select(select).range(p * PAGE, p * PAGE + PAGE - 1);
    for (const [k, v] of eq) q = q.eq(k, v);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...(data as T[]));
    if (data.length < PAGE) break;
  }
  return out;
}

async function buildPbpPlanCounties(
  zipPath: string,
  wanted: { hnumber: string; planId: string; state: string }[],
): Promise<Map<string, { state: string; county: string }[]>> {
  const want = new Set(wanted.map((w) => `${w.hnumber}|${w.planId}|${w.state}`));
  const out = new Map<string, { state: string; county: string }[]>();
  await new Promise<void>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('entry', (e: Entry) => {
        if (e.fileName.toLowerCase() !== 'planarea.txt') { zip.readEntry(); return; }
        zip.openReadStream(e, (err2, stream) => {
          if (err2) return reject(err2);
          const rl = createInterface({ input: stream, crlfDelay: Infinity });
          let header: string[] = [];
          let i = 0;
          rl.on('line', (line) => {
            if (i === 0) { header = line.split('\t').map((h) => h.trim().toLowerCase()); i++; return; }
            const cells = line.split('\t');
            const row: Record<string, string> = {};
            for (let j = 0; j < header.length; j += 1) row[header[j]] = (cells[j] ?? '').trim();
            const h = row['pbp_a_hnumber']; const pid = row['pbp_a_plan_identifier'];
            const stRaw = row['stcd']; const st = STATE_FIPS_TO_USPS[stRaw] ?? stRaw.toUpperCase();
            const ck = `${h}|${pid}|${st}`;
            if (!want.has(ck)) { i++; return; }
            const county = row['county'] ?? '';
            if (!county) { i++; return; }
            if (!out.has(ck)) out.set(ck, []);
            const arr = out.get(ck)!;
            if (!arr.find((x) => x.county === county)) arr.push({ state: st, county });
            i++;
          });
          rl.on('close', () => resolve());
          rl.on('error', reject);
        });
      });
      zip.on('end', () => resolve());
      zip.on('error', reject);
      zip.readEntry();
    });
  });
  return out;
}

async function main() {
  mkdirSync('_tmp', { recursive: true });
  const md: string[] = [];
  const data: Record<string, unknown> = {};
  md.push('# Scrape-target gap — root cause confirmation');
  md.push('');
  md.push(`Generated: ${new Date().toISOString()}`);
  md.push('');

  // Step 1: per state, what does the scrape target?  resolveTargets()
  // collects DISTINCT (county_name, county_fips) from pm_plans, then
  // picks the first matching zip from pm_zip_county. Mimic that.
  const perStateScrapeFips: Record<string, Set<string>> = {};
  const perStateAllFips: Record<string, Set<string>> = {};
  const perStateAllFipsToName: Record<string, Map<string, string>> = {};

  for (const st of STATES) {
    const plans = await paginate<{ county_fips: string | null; county_name: string | null }>(
      'pm_plans',
      'county_fips, county_name',
      [['state', st]],
    );
    const scraped = new Set<string>();
    for (const p of plans) if (p.county_fips) scraped.add(p.county_fips);
    perStateScrapeFips[st] = scraped;

    const all = await paginate<{ fips: string; county_name: string }>(
      'pm_county_fips',
      'fips, county_name',
      [['state', st]],
    );
    const allSet = new Set<string>();
    const m = new Map<string, string>();
    for (const r of all) { allSet.add(r.fips); m.set(r.fips, r.county_name); }
    perStateAllFips[st] = allSet;
    perStateAllFipsToName[st] = m;
  }

  md.push('## Per-state target coverage');
  md.push('');
  md.push('| state | counties in pm_county_fips | counties scraped (in pm_plans) | counties MISSING from scrape |');
  md.push('| --- | --- | --- | --- |');
  const missingByState: Record<string, { fips: string; county_name: string }[]> = {};
  for (const st of STATES) {
    const all = perStateAllFips[st];
    const scraped = perStateScrapeFips[st];
    const missing = [...all].filter((f) => !scraped.has(f));
    const named = missing.map((f) => ({ fips: f, county_name: perStateAllFipsToName[st].get(f) ?? '?' }));
    missingByState[st] = named;
    md.push(`| ${st} | ${all.size} | ${scraped.size} | **${missing.length}** |`);
  }
  data.missingByState = missingByState;

  md.push('');
  for (const st of STATES) {
    md.push(`### ${st} — ${missingByState[st].length} counties never scraped`);
    md.push('');
    if (missingByState[st].length === 0) { md.push('_none_'); md.push(''); continue; }
    md.push('| fips | county |');
    md.push('| --- | --- |');
    for (const m of missingByState[st].slice(0, 200)) md.push(`| ${m.fips} | ${m.county_name} |`);
    if (missingByState[st].length > 200) md.push(`\n_+${missingByState[st].length - 200} more_`);
    md.push('');
  }

  // Step 2: load 113 commissionable plans, look up their PBP counties,
  // map to FIPS, and bucket each plan by whether ALL/SOME/NONE of its
  // counties are in the missing-from-scrape set.
  const full = JSON.parse(readFileSync('_tmp/audit-sub100-full.json', 'utf8')) as {
    results: Array<{
      state: string; contract_id: string; plan_id: string; key: string;
      status: string; commissionable?: boolean;
    }>;
  };
  const commPlans = full.results.filter((r) => r.status === 'REAL' && r.commissionable);
  md.push(`## Correlation: do the ${commPlans.length} commissionable gap plans serve the missing counties?`);
  md.push('');

  const cachedZip = process.env.PBP_CACHED_ZIP || '/var/folders/nc/9vdhl2g97sv80lls6pxvv_sm0000gn/T/cms-pbp-1782401823800-pbp-benefits-2026.zip';
  const wanted = commPlans.map((p) => ({ hnumber: p.contract_id, planId: p.plan_id, state: p.state }));
  console.log('[main] scanning PBP for 113-plan counties…');
  const pbpCounties = await buildPbpPlanCounties(cachedZip, wanted);

  // For each plan, resolve its PBP counties → FIPS via pm_county_fips
  const planCoverage: { plan: typeof commPlans[number]; counties: string[]; missingHit: number; scrapedHit: number; unknown: number }[] = [];
  for (const p of commPlans) {
    const ck = `${p.contract_id}|${p.plan_id}|${p.state}`;
    const counties = pbpCounties.get(ck) ?? [];
    const fipsList: string[] = [];
    let missingHit = 0, scrapedHit = 0, unknown = 0;
    for (const c of counties) {
      const bare = stripCountySuffix(c.county).toLowerCase();
      // Look up in pm_county_fips for the plan's state
      let resolvedFips = '';
      for (const [f, name] of perStateAllFipsToName[p.state]) {
        if (normalizeCountyName(name) === bare) { resolvedFips = f; break; }
      }
      if (!resolvedFips) { unknown += 1; continue; }
      fipsList.push(resolvedFips);
      if (perStateScrapeFips[p.state].has(resolvedFips)) scrapedHit += 1;
      else missingHit += 1;
    }
    planCoverage.push({ plan: p, counties: fipsList, missingHit, scrapedHit, unknown });
  }

  let allInMissing = 0;       // every county missing — perfect root-cause confirmation
  let someInMissing = 0;      // at least one missing
  let noneInMissing = 0;      // all scraped (some other cause)
  let noCounties = 0;         // PBP didn't return counties or none resolved
  for (const c of planCoverage) {
    if (c.counties.length === 0) noCounties += 1;
    else if (c.missingHit === c.counties.length) allInMissing += 1;
    else if (c.missingHit > 0) someInMissing += 1;
    else noneInMissing += 1;
  }
  md.push('| bucket | plans | meaning |');
  md.push('| --- | --- | --- |');
  md.push(`| ALL counties missing from scrape | **${allInMissing}** | Plan only serves never-scraped counties → root cause confirmed for these |`);
  md.push(`| SOME counties missing | ${someInMissing} | Plan serves both scraped and unscraped counties — should have shown up via the scraped side, didn't → another cause |`);
  md.push(`| NONE missing (all counties scraped) | ${noneInMissing} | All counties WERE in the scrape target — different root cause (carrier filter, pagination cap, etc.) |`);
  md.push(`| Unresolved (no PBP county or name match) | ${noCounties} | Couldn't classify |`);
  data.coverageBuckets = { allInMissing, someInMissing, noneInMissing, noCounties };
  md.push('');

  md.push('### Per-state breakdown');
  md.push('');
  md.push('| state | comm plans | ALL missing | SOME missing | NONE missing | unresolved |');
  md.push('| --- | --- | --- | --- | --- | --- |');
  for (const st of STATES) {
    const pool = planCoverage.filter((c) => c.plan.state === st);
    let a = 0, s = 0, n = 0, u = 0;
    for (const c of pool) {
      if (c.counties.length === 0) u += 1;
      else if (c.missingHit === c.counties.length) a += 1;
      else if (c.missingHit > 0) s += 1;
      else n += 1;
    }
    md.push(`| ${st} | ${pool.length} | ${a} | ${s} | ${n} | ${u} |`);
  }
  md.push('');

  // Step 3: build the targets file with missing FIPS + a representative zip
  const targetLines: string[] = [];
  targetLines.push('# Scrape targets for counties currently missing from --state mode in scripts/scrape-medicare-gov.mjs.');
  targetLines.push('# Generated by scripts/audit-scrape-target-gap.ts.');
  targetLines.push('# Format: zip/fips (one per line), # comments allowed.');
  targetLines.push('');
  for (const st of STATES) {
    targetLines.push(`# === ${st} (${missingByState[st].length} missing counties) ===`);
    for (const m of missingByState[st]) {
      const bare = stripCountySuffix(m.county_name).toLowerCase();
      const { data: z } = await sb
        .from('pm_zip_county')
        .select('zip')
        .eq('state', st)
        .ilike('county', bare)
        .limit(1);
      const zip = z?.[0]?.zip ?? '00000';
      targetLines.push(`${zip}/${m.fips}  # ${st} ${m.county_name}`);
    }
    targetLines.push('');
  }
  writeFileSync('_tmp/scrape-targets-missing.txt', targetLines.join('\n') + '\n');
  md.push('## Targets file for retry scrape');
  md.push('');
  md.push('Written to `_tmp/scrape-targets-missing.txt`. Run:');
  md.push('');
  md.push('```');
  md.push('npx tsx scripts/scrape-medicare-gov.mjs --targetsFile=_tmp/scrape-targets-missing.txt --dry-run --verbose');
  md.push('```');
  md.push('');

  writeFileSync('_tmp/scrape-target-gap.md', md.join('\n') + '\n');
  writeFileSync('_tmp/scrape-target-gap.json', JSON.stringify(data, null, 2));
  console.log('[done] wrote _tmp/scrape-target-gap.{md,json} + _tmp/scrape-targets-missing.txt');
  console.log('[done] missing counties:', Object.fromEntries(STATES.map((s) => [s, missingByState[s].length])));
  console.log('[done] coverage buckets:', { allInMissing, someInMissing, noneInMissing, noCounties });
}

main().catch((err) => { console.error(err); process.exit(1); });
