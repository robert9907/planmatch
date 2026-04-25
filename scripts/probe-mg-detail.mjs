#!/usr/bin/env node
// One-off discovery: navigate to a plan-details hash route and dump
// every XHR/fetch the SPA makes. Used to find the detail-endpoint URL
// + response shape so scrape-medicare-gov.mjs can hit it directly.
//
// Usage:
//   node scripts/probe-mg-detail.mjs --year 2026 --plan H1036-335-2 --zip 27713 --fips 37063

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '_tmp', 'medicare-gov', 'detail-probe');

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const YEAR = arg('--year', '2026');
const PLAN = arg('--plan', 'H1036-335-2'); // contract-plan-segment
const ZIP = arg('--zip', '27713');
const FIPS = arg('--fips', '37063');

const WARM_URL = 'https://www.medicare.gov/plan-compare/';
const DETAIL_URL = `https://www.medicare.gov/plan-compare/#/plan-details/${YEAR}-${PLAN}?fips=${FIPS}&zip=${ZIP}&year=${YEAR}&lang=en`;
const SEARCH_URL = `https://www.medicare.gov/plan-compare/#/search-results?plan_type=PLAN_TYPE_MAPD&fips=${FIPS}&zip=${ZIP}&year=${YEAR}&lang=en`;
const COOKIE_WARM_MS = 6_000;
const SETTLE_MS = 15_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function launchBrowser() {
  const { chromium } = await import('playwright-core');
  if (process.platform === 'linux') {
    const sparticuz = (await import('@sparticuz/chromium')).default;
    return chromium.launch({
      executablePath: await sparticuz.executablePath(),
      args: sparticuz.args,
      headless: true,
    });
  }
  try {
    return await chromium.launch({ headless: true });
  } catch {
    const fallback = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    return chromium.launch({ executablePath: fallback, headless: true });
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`probe ${PLAN} (${YEAR}, zip ${ZIP}, fips ${FIPS})`);
  const browser = await launchBrowser();
  try {
    const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US' });
    const page = await ctx.newPage();

    const requests = [];
    page.on('request', (r) => {
      const u = r.url();
      if (!u.includes('/api/') && !u.includes('plan-compare')) return;
      if (u.includes('/static/') || u.includes('.js') || u.includes('.css') || u.includes('.png') || u.includes('.svg') || u.includes('.woff') || u.includes('akam')) return;
      requests.push({ method: r.method(), url: u, postData: r.postData() ?? null });
    });

    const responses = [];
    page.on('response', async (resp) => {
      const u = resp.url();
      if (!u.includes('/api/')) return;
      const ct = resp.headers()['content-type'] ?? '';
      if (!ct.includes('json')) return;
      try {
        const text = await resp.text();
        responses.push({ status: resp.status(), url: u, contentType: ct, body: text });
      } catch {}
    });

    console.log('warm…');
    await page.goto(WARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(COOKIE_WARM_MS);

    console.log('search-results…');
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(8_000);

    console.log('plan-details…');
    await page.goto(DETAIL_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(SETTLE_MS);

    fs.writeFileSync(
      path.join(OUT, `requests-${PLAN}.json`),
      JSON.stringify(requests, null, 2),
    );
    // Save each response body to its own file so we can inspect shapes.
    const summary = [];
    for (let i = 0; i < responses.length; i++) {
      const r = responses[i];
      const slug = `${String(i).padStart(3, '0')}-${(r.url.split('/').pop() || 'resp').slice(0, 40).replace(/[^a-z0-9._-]/gi, '_')}`;
      const file = path.join(OUT, `body-${slug}.json`);
      fs.writeFileSync(file, r.body);
      summary.push({ status: r.status, url: r.url, file: path.basename(file), bytes: r.body.length });
    }
    fs.writeFileSync(path.join(OUT, `responses-${PLAN}.json`), JSON.stringify(summary, null, 2));

    console.log(`\n${requests.length} requests, ${responses.length} JSON responses`);
    console.log('---all api/* requests---');
    for (const r of requests) {
      if (!r.url.includes('/api/')) continue;
      console.log(`  ${r.method} ${r.url}`);
      if (r.postData) console.log(`    body: ${r.postData.slice(0, 200)}`);
    }
    console.log('---all api/* json responses---');
    for (const s of summary) {
      console.log(`  ${s.status}  ${s.url}  (${s.bytes}B → ${s.file})`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
