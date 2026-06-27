// scripts/probe-h9725-015-segments.ts — diagnose H9725-015 segment
// mismatch. Read-only across pm_plans + pm_plan_benefits + the local
// CMS PBP extract.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const sb = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function main() {
  console.log('=== Supabase project:', process.env.SUPABASE_URL);

  // STEP 1 — all pm_plans rows for H9725-015
  console.log('\n========== STEP 1: pm_plans for H9725-015 ==========');
  const { data: planRows } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, county_name, county_fips, state, monthly_premium, moop')
    .eq('contract_id', 'H9725')
    .eq('plan_id', '015')
    .order('segment_id')
    .order('county_name');
  console.log(`Total rows: ${planRows?.length ?? 0}`);
  const distinctSegs = new Set<string>();
  const segByCounty: Record<string, Set<string>> = {};
  const durhamRows: typeof planRows = [];
  for (const r of planRows ?? []) {
    distinctSegs.add(r.segment_id ?? '');
    const cnty = r.county_name ?? '?';
    if (!segByCounty[cnty]) segByCounty[cnty] = new Set();
    segByCounty[cnty].add(r.segment_id ?? '');
    if (cnty === 'Durham') durhamRows.push(r);
  }
  console.log(`Distinct segment_ids: ${[...distinctSegs].sort().join(', ')}`);
  console.log(`Distinct counties: ${Object.keys(segByCounty).length}`);
  console.log('\nDurham specifically:');
  console.table(durhamRows);
  console.log('\nCounty → segments mapping (sample 20):');
  let n = 0;
  for (const [c, s] of Object.entries(segByCounty)) {
    if (n++ >= 20) break;
    console.log(`  ${c}: segments=[${[...s].sort().join(',')}]`);
  }

  // STEP 2 — pm_plan_benefits per-segment for H9725-015
  console.log('\n========== STEP 2: pm_plan_benefits segment distribution ==========');
  const { data: ben } = await sb
    .from('pm_plan_benefits')
    .select('segment_id, benefit_category')
    .eq('contract_id', 'H9725')
    .eq('plan_id', '015');
  const segCount: Record<string, number> = {};
  const segCats: Record<string, Set<string>> = {};
  for (const r of ben ?? []) {
    const s = (r.segment_id ?? '') as string;
    segCount[s] = (segCount[s] ?? 0) + 1;
    if (!segCats[s]) segCats[s] = new Set();
    segCats[s].add(r.benefit_category as string);
  }
  for (const s of Object.keys(segCount).sort()) {
    console.log(`  segment="${s}": ${segCount[s]} rows  categories=${segCats[s].size}`);
  }
  // Are the category sets identical?
  const segKeys = Object.keys(segCats).sort();
  if (segKeys.length > 1) {
    const ref = segCats[segKeys[0]];
    let allSame = true;
    for (const s of segKeys.slice(1)) {
      const set = segCats[s];
      if (ref.size !== set.size || [...ref].some((c) => !set.has(c))) {
        allSame = false;
        break;
      }
    }
    console.log(`  All segments carry same category set? ${allSame}`);
  }

  // Show 3 sample inpatient rows across segments
  console.log('\nInpatient rows across segments:');
  const { data: inpRows } = await sb
    .from('pm_plan_benefits')
    .select('segment_id, benefit_description, copay, coinsurance, coverage_amount, max_coverage')
    .eq('contract_id', 'H9725')
    .eq('plan_id', '015')
    .eq('benefit_category', 'inpatient')
    .order('segment_id');
  for (const r of inpRows ?? []) {
    console.log(`  seg=${r.segment_id}: copay=${r.copay} desc="${r.benefit_description}"`);
  }

  // STEP 3 — CMS PBP source spelunking
  console.log('\n========== STEP 3: CMS PBP source for H9725-015 ==========');
  const PBP_DIR = '/Users/robertsimm/Code/plan-match/data/pbp';
  if (!existsSync(PBP_DIR)) {
    console.log('  (no PBP dir)');
  } else {
    const files = readdirSync(PBP_DIR).filter((f) => f.endsWith('.txt'));
    // Files to inspect: anything beginning with pbp_a (plan info), pbp_b1a (inpat),
    // pbp_b1_b6 (services), and the service area / county crosswalk
    const targets = files.filter((f) =>
      /^(pbp_a_|pbp_b1a|pbp_b1_|service|sa_|county|county_crosswalk|pbp_sa|service_area)/i.test(f),
    );
    console.log('Candidate files:', targets);

    function dumpFilterMatches(path: string, label: string, hCol: string, pCol: string) {
      if (!existsSync(path)) return;
      const raw = readFileSync(path, 'utf8');
      const lines = raw.split('\n');
      if (lines.length < 2) return;
      const headers = lines[0].split('\t');
      const hIdx = headers.indexOf(hCol);
      const pIdx = headers.indexOf(pCol);
      if (hIdx < 0 || pIdx < 0) {
        console.log(`  ${label}: missing cols ${hCol}=${hIdx} ${pCol}=${pIdx}`);
        return;
      }
      const segIdx = headers.indexOf('segment_id');
      const matches: string[][] = [];
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split('\t');
        if (parts[hIdx] === 'H9725' && parts[pIdx] === '015') matches.push(parts);
      }
      console.log(`\n${label}: ${matches.length} matching rows`);
      if (matches.length > 0 && matches.length <= 30) {
        const segs = new Set(matches.map((m) => (segIdx >= 0 ? m[segIdx] : '?')));
        console.log(`  Distinct segment_ids in this file: [${[...segs].sort().join(',')}]`);
        // dump interesting non-empty columns from first row
        const firstWith: Record<string, string> = {};
        for (const m of matches) {
          const seg = segIdx >= 0 ? m[segIdx] : '?';
          if (firstWith[seg]) continue;
          firstWith[seg] = m.slice(0, 30).map((v, i) => `${headers[i]}=${v}`).join(', ');
        }
        for (const [seg, info] of Object.entries(firstWith)) {
          console.log(`  seg=${seg}: ${info.slice(0, 400)}`);
        }
      }
    }

    // Plan info / segment info
    dumpFilterMatches(join(PBP_DIR, 'pbp_a_plan_info.txt'), 'pbp_a_plan_info', 'pbp_a_hnumber', 'pbp_a_plan_identifier');
    dumpFilterMatches(join(PBP_DIR, 'pbp_b1a_inpat_hosp.txt'), 'pbp_b1a_inpat_hosp', 'pbp_a_hnumber', 'pbp_a_plan_identifier');

    // Service area files
    const saFiles = files.filter((f) => /sa|service|county/i.test(f));
    console.log('\nService-area candidate files:', saFiles);
    for (const f of saFiles) {
      const raw = readFileSync(join(PBP_DIR, f), 'utf8');
      const lines = raw.split('\n');
      if (lines.length < 2) continue;
      const headers = lines[0].split('\t');
      const hIdx = headers.indexOf('pbp_a_hnumber') >= 0 ? headers.indexOf('pbp_a_hnumber') : headers.indexOf('hnumber');
      const pIdx = headers.indexOf('pbp_a_plan_identifier') >= 0 ? headers.indexOf('pbp_a_plan_identifier') : headers.indexOf('plan_identifier');
      if (hIdx < 0 || pIdx < 0) continue;
      const segIdx = headers.indexOf('segment_id');
      const fipsIdx = headers.findIndex((h) => /ssa|fips|county_code|county/i.test(h));
      let count = 0;
      const segByFips = new Map<string, Set<string>>();
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split('\t');
        if (parts[hIdx] === 'H9725' && parts[pIdx] === '015') {
          count++;
          const seg = segIdx >= 0 ? parts[segIdx] : '?';
          const fips = fipsIdx >= 0 ? parts[fipsIdx] : '?';
          if (!segByFips.has(fips)) segByFips.set(fips, new Set());
          segByFips.get(fips)!.add(seg);
        }
      }
      if (count > 0) {
        console.log(`\n  ${f}: ${count} H9725-015 rows`);
        console.log(`    fipsCol="${fipsIdx >= 0 ? headers[fipsIdx] : 'n/a'}"`);
        let shown = 0;
        for (const [f2, segs] of segByFips.entries()) {
          if (shown++ > 20) break;
          console.log(`    fips/code=${f2}: segments=[${[...segs].sort().join(',')}]`);
        }
        // Durham NC FIPS is 37063 (or SSA equivalent 34170)
        const durham = [...segByFips.entries()].filter(([k]) => k === '37063' || k === '34170' || /durham/i.test(k));
        if (durham.length) {
          console.log(`    ** DURHAM mapped to segments: ${durham.map((d) => `${d[0]}=>[${[...d[1]].join(',')}]`).join(' | ')} **`);
        }
      }
    }
  }

  // STEP 4 — systemic check: NC Durham plans where pm_plans seg=0 but
  // pm_plan_benefits has 0 rows under seg=0.
  console.log('\n========== STEP 4: Systemic — Durham seg-0 plans with no seg-0 benefits ==========');
  const { data: durhamSeg0 } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, carrier')
    .eq('state', 'NC')
    .eq('county_name', 'Durham')
    .eq('segment_id', '0');
  const gap: Array<{contract:string; plan:string; carrier:string; planSegs:string[]; benSegs:string[]; benRows:number; name:string}> = [];
  for (const r of durhamSeg0 ?? []) {
    const { data: matching } = await sb
      .from('pm_plan_benefits')
      .select('segment_id')
      .eq('contract_id', r.contract_id)
      .eq('plan_id', r.plan_id)
      .eq('segment_id', '0');
    const matchCount = matching?.length ?? 0;
    if (matchCount === 0) {
      // Get all available benefit segments
      const { data: allBen } = await sb
        .from('pm_plan_benefits')
        .select('segment_id')
        .eq('contract_id', r.contract_id)
        .eq('plan_id', r.plan_id);
      const benSegs = [...new Set((allBen ?? []).map((x) => x.segment_id))].filter((s) => s != null).sort() as string[];
      gap.push({
        contract: r.contract_id,
        plan: r.plan_id,
        carrier: r.carrier ?? '',
        planSegs: ['0'],
        benSegs,
        benRows: allBen?.length ?? 0,
        name: r.plan_name ?? '',
      });
    }
  }
  console.log(`Durham seg=0 plans missing seg=0 benefits: ${gap.length} (of ${durhamSeg0?.length ?? 0})`);
  for (const g of gap) {
    console.log(`  ${g.contract}-${g.plan} [${g.carrier}] "${g.name.slice(0,40)}"  benefit segs=[${g.benSegs.join(',')}] totalBenefitRows=${g.benRows}`);
  }

  // Same check NC-wide (not just Durham) for scope
  console.log('\n--- NC-wide scope (plan_seg=0 with 0 seg-0 benefit rows) ---');
  const { data: ncSeg0 } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id')
    .eq('state', 'NC')
    .eq('segment_id', '0');
  const dedup = new Set<string>();
  const ncPairs = (ncSeg0 ?? []).filter((r) => {
    const k = `${r.contract_id}-${r.plan_id}`;
    if (dedup.has(k)) return false;
    dedup.add(k);
    return true;
  });
  console.log(`Distinct NC seg=0 plan-pairs: ${ncPairs.length}`);
  let gapCount = 0;
  const checked: string[] = [];
  for (const r of ncPairs) {
    const { data: m } = await sb
      .from('pm_plan_benefits')
      .select('segment_id', { count: 'exact', head: true })
      .eq('contract_id', r.contract_id)
      .eq('plan_id', r.plan_id)
      .eq('segment_id', '0');
    if ((m as unknown as { length: number })?.length === 0 ||
        ((m ?? []) as unknown as Array<unknown>).length === 0) {
      // double-check
      const { data: m2 } = await sb
        .from('pm_plan_benefits')
        .select('segment_id')
        .eq('contract_id', r.contract_id)
        .eq('plan_id', r.plan_id)
        .eq('segment_id', '0')
        .limit(1);
      if (!m2 || m2.length === 0) {
        gapCount++;
        if (checked.length < 30) checked.push(`${r.contract_id}-${r.plan_id}`);
      }
    }
  }
  console.log(`NC-wide gap count: ${gapCount}`);
  console.log(`Sample: ${checked.slice(0, 30).join(', ')}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
