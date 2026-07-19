#!/usr/bin/env node
// Scrape CMS plan-detail for every commissionable MA plan in the 5
// audit counties that doesn't already have a cached detail file.
// Same pattern as _scrape-snp-detail.mjs. Idempotent (skip if exists).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '_tmp', 'medicare-gov-mapd', 'detail');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

if (fs.existsSync(path.join(ROOT, '.env.local'))) {
  for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const WARM_URL = 'https://www.medicare.gov/plan-compare/';
const FE_VER = '2.69.0';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const YEAR = 2026;
const PER_PLAN_DELAY = 1500;

function h() {
  const t = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
  const s = [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
  return { Accept: 'application/json', Origin: 'https://www.medicare.gov', Referer: 'https://www.medicare.gov/plan-compare/', 'fe-ver': FE_VER, traceparent: `00-${t}-${s}-01` };
}

const COUNTIES = [{s:'NC',c:'Durham'},{s:'TX',c:'Harris'},{s:'TX',c:'Bexar'},{s:'GA',c:'Fulton'},{s:'NC',c:'Alleghany'}];

async function main() {
  const { data: nc } = await sb.from('pm_non_commissionable_contracts').select('contract_id, plan_number');
  const ncContract = new Set((nc ?? []).filter((r) => !r.plan_number).map((r) => r.contract_id));
  const ncPlan = new Set((nc ?? []).filter((r) => r.plan_number).map((r) => `${r.contract_id}-${r.plan_number}`));

  const plans = new Map();
  for (const cty of COUNTIES) {
    const { data } = await sb.from('pm_plans')
      .select('contract_id, plan_id, segment_id, plan_name, carrier, plan_type, snp_type, sanctioned, county_name')
      .eq('state', cty.s).ilike('county_name', `%${cty.c}%`);
    for (const r of (data ?? [])) {
      if (r.sanctioned) continue;
      if (ncContract.has(r.contract_id) || ncPlan.has(`${r.contract_id}-${r.plan_id}`)) continue;
      if (r.plan_type === 'PDP') continue;
      const key = `${r.contract_id}-${r.plan_id}-${String(r.segment_id ?? '0').replace(/^0+/, '') || '0'}`;
      if (!plans.has(key)) plans.set(key, { ...r, counties: [cty.c] });
      else plans.get(key).counties.push(cty.c);
    }
  }
  console.log(`Total plan+segment tuples in 5 counties: ${plans.size}`);

  // Skip cached
  const missing = [...plans.values()].filter((p) => {
    const seg = String(p.segment_id ?? '0').replace(/^0+/, '') || '0';
    const f = `${p.contract_id}-${p.plan_id}-${seg}.json`;
    return !fs.existsSync(path.join(OUT_DIR, f)) &&
           !fs.existsSync(path.join(ROOT, '_tmp', 'medicare-gov-snp', 'detail', f));
  });
  console.log(`Missing details: ${missing.length}`);
  if (missing.length === 0) return;

  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(WARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(6000);

  let ok = 0, fail = 0;
  for (let i = 0; i < missing.length; i++) {
    const p = missing[i];
    const seg = String(p.segment_id ?? '0').replace(/^0+/, '') || '0';
    const outPath = path.join(OUT_DIR, `${p.contract_id}-${p.plan_id}-${seg}.json`);
    const url = `https://www.medicare.gov/api/v1/data/plan-compare/plan/${YEAR}/${p.contract_id}/${p.plan_id}/${seg}?lis=LIS_NO_HELP`;
    try {
      const r = await page.request.get(url, { headers: h(), timeout: 30_000 });
      if (!r.ok()) { fail++; console.log(`  ✗ ${p.contract_id}-${p.plan_id}-${seg} ${r.status()}`); }
      else {
        const j = await r.json();
        fs.writeFileSync(outPath, JSON.stringify({ ...p, fetched_at: new Date().toISOString(), source_url: url, response: j }, null, 2));
        ok++;
        if (i % 10 === 0) console.log(`  [${i+1}/${missing.length}] ✓ ${p.contract_id}-${p.plan_id}-${seg} ${p.plan_name.slice(0,50)}`);
      }
    } catch (e) { fail++; console.log(`  ✗ ${p.contract_id}-${p.plan_id}-${seg} ${e.message}`); }
    if (i < missing.length - 1) await page.waitForTimeout(PER_PLAN_DELAY);
  }
  await browser.close();
  console.log(`\nDone. ok=${ok} fail=${fail}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
