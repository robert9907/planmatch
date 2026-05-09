#!/usr/bin/env node
// scripts/probe-network-check.mjs
//
// Probes the real Medicare.gov /plans/search?providers=<NPI> response to
// determine the exact JSON shape used for provider network coverage.
// Mirrors the Akamai-bypass pattern from api/drug-costs.ts:
//   1. Launch Playwright/Chromium
//   2. Warm https://www.medicare.gov/plan-compare/ for 6s (_abck/bm_sz cookies)
//   3. POST /plans/search with providers=1619976297 via page.request.post()
//   4. Write full response to _tmp/network-probe.json
//   5. Print top-level keys + one plans[] sample
//   6. Walk the JSON to find every path where the NPI appears
//
// Usage:
//   node scripts/probe-network-check.mjs [--npi 1619976297] [--zip 27713] [--fips 37063]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '_tmp', 'network-probe.json');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const NPI = arg('--npi', '1619976297');
const ZIP = arg('--zip', '27713');
const FIPS = arg('--fips', '37063');
const PLAN_TYPE = arg('--plan-type', 'PLAN_TYPE_MAPD');
const YEAR = arg('--year', '2026');

const PLAN_SEARCH_URL = 'https://www.medicare.gov/api/v1/data/plan-compare/plans/search';
const WARM_URL = 'https://www.medicare.gov/plan-compare/';
const COOKIE_WARM_MS = 6_000;
const FE_VER = '2.69.0';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function randomHex(n) {
  return [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
}

function buildHeaders() {
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

async function launchBrowser() {
  const { chromium } = await import('playwright-core');
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_BIN;
  if (envPath) {
    return chromium.launch({ executablePath: envPath, headless: true });
  }
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

// Walk the JSON tree and return all dot-paths where `needle` appears
// as a string value or as an object key.
function findNpiPaths(node, needle, pathParts = []) {
  const hits = [];
  if (node === null || node === undefined) return hits;
  if (typeof node === 'string' || typeof node === 'number') {
    if (String(node) === needle) {
      hits.push(pathParts.join('.'));
    }
    return hits;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => hits.push(...findNpiPaths(v, needle, [...pathParts, `[${i}]`])));
    return hits;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === needle) hits.push([...pathParts, k].join('.'));
      hits.push(...findNpiPaths(v, needle, [...pathParts, k]));
    }
  }
  return hits;
}

async function probe(attempt = 1) {
  console.log(`\n=== probe attempt ${attempt} ===`);
  const qs = new URLSearchParams({
    zip: ZIP,
    fips: FIPS,
    plan_type: PLAN_TYPE,
    year: YEAR,
    lang: 'en',
    providers: NPI,
  });
  const url = `${PLAN_SEARCH_URL}?${qs.toString()}`;
  const reqBody = {
    npis: [],
    prescriptions: [],
    lis: 'LIS_NO_HELP',
    starRatings: [],
    organizationNames: [],
  };

  const browser = await launchBrowser();
  try {
    const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US', ignoreHTTPSErrors: true });
    const page = await ctx.newPage();

    console.log(`warming ${WARM_URL} (${COOKIE_WARM_MS / 1000}s)…`);
    await page.goto(WARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(COOKIE_WARM_MS);

    console.log(`POST ${url}`);
    console.log(`body: ${JSON.stringify(reqBody)}`);

    const resp = await page.request.post(url, {
      data: reqBody,
      headers: buildHeaders(),
      timeout: 60_000,
    });
    const status = resp.status();
    console.log(`response status: ${status}`);

    if (!resp.ok()) {
      const sample = (await resp.text()).slice(0, 800);
      console.warn(`\n!!! HTTP ${status} — Akamai may have blocked the request`);
      console.warn('Body sample:', sample);
      return { ok: false, status };
    }

    const data = await resp.json();

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
    console.log(`\n✓ Full response written to ${OUT} (${fs.statSync(OUT).size} bytes)`);

    // Top-level keys
    const topKeys = Object.keys(data);
    console.log('\nTop-level keys:', topKeys);

    // Plans sample
    const plans = Array.isArray(data.plans) ? data.plans : [];
    console.log(`\nplans[] length: ${plans.length}`);
    if (plans.length > 0) {
      const sample = plans[0];
      console.log('\nplans[0] top-level keys:', Object.keys(sample));
      // Print relevant sub-keys
      for (const k of Object.keys(sample)) {
        const v = sample[k];
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          console.log(`  plans[0].${k} (object keys):`, Object.keys(v).slice(0, 15));
        } else if (Array.isArray(v)) {
          console.log(`  plans[0].${k} (array, length=${v.length})`);
          if (v.length > 0 && typeof v[0] === 'object') {
            console.log(`    [0] keys:`, Object.keys(v[0]).slice(0, 15));
          }
        } else {
          console.log(`  plans[0].${k}:`, String(v).slice(0, 80));
        }
      }
    }

    // NPI path search
    console.log(`\nSearching for NPI "${NPI}" in response…`);
    const npiPaths = findNpiPaths(data, NPI);
    if (npiPaths.length === 0) {
      console.log(`  NPI not found as a string value. Searching for it as a key…`);
      // The NPI might appear as a map key. Already handled in findNpiPaths.
      console.log('  No paths found — the response may not include the NPI string directly.');
      console.log('  Check _tmp/network-probe.json for the actual provider coverage shape.');
    } else {
      console.log(`  Found ${npiPaths.length} path(s):`);
      for (const p of npiPaths.slice(0, 30)) {
        console.log(`    ${p}`);
      }
    }

    // Also grep for provider/coverage/network keys near the top of plans[0]
    if (plans.length > 0) {
      console.log('\nCoverage/network related keys in plans[0] (deep search):');
      const networkHits = [];
      function searchNetworkKeys(node, pathParts) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach((v, i) => searchNetworkKeys(v, [...pathParts, `[${i}]`]));
          return;
        }
        for (const [k, v] of Object.entries(node)) {
          if (/provider|network|coverage|npi|in_net/i.test(k)) {
            const val = typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v).slice(0, 80);
            networkHits.push({ path: [...pathParts, k].join('.'), value: val });
          }
          searchNetworkKeys(v, [...pathParts, k]);
        }
      }
      searchNetworkKeys(plans[0], ['plans[0]']);
      if (networkHits.length === 0) {
        console.log('  (none found)');
      } else {
        for (const h of networkHits.slice(0, 30)) {
          console.log(`  ${h.path} = ${h.value}`);
        }
      }
    }

    return { ok: true, data, npiPaths };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  console.log('probe-network-check.mjs');
  console.log(`  NPI: ${NPI}`);
  console.log(`  zip: ${ZIP}, fips: ${FIPS}, plan_type: ${PLAN_TYPE}, year: ${YEAR}`);

  let result = await probe(1);
  if (!result.ok) {
    console.log('\nFirst attempt failed — waiting 30s then retrying…');
    await new Promise((r) => setTimeout(r, 30_000));
    result = await probe(2);
  }
  if (!result.ok) {
    console.log('\nBoth probe attempts failed (Akamai block). Proceeding to consumer-side source analysis.');
    process.exit(2);
  }
  console.log('\nProbe complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
