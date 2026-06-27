// scripts/probe-medicare-plan-detail.ts
//
// Probe Medicare.gov's plan-detail endpoint. Discovered via SPA snoop:
//   GET /api/v1/data/plan-compare/plan/{year}/{contract}/{plan}/{segment}?lis=LIS_NO_HELP
//
// First snoop got 403s — try direct page.request.get() (which worked for
// /plans/search) with the standard headers, then try variants with
// zip/fips/csrf in case those are required.

import { chromium, type Page } from 'playwright-core';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const WARM_URL = 'https://www.medicare.gov/plan-compare/';
const PLAN_SEARCH_URL = 'https://www.medicare.gov/api/v1/data/plan-compare/plans/search';
const FE_VER = '2.69.0';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const YEAR = 2026;
const PROBE = { zip: '27713', fips: '37063' };
const OUT_DIR = '_tmp/cms-audit';

function randomHex(n: number): string { return randomBytes(n / 2).toString('hex'); }

function commonHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: 'https://www.medicare.gov',
    Referer: 'https://www.medicare.gov/plan-compare/',
    'fe-ver': FE_VER,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    traceparent: `00-${randomHex(32)}-${randomHex(16)}-01`,
  };
}

async function searchOne(page: Page) {
  const qs = new URLSearchParams({
    zip: PROBE.zip, fips: PROBE.fips, plan_type: 'PLAN_TYPE_MAPD',
    year: String(YEAR), lang: 'en', page: '1',
  });
  const resp = await page.request.post(`${PLAN_SEARCH_URL}?${qs.toString()}`, {
    data: { npis: [], prescriptions: [], lis: 'LIS_NO_HELP', starRatings: [], organizationNames: [] },
    headers: commonHeaders(), timeout: 60_000,
  });
  if (!resp.ok()) return null;
  const body = (await resp.json()) as Record<string, unknown>;
  const plans = Array.isArray(body.plans) ? (body.plans as Record<string, unknown>[]) : [];
  for (const p of plans) {
    const contract = (p.contract_id as string) ?? (p.contractId as string);
    const plan_id = (p.plan_id as string) ?? (p.planId as string);
    const segment = (p.segment_id as string) ?? (p.segmentId as string) ?? '0';
    const name = (p.plan_name as string) ?? (p.name as string) ?? '';
    if (contract && plan_id) return { contract_id: String(contract), plan_id: String(plan_id), segment_id: String(segment), plan_name: String(name) };
  }
  return null;
}

async function tryDetail(page: Page, url: string): Promise<{ url: string; status: number; bodyLen: number; bodySnippet: string; json?: unknown }> {
  console.log(`[try] GET ${url.slice(-100)}`);
  const resp = await page.request.get(url, { headers: commonHeaders(), timeout: 60_000 });
  const status = resp.status();
  const text = await resp.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { /* not json */ }
  console.log(`     -> ${status} ${text.length}b ${text.slice(0, 120)}`);
  return { url, status, bodyLen: text.length, bodySnippet: text.slice(0, 600), json };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(WARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(6_000);

  // First, hit /plans/search so the upstream sees an established session.
  const pick = await searchOne(page);
  if (!pick) {
    console.error('search failed');
    await browser.close();
    process.exit(1);
  }
  console.log(`picked: ${pick.contract_id}-${pick.plan_id}-${pick.segment_id} ${pick.plan_name}`);

  const base = `https://www.medicare.gov/api/v1/data/plan-compare/plan/${YEAR}/${pick.contract_id}/${pick.plan_id}/${pick.segment_id}`;
  const variants = [
    `${base}?lis=LIS_NO_HELP`,
    `${base}?lis=LIS_NO_HELP&zip=${PROBE.zip}&fips=${PROBE.fips}`,
    `${base}?lis=LIS_NO_HELP&fips=${PROBE.fips}`,
    `${base}?lis=LIS_NO_HELP&zip=${PROBE.zip}&fips=${PROBE.fips}&lang=en&year=${YEAR}`,
    base,
  ];
  const results: Array<{ url: string; status: number; bodyLen: number; bodySnippet: string; json?: unknown }> = [];
  for (const v of variants) {
    results.push(await tryDetail(page, v));
  }

  // If any 200, dump the response body so we can inspect the shape.
  const winner = results.find(r => r.status === 200 && r.json);
  if (winner) {
    writeFileSync(`${OUT_DIR}/probe-detail.json`, JSON.stringify(winner.json, null, 2));
    console.log(`\n✓ winner: ${winner.url}`);
    console.log(`   bodyLen=${winner.bodyLen}, saved to _tmp/cms-audit/probe-detail.json`);

    // Print top-level shape
    const body = winner.json as Record<string, unknown>;
    console.log('\nTop-level keys:');
    for (const [k, v] of Object.entries(body)) {
      let s: string;
      if (Array.isArray(v)) s = `array len=${v.length}` + (v.length > 0 ? ` (item keys: ${Object.keys(v[0] as object).slice(0, 8).join(',')})` : '');
      else if (v === null) s = 'null';
      else if (typeof v === 'object') s = `object {${Object.keys(v).slice(0, 8).join(', ')}}`;
      else s = `${typeof v}: ${JSON.stringify(v).slice(0, 60)}`;
      console.log(`  ${k}: ${s}`);
    }
  } else {
    writeFileSync(`${OUT_DIR}/probe-detail-attempts.json`, JSON.stringify(results, null, 2));
    console.log('\n✗ no 200 from any variant. Attempts dumped to _tmp/cms-audit/probe-detail-attempts.json');
  }

  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
