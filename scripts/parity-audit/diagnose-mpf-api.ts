#!/usr/bin/env tsx
// MPF API reverse-engineering diagnostic.
//
// Boots real Chrome, navigates to medicare.gov/plan-compare with a real
// beneficiary URL (Durham NC, ZIP 27707), and dumps every /api/v1/data/
// plan-compare/ request + response body the SPA fires. Output goes to
// _tmp/parity-audit/mpf-diagnostic.json plus a live stream on stdout.
//
// Ground-truth for what mpf-scrape.ts should send.
//
// Usage:
//   npx tsx scripts/parity-audit/diagnose-mpf-api.ts        # headless
//   HEADFUL=1 npx tsx scripts/parity-audit/diagnose-mpf-api.ts   # visible
//
// No secrets, no Supabase. Only medicare.gov.

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, '_tmp', 'parity-audit');
mkdirSync(OUT_DIR, { recursive: true });

const API_PREFIX = '/api/v1/data/plan-compare/';

interface Captured {
  seq: number;
  timestamp: string;
  method: string;
  url: string;
  path: string;              // /plans/search, /status, /geography/fips, /plan/…, /formulary/…
  requestHeaders: Record<string, string>;
  postData: string | null;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;     // truncated to 4000 chars
}

const captured: Captured[] = [];
let seq = 0;

function shortPath(url: string): string {
  const i = url.indexOf(API_PREFIX);
  if (i < 0) return url;
  return url.substring(i + API_PREFIX.length - 1).split('?')[0];
}

async function main(): Promise<void> {
  const headless = process.env.HEADFUL !== '1';
  console.log(`[diagnose-mpf] Launching Chrome (headless=${headless})`);

  const browser = await chromium.launch({
    channel: 'chrome',
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  const pending = new Map<string, Captured>();

  page.on('request', async (req) => {
    if (!req.url().includes(API_PREFIX)) return;
    seq += 1;
    const entry: Captured = {
      seq,
      timestamp: new Date().toISOString(),
      method: req.method(),
      url: req.url(),
      path: shortPath(req.url()),
      requestHeaders: await req.allHeaders().catch(() => ({})),
      postData: req.postData() || null,
    };
    captured.push(entry);
    pending.set(`${entry.method}:${entry.url}:${entry.seq}`, entry);
    console.log(`→ [${entry.seq}] ${entry.method} ${entry.path}`);
    if (entry.postData) {
      console.log(`   body: ${entry.postData.substring(0, 800)}`);
    }
  });

  page.on('response', async (res) => {
    if (!res.url().includes(API_PREFIX)) return;
    // Match the newest unresolved request with matching URL+method
    let match: Captured | undefined;
    for (let i = captured.length - 1; i >= 0; i -= 1) {
      const c = captured[i];
      if (c.url === res.url() && c.method === res.request().method() && c.responseStatus === undefined) {
        match = c;
        break;
      }
    }
    const status = res.status();
    console.log(`← [${match?.seq ?? '?'}] ${status} ${shortPath(res.url())}`);
    if (match) {
      match.responseStatus = status;
      try {
        match.responseHeaders = await res.allHeaders();
      } catch { /* ignore */ }
      try {
        const body = await res.text();
        match.responseBody = body.substring(0, 4000);
        if (status !== 200 && status !== 204) {
          console.log(`   resp: ${body.substring(0, 800)}`);
        }
      } catch { /* ignore */ }
    }
  });

  // ─── Phase 1: warm up SPA at landing page ───────────────────────
  console.log('\n[phase 1] Warming session at /plan-compare/ landing');
  await page.goto('https://www.medicare.gov/plan-compare/', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForTimeout(8_000);

  // ─── Phase 2: search-results URL should auto-fire plans search ──
  console.log('\n[phase 2] Navigating to search-results with ZIP 27707 / FIPS 37063 / MAPD');
  const searchUrl =
    'https://www.medicare.gov/plan-compare/#/search-results?plan_type=PLAN_TYPE_MAPD&fips=37063&zip=27707&year=2026';
  await page
    .goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    .catch((err) => console.log(`[phase 2] goto warning: ${(err as Error).message}`));
  await page.waitForTimeout(15_000);

  // ─── Phase 3: prescription-drugs page — captures drug-cost XHR ──
  console.log('\n[phase 3] Navigating to prescription-drugs (drug-entry flow)');
  const drugUrl =
    'https://www.medicare.gov/plan-compare/#/prescription-drugs?plan_type=PLAN_TYPE_MAPD&fips=37063&zip=27707&year=2026';
  await page
    .goto(drugUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    .catch((err) => console.log(`[phase 3] goto warning: ${(err as Error).message}`));
  await page.waitForTimeout(10_000);

  // ─── Phase 4: try our current-shape POST inside the page ────────
  // Fires our best-guess payload against the endpoint from inside the
  // authenticated page context so any 400 surfaces the real error body.
  console.log('\n[phase 4] Firing our current-code payload as a page-context fetch');
  const ourPayloadResult = await page.evaluate(async () => {
    const searchUrl =
      'https://www.medicare.gov/api/v1/data/plan-compare/plans/search?plan_type=PLAN_TYPE_MAPD&snp_type=SNP_TYPE_NOT_SNP&page=0&year=2026&fips=37063&sort_order=ANNUAL_TOTAL&zip=27707';
    const body = {
      npis: [] as string[],
      prescriptions: [
        {
          name: 'Eliquis',
          dosage: '5mg',
          quantity: 60,
          frequency: 'MONTHLY',
          package: 'EACH',
        },
      ],
      lis: 'LIS_NO_HELP',
      starRatings: [] as string[],
      organizationNames: [] as string[],
    };
    try {
      const res = await fetch(searchUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'fe-ver': '2.69.0' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text.substring(0, 3000) };
    } catch (err) {
      return { status: 0, body: (err as Error).message };
    }
  });
  console.log(`[phase 4] Our-payload result: ${ourPayloadResult.status}`);
  console.log(`[phase 4] Response: ${ourPayloadResult.body.substring(0, 600)}`);

  // ─── Phase 5: try MINIMAL payload (empty prescriptions) ─────────
  console.log('\n[phase 5] Firing minimal payload (empty prescriptions array)');
  const minimalResult = await page.evaluate(async () => {
    const searchUrl =
      'https://www.medicare.gov/api/v1/data/plan-compare/plans/search?plan_type=PLAN_TYPE_MAPD&snp_type=SNP_TYPE_NOT_SNP&page=0&year=2026&fips=37063&sort_order=ANNUAL_TOTAL&zip=27707';
    const body = {
      npis: [] as string[],
      prescriptions: [] as unknown[],
      lis: 'LIS_NO_HELP',
      starRatings: [] as string[],
      organizationNames: [] as string[],
    };
    try {
      const res = await fetch(searchUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'fe-ver': '2.69.0' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text.substring(0, 3000) };
    } catch (err) {
      return { status: 0, body: (err as Error).message };
    }
  });
  console.log(`[phase 5] Minimal-payload result: ${minimalResult.status}`);
  console.log(`[phase 5] Response: ${minimalResult.body.substring(0, 400)}`);

  void pending;

  // ─── Persist ────────────────────────────────────────────────────
  console.log(`\n[diagnose-mpf] Captured ${captured.length} /api/v1/ requests`);
  const outFile = path.join(OUT_DIR, 'mpf-diagnostic.json');
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        ourPayloadResult,
        minimalResult,
        requests: captured,
      },
      null,
      2,
    ),
  );
  console.log(`[diagnose-mpf] Written: ${outFile}`);

  console.log('\n--- Path summary ---');
  const byPath = new Map<string, { count: number; statuses: number[] }>();
  for (const c of captured) {
    const key = `${c.method} ${c.path}`;
    if (!byPath.has(key)) byPath.set(key, { count: 0, statuses: [] });
    const s = byPath.get(key)!;
    s.count += 1;
    if (c.responseStatus !== undefined) s.statuses.push(c.responseStatus);
  }
  for (const [key, val] of Array.from(byPath.entries()).sort()) {
    console.log(`  ${key}  ×${val.count}  status=[${val.statuses.join(',')}]`);
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
