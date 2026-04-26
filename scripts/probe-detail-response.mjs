#!/usr/bin/env node
// scripts/probe-detail-response.mjs
//
// Spike: fetches the full /plan-compare/plan/{year}/{contract}/{plan}/{segment}
// response (NOT just plan_card) and saves it to _tmp/medicare-gov-detail/.
// Then greps for dental annual max / allowance / coverage candidates so we
// can locate the field path before wiring it into the scraper.
//
// Usage:
//   node scripts/probe-detail-response.mjs H5253 079 0
//   node scripts/probe-detail-response.mjs H1036 335 2

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '_tmp', 'medicare-gov-detail');

const YEAR = 2026;
const FE_VER = '2.69.0';
const WARM_URL = 'https://www.medicare.gov/plan-compare/';
const COOKIE_WARM_MS = 6_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function buildHeaders() {
  const h = (n) => [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: 'https://www.medicare.gov',
    Referer: 'https://www.medicare.gov/plan-compare/',
    'fe-ver': FE_VER,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    traceparent: `00-${h(32)}-${h(16)}-01`,
  };
}

const [, , contract, plan, segment] = process.argv;
if (!contract || !plan || segment == null) {
  console.error('usage: probe-detail-response.mjs <CONTRACT> <PLAN> <SEGMENT>');
  process.exit(2);
}

const url = `https://www.medicare.gov/api/v1/data/plan-compare/plan/${YEAR}/${contract}/${plan}/${segment}?lis=LIS_NO_HELP`;
console.log('GET', url);

fs.mkdirSync(OUT_DIR, { recursive: true });

async function launch() {
  if (process.platform === 'linux') {
    const sparticuz = (await import('@sparticuz/chromium')).default;
    return chromium.launch({
      headless: true,
      executablePath: await sparticuz.executablePath(),
      args: sparticuz.args,
    });
  }
  try {
    return await chromium.launch({ headless: true });
  } catch {
    const fallback = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    return chromium.launch({ executablePath: fallback, headless: true });
  }
}
const browser = await launch();
try {
  const ctx = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(WARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(COOKIE_WARM_MS);

  const resp = await page.request.get(url, { headers: buildHeaders(), timeout: 60_000 });
  console.log('status', resp.status());
  const ct = resp.headers()['content-type'] ?? '';
  if (!resp.ok() || !ct.includes('json')) {
    console.error('non-json response:', (await resp.text()).slice(0, 400));
    process.exit(1);
  }
  const body = await resp.json();
  const outPath = path.join(OUT_DIR, `${contract}-${plan}-${segment}.json`);
  fs.writeFileSync(outPath, JSON.stringify(body, null, 2));
  console.log(`saved ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);

  // Print top-level keys + first-level structure summary.
  console.log('\nTop-level keys:', Object.keys(body));
  if (body.plan_card) {
    console.log('plan_card keys:', Object.keys(body.plan_card));
  }

  // Dump every leaf path that mentions dental / annual_max / allowance.
  const hits = [];
  function walk(node, pathParts) {
    if (node == null) return;
    if (typeof node === 'string') {
      if (/dental|annual.?max|allowance|coverage.?max/i.test(node)) {
        hits.push({ path: pathParts.join('.'), value: node });
      }
      return;
    }
    if (typeof node === 'number' || typeof node === 'boolean') return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, [...pathParts, `[${i}]`]));
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (/dental|annual_max|allowance|coverage_max|max_coverage/i.test(k)) {
        hits.push({ path: [...pathParts, k].join('.'), value: typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : v });
      }
      walk(v, [...pathParts, k]);
    }
  }
  walk(body, []);
  console.log(`\nDental/allowance/max hits (${hits.length}):`);
  for (const h of hits.slice(0, 60)) console.log(' ', h.path, '=', h.value);
} finally {
  await browser.close().catch(() => {});
}
