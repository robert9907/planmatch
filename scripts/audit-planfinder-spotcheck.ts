// scripts/audit-planfinder-spotcheck.ts
//
// Ground-truth check: hit medicare.gov /plans/search for 10 specific
// counties and diff against pm_plans. Also samples 20 of the
// "sub-100 CMS-only" plans from _tmp/audit-cms-diff.json and checks
// whether they appear on Plan Finder for one of their PBP counties.
//
// Reuses the warm + POST pattern from api/network-check.ts and
// scripts/scrape-medicare-gov.mjs.
//
// Output: _tmp/audit-planfinder.md  +  _tmp/audit-planfinder.json

import { createClient } from '@supabase/supabase-js';
import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import yauzl, { type Entry } from 'yauzl';
import { randomBytes } from 'node:crypto';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const url = process.env.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
if (!url || !key) {
  console.error('Missing env');
  process.exit(1);
}
const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const PLAN_SEARCH_URL = 'https://www.medicare.gov/api/v1/data/plan-compare/plans/search';
const WARM_URL = 'https://www.medicare.gov/plan-compare/';
const FE_VER = '2.69.0';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const YEAR = 2026;
const COUNTIES: { state: string; county: string }[] = [
  { state: 'NC', county: 'Durham' },
  { state: 'NC', county: 'Wake' },
  { state: 'NC', county: 'Buncombe' },
  { state: 'NC', county: 'Alleghany' },
  { state: 'TX', county: 'Harris' },
  { state: 'TX', county: 'Dallas' },
  { state: 'TX', county: 'Bexar' },
  { state: 'GA', county: 'Fulton' },
  { state: 'GA', county: 'DeKalb' },
  { state: 'GA', county: 'Gwinnett' },
];
const PLAN_TYPES = ['PLAN_TYPE_MAPD', 'PLAN_TYPE_MA'] as const;
const STATE_FIPS_TO_USPS: Record<string, string> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO',
  '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI',
  '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY',
  '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN',
  '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH',
  '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA',
  '54': 'WV', '55': 'WI', '56': 'WY',
};
const USPS_TO_STATE_FIPS: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_FIPS_TO_USPS).map(([fips, usps]) => [usps, fips]),
);

function stripCountySuffix(name: string): string {
  return name.replace(/\s+(county|parish|borough|census area|municipality)\s*$/i, '').trim();
}

function randomHex(n: number): string {
  return randomBytes(n / 2).toString('hex');
}

interface PlanFinderPlan {
  contract_id: string;
  plan_id: string;
  segment_id?: string;
  plan_name?: string;
  carrier?: string;
}

function extractPlansFromApi(body: unknown): PlanFinderPlan[] {
  // Walk a /plans/search response and emit a flat plan list. Real
  // responses key on "plans" or "results"; some builds nest under
  // data. Tolerant — log shape if neither matches.
  let arr: unknown[] = [];
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (Array.isArray(b.plans)) arr = b.plans;
    else if (Array.isArray(b.results)) arr = b.results;
    else if (b.data && typeof b.data === 'object') {
      const d = b.data as Record<string, unknown>;
      if (Array.isArray(d.plans)) arr = d.plans;
      else if (Array.isArray(d.results)) arr = d.results;
    } else if (Array.isArray(body)) {
      arr = body as unknown[];
    }
  }
  const out: PlanFinderPlan[] = [];
  for (const p of arr) {
    if (!p || typeof p !== 'object') continue;
    const r = p as Record<string, unknown>;
    // Field names vary by SPA build — try multiple shapes
    const contract =
      str(r.contract_id) ??
      str(r.contractId) ??
      str(r.hnumber) ??
      str(r.h_number) ??
      str(r.pbp_a_hnumber);
    const planId =
      str(r.plan_id) ??
      str(r.planId) ??
      str(r.plan_identifier) ??
      str(r.pbp_a_plan_identifier);
    const segment =
      str(r.segment_id) ??
      str(r.segmentId) ??
      str(r.segment);
    const name = str(r.plan_name) ?? str(r.planName) ?? str(r.name);
    const carrier =
      str(r.organization_name) ??
      str(r.organizationName) ??
      str(r.carrier) ??
      str(r.parent_organization_name);
    if (!contract || !planId) continue;
    out.push({
      contract_id: contract,
      plan_id: planId,
      segment_id: segment ?? undefined,
      plan_name: name ?? undefined,
      carrier: carrier ?? undefined,
    });
  }
  return out;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  return null;
}

async function warmCtx(): Promise<{ ctx: BrowserContext; page: Page; close: () => Promise<void> }> {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(WARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(6_000);
  return {
    ctx,
    page,
    close: async () => {
      await ctx.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

async function searchPlansOnePage(
  page: Page,
  args: { zip: string; fips: string; planType: string; pageNum: number },
): Promise<{ ok: boolean; plans: PlanFinderPlan[]; total: number; status: number; sample?: string }> {
  const qs = new URLSearchParams({
    zip: args.zip,
    fips: args.fips,
    plan_type: args.planType,
    year: String(YEAR),
    lang: 'en',
    page: String(args.pageNum),
  });
  const url = `${PLAN_SEARCH_URL}?${qs.toString()}`;
  const reqBody = {
    npis: [],
    prescriptions: [],
    lis: 'LIS_NO_HELP',
    starRatings: [],
    organizationNames: [],
  };
  const traceId = randomHex(32);
  const spanId = randomHex(16);
  const resp = await page.request.post(url, {
    data: reqBody,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: 'https://www.medicare.gov',
      Referer: 'https://www.medicare.gov/plan-compare/',
      'fe-ver': FE_VER,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      traceparent: `00-${traceId}-${spanId}-01`,
    },
    timeout: 60_000,
  });
  const status = resp.status();
  if (!resp.ok()) {
    const sample = (await resp.text()).slice(0, 600);
    return { ok: false, plans: [], total: 0, status, sample };
  }
  const body = (await resp.json()) as Record<string, unknown>;
  const plans = extractPlansFromApi(body);
  const total = typeof body.total_results === 'number' ? body.total_results : plans.length;
  return { ok: true, plans, total, status };
}

async function searchPlansAllPages(
  page: Page,
  args: { zip: string; fips: string; planType: string },
): Promise<PlanFinderPlan[]> {
  const all = new Map<string, PlanFinderPlan>();
  let total = 0;
  for (let pn = 1; pn <= 30; pn += 1) {
    const r = await searchPlansOnePage(page, { ...args, pageNum: pn });
    if (!r.ok) {
      console.warn(`[search] ${args.planType} fips=${args.fips} p${pn} → ${r.status}: ${r.sample?.slice(0, 200)}`);
      break;
    }
    total = r.total;
    for (const p of r.plans) {
      const k = `${p.contract_id}-${p.plan_id}`;
      if (!all.has(k)) all.set(k, p);
    }
    if (all.size >= total) break;
    if (r.plans.length < 10) break;
  }
  console.log(`[search] ${args.planType} fips=${args.fips}: ${all.size}/${total} plans across pages`);
  return [...all.values()];
}

async function searchCounty(page: Page, args: { zip: string; fips: string }): Promise<PlanFinderPlan[]> {
  const merged = new Map<string, PlanFinderPlan>();
  for (const pt of PLAN_TYPES) {
    try {
      const plans = await searchPlansAllPages(page, { ...args, planType: pt });
      for (const p of plans) {
        const k = `${p.contract_id}-${p.plan_id}`;
        if (!merged.has(k)) merged.set(k, p);
      }
    } catch (err) {
      console.warn('[search] threw:', (err as Error).message);
    }
  }
  if (merged.size === 0) {
    console.warn(`[search] WARNING: 0 plans for fips=${args.fips}`);
  }
  return [...merged.values()];
}

// ─── DB lookups ─────────────────────────────────────────────────────
async function resolveCountyMeta(): Promise<{ state: string; county: string; fips: string; zip: string }[]> {
  // Pull all matching fips rows, then pick a representative zip per fips.
  const out: { state: string; county: string; fips: string; zip: string }[] = [];
  for (const c of COUNTIES) {
    const { data: f, error: e1 } = await sb
      .from('pm_county_fips')
      .select('fips, county_name')
      .eq('state', c.state)
      .ilike('county_name', `${c.county}%`)
      .limit(5);
    if (e1) throw e1;
    if (!f || f.length === 0) {
      console.warn(`[fips] no row for ${c.state}/${c.county}`);
      continue;
    }
    // pick exact match if possible
    const exact = f.find((r) => r.county_name.toLowerCase() === c.county.toLowerCase());
    const pick = exact ?? f[0];
    const bare = stripCountySuffix(pick.county_name);
    const { data: zRows, error: e2 } = await sb
      .from('pm_zip_county')
      .select('zip')
      .eq('state', c.state)
      .ilike('county', bare)
      .limit(1);
    if (e2) throw e2;
    let zip = zRows?.[0]?.zip;
    if (!zip) {
      // fall back to prefix ilike
      const { data: z2 } = await sb
        .from('pm_zip_county')
        .select('zip,county')
        .eq('state', c.state)
        .ilike('county', `${bare}%`)
        .limit(5);
      zip = z2?.[0]?.zip;
    }
    if (!zip) {
      console.warn(`[zip] no zip for ${c.state}/${pick.county_name} (bare=${bare})`);
      continue;
    }
    out.push({ state: c.state, county: pick.county_name, fips: pick.fips, zip });
  }
  return out;
}

async function dbPlansForCounty(state: string, county: string): Promise<Map<string, { name: string; carrier: string; type: string }>> {
  const bare = stripCountySuffix(county);
  const { data, error } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, plan_name, carrier, plan_type')
    .eq('state', state)
    .or(`county_name.ilike.${bare},county_name.ilike.${bare} County,county_name.ilike.${bare} %`)
    .range(0, 999);
  if (error) throw error;
  const m = new Map<string, { name: string; carrier: string; type: string }>();
  for (const r of data ?? []) {
    const k = `${r.contract_id}-${r.plan_id}`;
    if (!m.has(k)) m.set(k, { name: r.plan_name ?? '', carrier: r.carrier ?? '', type: r.plan_type ?? '' });
  }
  return m;
}

// ─── Sub-100 plan → PBP county name list (we'll resolve FIPS later) ─
async function buildPbpPlanToCountyMap(
  zipPath: string,
  wanted: { hnumber: string; planId: string; state: string }[],
): Promise<Map<string, { state: string; county: string }[]>> {
  const want = new Set(wanted.map((w) => `${w.hnumber}|${w.planId}|${w.state}`));
  const out = new Map<string, { state: string; county: string }[]>();
  await new Promise<void>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('entry', (e: Entry) => {
        if (e.fileName.toLowerCase() !== 'planarea.txt') {
          zip.readEntry();
          return;
        }
        zip.openReadStream(e, (err2, stream) => {
          if (err2) return reject(err2);
          const rl = createInterface({ input: stream, crlfDelay: Infinity });
          let header: string[] = [];
          let i = 0;
          rl.on('line', (line) => {
            if (i === 0) {
              header = line.split('\t').map((h) => h.trim().toLowerCase());
              i++;
              return;
            }
            const cells = line.split('\t');
            const row: Record<string, string> = {};
            for (let j = 0; j < header.length; j += 1) row[header[j]] = (cells[j] ?? '').trim();
            const h = row['pbp_a_hnumber'];
            const pid = row['pbp_a_plan_identifier'];
            const stRaw = row['stcd'];
            const st = STATE_FIPS_TO_USPS[stRaw] ?? stRaw.toUpperCase();
            const ck = `${h}|${pid}|${st}`;
            if (!want.has(ck)) {
              i++;
              return;
            }
            const county = row['county'] ?? '';
            if (!county) {
              i++;
              return;
            }
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

// ─── Main ──────────────────────────────────────────────────────────
async function main() {
  mkdirSync('_tmp', { recursive: true });

  const counties = await resolveCountyMeta();
  console.log(`[main] resolved ${counties.length} counties`);
  for (const c of counties) {
    console.log(`  ${c.state} ${c.county} → fips=${c.fips} zip=${c.zip}`);
  }

  const { page, close } = await warmCtx();
  const report: string[] = [];
  const data: Record<string, unknown> = { counties: [], samples: [] };

  report.push('# Plan Finder ground-truth spot-check');
  report.push(`Generated ${new Date().toISOString()}`);
  report.push('');
  report.push('## County diff (Plan Finder vs DB)');
  report.push('');
  report.push('| state | county | fips | zip | pf_plans | db_plans | pf_only | db_only |');
  report.push('| --- | --- | --- | --- | --- | --- | --- | --- |');

  const countyDetail: {
    state: string; county: string; fips: string; zip: string;
    pfOnly: { key: string; name: string; carrier: string }[];
    dbOnly: { key: string; name: string; carrier: string; type: string }[];
  }[] = [];

  for (const c of counties) {
    console.log(`\n[county] ${c.state} ${c.county} fips=${c.fips} zip=${c.zip}`);
    const pfPlans = await searchCounty(page, { zip: c.zip, fips: c.fips });
    const pfMap = new Map<string, PlanFinderPlan>();
    for (const p of pfPlans) pfMap.set(`${p.contract_id}-${p.plan_id}`, p);
    const dbMap = await dbPlansForCounty(c.state, c.county);
    const pfOnly = [...pfMap.keys()].filter((k) => !dbMap.has(k));
    const dbOnly = [...dbMap.keys()].filter((k) => !pfMap.has(k));
    report.push(
      `| ${c.state} | ${c.county} | ${c.fips} | ${c.zip} | ${pfMap.size} | ${dbMap.size} | ${pfOnly.length} | ${dbOnly.length} |`,
    );
    countyDetail.push({
      state: c.state,
      county: c.county,
      fips: c.fips,
      zip: c.zip,
      pfOnly: pfOnly.map((k) => ({
        key: k,
        name: pfMap.get(k)?.plan_name ?? '',
        carrier: pfMap.get(k)?.carrier ?? '',
      })),
      dbOnly: dbOnly.map((k) => ({
        key: k,
        name: dbMap.get(k)?.name ?? '',
        carrier: dbMap.get(k)?.carrier ?? '',
        type: dbMap.get(k)?.type ?? '',
      })),
    });
  }
  data.counties = countyDetail;

  for (const c of countyDetail) {
    report.push('');
    report.push(`### ${c.state} ${c.county} (fips ${c.fips})`);
    report.push('');
    report.push(`#### Plan Finder only (DB missing) — ${c.pfOnly.length}`);
    if (c.pfOnly.length === 0) report.push('_none_');
    else {
      report.push('| contract-plan | plan_name | carrier |');
      report.push('| --- | --- | --- |');
      for (const r of c.pfOnly.slice(0, 50)) {
        report.push(`| ${r.key} | ${r.name.replace(/\|/g, '\\|')} | ${r.carrier} |`);
      }
      if (c.pfOnly.length > 50) report.push(`\n_+${c.pfOnly.length - 50} more_`);
    }
    report.push('');
    report.push(`#### DB only (Plan Finder does not show) — ${c.dbOnly.length}`);
    if (c.dbOnly.length === 0) report.push('_none_');
    else {
      report.push('| contract-plan | plan_name | carrier | type |');
      report.push('| --- | --- | --- | --- |');
      for (const r of c.dbOnly.slice(0, 50)) {
        report.push(`| ${r.key} | ${r.name.replace(/\|/g, '\\|')} | ${r.carrier} | ${r.type} |`);
      }
      if (c.dbOnly.length > 50) report.push(`\n_+${c.dbOnly.length - 50} more_`);
    }
  }

  // ─── Sub-100 verification ─────────────────────────────────────────
  report.push('');
  report.push('## Sub-100 CMS-only verification (20 random plans)');
  const diff = JSON.parse(readFileSync('_tmp/audit-cms-diff.json', 'utf8')) as {
    maCmsOnlyDetail: { state: string; key: string }[];
  };
  const subHundred = diff.maCmsOnlyDetail.filter((r) => {
    const pid = parseInt(r.key.split('-')[1].replace(/^0+/, '') || '0', 10);
    return pid < 100;
  });
  console.log(`\n[sub100] ${subHundred.length} sub-100 candidates; sampling 20`);

  // Seeded sample for reproducibility
  const seed = 42;
  const sample: typeof subHundred = [];
  const used = new Set<number>();
  let r = seed;
  while (sample.length < 20 && used.size < subHundred.length) {
    r = (r * 9301 + 49297) % 233280;
    const idx = Math.floor((r / 233280) * subHundred.length);
    if (used.has(idx)) continue;
    used.add(idx);
    sample.push(subHundred[idx]);
  }
  console.log(`[sub100] sampled ${sample.length} plans`);

  // Build wanted set for PBP county lookup
  const wanted = sample.map((s) => {
    const [h, p] = s.key.split('-');
    return { hnumber: h, planId: p, state: s.state };
  });
  const cached = process.env.PBP_CACHED_ZIP;
  if (!cached || !existsSync(cached)) {
    console.error('PBP_CACHED_ZIP not set or missing');
    process.exit(1);
  }
  const pbpCounties = await buildPbpPlanToCountyMap(cached, wanted);

  report.push('');
  report.push('| # | state | contract-plan | tested_fips | tested_zip | found_on_planfinder |');
  report.push('| --- | --- | --- | --- | --- | --- |');

  // Cache per-fips plan search to avoid duplicate work
  const searchCache = new Map<string, Set<string>>();
  let foundOnPf = 0;
  let testedSamples = 0;
  const sampleDetail: { state: string; key: string; fips: string; zip: string; found: boolean }[] = [];

  for (let i = 0; i < sample.length; i++) {
    const s = sample[i];
    const ck = `${s.key.split('-')[0]}|${s.key.split('-')[1]}|${s.state}`;
    const counties = pbpCounties.get(ck);
    if (!counties || counties.length === 0) {
      report.push(`| ${i + 1} | ${s.state} | ${s.key} | _no PBP counties_ | - | - |`);
      sampleDetail.push({ state: s.state, key: s.key, fips: '', zip: '', found: false });
      continue;
    }
    // Pick one PBP county and resolve to FIPS via pm_county_fips.
    let fips = '';
    let zip = '';
    for (const pc of counties.slice(0, 3)) {
      const bare = stripCountySuffix(pc.county);
      const { data: cf } = await sb
        .from('pm_county_fips')
        .select('fips, county_name')
        .eq('state', pc.state)
        .or(`county_name.ilike.${bare},county_name.ilike.${bare} County,county_name.ilike.${bare} %`)
        .limit(1);
      if (cf?.[0]?.fips) {
        fips = cf[0].fips;
        const { data: z } = await sb
          .from('pm_zip_county')
          .select('zip')
          .eq('state', pc.state)
          .ilike('county', bare)
          .limit(1);
        zip = z?.[0]?.zip ?? '';
        break;
      }
    }
    if (!fips) {
      report.push(`| ${i + 1} | ${s.state} | ${s.key} | _fips not resolved_ | - | - |`);
      sampleDetail.push({ state: s.state, key: s.key, fips: '', zip: '', found: false });
      continue;
    }
    if (!zip) {
      const { data: zAny } = await sb.from('pm_zip_county').select('zip').eq('state', s.state).limit(1);
      zip = zAny?.[0]?.zip ?? '00000';
    }

    let pfSet: Set<string>;
    if (searchCache.has(fips)) {
      pfSet = searchCache.get(fips)!;
    } else {
      const plans = await searchCounty(page, { zip, fips });
      pfSet = new Set(plans.map((p) => `${p.contract_id}-${p.plan_id}`));
      searchCache.set(fips, pfSet);
    }
    const found = pfSet.has(s.key);
    if (found) foundOnPf += 1;
    testedSamples += 1;
    report.push(`| ${i + 1} | ${s.state} | ${s.key} | ${fips} | ${zip} | ${found ? '✓ FOUND' : '✗ ghost'} |`);
    sampleDetail.push({ state: s.state, key: s.key, fips, zip, found });
  }
  report.push('');
  report.push(`**Verdict: ${foundOnPf} of ${testedSamples} tested sub-100 CMS-only plans actually appear on Medicare.gov Plan Finder.**`);
  data.samples = sampleDetail;
  data.sampleStats = { tested: testedSamples, foundOnPf };

  await close();

  writeFileSync('_tmp/audit-planfinder.md', report.join('\n') + '\n');
  writeFileSync('_tmp/audit-planfinder.json', JSON.stringify(data, null, 2));
  console.log('\nWrote _tmp/audit-planfinder.md + _tmp/audit-planfinder.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
