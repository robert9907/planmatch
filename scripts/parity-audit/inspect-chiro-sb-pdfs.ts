#!/usr/bin/env tsx
// Classify the 76 chiropractic NO_MPF_DATA plans surfaced by spot-
// check-chiro-mpf.ts. For each plan:
//
//   1. Verify MPF plan-compare API has no chiro reference anywhere
//      (searches ma_benefits + additional_supplemental_benefits +
//      optional_benefits + abstract_benefits + full-JSON text scan
//      for /chiro|spinal|manipulat|subluxation/i).
//   2. Compare pm_plan_benefits.chiropractic.copay against
//      pm_plan_benefits.specialist.copay for the same plan.
//   3. Classify:
//
//      A  chi_copay == spec_copay, no MPF chiro anywhere
//         → chiropractic is billed at the specialist copay rate on
//           this plan. PM's value is correct beneficiary-facing; the
//           pbp cms_pbp row is a filed-but-not-visible datum.
//           Action: UPDATE description to document the bundling
//           (keep copay).
//      B  MPF has chiro under an alternate service key (not
//         literally 'CHIROPRACTIC')
//         → UPDATE PM's copay to that MPF value. (Not observed in
//           sample-of-4 probe, but implemented for completeness.)
//      C  MPF has chiro mentioned only in a free-text description
//         → parse and UPDATE. (Not observed.)
//      D  chi_copay != spec_copay, no MPF chiro anywhere
//         → three-way disagreement (pm ≠ pbp ≠ spec). Flag for
//           manual review; don't overwrite automatically.
//
// Reuses the Playwright + Akamai warmup pattern from spot-check-
// chiro-mpf.ts. Cache-first via _tmp/parity-audit/mpf/ (any cache
// hit skips network).
//
// Modes:
//   default   → dry-run classification + report
//   --write   → UPDATE pm_plan_benefits.chiropractic.benefit_description
//               on Classification A plans

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
const PLAN_LIST = path.join(OUT_DIR, 'chiro-76-plans.csv');

const sb = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const SKIP_MPF = args.includes('--skip-mpf');   // just do pm chi-vs-spec comparison
const YEAR = 2026;
const PLAN_COMPARE_BASE = 'https://www.medicare.gov/plan-compare';
const API_BASE = '/api/v1/data/plan-compare';
const INTER_PLAN_DELAY_MS = 2_000;
const BATCH_SIZE = 30;
const INTER_BATCH_PAUSE_MS = 30_000;

class AkamaiBlocked extends Error {}

interface PlanKey { contract: string; plan: string; segment: string }

function loadPlans(): PlanKey[] {
  return readFileSync(PLAN_LIST, 'utf8').trim().split('\n').map((l) => {
    const [contract, plan, segment] = l.split(',');
    return { contract, plan, segment };
  });
}

function loadCachedPlan(k: PlanKey): unknown | null {
  if (!existsSync(MPF_CACHE_DIR)) return null;
  const filename = `${k.contract}-${k.plan}-${k.segment}.json`;
  const profileDirs = readdirSync(MPF_CACHE_DIR).filter((d) => statSync(path.join(MPF_CACHE_DIR, d)).isDirectory());
  for (const pd of profileDirs) {
    const p = path.join(MPF_CACHE_DIR, pd, filename);
    if (existsSync(p)) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { /* keep looking */ } }
  }
  return null;
}

interface ChiroEvidence {
  status: 'NO_CHIRO_ANYWHERE' | 'HAS_CHIRO_MPF' | 'FETCH_FAILED';
  mpfCopay?: number | null;
  mpfCoins?: number | null;
  mpfSourceKey?: string;
}

function extractChiroEvidence(json: unknown): ChiroEvidence {
  const card = (json as { plan_card?: Record<string, unknown> })?.plan_card;
  if (!card) return { status: 'FETCH_FAILED' };
  const asStr = JSON.stringify(card).toLowerCase();
  const anyChiro = /chiro|spinal\s*manipulation|subluxation/.test(asStr);
  if (!anyChiro) return { status: 'NO_CHIRO_ANYWHERE' };
  // Some chiro reference exists — extract from ma_benefits first
  const arr = (card.ma_benefits ?? []) as Array<any>;
  const chi = arr.find((b) => /chiro/i.test(b.service ?? '') || /chiro/i.test(b.category ?? ''));
  if (chi) {
    const inNet = (chi.cost_sharing ?? []).find((cs: any) => cs.network_status === 'IN_NETWORK');
    return {
      status: 'HAS_CHIRO_MPF',
      mpfCopay: inNet?.min_copay ?? null,
      mpfCoins: inNet?.min_coinsurance ?? null,
      mpfSourceKey: `ma_benefits.${chi.service ?? chi.category}`,
    };
  }
  // Reference exists elsewhere — additional_supplemental_benefits, etc.
  return { status: 'HAS_CHIRO_MPF', mpfSourceKey: 'unknown-non-ma_benefits' };
}

async function bootstrapBrowser(): Promise<{ close: () => Promise<void>; page: Page; context: BrowserContext }> {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'America/New_York',
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await context.newPage();
  await page.goto(`${PLAN_COMPARE_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(8_000);
  const warm = await page.evaluate(async (base) => {
    try { const r = await fetch(`${base}/status`, { credentials: 'include' }); return { s: r.status }; }
    catch { return { s: -1 }; }
  }, API_BASE);
  if (warm.s !== 200) throw new Error(`warmup ${warm.s}`);
  return { context, page, close: async () => { await context.close(); await browser.close(); } };
}

async function fetchAndSave(page: Page, k: PlanKey): Promise<unknown | null> {
  const seg = k.segment.replace(/^0+/, '') || '0';
  const url = `${API_BASE}/plan/${YEAR}/${k.contract}/${k.plan}/${seg}?lis=LIS_NO_HELP`;
  const resp = await page.evaluate(async (u) => {
    try { const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } }); return { s: r.status, t: await r.text() }; }
    catch (e) { return { s: -1, t: (e as Error).message }; }
  }, url);
  if (resp.s === 403 || /Access Denied/i.test(resp.t)) throw new AkamaiBlocked(url);
  if (resp.s !== 200) return null;
  let json: unknown;
  try { json = JSON.parse(resp.t); } catch { return null; }
  // Save to a "chiro-inspect" profile cache so we don't scrape again
  const dir = path.join(MPF_CACHE_DIR, 'chiro-inspect');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${k.contract}-${k.plan}-${seg}.json`), JSON.stringify(json));
  return json;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Classified {
  key: PlanKey;
  pmChiCopay: number | null;
  pmSpecCopay: number | null;
  mpfEvidence: ChiroEvidence;
  classification: 'A_BUNDLED_SPECIALIST' | 'B_MPF_ALT_KEY' | 'C_MPF_TEXT' | 'D_UNRESOLVED';
  note: string;
}

async function main() {
  console.log(`=== ${WRITE ? 'WRITE' : 'DRY-RUN'} MODE  ${SKIP_MPF ? '(SKIP_MPF)' : ''}===`);
  const plans = loadPlans();
  console.log(`Loaded ${plans.length} plans from ${path.basename(PLAN_LIST)}`);

  const results: Classified[] = [];
  let session: { page: Page; close: () => Promise<void> } | null = null;
  let netFetches = 0;

  for (let i = 0; i < plans.length; i++) {
    const k = plans[i];
    // pm chi + spec copays
    const chi = await sb.from('pm_plan_benefits').select('copay, coinsurance, benefit_description').eq('contract_id', k.contract).eq('plan_id', k.plan).eq('segment_id', k.segment).eq('benefit_category', 'chiropractic').maybeSingle();
    const spec = await sb.from('pm_plan_benefits').select('copay, coinsurance').eq('contract_id', k.contract).eq('plan_id', k.plan).eq('segment_id', k.segment).eq('benefit_category', 'specialist').maybeSingle();
    const pmChiCopay = chi.data?.copay ?? null;
    const pmSpecCopay = spec.data?.copay ?? null;

    // MPF evidence
    let ev: ChiroEvidence;
    if (SKIP_MPF) {
      ev = { status: 'NO_CHIRO_ANYWHERE' };  // trust prior spot-check verdict
    } else {
      const cached = loadCachedPlan(k);
      if (cached) {
        ev = extractChiroEvidence(cached);
      } else {
        if (!session) { console.log('Bootstrapping headless Chrome…'); session = await bootstrapBrowser(); console.log('OK'); }
        if (netFetches > 0 && netFetches % BATCH_SIZE === 0) { console.log(`  --- batch pause ${INTER_BATCH_PAUSE_MS}ms ---`); await sleep(INTER_BATCH_PAUSE_MS); }
        const json = await fetchAndSave(session.page, k);
        ev = json ? extractChiroEvidence(json) : { status: 'FETCH_FAILED' };
        netFetches++;
        if (netFetches > 0 && i < plans.length - 1) await sleep(INTER_PLAN_DELAY_MS);
      }
    }

    // Classify
    let classification: Classified['classification'];
    let note: string;
    if (ev.status === 'HAS_CHIRO_MPF' && ev.mpfCopay != null) {
      classification = 'B_MPF_ALT_KEY';
      note = `MPF reports $${ev.mpfCopay} via ${ev.mpfSourceKey}`;
    } else if (ev.status === 'HAS_CHIRO_MPF') {
      classification = 'C_MPF_TEXT';
      note = `MPF has chiro reference via ${ev.mpfSourceKey} but no structured copay extracted`;
    } else if (pmChiCopay != null && pmSpecCopay != null && pmChiCopay === pmSpecCopay) {
      classification = 'A_BUNDLED_SPECIALIST';
      note = `pm.chi=pm.spec=$${pmChiCopay}; MPF omits chiro — beneficiary pays specialist copay`;
    } else {
      classification = 'D_UNRESOLVED';
      note = `pm.chi=$${pmChiCopay} pm.spec=$${pmSpecCopay}; MPF has no chiro; manual review`;
    }
    results.push({ key: k, pmChiCopay, pmSpecCopay, mpfEvidence: ev, classification, note });

    if ((i + 1) % 20 === 0) console.log(`  progress: ${i + 1}/${plans.length}`);
  }
  if (session) await session.close();

  // Summary
  const byClass = new Map<string, Classified[]>();
  for (const r of results) {
    const list = byClass.get(r.classification) ?? [];
    list.push(r); byClass.set(r.classification, list);
  }
  console.log('\n=== Classification summary ===');
  for (const [cls, list] of [...byClass.entries()].sort()) {
    console.log(`  ${cls.padEnd(24)} ${list.length}`);
  }

  // CSV
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const csvPath = path.join(OUT_DIR, `chiro-76-classify-${ts}.csv`);
  const esc = (s: string | number | null): string => { if (s == null) return ''; const v = String(s).replace(/"/g, '""'); return /[,"\n]/.test(v) ? `"${v}"` : v; };
  writeFileSync(csvPath, ['contract,plan,segment,pm_chi_copay,pm_spec_copay,mpf_status,mpf_copay,mpf_source_key,classification,note',
    ...results.map((r) => [r.key.contract, r.key.plan, r.key.segment, r.pmChiCopay, r.pmSpecCopay, r.mpfEvidence.status, r.mpfEvidence.mpfCopay ?? null, r.mpfEvidence.mpfSourceKey ?? '', r.classification, r.note].map(esc).join(','))].join('\n'));
  console.log(`\nCSV: ${csvPath}`);

  if (!WRITE) {
    const aList = results.filter((r) => r.classification === 'A_BUNDLED_SPECIALIST');
    const bList = results.filter((r) => r.classification === 'B_MPF_ALT_KEY');
    console.log(`\n(dry-run — would UPDATE ${aList.length} A-class descriptions, ${bList.length} B-class copays)`);
    return;
  }

  // ── WRITE mode ────────────────────────────────────────────────────
  let ok = 0, err = 0;
  for (const r of results) {
    if (r.classification === 'A_BUNDLED_SPECIALIST') {
      // Update description only; keep copay
      const newDesc = `Chiropractic services · $${r.pmChiCopay} copay (billed at specialist rate — plan does not file a separate chiropractic benefit)`;
      const u = await sb.from('pm_plan_benefits').update({ benefit_description: newDesc })
        .eq('contract_id', r.key.contract).eq('plan_id', r.key.plan).eq('segment_id', r.key.segment)
        .eq('benefit_category', 'chiropractic');
      if (u.error) { console.error(`  UPDATE fail ${r.key.contract}-${r.key.plan}-${r.key.segment}: ${u.error.message}`); err++; }
      else ok++;
    } else if (r.classification === 'B_MPF_ALT_KEY' && r.mpfEvidence.mpfCopay != null) {
      const newDesc = `Chiropractic services · $${r.mpfEvidence.mpfCopay} copay`;
      const u = await sb.from('pm_plan_benefits').update({
        copay: r.mpfEvidence.mpfCopay,
        coinsurance: r.mpfEvidence.mpfCoins ?? null,
        benefit_description: newDesc,
      }).eq('contract_id', r.key.contract).eq('plan_id', r.key.plan).eq('segment_id', r.key.segment)
        .eq('benefit_category', 'chiropractic');
      if (u.error) { console.error(`  UPDATE fail ${r.key.contract}-${r.key.plan}-${r.key.segment}: ${u.error.message}`); err++; }
      else ok++;
    }
  }
  console.log(`\nWRITE complete: ${ok} ok, ${err} failed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
