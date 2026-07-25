#!/usr/bin/env tsx
// MPF ground-truth resolver for the 81 chiropractic VALUE_MISMATCH
// plans surfaced by audit-diabetes-chiro-acupuncture.ts. For each
// plan, hits medicare.gov's plan-compare API, extracts the CHIROPRACTIC
// service's in-network cost sharing, and compares against pm_plan_
// benefits + pbp_benefits. When pm disagrees with MPF, updates pm to
// match — MPF is what the beneficiary actually sees, so it wins.
//
// Reuses the Playwright + real-Chrome + Akamai-warmup pattern from
// backfill-ppo-moop-combined.ts. Rate-limited (2s inter-plan, 30s
// batch pause). Cached MPF JSONs from _tmp/parity-audit/mpf/ are
// consulted first to skip re-scraping.
//
// Modes:
//   default   → dry-run summary (fetch + compare, no writes)
//   --write   → additionally UPDATE pm_plan_benefits rows where pm
//               loses to MPF

import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
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
const OUT_DIR = path.join(REPO_ROOT, '_tmp', 'parity-audit');
const MPF_CACHE_DIR = path.join(OUT_DIR, 'mpf');
const AUDIT_CSV = path.join(OUT_DIR, 'dca-audit-2026-07-25T15-17-29.csv');

const sb = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const YEAR = 2026;
const PLAN_COMPARE_BASE = 'https://www.medicare.gov/plan-compare';
const API_BASE = '/api/v1/data/plan-compare';
const INTER_PLAN_DELAY_MS = 2_000;
const BATCH_SIZE = 30;
const INTER_BATCH_PAUSE_MS = 30_000;
const AKAMAI_BACKOFFS_MS = [5_000, 10_000, 30_000];

class AkamaiBlocked extends Error {}

interface DisputeRow {
  contract: string;
  plan: string;
  segment: string;
  planName: string;
  carrier: string;
  state: string;
  pmCopay: number | null;
  pbpCopay: number | null;
  pbpDesc: string;
}

function parseCsvDisputes(): DisputeRow[] {
  const raw = readFileSync(AUDIT_CSV, 'utf8').split('\n').slice(1);
  const out: DisputeRow[] = [];
  for (const line of raw) {
    if (!line.trim()) continue;
    // Simple CSV parse — audit script quotes fields with special chars
    // Use a proper splitter that respects double-quoted commas.
    const fields: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (c === ',' && !inQ) { fields.push(cur); cur = ''; }
      else cur += c;
    }
    fields.push(cur);
    if (fields[8] !== 'chiropractic' || fields[13] !== 'VALUE_MISMATCH') continue;
    const pmCopay = fields[9] === '' ? null : Number(fields[9]);
    const pbpBest = fields[12]; // "cms_pbp: copay=15 max=15 coins=null desc=..."
    const m = pbpBest.match(/copay=([\d.]+|null)/);
    const pbpCopay = m && m[1] !== 'null' ? Number(m[1]) : null;
    out.push({
      contract: fields[0], plan: fields[1], segment: fields[2],
      planName: fields[3], carrier: fields[4], state: fields[5],
      pmCopay, pbpCopay, pbpDesc: pbpBest,
    });
  }
  return out;
}

// Reuse cached JSONs where possible
function loadCachedPlan(contract: string, plan: string, segment: string): unknown | null {
  if (!existsSync(MPF_CACHE_DIR)) return null;
  const seg = segment.padStart(1, '0'); // MPF cache files use "H1234-005-0" pattern
  const filename = `${contract}-${plan}-${seg}.json`;
  const profileDirs = readdirSync(MPF_CACHE_DIR).filter((d) => statSync(path.join(MPF_CACHE_DIR, d)).isDirectory());
  for (const pd of profileDirs) {
    const p = path.join(MPF_CACHE_DIR, pd, filename);
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, 'utf8')); } catch { /* keep looking */ }
    }
  }
  return null;
}

interface MpfChiro {
  copay: number | null;
  coinsurance: number | null;
  maxCopay: number | null;
  visitLimit: string | null;
  type: string;  // MEDICARE_COVERED / MANDATORY_SUPPLEMENTAL
}

function extractChiro(planJson: unknown): MpfChiro | null {
  const card = (planJson as { plan_card?: { ma_benefits?: unknown[] } })?.plan_card;
  const arr = (card?.ma_benefits ?? []) as Array<{
    service?: string; category?: string; type?: string;
    cost_sharing?: Array<{ network_status?: string; min_copay?: number | null; max_copay?: number | null; min_coinsurance?: number | null; max_coinsurance?: number | null }>;
    plan_limits_details?: Array<{ limit_type?: string; limit_value?: number; limit_period?: string }>;
  }>;
  const chiro = arr.find((b) => b.service === 'CHIROPRACTIC' || /^CHIROPRACTIC$/i.test(b.category ?? ''));
  if (!chiro) return null;
  const inNet = (chiro.cost_sharing ?? []).find((cs) => cs.network_status === 'IN_NETWORK');
  if (!inNet) return null;
  const visitLimit = (chiro.plan_limits_details ?? [])
    .filter((l) => l.limit_type === 'BENEFIT_LIMIT_TYPE_VISITS')
    .map((l) => `${l.limit_value} visits/${(l.limit_period ?? '').replace('BENEFIT_LIMIT_PERIOD_', '').toLowerCase()}`)
    .join('; ') || null;
  return {
    copay: inNet.min_copay ?? null,
    coinsurance: inNet.min_coinsurance ?? null,
    maxCopay: inNet.max_copay ?? null,
    visitLimit,
    type: chiro.type ?? '',
  };
}

// ── Playwright bootstrap (copied from backfill-ppo-moop-combined.ts) ──
async function bootstrapBrowser(): Promise<{ context: BrowserContext; page: Page; close: () => Promise<void> }> {
  const browser = await chromium.launch({ channel: 'chrome', headless: process.env.MG_HEADFUL !== '1', args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'America/New_York',
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await context.newPage();
  await page.goto(`${PLAN_COMPARE_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(8_000);
  const warm = await page.evaluate(async (base) => {
    try { const r = await fetch(`${base}/status`, { credentials: 'include' }); return { s: r.status, t: (await r.text()).slice(0, 100) }; }
    catch (e) { return { s: -1, t: (e as Error).message }; }
  }, API_BASE);
  if (warm.s !== 200) {
    if (warm.s === 403 || /Access Denied/i.test(warm.t)) throw new AkamaiBlocked('warmup');
    throw new Error(`MPF warmup ${warm.s}`);
  }
  return { context, page, close: async () => { await context.close(); await browser.close(); } };
}

async function fetchPlanJson(page: Page, contract: string, plan: string, segment: string): Promise<unknown | null> {
  const seg = segment.replace(/^0+/, '') || '0';
  const url = `${API_BASE}/plan/${YEAR}/${contract}/${plan}/${seg}?lis=LIS_NO_HELP`;
  const resp = await page.evaluate(async (p) => {
    try { const r = await fetch(p, { credentials: 'include', headers: { Accept: 'application/json' } }); return { s: r.status, t: await r.text() }; }
    catch (e) { return { s: -1, t: (e as Error).message }; }
  }, url);
  if (resp.s === 403 || /Access Denied/i.test(resp.t)) throw new AkamaiBlocked(url);
  if (resp.s !== 200) { console.warn(`  [${contract}-${plan}-${seg}] HTTP ${resp.s}`); return null; }
  try { return JSON.parse(resp.t); } catch { return null; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Main ────────────────────────────────────────────────────────────

interface ResolvedRow extends DisputeRow {
  mpfCopay: number | null;
  mpfCoins: number | null;
  mpfMaxCopay: number | null;
  mpfVisitLimit: string | null;
  mpfType: string;
  cameFromCache: boolean;
  verdict: 'PM_MATCHES_MPF' | 'PBP_MATCHES_MPF' | 'NEITHER_MATCHES' | 'NO_MPF_DATA' | 'FETCH_FAILED';
}

async function main() {
  const disputes = parseCsvDisputes();
  console.log(`=== ${WRITE ? 'WRITE' : 'DRY-RUN'} MODE ===`);
  console.log(`Loaded ${disputes.length} chiro disputes from ${path.basename(AUDIT_CSV)}`);

  const resolved: ResolvedRow[] = [];
  const needScrape: DisputeRow[] = [];

  // Cache pass
  for (const d of disputes) {
    const cached = loadCachedPlan(d.contract, d.plan, d.segment);
    if (cached) {
      const c = extractChiro(cached);
      resolved.push(buildResolved(d, c, true));
    } else {
      needScrape.push(d);
    }
  }
  console.log(`Cache hits: ${resolved.length}  |  need scrape: ${needScrape.length}`);

  // Scrape pass
  if (needScrape.length > 0) {
    console.log(`Bootstrapping headless Chrome…`);
    let session = await bootstrapBrowser();
    console.log(`OK`);
    for (let i = 0; i < needScrape.length; i++) {
      const d = needScrape[i];
      if (i > 0 && i % BATCH_SIZE === 0) { console.log(`  --- batch pause ${INTER_BATCH_PAUSE_MS}ms (${i}/${needScrape.length}) ---`); await sleep(INTER_BATCH_PAUSE_MS); }
      let attempt = 0;
      let json: unknown | null = null;
      for (;;) {
        try { json = await fetchPlanJson(session.page, d.contract, d.plan, d.segment); break; }
        catch (e) {
          if (e instanceof AkamaiBlocked && attempt < AKAMAI_BACKOFFS_MS.length) {
            console.warn(`  Akamai block, backoff ${AKAMAI_BACKOFFS_MS[attempt]}ms`);
            await session.close(); await sleep(AKAMAI_BACKOFFS_MS[attempt]);
            session = await bootstrapBrowser(); attempt++; continue;
          }
          throw e;
        }
      }
      if (json == null) { resolved.push(buildResolved(d, null, false, 'FETCH_FAILED')); }
      else {
        const c = extractChiro(json);
        resolved.push(buildResolved(d, c, false));
      }
      if ((i + 1) % 10 === 0) console.log(`  progress: ${i + 1}/${needScrape.length}`);
      if (i < needScrape.length - 1) await sleep(INTER_PLAN_DELAY_MS);
    }
    await session.close();
  }

  // Summary
  const byVerdict = new Map<string, number>();
  for (const r of resolved) byVerdict.set(r.verdict, (byVerdict.get(r.verdict) ?? 0) + 1);
  console.log(`\n=== Verdict summary ===`);
  for (const [v, n] of [...byVerdict.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${v.padEnd(24)} ${n}`);

  // CSV
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const csvPath = path.join(OUT_DIR, `chiro-mpf-spotcheck-${ts}.csv`);
  const esc = (s: string | number | null): string => { if (s == null) return ''; const v = String(s).replace(/"/g, '""'); return /[,"\n]/.test(v) ? `"${v}"` : v; };
  const header = 'contract,plan,segment,plan_name,carrier,state,pm_copay,pbp_copay,mpf_copay,mpf_coins,mpf_max_copay,mpf_visit_limit,mpf_type,came_from_cache,verdict';
  const lines = [header, ...resolved.map((r) => [r.contract, r.plan, r.segment, r.planName, r.carrier, r.state, r.pmCopay, r.pbpCopay, r.mpfCopay, r.mpfCoins, r.mpfMaxCopay, r.mpfVisitLimit, r.mpfType, r.cameFromCache ? 'yes' : 'no', r.verdict].map(esc).join(','))];
  writeFileSync(csvPath, lines.join('\n'));
  console.log(`\nCSV: ${csvPath}`);

  // Write updates
  if (WRITE) {
    const losers = resolved.filter((r) => r.verdict === 'PBP_MATCHES_MPF' || r.verdict === 'NEITHER_MATCHES');
    console.log(`\n=== Applying ${losers.length} pm_plan_benefits UPDATEs ===`);
    let ok = 0, err = 0;
    for (const r of losers) {
      const newCopay = r.mpfCopay;
      const newCoins = r.mpfCoins;
      const newMax = r.mpfMaxCopay != null && r.mpfCopay != null && r.mpfMaxCopay > r.mpfCopay ? r.mpfMaxCopay : null;
      const desc = newCoins != null
        ? `Chiropractic services · ${newCoins}% coinsurance`
        : newCopay === 0 && newMax != null ? `Chiropractic services · $0–$${newMax} copay`
        : newCopay != null ? `Chiropractic services · $${newCopay} copay`
        : `Chiropractic services`;
      const u = await sb.from('pm_plan_benefits').update({
        copay: newCopay, coinsurance: newCoins, max_coverage: newMax, benefit_description: desc,
      })
        .eq('contract_id', r.contract).eq('plan_id', r.plan).eq('segment_id', r.segment)
        .eq('benefit_category', 'chiropractic');
      if (u.error) { console.error(`  UPDATE ${r.contract}-${r.plan}-${r.segment}: ${u.error.message}`); err++; }
      else ok++;
    }
    console.log(`  UPDATE: ${ok} ok, ${err} failed`);
  } else {
    const losers = resolved.filter((r) => r.verdict === 'PBP_MATCHES_MPF' || r.verdict === 'NEITHER_MATCHES');
    console.log(`\n(dry-run — would UPDATE ${losers.length} pm_plan_benefits rows on --write)`);
  }
}

function buildResolved(d: DisputeRow, c: MpfChiro | null, cache: boolean, forceVerdict?: ResolvedRow['verdict']): ResolvedRow {
  const base = {
    ...d,
    mpfCopay: c?.copay ?? null, mpfCoins: c?.coinsurance ?? null,
    mpfMaxCopay: c?.maxCopay ?? null, mpfVisitLimit: c?.visitLimit ?? null,
    mpfType: c?.type ?? '',
    cameFromCache: cache,
  };
  let verdict: ResolvedRow['verdict'];
  if (forceVerdict) verdict = forceVerdict;
  else if (!c) verdict = 'NO_MPF_DATA';
  else {
    const mpfEff = c.copay ?? (c.coinsurance != null ? -c.coinsurance : null); // hack — coins vs copay differentiated by sign
    const pmMatch = d.pmCopay != null && c.copay != null && d.pmCopay === c.copay;
    const pbpMatch = d.pbpCopay != null && c.copay != null && d.pbpCopay === c.copay;
    void mpfEff;
    if (pmMatch) verdict = 'PM_MATCHES_MPF';
    else if (pbpMatch) verdict = 'PBP_MATCHES_MPF';
    else verdict = 'NEITHER_MATCHES';
  }
  return { ...base, verdict };
}

main().catch((e) => { console.error(e); process.exit(1); });
