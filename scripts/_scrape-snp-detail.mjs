#!/usr/bin/env node
// scripts/_scrape-snp-detail.mjs — SNP catalog via per-plan detail.
//
// medicare.gov's /plans/search suppresses SNPs (probe confirmed).
// The /plan/{year}/{contract}/{plan}/{segment} endpoint is unrestricted
// and returns full plan_card including snp_type. Strategy:
//
//   1. Enumerate distinct SNP (contract, plan, segment) from pm_plans
//      for the 5 audited counties.
//   2. Fetch plan-detail for each.
//   3. Persist the raw plan_card blobs to _tmp/medicare-gov-snp/detail/
//      keyed by contract-plan-segment (idempotent).
//
// Downstream: the parity comparator will read these blobs and diff
// against pm_plans.
//
// Run: node scripts/_scrape-snp-detail.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '_tmp', 'medicare-gov-snp', 'detail');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// env.local loader
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
  return {
    Accept: 'application/json',
    Origin: 'https://www.medicare.gov',
    Referer: 'https://www.medicare.gov/plan-compare/',
    'fe-ver': FE_VER,
    traceparent: `00-${t}-${s}-01`,
  };
}

const COUNTIES = [
  { state: 'NC', county: 'Durham',    fips: '37063' },
  { state: 'TX', county: 'Harris',    fips: '48201' },
  { state: 'TX', county: 'Bexar',     fips: '48029' },
  { state: 'GA', county: 'Fulton',    fips: '13121' },
  { state: 'NC', county: 'Alleghany', fips: '37005' },
];

async function main() {
  // 1. Enumerate SNP plans in the 5 counties (post commissionable filter).
  const { data: nc } = await sb.from('pm_non_commissionable_contracts').select('contract_id, plan_number');
  const ncContracts = new Set((nc ?? []).filter((r) => !r.plan_number).map((r) => r.contract_id));
  const ncPlans     = new Set((nc ?? []).filter((r) => r.plan_number).map((r) => `${r.contract_id}-${r.plan_number}`));

  const distinct = new Map(); // key contract-plan-segment → { contract, plan, segment, snp_type, plan_name }
  for (const c of COUNTIES) {
    const { data } = await sb.from('pm_plans')
      .select('contract_id, plan_id, segment_id, plan_name, carrier, snp_type, sanctioned')
      .eq('state', c.state)
      .ilike('county_name', `%${c.county}%`)
      .not('snp_type', 'is', null);
    for (const r of data ?? []) {
      if (r.sanctioned) continue;
      if (ncContracts.has(r.contract_id) || ncPlans.has(`${r.contract_id}-${r.plan_id}`)) continue;
      const seg = String(r.segment_id ?? '0');
      const k = `${r.contract_id}-${r.plan_id}-${seg}`;
      if (!distinct.has(k)) {
        distinct.set(k, {
          contract_id: r.contract_id, plan_id: r.plan_id, segment_id: seg,
          plan_name: r.plan_name, carrier: r.carrier, snp_type: r.snp_type,
          counties: [c.county],
        });
      } else {
        distinct.get(k).counties.push(c.county);
      }
    }
  }
  console.log(`Distinct commissionable SNPs across 5 counties: ${distinct.size}`);
  const bySnp = {};
  for (const v of distinct.values()) bySnp[v.snp_type] = (bySnp[v.snp_type] ?? 0) + 1;
  console.log(`  by snp_type:`, bySnp);

  // 2. Launch Chromium and warm.
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(WARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(6000);

  // 3. Fetch details, skip files that already exist (idempotent).
  let ok = 0, fail = 0, skip = 0;
  const failures = [];
  const values = [...distinct.values()];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const key = `${v.contract_id}-${v.plan_id}-${v.segment_id}`;
    const outPath = path.join(OUT_DIR, `${key}.json`);
    if (fs.existsSync(outPath)) { skip++; continue; }
    const seg = v.segment_id === '0' ? '0' : v.segment_id;
    const url = `https://www.medicare.gov/api/v1/data/plan-compare/plan/${YEAR}/${v.contract_id}/${v.plan_id}/${seg}?lis=LIS_NO_HELP`;
    try {
      const resp = await page.request.get(url, { headers: h(), timeout: 30_000 });
      if (!resp.ok()) {
        fail++;
        failures.push({ key, status: resp.status(), sample: (await resp.text()).slice(0, 200) });
        console.log(`  ✗ ${key.padEnd(15)} ${resp.status()}  ${v.plan_name}`);
      } else {
        const j = await resp.json();
        fs.writeFileSync(outPath, JSON.stringify({ ...v, fetched_at: new Date().toISOString(), source_url: url, response: j }, null, 2));
        ok++;
        if (i % 5 === 0) console.log(`  [${i+1}/${values.length}] ✓ ${key.padEnd(15)} ${v.plan_name.slice(0, 60)}`);
      }
    } catch (e) {
      fail++;
      failures.push({ key, error: e.message });
      console.log(`  ✗ ${key.padEnd(15)} error ${e.message}`);
    }
    if (i < values.length - 1) await page.waitForTimeout(PER_PLAN_DELAY);
  }

  await browser.close();
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Done. ok=${ok}  fail=${fail}  skip(cached)=${skip}`);
  if (failures.length > 0) {
    console.log('First 5 failures:');
    failures.slice(0, 5).forEach((f) => console.log(`  ${f.key}: ${f.status ?? f.error}`));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
