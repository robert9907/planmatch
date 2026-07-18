#!/usr/bin/env node
// scripts/_probe-lis-enum.mjs — discover valid LIS enum values by
// (a) sniffing the SPA's JS bundle for the enum declaration,
// (b) trying common enum guesses against /plans/search,
// (c) driving the SPA UI into a "yes I have Medicaid" toggle and
//     capturing the POST it makes.
//
// Prints the working values so the SNP scraper can be updated.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WARM_URL = 'https://www.medicare.gov/plan-compare/';
const SEARCH_URL = 'https://www.medicare.gov/api/v1/data/plan-compare/plans/search';
const FE_VER = '2.69.0';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function headers() {
  const trace = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
  const span  = [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: 'https://www.medicare.gov',
    Referer: 'https://www.medicare.gov/plan-compare/',
    'fe-ver': FE_VER,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    traceparent: `00-${trace}-${span}-01`,
  };
}

async function main() {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US' });
  const page = await ctx.newPage();

  // 1. Warm & sniff JS bundles for LIS enum values
  console.log('▶ Warming and sniffing SPA bundles for LIS enum…');
  const jsBodies = [];
  const respHandler = async (resp) => {
    const url = resp.url();
    if (url.endsWith('.js') && url.includes('plan-compare')) {
      try { jsBodies.push({ url, body: await resp.text() }); } catch {}
    }
  };
  page.on('response', respHandler);
  await page.goto(WARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(6000);
  page.off('response', respHandler);
  console.log(`  captured ${jsBodies.length} JS bundles`);
  const lisMatches = new Set();
  for (const b of jsBodies) {
    for (const m of b.body.matchAll(/LIS_[A-Z_0-9]+/g)) lisMatches.add(m[0]);
  }
  console.log('  LIS_* tokens in bundles:', [...lisMatches].sort());

  // 2. Guess enums against /plans/search
  console.log('\n▶ Testing candidate LIS values against /plans/search…');
  const candidates = new Set([
    'LIS_NO_HELP', 'LIS_FULL_HELP', 'LIS_PARTIAL_HELP',
    'LIS_TYPE_UNSPECIFIED', 'LIS_UNKNOWN', 'LIS_UNSPECIFIED',
    ...lisMatches,
  ]);
  const zip = '27713', fips = '37063', year = 2026;
  const qs = new URLSearchParams({ zip, fips, plan_type: 'PLAN_TYPE_MAPD', year: String(year), lang: 'en' });
  const url = `${SEARCH_URL}?${qs.toString()}&page=1`;
  const okValues = [];
  for (const c of candidates) {
    const body = { npis: [], prescriptions: [], lis: c, starRatings: [], organizationNames: [] };
    const resp = await page.request.post(url, { data: body, headers: headers(), timeout: 30_000 });
    const status = resp.status();
    if (status === 200) {
      const j = await resp.json();
      const nPlans = (j.plans ?? j.data?.plans ?? []).length;
      const total = j.total_results ?? nPlans;
      const snpCount = (j.plans ?? []).filter((p) => p.snp_type && p.snp_type !== 'SNP_TYPE_NOT_SNP').length;
      okValues.push({ enum: c, plans: nPlans, total, snpCount });
      console.log(`  ✓ ${c.padEnd(30)} plans=${nPlans} total=${total} snps_on_page=${snpCount}`);
    } else {
      const t = (await resp.text()).slice(0, 200);
      console.log(`  ✗ ${c.padEnd(30)} ${status}: ${t.slice(0, 150)}`);
    }
    await page.waitForTimeout(500);
  }

  // 3. Drive the SPA UI: try the "I have Medicaid" flow
  console.log('\n▶ Driving SPA into "I have Medicaid" toggle to observe body…');
  const posts = [];
  const reqHandler = (req) => {
    if (req.url().includes('/plans/search') && req.method() === 'POST') {
      try { posts.push({ url: req.url(), body: JSON.parse(req.postData() ?? 'null') }); }
      catch {}
    }
  };
  page.on('request', reqHandler);

  // Land on plan-compare start
  await page.goto('https://www.medicare.gov/plan-compare/#/prescriptions?year=2026&lang=en', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(3000);
  // Try the medicaid flow via the "already-signed-in" style URL
  await page.goto(`https://www.medicare.gov/plan-compare/#/dual-eligible?zip=${zip}&fips=${fips}&year=${year}&lang=en`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(4000);
  // Fall back to the main search URL with hints
  await page.goto(`https://www.medicare.gov/plan-compare/#/search-results?plan_type=PLAN_TYPE_MAPD&fips=${fips}&zip=${zip}&year=${year}&lang=en&extra_help=yes`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(8000);
  page.off('request', reqHandler);
  console.log(`  captured ${posts.length} /plans/search POSTs during SPA drive`);
  for (const p of posts) console.log(`    body.lis = ${JSON.stringify(p.body?.lis)}  body = ${JSON.stringify(p.body)}`);

  await browser.close();

  console.log('\n─── SUMMARY ───');
  console.log(`Bundle-mined LIS tokens: ${[...lisMatches].sort().join(', ') || '(none)'}`);
  console.log(`Valid /plans/search LIS enums:`);
  for (const v of okValues) console.log(`  ${v.enum.padEnd(30)} → ${v.plans}/${v.total} plans, ${v.snpCount} SNPs on page`);
}
main().catch((e) => { console.error(e); process.exit(1); });
