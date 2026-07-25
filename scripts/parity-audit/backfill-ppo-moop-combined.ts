#!/usr/bin/env tsx
// Backfill pm_plans.moop_combined for PPO plans by scraping medicare.gov's
// plan-compare API (same source beneficiaries see on MPF UI).
//
// Modes:
//   (no --state)                → 11 audit-universe PPOs (from MPF cache only)
//   --state NC[,TX,GA]          → all PPO plans in those states with null
//                                  moop_combined; uses MPF cache first, then
//                                  Playwright scrape for uncached plans
//   --write                     → executes UPDATEs against pm_plans
//   default is dry-run

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { chromium, type BrowserContext, type Page } from 'playwright-core';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MPF_CACHE_DIR = path.join(REPO_ROOT, '_tmp', 'parity-audit', 'mpf');

const sb = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const YEAR = 2026;
const PLAN_COMPARE_BASE = 'https://www.medicare.gov/plan-compare';
const API_BASE = '/api/v1/data/plan-compare';
const INTER_PLAN_DELAY_MS = 2_000;
const BATCH_SIZE = 50;
const INTER_BATCH_PAUSE_MS = 30_000;
const AKAMAI_BACKOFFS_MS = [5_000, 10_000, 30_000];

function parseCombined(costShare: string): number | null {
  const clean = costShare.replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
  const m = clean.match(/\$([\d,]+)\s+In\s+and\s+Out-of-network/i);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function padSeg(s: string): string {
  return s.padStart(3, '0');
}

function unpadSeg(s: string): string {
  return s.replace(/^0+/, '') || '0';
}

interface PlanKey { contract: string; plan: string; segment: string; name?: string }

// Sweep every cached MPF plan-detail JSON, extract PPO plan + combined MOOP.
function loadCachedCombined(): Map<string, number> {
  const out = new Map<string, number>();
  if (!existsSync(MPF_CACHE_DIR)) return out;
  const profileDirs = readdirSync(MPF_CACHE_DIR).filter((d) =>
    statSync(path.join(MPF_CACHE_DIR, d)).isDirectory(),
  );
  for (const pd of profileDirs) {
    const dir = path.join(MPF_CACHE_DIR, pd);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'snapshot.json');
    for (const f of files) {
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      const card = (raw as { plan_card?: Record<string, unknown> })?.plan_card;
      if (!card) continue;
      const contract = String(card.contract_id ?? '');
      const plan = String(card.plan_id ?? '');
      const segment = padSeg(String(card.segment_id ?? '0'));
      const key = `${contract}-${plan}-${segment}`;
      if (out.has(key)) continue;
      const moopBenefit = (card.package_benefits as Record<string, unknown> | undefined)
        ?.BENEFIT_MAXIMUM_OOPC as { network_costs?: Record<string, { cost_share?: string }> } | undefined;
      const netCosts = moopBenefit?.network_costs ?? {};
      const firstNet = Object.values(netCosts)[0];
      const combined = parseCombined(firstNet?.cost_share ?? '');
      if (combined != null) out.set(key, combined);
    }
  }
  return out;
}

// ─── Playwright / MPF plan-detail fetch (minimal port of mpf-scrape.ts) ─
class AkamaiBlocked extends Error {}

async function bootstrapBrowser(): Promise<{ context: BrowserContext; page: Page; close: () => Promise<void> }> {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: process.env.MG_HEADFUL !== '1',
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
  await page.goto(`${PLAN_COMPARE_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(8_000);
  // Session warm — hit /status once
  const warm = await page.evaluate(async (base) => {
    try {
      const r = await fetch(`${base}/status`, { credentials: 'include' });
      return { s: r.status, t: (await r.text()).slice(0, 100) };
    } catch (e) { return { s: -1, t: (e as Error).message }; }
  }, API_BASE);
  if (warm.s !== 200) {
    if (warm.s === 403 || /Access Denied/i.test(warm.t)) throw new AkamaiBlocked('warmup 403');
    throw new Error(`MPF warmup failed: ${warm.s}`);
  }
  return { context, page, close: async () => { await context.close(); await browser.close(); } };
}

async function fetchPlanDetail(page: Page, plan: PlanKey): Promise<number | null> {
  const seg = unpadSeg(plan.segment);
  const url = `${API_BASE}/plan/${YEAR}/${plan.contract}/${plan.plan}/${seg}?lis=LIS_NO_HELP`;
  const resp = await page.evaluate(async (p) => {
    try {
      const r = await fetch(p, { credentials: 'include', headers: { Accept: 'application/json' } });
      return { s: r.status, t: await r.text() };
    } catch (e) { return { s: -1, t: (e as Error).message }; }
  }, url);
  if (resp.s === 403 || /Access Denied/i.test(resp.t)) throw new AkamaiBlocked(url);
  if (resp.s !== 200) {
    console.warn(`  [${plan.contract}-${plan.plan}-${seg}] HTTP ${resp.s} — skip`);
    return null;
  }
  let json: unknown;
  try { json = JSON.parse(resp.t); } catch { return null; }
  const card = (json as { plan_card?: Record<string, unknown> })?.plan_card;
  if (!card) return null;
  const moopBenefit = (card.package_benefits as Record<string, unknown> | undefined)
    ?.BENEFIT_MAXIMUM_OOPC as { network_costs?: Record<string, { cost_share?: string }> } | undefined;
  const netCosts = moopBenefit?.network_costs ?? {};
  const firstNet = Object.values(netCosts)[0];
  return parseCombined(firstNet?.cost_share ?? '');
}

async function sleep(ms: number): Promise<void> { await new Promise((r) => setTimeout(r, ms)); }

// ─── Main ─────────────────────────────────────────────────────────────

async function collectTargets(states: string[] | null): Promise<PlanKey[]> {
  if (!states) {
    // Legacy mode — 11 audit plans from cache only
    const cached = loadCachedCombined();
    return [...cached.keys()].map((k) => {
      const [contract, plan, segment] = k.split('-');
      return { contract, plan, segment };
    });
  }
  // Fetch PPO plans in states with null moop_combined
  const rows = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name')
    .in('state', states)
    .ilike('plan_type', '%ppo%')
    .is('moop_combined', null);
  if (rows.error) throw rows.error;
  const seen = new Set<string>();
  const out: PlanKey[] = [];
  for (const r of rows.data ?? []) {
    const rr = r as { contract_id: string; plan_id: string; segment_id: string | null; plan_name?: string };
    const segment = padSeg(rr.segment_id ?? '000');
    const key = `${rr.contract_id}-${rr.plan_id}-${segment}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ contract: rr.contract_id, plan: rr.plan_id, segment, name: rr.plan_name });
  }
  return out;
}

async function updatePmPlans(plan: PlanKey, combined: number): Promise<boolean> {
  const unpadded = unpadSeg(plan.segment);
  const u = await sb
    .from('pm_plans')
    .update({ moop_combined: combined })
    .eq('contract_id', plan.contract).eq('plan_id', plan.plan)
    .in('segment_id', [plan.segment, unpadded]);
  return !u.error;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isWrite = args.includes('--write');
  const stateArg = args.find((a) => a.startsWith('--state='))?.slice(8) ?? args[args.indexOf('--state') + 1];
  const states = stateArg ? stateArg.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null;

  const start = Date.now();
  console.log(`=== ${isWrite ? 'WRITE' : 'DRY-RUN'} MODE ===`);
  console.log(`States: ${states ? states.join(',') : '(audit-cache only)'}`);

  const targets = await collectTargets(states);
  console.log(`Targets: ${targets.length} plans\n`);
  if (targets.length === 0) { console.log('nothing to do'); return; }

  const cached = loadCachedCombined();
  const cacheHits = targets.filter((t) => cached.has(`${t.contract}-${t.plan}-${t.segment}`));
  const cacheMisses = targets.filter((t) => !cached.has(`${t.contract}-${t.plan}-${t.segment}`));
  console.log(`Cache hits: ${cacheHits.length}  |  Need scrape: ${cacheMisses.length}\n`);

  const results = new Map<string, number>();
  for (const t of cacheHits) {
    const key = `${t.contract}-${t.plan}-${t.segment}`;
    results.set(key, cached.get(key)!);
  }

  // Scrape uncached
  let session: { page: Page; close: () => Promise<void> } | null = null;
  let scraped = 0;
  let scrapeFailed = 0;
  if (cacheMisses.length > 0) {
    console.log(`Bootstrapping headless Chrome…`);
    session = await bootstrapBrowser();
    console.log(`OK\n`);

    for (let i = 0; i < cacheMisses.length; i++) {
      const t = cacheMisses[i];
      if (i > 0 && i % BATCH_SIZE === 0) {
        console.log(`  --- batch pause ${INTER_BATCH_PAUSE_MS}ms (${i}/${cacheMisses.length}) ---`);
        await sleep(INTER_BATCH_PAUSE_MS);
      }
      let attempt = 0;
      let combined: number | null = null;
      for (;;) {
        try {
          combined = await fetchPlanDetail(session.page, t);
          break;
        } catch (e) {
          if (e instanceof AkamaiBlocked && attempt < AKAMAI_BACKOFFS_MS.length) {
            const back = AKAMAI_BACKOFFS_MS[attempt];
            console.warn(`  Akamai block, backoff ${back}ms then reboot`);
            await session.close();
            await sleep(back);
            session = await bootstrapBrowser();
            attempt += 1;
            continue;
          }
          throw e;
        }
      }
      const key = `${t.contract}-${t.plan}-${t.segment}`;
      if (combined != null) {
        results.set(key, combined);
        scraped += 1;
      } else {
        scrapeFailed += 1;
      }
      if ((i + 1) % 10 === 0) {
        console.log(`  progress: ${i + 1}/${cacheMisses.length}  scraped=${scraped} failed=${scrapeFailed}`);
      }
      await sleep(INTER_PLAN_DELAY_MS);
    }
    await session.close();
  }

  console.log(`\nResults: ${results.size} plans with combined MOOP resolved`);
  console.log(`  cache hits: ${cacheHits.length}`);
  console.log(`  scraped:    ${scraped}`);
  console.log(`  scrape misses (no combined MOOP returned): ${scrapeFailed}`);

  // Sanity check: any values outside $3k-$15k?
  const outliers: string[] = [];
  for (const [k, v] of results) {
    if (v < 3000 || v > 15000) outliers.push(`${k}: $${v}`);
  }
  if (outliers.length > 0) {
    console.log(`\n⚠ ${outliers.length} outlier values (outside $3k-$15k range):`);
    outliers.forEach((o) => console.log(`  ${o}`));
  }

  if (!isWrite) {
    console.log('\n(dry-run — pass --write to execute UPDATEs)');
    return;
  }

  console.log('\n--- executing UPDATEs ---');
  let updated = 0;
  let updateFailed = 0;
  for (const t of targets) {
    const key = `${t.contract}-${t.plan}-${t.segment}`;
    const combined = results.get(key);
    if (combined == null) continue;
    const ok = await updatePmPlans(t, combined);
    if (ok) updated += 1;
    else updateFailed += 1;
  }

  const elapsed = ((Date.now() - start) / 1000 / 60).toFixed(1);
  console.log(`\n=== SUMMARY ===`);
  console.log(`Duration: ${elapsed} min`);
  console.log(`UPDATE: ${updated} succeeded, ${updateFailed} failed`);
  console.log(`Skipped (no combined MOOP available): ${targets.length - results.size}`);

  // Per-state breakdown
  if (states) {
    for (const s of states) {
      const stateRows = await sb
        .from('pm_plans')
        .select('*', { count: 'exact', head: true })
        .ilike('plan_type', '%ppo%')
        .eq('state', s)
        .not('moop_combined', 'is', null)
        .gt('moop_combined', 0);
      const stateNull = await sb
        .from('pm_plans')
        .select('*', { count: 'exact', head: true })
        .ilike('plan_type', '%ppo%')
        .eq('state', s)
        .is('moop_combined', null);
      console.log(`  ${s}: ${stateRows.count} rows with combined MOOP, ${stateNull.count} still null`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
