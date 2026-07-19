#!/usr/bin/env node
// scripts/_scrape-mapd-detail.mjs — MAPD non-SNP plan-detail scrape.
//
// Phase 3 needs per-plan detail for the 115 MAPD non-SNP plans that
// matched in Phase 2. The MAPD cache at _tmp/medicare-gov/*.json only
// has /plans/search results; benefit breakdowns require the detail
// endpoint. Same shape as scripts/_scrape-snp-detail.mjs — different
// input set.
//
// Source of matched keys: _tmp/parity-data/*-FINAL.json (fieldDiffs +
// intersection). Simpler: enumerate MAPD non-SNP from the 5 MAPD cache
// files and dedupe.
//
// Writes: _tmp/medicare-gov-mapd/detail/{contract}-{plan}-{segment}.json
// Idempotent (skip existing).
//
// Run: node scripts/_scrape-mapd-detail.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '_tmp', 'medicare-gov-mapd', 'detail');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const WARM_URL = 'https://www.medicare.gov/plan-compare/';
const FE_VER = '2.69.0';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const YEAR = 2026;
const PER_PLAN_DELAY = 1500;

function h() {
  const t = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
  const s = [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
  return {
    Accept: 'application/json',
    Origin: 'https://www.medicare.gov',
    Referer: 'https://www.medicare.gov/plan-compare/',
    'fe-ver': FE_VER,
    traceparent: `00-${t}-${s}-01`,
  };
}

const MAPD_CACHES = [
  { path: '_tmp/medicare-gov/27713-37063.json', label: 'Durham NC' },
  { path: '_tmp/medicare-gov/77001-48201.json', label: 'Harris TX' },
  { path: '_tmp/medicare-gov/78002-48029.json', label: 'Bexar TX' },
  { path: '_tmp/medicare-gov/30004-13121.json', label: 'Fulton GA' },
  { path: '_tmp/medicare-gov/28623-37005.json', label: 'Alleghany NC' },
];

async function main() {
  // 1. Enumerate distinct MAPD non-SNP plans from all 5 caches.
  const distinct = new Map();
  for (const c of MAPD_CACHES) {
    if (!fs.existsSync(c.path)) continue;
    const raw = JSON.parse(fs.readFileSync(c.path, 'utf8'));
    for (const p of raw.plans ?? []) {
      if (p.snp_type && p.snp_type !== 'SNP_TYPE_NOT_SNP') continue;
      const k = `${p.contract_id}-${p.plan_id}-${p.segment_id ?? '0'}`;
      if (!distinct.has(k)) {
        distinct.set(k, {
          contract_id: p.contract_id,
          plan_id: p.plan_id,
          segment_id: String(p.segment_id ?? '0'),
          plan_name: p.name,
          carrier: p.organization_name,
          counties: [c.label],
        });
      } else {
        distinct.get(k).counties.push(c.label);
      }
    }
  }
  console.log(`Distinct MAPD non-SNP plans across 5 caches: ${distinct.size}`);

  // 2. Launch Chromium and warm.
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(WARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(6000);

  // 3. Fetch details.
  let ok = 0, fail = 0, skip = 0;
  const values = [...distinct.values()];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const key = `${v.contract_id}-${v.plan_id}-${v.segment_id}`;
    const outPath = path.join(OUT_DIR, `${key}.json`);
    if (fs.existsSync(outPath)) { skip++; continue; }
    const url = `https://www.medicare.gov/api/v1/data/plan-compare/plan/${YEAR}/${v.contract_id}/${v.plan_id}/${v.segment_id}?lis=LIS_NO_HELP`;
    try {
      const resp = await page.request.get(url, { headers: h(), timeout: 30_000 });
      if (!resp.ok()) {
        fail++;
        console.log(`  ✗ ${key.padEnd(15)} ${resp.status()}  ${v.plan_name}`);
      } else {
        const j = await resp.json();
        fs.writeFileSync(outPath, JSON.stringify({ ...v, fetched_at: new Date().toISOString(), source_url: url, response: j }, null, 2));
        ok++;
        if (i % 10 === 0) console.log(`  [${i+1}/${values.length}] ✓ ${key.padEnd(15)} ${v.plan_name.slice(0, 60)}`);
      }
    } catch (e) {
      fail++;
      console.log(`  ✗ ${key.padEnd(15)} error ${e.message}`);
    }
    if (i < values.length - 1) await page.waitForTimeout(PER_PLAN_DELAY);
  }
  await browser.close();
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Done. ok=${ok}  fail=${fail}  skip(cached)=${skip}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
