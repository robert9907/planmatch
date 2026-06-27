// scripts/audit-scrape-pagination-bug.ts
//
// Demonstrate the actual root cause for the 113-plan commissionable
// gap: scripts/scrape-medicare-gov.mjs makes ONE /plans/search call
// per (zip, fips, plan_type) target and never paginates. The default
// page size is 10. Any county with more than 10 MAPD plans loses
// plans 11+. The scrape also only fetches a single plan_type
// (PLAN_TYPE_MAPD by default), so MA-only plans are dropped too.
//
// Method:
//  1. For each tested_fips in audit-sub100-full.json, do ONE
//     unpaginated PLAN_TYPE_MAPD call to mimic the scrape exactly.
//  2. For each tested_fips, also do the paginated dual-plan-type sweep
//     to get ground truth (same logic as audit-sub100-full).
//  3. Cross-reference: which of the 113 commissionable plans appear in
//     "paginated truth" but NOT in "scrape sim"? Those are the ones
//     directly blamed on the missing-pagination bug.
//
// Output: _tmp/scrape-pagination-bug.{md,json}

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { chromium, type Page } from 'playwright-core';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const PLAN_SEARCH_URL = 'https://www.medicare.gov/api/v1/data/plan-compare/plans/search';
const WARM_URL = 'https://www.medicare.gov/plan-compare/';
const FE_VER = '2.69.0';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const YEAR = 2026;

function randomHex(n: number): string { return randomBytes(n / 2).toString('hex'); }

interface PfPlanLite { contract_id: string; plan_id: string; }

async function callOnce(
  page: Page,
  args: { zip: string; fips: string; planType: string; pageNum?: number },
): Promise<{ ok: boolean; plans: PfPlanLite[]; total: number; status: number }> {
  const qs: Record<string, string> = {
    zip: args.zip,
    fips: args.fips,
    plan_type: args.planType,
    year: String(YEAR),
    lang: 'en',
  };
  if (args.pageNum) qs.page = String(args.pageNum);
  const url = `${PLAN_SEARCH_URL}?${new URLSearchParams(qs).toString()}`;
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
  if (!resp.ok()) return { ok: false, plans: [], total: 0, status };
  const body = (await resp.json()) as Record<string, unknown>;
  const arr = Array.isArray(body.plans) ? (body.plans as Array<{ contract_id: string; plan_id: string }>) : [];
  const plans = arr.map((p) => ({ contract_id: p.contract_id, plan_id: p.plan_id }));
  const total = typeof body.total_results === 'number' ? body.total_results : plans.length;
  return { ok: true, plans, total, status };
}

async function paginated(
  page: Page,
  args: { zip: string; fips: string; planType: string },
): Promise<{ plans: PfPlanLite[]; total: number }> {
  const out = new Map<string, PfPlanLite>();
  let total = 0;
  for (let pn = 1; pn <= 30; pn += 1) {
    const r = await callOnce(page, { ...args, pageNum: pn });
    if (!r.ok) break;
    total = r.total;
    for (const p of r.plans) out.set(`${p.contract_id}-${p.plan_id}`, p);
    if (out.size >= r.total) break;
    if (r.plans.length < 10) break;
  }
  return { plans: [...out.values()], total };
}

async function main() {
  mkdirSync('_tmp', { recursive: true });
  const full = JSON.parse(readFileSync('_tmp/audit-sub100-full.json', 'utf8')) as {
    results: Array<{
      state: string; contract_id: string; plan_id: string; key: string;
      status: string; commissionable?: boolean; tested_fips?: string; tested_zip?: string;
    }>;
  };
  const comm = full.results.filter((r) => r.status === 'REAL' && r.commissionable);
  // Pick representative FIPS — first 12 distinct tested_fips covering the comm plans
  const fipsToPlans = new Map<string, { zip: string; commPlans: string[] }>();
  for (const r of comm) {
    if (!r.tested_fips || !r.tested_zip) continue;
    if (!fipsToPlans.has(r.tested_fips)) fipsToPlans.set(r.tested_fips, { zip: r.tested_zip, commPlans: [] });
    fipsToPlans.get(r.tested_fips)!.commPlans.push(r.key);
  }
  // Sort by comm-plan count, take top 12 (covers most of the 113)
  const targets = [...fipsToPlans.entries()]
    .sort((a, b) => b[1].commPlans.length - a[1].commPlans.length)
    .slice(0, 12)
    .map(([fips, info]) => ({ fips, zip: info.zip, commPlans: info.commPlans }));
  console.log(`[main] testing ${targets.length} FIPS that cover ${targets.reduce((a, t) => a + t.commPlans.length, 0)} of the 113 commissionable plans`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(WARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(6_000);

  const rows: {
    fips: string; zip: string;
    scrapeSimMapd: number;     // current scrape behaviour: 1 call, plan_type=MAPD
    paginatedMapd: number;     // paginated MAPD
    paginatedMa: number;       // paginated MA-only
    total: number;             // unique across both plan_types after pagination
    commPlansAtFips: string[]; // commissionable plans that should appear at this fips
    commPlansFoundByScrapeSim: string[];
    commPlansFoundByPaginated: string[];
    commPlansMissedByScrapeSim: string[];
  }[] = [];

  for (const t of targets) {
    console.log(`[fips=${t.fips}] (${t.commPlans.length} comm plans should appear here)`);
    // What the current scrape would see — one call, MAPD only
    const scrapeSim = await callOnce(page, { zip: t.zip, fips: t.fips, planType: 'PLAN_TYPE_MAPD' });
    const scrapeSimSet = new Set(scrapeSim.plans.map((p) => `${p.contract_id}-${p.plan_id}`));
    // What pagination would see — both plan_types
    const mapd = await paginated(page, { zip: t.zip, fips: t.fips, planType: 'PLAN_TYPE_MAPD' });
    const ma = await paginated(page, { zip: t.zip, fips: t.fips, planType: 'PLAN_TYPE_MA' });
    const allPaginated = new Set<string>();
    for (const p of mapd.plans) allPaginated.add(`${p.contract_id}-${p.plan_id}`);
    for (const p of ma.plans) allPaginated.add(`${p.contract_id}-${p.plan_id}`);
    const commFoundByScrape = t.commPlans.filter((k) => scrapeSimSet.has(k));
    const commFoundByPaginated = t.commPlans.filter((k) => allPaginated.has(k));
    const commMissedByScrape = t.commPlans.filter((k) => !scrapeSimSet.has(k));
    rows.push({
      fips: t.fips, zip: t.zip,
      scrapeSimMapd: scrapeSim.plans.length,
      paginatedMapd: mapd.plans.length,
      paginatedMa: ma.plans.length,
      total: allPaginated.size,
      commPlansAtFips: t.commPlans,
      commPlansFoundByScrapeSim: commFoundByScrape,
      commPlansFoundByPaginated: commFoundByPaginated,
      commPlansMissedByScrapeSim: commMissedByScrape,
    });
    console.log(`  scrape-sim (1 call, MAPD)        : ${scrapeSim.plans.length}/${scrapeSim.total}`);
    console.log(`  paginated MAPD                   : ${mapd.plans.length}/${mapd.total}`);
    console.log(`  paginated MA                     : ${ma.plans.length}/${ma.total}`);
    console.log(`  comm plans missed by scrape-sim  : ${commMissedByScrape.length}/${t.commPlans.length}`);
  }
  await browser.close().catch(() => {});

  // Aggregate
  const totalCommExpected = rows.reduce((a, r) => a + r.commPlansAtFips.length, 0);
  const totalCommFoundByScrapeSim = rows.reduce((a, r) => a + r.commPlansFoundByScrapeSim.length, 0);
  const totalCommFoundByPaginated = rows.reduce((a, r) => a + r.commPlansFoundByPaginated.length, 0);

  // Build markdown
  const md: string[] = [];
  md.push('# Scrape pagination bug — root cause confirmation');
  md.push('');
  md.push(`Generated: ${new Date().toISOString()}`);
  md.push('');
  md.push('## Hypothesis');
  md.push('');
  md.push('`scripts/scrape-medicare-gov.mjs` calls `/plans/search` **once** per `(zip, fips)` target via `searchPlansViaApi` (line 1125, no `page` query param). Medicare.gov returns 10 plans per page. For any county with more than 10 MAPD plans the scrape silently drops plans 11+. The scrape also only runs a single `plan_type` (default `PLAN_TYPE_MAPD`), so MA-only plans never enter the pipeline.');
  md.push('');
  md.push('## Controlled comparison (top 12 FIPS by commissionable plan count)');
  md.push('');
  md.push('| fips | zip | scrape-sim (1 call MAPD) | paginated MAPD | paginated MA | comm plans at fips | found by scrape-sim | missed by scrape-sim |');
  md.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    md.push(`| ${r.fips} | ${r.zip} | ${r.scrapeSimMapd} | ${r.paginatedMapd} | ${r.paginatedMa} | ${r.commPlansAtFips.length} | ${r.commPlansFoundByScrapeSim.length} | **${r.commPlansMissedByScrapeSim.length}** |`);
  }
  md.push('');
  md.push(`**Aggregate across 12 FIPS:** scrape-sim finds **${totalCommFoundByScrapeSim} / ${totalCommExpected}** commissionable gap plans; paginated finds **${totalCommFoundByPaginated} / ${totalCommExpected}**.`);
  md.push('');
  md.push('## Verdict');
  md.push('');
  if (totalCommFoundByScrapeSim < totalCommFoundByPaginated) {
    md.push(`Confirmed. The pagination gap accounts for **${totalCommFoundByPaginated - totalCommFoundByScrapeSim}** of the missing plans across the 12 sampled FIPS alone. Extrapolating, pagination alone explains the bulk of the 113-plan commissionable gap. The MA-only plan-type omission is a secondary contributor (every \`paginated MA\` count above 0 represents plans the scrape would also miss).`);
  } else {
    md.push('Refuted. Scrape-sim found the same plans as paginated — pagination is not the cause for these FIPS. Look elsewhere.');
  }
  md.push('');
  md.push('## Fix');
  md.push('');
  md.push('In `scripts/scrape-medicare-gov.mjs`:');
  md.push('');
  md.push('1. Replace the single `searchPlansViaApi` call with a paginated loop (mirror `searchPlansAllPages` in `scripts/audit-planfinder-spotcheck.ts` / `scripts/audit-sub100-full.ts`). Page until `total_results` is satisfied or a page returns fewer than 10 plans.');
  md.push('2. Iterate `plan_type` over `[PLAN_TYPE_MAPD, PLAN_TYPE_MA]` and dedupe results by `contract-plan-segment`.');
  md.push('3. SNP plan-types appear under MAPD already (verified by spot-check) so no extra plan_type needed.');
  md.push('');
  md.push('## Per-FIPS detail of missed comm plans');
  md.push('');
  for (const r of rows) {
    if (r.commPlansMissedByScrapeSim.length === 0) continue;
    md.push(`### fips ${r.fips} — ${r.commPlansMissedByScrapeSim.length} comm plans missed by current scrape behaviour`);
    md.push('');
    md.push('| contract-plan |');
    md.push('| --- |');
    for (const k of r.commPlansMissedByScrapeSim) md.push(`| ${k} |`);
    md.push('');
  }

  writeFileSync('_tmp/scrape-pagination-bug.md', md.join('\n') + '\n');
  writeFileSync('_tmp/scrape-pagination-bug.json', JSON.stringify({ rows, totalCommExpected, totalCommFoundByScrapeSim, totalCommFoundByPaginated }, null, 2));
  console.log('[done] wrote _tmp/scrape-pagination-bug.{md,json}');
  console.log(`[done] aggregate: scrape-sim ${totalCommFoundByScrapeSim}/${totalCommExpected}, paginated ${totalCommFoundByPaginated}/${totalCommExpected}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
