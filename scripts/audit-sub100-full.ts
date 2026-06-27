// scripts/audit-sub100-full.ts
//
// Classify every one of the 451 sub-100 PBP-only plans from
// _tmp/audit-cms-diff.json (maCmsOnlyDetail with plan_id < 100) as
// REAL (visible on Medicare.gov Plan Finder) / GHOST (not visible) /
// UNRESOLVED. For REAL plans pull full Plan Finder details and split
// by commissionability via pm_non_commissionable_contracts.
//
// Output:  _tmp/audit-sub100-full.{md,json}
//
// Per-FIPS Plan Finder responses are cached so e.g. 30 plans that all
// share Harris County only fire one search round.

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
import { chromium, type Page } from 'playwright-core';
import { getNonCommissionableSets } from '../api/_lib/non-commissionable.js';

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

const PLAN_SEARCH_URL = 'https://www.medicare.gov/api/v1/data/plan-compare/plans/search';
const WARM_URL = 'https://www.medicare.gov/plan-compare/';
const FE_VER = '2.69.0';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const YEAR = 2026;
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
function stripCountySuffix(name: string): string {
  return name.replace(/\s+(county|parish|borough|census area|municipality)\s*$/i, '').trim();
}
function randomHex(n: number): string { return randomBytes(n / 2).toString('hex'); }
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  return null;
}

interface PfPlan {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_name: string;
  carrier: string;
  plan_type: string;
  premium: string;
  star_rating: string;
  raw: Record<string, unknown>;
}

function extractPlanFields(p: unknown): PfPlan | null {
  if (!p || typeof p !== 'object') return null;
  const r = p as Record<string, unknown>;
  const contract = str(r.contract_id) ?? str(r.contractId) ?? str(r.hnumber);
  const planId = str(r.plan_id) ?? str(r.planId);
  if (!contract || !planId) return null;
  return {
    contract_id: contract,
    plan_id: planId,
    segment_id: str(r.segment_id) ?? str(r.segmentId) ?? '0',
    plan_name: str(r.name) ?? str(r.plan_name) ?? '',
    carrier: str(r.organization_name) ?? str(r.carrier) ?? '',
    plan_type: str(r.plan_type) ?? str(r.category) ?? '',
    premium: str(r.calculated_monthly_premium) ?? str(r.partc_premium) ?? '',
    star_rating: str(r.overall_star_rating) ?? str(r.star_rating) ?? '',
    raw: r,
  };
}

async function searchOnePage(
  page: Page,
  args: { zip: string; fips: string; planType: string; pageNum: number },
): Promise<{ ok: boolean; plans: PfPlan[]; total: number; status: number; sample?: string }> {
  const qs = new URLSearchParams({
    zip: args.zip, fips: args.fips, plan_type: args.planType,
    year: String(YEAR), lang: 'en', page: String(args.pageNum),
  });
  const url = `${PLAN_SEARCH_URL}?${qs.toString()}`;
  const reqBody = { npis: [], prescriptions: [], lis: 'LIS_NO_HELP', starRatings: [], organizationNames: [] };
  const resp = await page.request.post(url, {
    data: reqBody,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: 'https://www.medicare.gov',
      Referer: 'https://www.medicare.gov/plan-compare/',
      'fe-ver': FE_VER,
      traceparent: `00-${randomHex(32)}-${randomHex(16)}-01`,
    },
    timeout: 60_000,
  });
  const status = resp.status();
  if (!resp.ok()) {
    const sample = (await resp.text()).slice(0, 300);
    return { ok: false, plans: [], total: 0, status, sample };
  }
  const body = (await resp.json()) as Record<string, unknown>;
  const arr = Array.isArray(body.plans) ? (body.plans as unknown[]) : [];
  const plans = arr.map(extractPlanFields).filter((p): p is PfPlan => !!p);
  const total = typeof body.total_results === 'number' ? body.total_results : plans.length;
  return { ok: true, plans, total, status };
}

async function searchAllPages(page: Page, args: { zip: string; fips: string }): Promise<Map<string, PfPlan>> {
  const out = new Map<string, PfPlan>();
  for (const pt of PLAN_TYPES) {
    let totalSeen = 0;
    let lastTotal = 0;
    for (let pn = 1; pn <= 30; pn += 1) {
      const r = await searchOnePage(page, { ...args, planType: pt, pageNum: pn });
      if (!r.ok) {
        // 400 page-out-of-bounds for plan types with 0 results — silent skip
        break;
      }
      lastTotal = r.total;
      for (const p of r.plans) {
        const k = `${p.contract_id}-${p.plan_id}`;
        if (!out.has(k)) out.set(k, p);
      }
      totalSeen += r.plans.length;
      if (totalSeen >= r.total) break;
      if (r.plans.length < 10) break;
    }
    void lastTotal;
  }
  return out;
}

// ─── PBP county lookup ──────────────────────────────────────────────
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
            const h = row['pbp_a_hnumber'];
            const pid = row['pbp_a_plan_identifier'];
            const stRaw = row['stcd'];
            const st = STATE_FIPS_TO_USPS[stRaw] ?? stRaw.toUpperCase();
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

// ─── Resolve county name → FIPS + zip ───────────────────────────────
const fipsCache = new Map<string, { fips: string; zip: string }>(); // state|countyName → resolved
async function resolveFipsZip(state: string, county: string): Promise<{ fips: string; zip: string } | null> {
  const ck = `${state}|${county}`;
  if (fipsCache.has(ck)) return fipsCache.get(ck)!;
  const bare = stripCountySuffix(county);
  // Try exact and "<bare> County" variants
  const { data: cf } = await sb
    .from('pm_county_fips')
    .select('fips, county_name')
    .eq('state', state)
    .or(`county_name.ilike.${bare},county_name.ilike.${bare} County,county_name.ilike.${bare} %`)
    .limit(1);
  const fips = cf?.[0]?.fips ?? '';
  if (!fips) {
    fipsCache.set(ck, { fips: '', zip: '' });
    return null;
  }
  const { data: z } = await sb
    .from('pm_zip_county')
    .select('zip')
    .eq('state', state)
    .ilike('county', bare)
    .limit(1);
  let zip = z?.[0]?.zip ?? '';
  if (!zip) {
    const { data: zAny } = await sb.from('pm_zip_county').select('zip').eq('state', state).limit(1);
    zip = zAny?.[0]?.zip ?? '00000';
  }
  const v = { fips, zip };
  fipsCache.set(ck, v);
  return v;
}

// ─── Existing carrier-set in pm_plans ───────────────────────────────
async function loadExistingCarriers(): Promise<Map<string, { carrier: string; sampleCounty: string }>> {
  // contract_id → carrier name in pm_plans (any state)
  const out = new Map<string, { carrier: string; sampleCounty: string }>();
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await sb
      .from('pm_plans')
      .select('contract_id, carrier, county_name')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) {
      if (!out.has(r.contract_id)) {
        out.set(r.contract_id, { carrier: r.carrier ?? '?', sampleCounty: r.county_name ?? '?' });
      }
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// ─── Main ──────────────────────────────────────────────────────────
interface Sub100Result {
  state: string;
  contract_id: string;
  plan_id: string;
  key: string;
  status: 'REAL' | 'GHOST' | 'UNRESOLVED';
  reason?: string;
  tested_fips?: string;
  tested_zip?: string;
  tested_county?: string;
  pf?: PfPlan;
  commissionable?: boolean;
  carrier_already_imported?: boolean;
  carrier_existing_name?: string;
}

async function main() {
  mkdirSync('_tmp', { recursive: true });

  const diff = JSON.parse(readFileSync('_tmp/audit-cms-diff.json', 'utf8')) as {
    maCmsOnlyDetail: { state: string; key: string }[];
  };
  const sub100 = diff.maCmsOnlyDetail.filter((r) => {
    const pid = parseInt(r.key.split('-')[1].replace(/^0+/, '') || '0', 10);
    return pid < 100;
  });
  console.log(`[main] ${sub100.length} sub-100 plans across NC/TX/GA`);

  const byState: Record<string, number> = {};
  for (const s of sub100) byState[s.state] = (byState[s.state] ?? 0) + 1;
  console.log('[main] per-state:', byState);

  const cachedZip = process.env.PBP_CACHED_ZIP || '/var/folders/nc/9vdhl2g97sv80lls6pxvv_sm0000gn/T/cms-pbp-1782401823800-pbp-benefits-2026.zip';
  if (!existsSync(cachedZip)) {
    console.error(`[main] PBP zip not found at ${cachedZip}`);
    process.exit(1);
  }

  const wanted = sub100.map((s) => {
    const [h, p] = s.key.split('-');
    return { hnumber: h, planId: p, state: s.state };
  });
  console.log('[main] scanning PlanArea.txt for county info…');
  const pbpCounties = await buildPbpPlanCounties(cachedZip, wanted);
  console.log(`[main] resolved counties for ${pbpCounties.size}/${wanted.length} plans`);

  console.log('[main] loading non-commissionable sets and existing carriers…');
  const [nonComm, existingCarriers] = await Promise.all([
    getNonCommissionableSets(url, key),
    loadExistingCarriers(),
  ]);
  console.log(`[main] non-comm contracts: ${nonComm.contracts.size}, non-comm plans: ${nonComm.plans.size}`);
  console.log(`[main] existing contract_ids in pm_plans: ${existingCarriers.size}`);

  console.log('[main] warming Playwright…');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(WARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(6_000);

  const fipsResultsCache = new Map<string, Map<string, PfPlan>>(); // fips → set of contract-plan → PfPlan
  const results: Sub100Result[] = [];

  let n = 0;
  for (const s of sub100) {
    n += 1;
    const ck = `${s.key.split('-')[0]}|${s.key.split('-')[1]}|${s.state}`;
    const counties = pbpCounties.get(ck);
    if (!counties || counties.length === 0) {
      results.push({
        state: s.state,
        contract_id: s.key.split('-')[0],
        plan_id: s.key.split('-')[1],
        key: s.key,
        status: 'UNRESOLVED',
        reason: 'no PBP counties',
      });
      continue;
    }
    let resolved: { fips: string; zip: string; county: string } | null = null;
    for (const pc of counties.slice(0, 5)) {
      const r = await resolveFipsZip(pc.state, pc.county);
      if (r && r.fips) {
        resolved = { ...r, county: pc.county };
        break;
      }
    }
    if (!resolved) {
      results.push({
        state: s.state,
        contract_id: s.key.split('-')[0],
        plan_id: s.key.split('-')[1],
        key: s.key,
        status: 'UNRESOLVED',
        reason: 'fips/zip unresolved',
      });
      continue;
    }

    // Cache PF results by fips
    let pfSet: Map<string, PfPlan>;
    if (fipsResultsCache.has(resolved.fips)) {
      pfSet = fipsResultsCache.get(resolved.fips)!;
    } else {
      try {
        pfSet = await searchAllPages(page, { fips: resolved.fips, zip: resolved.zip });
        fipsResultsCache.set(resolved.fips, pfSet);
        console.log(`[search] fips=${resolved.fips} → ${pfSet.size} unique plans`);
      } catch (err) {
        console.warn(`[search] fips=${resolved.fips} threw: ${(err as Error).message}`);
        pfSet = new Map();
        fipsResultsCache.set(resolved.fips, pfSet);
      }
    }

    const found = pfSet.get(s.key);
    const [contract_id, plan_id] = s.key.split('-');
    if (found) {
      const isNonComm = nonComm.contracts.has(contract_id) || nonComm.plans.has(s.key);
      const existing = existingCarriers.get(contract_id);
      results.push({
        state: s.state,
        contract_id,
        plan_id,
        key: s.key,
        status: 'REAL',
        tested_fips: resolved.fips,
        tested_zip: resolved.zip,
        tested_county: resolved.county,
        pf: found,
        commissionable: !isNonComm,
        carrier_already_imported: !!existing,
        carrier_existing_name: existing?.carrier,
      });
    } else {
      results.push({
        state: s.state,
        contract_id,
        plan_id,
        key: s.key,
        status: 'GHOST',
        tested_fips: resolved.fips,
        tested_zip: resolved.zip,
        tested_county: resolved.county,
      });
    }

    if (n % 25 === 0) {
      const real = results.filter((r) => r.status === 'REAL').length;
      const ghost = results.filter((r) => r.status === 'GHOST').length;
      const unr = results.filter((r) => r.status === 'UNRESOLVED').length;
      console.log(`[progress] ${n}/${sub100.length} (REAL ${real} / GHOST ${ghost} / UNR ${unr}, fips-cache ${fipsResultsCache.size})`);
      // Persist mid-flight in case of crash
      writeFileSync('_tmp/audit-sub100-full.json', JSON.stringify({ partial: true, results }, null, 2));
    }
  }

  await browser.close().catch(() => {});

  const real = results.filter((r) => r.status === 'REAL');
  const ghost = results.filter((r) => r.status === 'GHOST');
  const unr = results.filter((r) => r.status === 'UNRESOLVED');
  const realComm = real.filter((r) => r.commissionable);
  const realNon = real.filter((r) => !r.commissionable);
  const realCommExistingCarrier = realComm.filter((r) => r.carrier_already_imported);
  const realCommNewCarrier = realComm.filter((r) => !r.carrier_already_imported);

  // Carrier breakdown of commissionable gaps
  const carrierBreakdown = new Map<string, { plans: number; existing: boolean; existing_name?: string }>();
  for (const r of realComm) {
    const k = r.pf?.carrier ?? r.contract_id;
    const cur = carrierBreakdown.get(k) ?? { plans: 0, existing: !!r.carrier_already_imported, existing_name: r.carrier_existing_name };
    cur.plans += 1;
    carrierBreakdown.set(k, cur);
  }

  // Final JSON
  writeFileSync(
    '_tmp/audit-sub100-full.json',
    JSON.stringify(
      {
        partial: false,
        counts: {
          total: sub100.length,
          REAL: real.length,
          GHOST: ghost.length,
          UNRESOLVED: unr.length,
          REAL_COMMISSIONABLE: realComm.length,
          REAL_NON_COMMISSIONABLE: realNon.length,
          REAL_COMM_EXISTING_CARRIER: realCommExistingCarrier.length,
          REAL_COMM_NEW_CARRIER: realCommNewCarrier.length,
        },
        results,
      },
      null,
      2,
    ),
  );

  // Final Markdown
  const md: string[] = [];
  md.push('# Sub-100 PBP-only Plans — Full Plan Finder Classification');
  md.push('');
  md.push(`Generated: ${new Date().toISOString()}`);
  md.push('');
  md.push('## Totals');
  md.push('');
  md.push('| classification | count | % |');
  md.push('| --- | --- | --- |');
  const tot = sub100.length;
  md.push(`| REAL (on Plan Finder) | ${real.length} | ${(real.length / tot * 100).toFixed(1)}% |`);
  md.push(`| GHOST (PBP only) | ${ghost.length} | ${(ghost.length / tot * 100).toFixed(1)}% |`);
  md.push(`| UNRESOLVED | ${unr.length} | ${(unr.length / tot * 100).toFixed(1)}% |`);
  md.push(`| **Total tested** | **${tot}** | |`);
  md.push('');
  md.push('### REAL split by commissionability');
  md.push('');
  md.push('| | count | % of REAL |');
  md.push('| --- | --- | --- |');
  md.push(`| REAL + COMMISSIONABLE (actionable gap) | ${realComm.length} | ${(realComm.length / Math.max(1, real.length) * 100).toFixed(1)}% |`);
  md.push(`| REAL + NON-COMMISSIONABLE | ${realNon.length} | ${(realNon.length / Math.max(1, real.length) * 100).toFixed(1)}% |`);
  md.push('');
  md.push('### REAL + COMMISSIONABLE split by carrier-import status');
  md.push('');
  md.push('| | count |');
  md.push('| --- | --- |');
  md.push(`| Carrier already imported (HIGH PRIORITY — plan variant we missed) | ${realCommExistingCarrier.length} |`);
  md.push(`| Carrier not yet imported | ${realCommNewCarrier.length} |`);
  md.push('');

  md.push('## REAL + COMMISSIONABLE plans (the actionable gap)');
  md.push('');
  md.push('### HIGH PRIORITY: carrier already in pm_plans (plan variant gap)');
  md.push('');
  if (realCommExistingCarrier.length === 0) md.push('_none_');
  else {
    md.push('| state | contract-plan | plan_name | carrier | plan_type | premium | star | existing_carrier_label |');
    md.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of realCommExistingCarrier) {
      const pf = r.pf!;
      md.push(`| ${r.state} | ${r.key} | ${pf.plan_name.replace(/\|/g, '\\|')} | ${pf.carrier} | ${pf.plan_type} | ${pf.premium} | ${pf.star_rating} | ${r.carrier_existing_name ?? ''} |`);
    }
  }
  md.push('');

  md.push('### LOWER PRIORITY: carrier not yet in pm_plans');
  md.push('');
  if (realCommNewCarrier.length === 0) md.push('_none_');
  else {
    md.push('| state | contract-plan | plan_name | carrier | plan_type | premium | star |');
    md.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const r of realCommNewCarrier) {
      const pf = r.pf!;
      md.push(`| ${r.state} | ${r.key} | ${pf.plan_name.replace(/\|/g, '\\|')} | ${pf.carrier} | ${pf.plan_type} | ${pf.premium} | ${pf.star_rating} |`);
    }
  }
  md.push('');

  md.push('## REAL + NON-COMMISSIONABLE plans (real but blocked by Rob\'s contract status)');
  md.push('');
  if (realNon.length === 0) md.push('_none_');
  else {
    md.push('| state | contract-plan | plan_name | carrier | plan_type | premium |');
    md.push('| --- | --- | --- | --- | --- | --- |');
    for (const r of realNon) {
      const pf = r.pf!;
      md.push(`| ${r.state} | ${r.key} | ${pf.plan_name.replace(/\|/g, '\\|')} | ${pf.carrier} | ${pf.plan_type} | ${pf.premium} |`);
    }
  }
  md.push('');

  md.push('## GHOST plans (PBP-only — not visible on Plan Finder)');
  md.push('');
  md.push(`Total: ${ghost.length}. Just contract-plan keys, no details (they don't surface to consumers).`);
  md.push('');
  md.push('| state | contract-plan |');
  md.push('| --- | --- |');
  for (const r of ghost) md.push(`| ${r.state} | ${r.key} |`);
  md.push('');

  md.push('## UNRESOLVED plans (could not resolve county/FIPS/zip to test)');
  md.push('');
  md.push(`Total: ${unr.length}.`);
  md.push('');
  if (unr.length > 0) {
    md.push('| state | contract-plan | reason |');
    md.push('| --- | --- | --- |');
    for (const r of unr) md.push(`| ${r.state} | ${r.key} | ${r.reason ?? ''} |`);
    md.push('');
  }

  md.push('## Carriers contributing to commissionable gaps');
  md.push('');
  md.push('| carrier | plans | already imported? | existing label in pm_plans |');
  md.push('| --- | --- | --- | --- |');
  const sortedCarriers = [...carrierBreakdown.entries()].sort((a, b) => b[1].plans - a[1].plans);
  for (const [carrier, info] of sortedCarriers) {
    md.push(`| ${carrier} | ${info.plans} | ${info.existing ? 'yes' : 'no'} | ${info.existing_name ?? ''} |`);
  }
  md.push('');

  md.push('## Recommended action');
  md.push('');
  if (realCommExistingCarrier.length > 0) {
    md.push(`1. **Import the ${realCommExistingCarrier.length} HIGH PRIORITY plans** — same carriers are already in pm_plans, so the import pipeline is in place; these are plan variants that fell through. Add to the existing scrape/seed flow.`);
  }
  if (realCommNewCarrier.length > 0) {
    md.push(`2. **Evaluate ${realCommNewCarrier.length} new-carrier plans** — these are commissionable but the carrier has no other plans in pm_plans. Decide per carrier whether to add to the import pipeline.`);
  }
  if (realNon.length > 0) {
    md.push(`3. **${realNon.length} REAL + NON-COMMISSIONABLE plans require no action** — Rob can't write them per pm_non_commissionable_contracts.`);
  }
  md.push(`4. **${ghost.length} GHOST plans are noise** — PBP filings with no consumer marketing. Ignore.`);

  writeFileSync('_tmp/audit-sub100-full.md', md.join('\n') + '\n');
  console.log('\n[done] wrote _tmp/audit-sub100-full.md and _tmp/audit-sub100-full.json');
  console.log(`[done] REAL ${real.length} / GHOST ${ghost.length} / UNRESOLVED ${unr.length}`);
  console.log(`[done] REAL+COMM ${realComm.length} (existing carrier ${realCommExistingCarrier.length}, new carrier ${realCommNewCarrier.length}); REAL+NON ${realNon.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
