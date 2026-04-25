#!/usr/bin/env node
// Hit the discovered plan-detail endpoint directly via
// page.request.get() (warm Akamai first) and dump the response body.
// Used once to learn the response shape; not part of the runtime path.

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
const CONTRACT = arg('--contract', 'H1036');
const PLAN = arg('--plan', '335');
const SEGMENT = arg('--segment', '2');

const WARM_URL = 'https://www.medicare.gov/plan-compare/';
const DETAIL_URL = `https://www.medicare.gov/api/v1/data/plan-compare/plan/${YEAR}/${CONTRACT}/${PLAN}/${SEGMENT}?lis=LIS_NO_HELP`;
const COOKIE_WARM_MS = 6_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FE_VER = '2.69.0';

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
  console.log(`probe2 detail ${YEAR}/${CONTRACT}/${PLAN}/${SEGMENT}`);
  const browser = await launchBrowser();
  try {
    const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US' });
    const page = await ctx.newPage();
    await page.goto(WARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(COOKIE_WARM_MS);

    console.log(`GET ${DETAIL_URL}`);
    const traceId = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
    const spanId = [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
    const resp = await page.request.get(DETAIL_URL, {
      headers: {
        Accept: 'application/json',
        Origin: 'https://www.medicare.gov',
        Referer: 'https://www.medicare.gov/plan-compare/',
        'fe-ver': FE_VER,
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        traceparent: `00-${traceId}-${spanId}-01`,
      },
    });
    console.log(`status: ${resp.status()}  ct: ${resp.headers()['content-type']}`);
    const text = await resp.text();
    const file = path.join(OUT, `detail-${YEAR}-${CONTRACT}-${PLAN}-${SEGMENT}.json`);
    fs.writeFileSync(file, text);
    console.log(`saved ${text.length}B → ${file}`);
    if (resp.ok()) {
      try {
        const j = JSON.parse(text);
        console.log('top-level keys:', Object.keys(j));
      } catch {
        console.log('not JSON');
      }
    } else {
      console.log('preview:', text.slice(0, 400));
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
