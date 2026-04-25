#!/usr/bin/env node
// scripts/scrape-medicare-gov.mjs
//
// Medicare.gov Plan Finder scraper — writes to pbp_benefits with
// source='medicare_gov'. Migration scripts/migrations/001_pbp_benefits.sql
// must be applied before --write can succeed.
//
// Strategy (mirrors api/drug-costs.ts):
//   1. Launch playwright-core + @sparticuz/chromium
//   2. Navigate to https://www.medicare.gov/plan-compare/
//   3. Wait 6s for Akamai's _abck / bm_sz sensors to settle
//   4. POST the plan-compare search endpoint via page.request.post()
//      (page.evaluate(fetch) is fingerprinted by Akamai and 403s)
//   5. If the JSON path 4xx's, fall back to DOM scraping each plan
//      detail page (slower; ~2s per plan)
//
// Required headers on the POST: fe-ver: 2.69.0, Origin, Referer.
// The plan list comes back nested; extractor is tolerant.
//
// Usage:
//   node scripts/scrape-medicare-gov.mjs --zip 27713 --fips 37063 --limit 3 --write --verbose
//   node scripts/scrape-medicare-gov.mjs --state NC --write
//   node scripts/scrape-medicare-gov.mjs --plan H5253-189
//
// --limit N  — when one county is targeted, slices to first N plans.
//              When --state is used, slices to first N county targets.
// --dry-run  — implied unless --write is passed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '_tmp', 'medicare-gov');

// medicare.gov SPA constants. Bumped together with api/drug-costs.ts
// when their build version rolls — keep in sync to avoid divergent
// fingerprints.
const PLAN_SEARCH_URL =
  'https://www.medicare.gov/api/v1/data/plan-compare/plans/search';
// Per-plan detail endpoint (discovered 2026-04-25). Returns plan_card
// with ma_benefits[] (53 service rows × cost_sharing min/max copay +
// coinsurance), abstract_benefits.initial_coverage.tiers[] (5 Rx tier
// rows with retail / mail-order / 30-day / 90-day pricing), inpatient
// + SNF tiered_cost_sharing day-stage rows, package_benefits
// (deductibles + MOOP), and additional_supplemental_benefits.
const PLAN_DETAIL_URL_FN = (year, contract, plan, segment) =>
  `https://www.medicare.gov/api/v1/data/plan-compare/plan/${year}/${contract}/${plan}/${segment}?lis=LIS_NO_HELP`;
const WARM_URL = 'https://www.medicare.gov/plan-compare/';
const SEARCH_RESULTS_HASH =
  'https://www.medicare.gov/plan-compare/#/search-results';
const COOKIE_WARM_MS = 6_000;
const FE_VER = '2.69.0';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const YEAR = 2026;
const PER_PLAN_DELAY_MS = 2_000;
const PER_COUNTY_DELAY_MS = 2_000;

// ─── arg parsing ────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    dryRun: null,
    write: false,
    limit: null,
    zip: null,
    fips: null,
    state: null,
    plan: null,
    planType: 'PLAN_TYPE_MAPD',
    verbose: false,
    forceDom: false,
    skipDetail: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--zip': out.zip = next; i++; break;
      case '--fips': out.fips = next; i++; break;
      case '--state': out.state = (next ?? '').toUpperCase(); i++; break;
      case '--plan': out.plan = next; i++; break;
      case '--plan-type': out.planType = next; i++; break;
      case '--limit': out.limit = Number(next); i++; break;
      case '--dry-run': out.dryRun = true; break;
      case '--write': out.write = true; break;
      case '--force-dom': out.forceDom = true; break;
      case '--no-detail': out.skipDetail = true; break;
      case '--verbose': case '-v': out.verbose = true; break;
      default: break;
    }
  }
  if (out.dryRun === null) out.dryRun = !out.write;
  return out;
}

// ─── env ────────────────────────────────────────────────────────────
function readEnvLocal() {
  const env = { ...process.env };
  const envPath = path.join(ROOT, '.env.local');
  if (!fs.existsSync(envPath)) return env;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    env[key] = val;
  }
  return env;
}
const env = readEnvLocal();

// ─── supabase REST helpers ─────────────────────────────────────────
async function sbGet(env, pathQ) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${pathQ}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`supabase GET ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sbDeleteForPlans(env, planIds) {
  if (planIds.length === 0) return;
  // The pbp_benefits unique index is functional (COALESCE(tier_id,''))
  // which PostgREST's on_conflict parameter can't target. Delete-then-
  // insert is fully idempotent and avoids the conflict-target dance.
  // Only delete medicare_gov rows so we don't clobber pbp_federal /
  // sb_ocr / manual entries from other sources.
  const ids = planIds.map((id) => `"${id}"`).join(',');
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/pbp_benefits?source=eq.medicare_gov&plan_id=in.(${encodeURIComponent(ids)})`,
    {
      method: 'DELETE',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=minimal',
      },
    },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`supabase delete ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
}

async function sbInsert(env, rows) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/pbp_benefits`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 404 || /PGRST205/.test(body)) {
      throw new Error(
        'pbp_benefits table missing. Run scripts/migrations/001_pbp_benefits.sql first.',
      );
    }
    throw new Error(`supabase insert ${res.status}: ${body.slice(0, 400)}`);
  }
}

// ─── browser bootstrap ─────────────────────────────────────────────
// Three resolution paths:
//   1. PUPPETEER_EXECUTABLE_PATH / CHROME_BIN env override
//   2. Linux (Vercel, CI): @sparticuz/chromium — same as drug-costs.ts
//   3. macOS / Windows local dev: Playwright's bundled chromium via
//      chromium.launch() with no executablePath. Falls back to a
//      hardcoded "Google Chrome for Testing" path under
//      ~/Library/Caches/ms-playwright/ if needed.
async function launchBrowser({ verbose }) {
  const { chromium } = await import('playwright-core');
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_BIN;
  if (envPath) {
    if (verbose) console.log('  chromium (env):', envPath);
    return chromium.launch({ executablePath: envPath, headless: true });
  }
  if (process.platform === 'linux') {
    const sparticuz = (await import('@sparticuz/chromium')).default;
    const exe = await sparticuz.executablePath();
    if (verbose) console.log('  chromium (sparticuz):', exe);
    return chromium.launch({ executablePath: exe, args: sparticuz.args, headless: true });
  }
  // Local dev (mac / win): try the Playwright-bundled binary first.
  try {
    if (verbose) console.log('  chromium: bundled (playwright-core)');
    return await chromium.launch({ headless: true });
  } catch (err) {
    // Final fallback: probe for the Chrome-for-Testing install path
    // that `npx playwright install chromium` produces on macOS-arm64.
    const fallback = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    if (verbose) console.log('  chromium (fallback):', fallback);
    return chromium.launch({ executablePath: fallback, headless: true });
  }
}

// ─── Akamai-warmed page ────────────────────────────────────────────
async function warmPage(browser, { verbose }) {
  const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US' });
  const page = await ctx.newPage();
  if (verbose) console.log('  warming Akamai…');
  await page.goto(WARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(COOKIE_WARM_MS);
  return { ctx, page };
}

// ─── schema discovery ─────────────────────────────────────────────
// medicare.gov's /plans/search is a grpc-web endpoint and the JSON
// field names aren't documented. Drive the SPA into a real search and
// capture the body it actually posts; reuse that body shape verbatim
// for our subsequent direct calls.
async function discoverSearchSchema(page, { zip, fips, planType, verbose }) {
  if (verbose) console.log('  discovering /plans/search body shape…');
  const captures = [];
  const handler = (request) => {
    if (request.url().includes('/plan-compare/plans/search') && request.method() === 'POST') {
      let body = null;
      try {
        const raw = request.postData();
        body = raw ? JSON.parse(raw) : null;
      } catch {}
      captures.push({ url: request.url(), body });
    }
  };
  page.on('request', handler);
  try {
    const url = `${SEARCH_RESULTS_HASH}?plan_type=${planType}&fips=${fips}&zip=${zip}&year=${YEAR}&lang=en`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(15_000);
  } finally {
    page.off('request', handler);
  }
  if (captures.length === 0) {
    if (verbose) console.log('  no /plans/search POST captured');
    return null;
  }
  captures.sort((a, b) => Object.keys(b.body ?? {}).length - Object.keys(a.body ?? {}).length);
  const best = captures[0];
  if (verbose) {
    console.log(`  captured ${captures.length} POST${captures.length === 1 ? '' : 's'}`);
    for (const c of captures) {
      console.log('   url:', c.url);
      console.log('   body:', JSON.stringify(c.body));
    }
  }
  return best;
}

function buildSearchHeaders() {
  const traceId = [...Array(32)]
    .map(() => Math.floor(Math.random() * 16).toString(16))
    .join('');
  const spanId = [...Array(16)]
    .map(() => Math.floor(Math.random() * 16).toString(16))
    .join('');
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: 'https://www.medicare.gov',
    Referer: 'https://www.medicare.gov/plan-compare/',
    'fe-ver': FE_VER,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

// ─── JSON path: POST /plans/search ─────────────────────────────────
// Body shape comes from discoverSearchSchema (the live SPA request).
// We swap the targeted zip/fips/planType into whatever fields the
// captured template carried, then post via page.request.post() so
// Akamai sees a same-origin XHR with the warmed cookies.
function rewriteCapturedBody(template, { zip, fips, planType }) {
  if (!template) return null;
  const body = JSON.parse(JSON.stringify(template));
  for (const k of Object.keys(body)) {
    if (/^zip/i.test(k)) body[k] = String(zip);
    else if (/fips/i.test(k)) body[k] = String(fips);
    else if (/plan.?type/i.test(k)) body[k] = planType;
    else if (/^year$|contract.?year/i.test(k)) body[k] = String(YEAR);
  }
  return body;
}

// Captured template carries both the URL (with geo args in the query
// string) and the body (npis/prescriptions/lis/etc.). Reuse both — the
// SPA's URL params are how /plans/search receives zip / fips / year /
// plan_type, NOT the body.
async function searchPlansViaApi(page, { zip, fips, planType, capturedTemplate, verbose }) {
  let url = PLAN_SEARCH_URL;
  let reqBody;
  if (capturedTemplate?.url) {
    const u = new URL(capturedTemplate.url);
    for (const [k] of Array.from(u.searchParams.entries())) {
      if (/zip/i.test(k)) u.searchParams.set(k, String(zip));
      else if (/fips/i.test(k)) u.searchParams.set(k, String(fips));
      else if (/plan.?type/i.test(k)) u.searchParams.set(k, planType);
      else if (/year/i.test(k)) u.searchParams.set(k, String(YEAR));
    }
    // Force-add fields the captured URL might be missing (search-results
    // hash sometimes doesn't seed them on first capture).
    if (!u.searchParams.has('zip') && !u.searchParams.has('zipCode')) u.searchParams.set('zip', String(zip));
    if (!u.searchParams.has('fips') && !u.searchParams.has('countyFips')) u.searchParams.set('fips', String(fips));
    if (!u.searchParams.has('plan_type') && !u.searchParams.has('planType')) u.searchParams.set('plan_type', planType);
    if (!u.searchParams.has('year')) u.searchParams.set('year', String(YEAR));
    if (!u.searchParams.has('lang')) u.searchParams.set('lang', 'en');
    url = u.toString();
    reqBody = capturedTemplate.body ?? {};
  } else {
    const qs = new URLSearchParams({
      zip: String(zip),
      fips: String(fips),
      plan_type: planType,
      year: String(YEAR),
      lang: 'en',
    });
    url = `${PLAN_SEARCH_URL}?${qs.toString()}`;
    reqBody = {
      npis: [],
      prescriptions: [],
      lis: 'LIS_NO_HELP',
      starRatings: [],
      organizationNames: [],
    };
  }
  if (verbose) {
    console.log('  POST', url);
    console.log('       body', JSON.stringify(reqBody));
  }
  const resp = await page.request.post(url, {
    data: reqBody,
    headers: buildSearchHeaders(),
  });
  const status = resp.status();
  const ct = resp.headers()['content-type'] ?? '';
  if (!resp.ok() || !ct.includes('json')) {
    const sample = (await resp.text()).slice(0, 1500);
    return { ok: false, status, contentType: ct, sample };
  }
  const body = await resp.json();
  return { ok: true, status, body };
}

// ─── Per-plan detail fetch ─────────────────────────────────────────
async function fetchPlanDetail(page, { year, contract, plan, segment, verbose }) {
  const url = PLAN_DETAIL_URL_FN(year, contract, plan, segment);
  if (verbose) console.log('   GET', url);
  const resp = await page.request.get(url, { headers: buildSearchHeaders() });
  const status = resp.status();
  if (!resp.ok()) {
    const sample = (await resp.text()).slice(0, 300);
    if (verbose) console.warn(`   detail ${status}: ${sample}`);
    return null;
  }
  const ct = resp.headers()['content-type'] ?? '';
  if (!ct.includes('json')) return null;
  const body = await resp.json();
  return body?.plan_card ?? null;
}

// ─── Service → benefit_type mapping ────────────────────────────────
// Keys are the SERVICE strings on plan_card.ma_benefits[].service.
// Values are pbp_benefits.benefit_type. Anything not mapped falls
// through to a generic '<category_lower>__<service_lower>' name so
// no row is dropped silently.
const SERVICE_TO_BENEFIT = {
  GROUND_AMBULANCE: 'ambulance',
  SERVICE_DURABLE_MEDICAL_EQUIPMENT: 'dme',
  SERVICE_PROSTHETICS: 'prosthetics',
  SERVICE_DIABETES_SUPPLIES: 'diabetic_supplies',
  SERVICE_DIALYSIS: 'dialysis',
  ACUPUNCTURE: 'acupuncture',
  OTC_ITEMS: 'otc_items',
  MEALS_SHORT_DURATION: 'meals_short_duration',
  ANNUAL_PHYSICAL: 'annual_physical',
  FITNESS: 'fitness_visit',
  SERVICE_PART_B_INSULIN: 'part_b_insulin',
  PART_B_CHEMOTHERAPY_DRUGS: 'part_b_chemo',
  PART_B_OTHER_DRUGS: 'part_b_other',
  SERVICE_ORAL_EXAM: 'dental_oral_exam',
  SERVICE_DENTAL_XRAYS: 'dental_xray',
  PROPHYLAXIS: 'dental_cleaning',
  OTHER_PREVENTATIVE_DENTAL_SERVICES: 'dental_preventive_other',
  SERVICE_RESTORATIVE_SERVICES: 'dental_restorative',
  SERVICE_ENDODONTICS: 'dental_endodontics',
  SERVICE_PERIODONTICS: 'dental_periodontics',
  PROSTHODONTICS_REMOVABLE: 'dental_prosthodontics_removable',
  PROSTHODONTICS_FIXED: 'dental_prosthodontics_fixed',
  ORAL_AND_MAXILLOFACIAL_SURGERY: 'dental_oral_surgery',
  ADJUNCTIVE_GENERAL_SERVICES: 'dental_adjunctive',
  VISION_ROUTINE_EYE_EXAMS: 'vision_exam',
  VISION_EYEGLASSES_FRAMES_AND_LENSES: 'vision_eyewear',
  VISION_CONTACT_LENSES: 'vision_contacts',
  ROUTINE_HEARING_EXAMS: 'hearing_exam',
  FITTING_EVALUATION_HEARING_AIDS: 'hearing_fitting',
  RX_HEARING_AIDS: 'hearing_aid_rx',
  OTC_HEARING_AIDS: 'hearing_aid_otc',
  SERVICE_EMERGENCY: 'emergency',
  SERVICE_URGENT_CARE: 'urgent_care',
  SERVICE_WORLDWIDE_EMERGENCY: 'worldwide_emergency_care',
  SERVICE_PRIMARY: 'primary_care',
  SERVICE_SPECIALIST: 'specialist',
  SERVICE_OCCUPATIONAL_THERAPY_VISIT: 'occupational_therapy',
  SERVICE_PHYSICAL_THERAPY_AND_SPEECH_AND_LANGUAGE_THERAPY_VISIT: 'physical_therapy',
  SERVICE_OUTPATIENT_INDIVIDUAL_THERAPY_VISIT: 'mental_health_individual',
  SERVICE_OUTPATIENT_GROUP_THERAPY_VISIT: 'mental_health_group',
  SERVICE_OUTPATIENT_INDIVIDUAL_THERAPY_VISIT_WITH_PSYCHIATRIST: 'mental_health_individual_psych',
  SERVICE_OUTPATIENT_GROUP_THERAPY_VISIT_WITH_PSYCHIATRIST: 'mental_health_group_psych',
  SERVICE_OPIOID_TREATMENT_PROGRAM_SERVICES: 'opioid_treatment',
  TELEHEALTH: 'telehealth_visit',
  SERVICE_DIAGNOSTIC_TESTS: 'diagnostic_tests',
  SERVICE_LAB_SERVICES: 'lab',
  SERVICE_DIAGNOSTIC_RADIOLOGY_SERVICES: 'diagnostic_radiology',
  SERVICE_OUTPATIENT_XRAYS: 'outpatient_xray',
  SERVICE_OUTPATIENT_HOSPITAL_SERVICES: 'outpatient_hospital',
  INPATIENT_HOSPITAL: 'inpatient_hospital',
  SKILLED_NURSING_FACILITY: 'snf',
};

// Rx tier label → tier_id (1-5).
const RX_TIER_LABEL_TO_ID = {
  COST_SHARE_TIER_PREFERRED_GENERIC: '1',
  COST_SHARE_TIER_GENERIC: '2',
  COST_SHARE_TIER_PREFERRED_BRAND: '3',
  COST_SHARE_TIER_NON_PREFERRED_DRUG: '4',
  COST_SHARE_TIER_SPECIALTY_TIER: '5',
};

// "$0.00 copay" → { copay: 0, coinsurance: null }
// "50% coinsurance" → { copay: null, coinsurance: 50 }
// "" / null → { copay: null, coinsurance: null }
function parseTierCost(s) {
  if (!s || typeof s !== 'string') return { copay: null, coinsurance: null };
  const m = s.match(/\$([\d,]+(?:\.\d+)?)/);
  if (m) return { copay: Number(m[1].replace(/,/g, '')), coinsurance: null };
  const c = s.match(/(\d+(?:\.\d+)?)\s*%/);
  if (c) return { copay: null, coinsurance: Number(c[1]) };
  return { copay: null, coinsurance: null };
}

// ─── DOM fallback ──────────────────────────────────────────────────
// Last-resort path when the search endpoint 4xx's. Renders the SPA
// search results, harvests the visible plan cards, then walks each
// detail page extracting labeled cost rows.
async function searchPlansViaDom(page, { zip, fips, planType, planLimit, verbose }) {
  const url = `${SEARCH_RESULTS_HASH}?plan_type=${planType}&fips=${fips}&zip=${zip}&year=${YEAR}&lang=en`;
  if (verbose) console.log('  DOM nav:', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // SPA renders cards async; give it room then collect anchors that
  // look like plan-detail links. medicare.gov uses /plan-details/ in
  // the hash router but the link selector is fragile across releases —
  // accept any anchor whose href contains contract-plan-segment.
  await page.waitForTimeout(8_000);
  const planRefs = await page.evaluate(() => {
    const out = [];
    const anchors = Array.from(document.querySelectorAll('a[href*="plan-details"], a[href*="/plan/"], button[data-plan-id]'));
    for (const a of anchors) {
      const href = a.getAttribute('href') || a.getAttribute('data-href') || '';
      const planId = a.getAttribute('data-plan-id') || '';
      const m = (href + ' ' + planId).match(/(H\d{4})[-/](\d{3})[-/]?(\d{1,3})?/i);
      if (!m) continue;
      out.push({
        href,
        contract_id: m[1],
        plan_id: m[2],
        segment_id: m[3] ?? '0',
        text: (a.textContent || '').trim().slice(0, 120),
      });
    }
    // Dedup by triple.
    const seen = new Set();
    return out.filter((p) => {
      const k = `${p.contract_id}-${p.plan_id}-${p.segment_id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });
  if (verbose) console.log(`  DOM found ${planRefs.length} plan refs`);
  const refs = planLimit ? planRefs.slice(0, planLimit) : planRefs;

  const plans = [];
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    if (i > 0) await page.waitForTimeout(PER_PLAN_DELAY_MS);
    const detailUrl = ref.href.startsWith('http')
      ? ref.href
      : ref.href.startsWith('#')
        ? `https://www.medicare.gov/plan-compare/${ref.href}`
        : `https://www.medicare.gov${ref.href}`;
    if (verbose) console.log(`  detail [${i + 1}/${refs.length}]`, detailUrl);
    try {
      await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(3_000);
      const extracted = await page.evaluate(extractDomPlanInPage);
      plans.push({
        contract_id: ref.contract_id,
        plan_id: ref.plan_id,
        segment_id: ref.segment_id,
        plan_name: extracted.plan_name || ref.text,
        ...extracted,
      });
    } catch (err) {
      if (verbose) console.warn(`  detail failed for ${ref.contract_id}-${ref.plan_id}:`, err.message);
    }
  }
  return { ok: true, body: { plans }, source: 'dom' };
}

// Runs inside the page. Walks all visible text scoped to the
// detail-page main panel and pulls labeled cost rows by regex. Returns
// an object keyed on benefit_type that the normalizer downstream maps
// into pbp_benefits rows.
function extractDomPlanInPage() {
  const text = document.body?.innerText || '';
  const get = (re) => {
    const m = text.match(re);
    if (!m) return null;
    const s = m[1] ?? m[0];
    const num = s.replace(/[^\d.]/g, '');
    return num ? Number(num) : null;
  };
  const findCopay = (label) => {
    // Match "<label>" followed within ~80 chars by a "$X" or "$X copay"
    // or "$X-$Y" range (we take the low end). Tolerant of newlines.
    const re = new RegExp(
      `${label}[\\s\\S]{0,80}?\\$\\s?(\\d{1,4}(?:\\.\\d{2})?)`,
      'i',
    );
    return get(re);
  };
  const findCoins = (label) => {
    const re = new RegExp(`${label}[\\s\\S]{0,80}?(\\d{1,2})\\s?%`, 'i');
    return get(re);
  };

  const planNameEl = document.querySelector('h1, [data-testid="plan-name"], .plan-name');
  const plan_name = planNameEl ? (planNameEl.textContent || '').trim().slice(0, 200) : null;

  const monthly_premium = findCopay('monthly premium');
  const moop = findCopay('out-of-pocket maximum') ?? findCopay('maximum out[- ]of[- ]pocket');
  const drug_deductible = findCopay('drug deductible') ?? findCopay('part d deductible');
  const annual_deductible = findCopay('medical deductible') ?? findCopay('annual deductible');

  const pcp_copay = findCopay('primary care');
  const specialist_copay = findCopay('specialist');
  const er_copay = findCopay('emergency');
  const urgent_care_copay = findCopay('urgent care');
  const lab_copay = findCopay('lab(?:oratory)?');
  const imaging_copay = findCopay('diagnostic (?:radiology|imaging)') ?? findCopay('x[- ]?ray');
  const ambulance_copay = findCopay('ambulance');
  const outpatient_surgery_hospital = findCopay('outpatient surgery.*hospital') ?? findCopay('outpatient hospital');
  const outpatient_surgery_asc = findCopay('ambulatory surgical center');

  // Inpatient is usually a stage table — pull first stage day-1 copay.
  const inpatient_first = findCopay('inpatient hospital');
  const inpatient = inpatient_first != null
    ? { stages: [{ copay: inpatient_first, coinsurance: null, description: 'Inpatient day 1+' }] }
    : null;

  // Rx tiers.
  const rx_tiers = [];
  for (let t = 1; t <= 5; t++) {
    const labelRe = new RegExp(`tier\\s*${t}\\b`, 'i');
    if (!labelRe.test(text)) continue;
    const copay = findCopay(`tier\\s*${t}`);
    const coins = findCoins(`tier\\s*${t}`);
    if (copay == null && coins == null) continue;
    rx_tiers.push({ tier: t, copay, coinsurance: coins, description: null });
  }

  const dental_annual_max = findCopay('dental.*?(?:max|allowance|coverage)');
  const vision_eyewear_allowance_year = findCopay('eyewear') ?? findCopay('eyeglasses');
  const hearing_aid_allowance_year = findCopay('hearing aid');
  const otc_allowance_per_quarter = findCopay('over[- ]the[- ]counter') ?? findCopay('otc allowance');
  const food_card_allowance_per_month = findCopay('food (?:card|allowance)') ?? findCopay('grocery');
  const fitness_program = /silver\s*sneakers|silver&fit|fitness program|gym/i.test(text)
    ? 'Fitness program included'
    : null;
  const transportation_trips_per_year = (() => {
    const m = text.match(/(\d{1,3})\s+(?:one[- ]way|round[- ]trip)?\s*(?:transportation|rides|trips)/i);
    return m ? Number(m[1]) : null;
  })();
  const post_discharge_meals_count = (() => {
    const m = text.match(/(\d{1,3})\s+(?:post[- ]discharge\s+)?meals/i);
    return m ? Number(m[1]) : null;
  })();

  return {
    plan_name,
    monthly_premium,
    moop,
    drug_deductible,
    annual_deductible,
    pcp_copay,
    specialist_copay,
    er_copay,
    urgent_care_copay,
    lab_copay,
    imaging_copay,
    ambulance_copay,
    outpatient_surgery_hospital,
    outpatient_surgery_asc,
    inpatient,
    rx_tiers,
    dental_annual_max,
    vision_eyewear_allowance_year,
    hearing_aid_allowance_year,
    otc_allowance_per_quarter,
    food_card_allowance_per_month,
    fitness_program,
    transportation_trips_per_year,
    post_discharge_meals_count,
  };
}

// ─── normalize → pbp_benefits rows ─────────────────────────────────
//
// Accepts either the /plans/search summary plan (sparse — premium,
// MOOP, deductibles, PCP/specialist cost-sharing structs, plus extra-
// benefit booleans) OR the DOM-extracted shape from
// extractDomPlanInPage. Reads tolerantly from both.
//
// Known limit: /plans/search does NOT return Rx tiers, ER/urgent/lab/
// imaging copays, dental/vision/hearing dollar amounts, or inpatient
// stage copays. Those require either a per-plan detail endpoint (TBD)
// or the DOM-scrape fallback. The summary still produces ~10 rows per
// plan covering the main quote-table fields.
function parseDollar(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return null;
  const m = v.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function normalizePlanToBenefits(rawPlan, detailCard, planFilter) {
  const contract = rawPlan.contract_id ?? rawPlan.contractId;
  const planId = rawPlan.plan_id ?? rawPlan.planId;
  const segment = rawPlan.segment_id ?? rawPlan.segmentId ?? '0';
  if (!contract || !planId) return { triple: null, rows: [] };
  if (planFilter && `${contract}-${planId}` !== planFilter) return { triple: null, rows: [] };
  const triple = `${contract}-${planId}-${segment}`;

  const seenKeys = new Set();
  const rows = [];
  const push = (benefit_type, tier_id, copay, coinsurance, description) => {
    if (copay == null && coinsurance == null && !description) return;
    // pbp_benefits unique constraint is (plan_id, benefit_type,
    // COALESCE(tier_id, '')) — PostgREST's on_conflict can't see the
    // COALESCE, so we send '' literally to make conflict resolution
    // work for non-tiered rows.
    const tier = tier_id == null ? '' : String(tier_id);
    // Local de-dupe so a benefit_type/tier_id pair never lands in the
    // batch twice (would 23505 on insert). When a key collides we keep
    // the first row — search-summary fields are added before detail
    // overrides, but detail rows for unique services don't collide.
    const key = `${benefit_type}\t${tier}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    rows.push({
      plan_id: triple,
      benefit_type,
      tier_id: tier,
      copay: copay != null ? Number(copay) : null,
      coinsurance: coinsurance != null ? Number(coinsurance) : null,
      description: description ?? null,
      source: 'medicare_gov',
    });
  };

  // ── Premium / MOOP / Deductibles ──
  // /plans/search splits the premium into Part C + Part D; sum them
  // for a single line item. calculated_monthly_premium is the SPA's
  // pre-rounded display value; prefer it when present.
  const monthlyPremium =
    rawPlan.calculated_monthly_premium ??
    (rawPlan.partc_premium != null || rawPlan.partd_premium != null
      ? (rawPlan.partc_premium ?? 0) + (rawPlan.partd_premium ?? 0)
      : rawPlan.monthly_premium ?? rawPlan.premium);
  push('premium', null, monthlyPremium, null, null);
  push(
    'moop_in_network',
    null,
    parseDollar(rawPlan.maximum_oopc ?? rawPlan.moop ?? rawPlan.moop_in_network),
    null,
    typeof rawPlan.maximum_oopc === 'string' ? rawPlan.maximum_oopc : null,
  );
  push('rx_deductible', null, rawPlan.drug_plan_deductible ?? rawPlan.drug_deductible, null, null);
  push(
    'medical_deductible',
    null,
    parseDollar(rawPlan.annual_deductible),
    null,
    null,
  );
  if (rawPlan.partb_premium_reduction != null && rawPlan.partb_premium_reduction !== 0) {
    push('part_b_giveback', null, rawPlan.partb_premium_reduction, null, null);
  }

  // ── PCP / Specialist cost-sharing ──
  // /plans/search returns {min_copay, max_copay, min_coinsurance,
  // max_coinsurance}. We record min as the headline copay and max as
  // a separate row tagged 'max' so a downstream UI can show ranges.
  const pcp = rawPlan.primary_doctor_cost_sharing;
  if (pcp) {
    push('primary_care', 'min', pcp.min_copay, pcp.min_coinsurance, null);
    if (pcp.max_copay !== pcp.min_copay || pcp.max_coinsurance !== pcp.min_coinsurance) {
      push('primary_care', 'max', pcp.max_copay, pcp.max_coinsurance, null);
    }
  } else {
    push('primary_care', null, parseDollar(rawPlan.primary_doctor_visit_cost) ?? rawPlan.pcp_copay, null, null);
  }
  const spec = rawPlan.specialist_doctor_cost_sharing;
  if (spec) {
    push('specialist', 'min', spec.min_copay, spec.min_coinsurance, null);
    if (spec.max_copay !== spec.min_copay || spec.max_coinsurance !== spec.min_coinsurance) {
      push('specialist', 'max', spec.max_copay, spec.max_coinsurance, null);
    }
  } else {
    push('specialist', null, parseDollar(rawPlan.specialist_doctor_visit_cost) ?? rawPlan.specialist_copay, null, null);
  }
  push('emergency', null, parseDollar(rawPlan.emergency_care_cost) ?? rawPlan.er_copay, null, null);
  push('urgent_care', null, rawPlan.urgent_care_copay, null, null);
  push('lab', null, rawPlan.lab_copay, null, null);
  push('diagnostic_radiology', null, rawPlan.imaging_copay, null, null);
  push('ambulance', null, rawPlan.ambulance_copay, null, null);
  push('outpatient_surgery_hospital', null, rawPlan.outpatient_surgery_hospital, null, null);
  push('outpatient_surgery_asc', null, rawPlan.outpatient_surgery_asc, null, null);

  if (rawPlan.inpatient && Array.isArray(rawPlan.inpatient.stages)) {
    rawPlan.inpatient.stages.forEach((stage, i) =>
      push(
        `inpatient_day_stage_${i + 1}`,
        String(i + 1),
        stage.copay,
        stage.coinsurance,
        stage.description,
      ),
    );
  }

  for (const t of rawPlan.rx_tiers ?? []) {
    push('rx_tier', String(t.tier), t.copay, t.coinsurance, t.description);
  }

  // ── Extras ──
  // /plans/search exposes most extras as booleans (silver_sneakers,
  // transportation, otc_drugs, telehealth, worldwide_emergency, etc).
  // Record them as description-only rows so the bench knows the plan
  // OFFERS the benefit; dollar amounts still require detail-page DOM
  // scrape.
  push('dental_max', null, rawPlan.dental_annual_max, null, null);
  push('vision_eyewear', null, rawPlan.vision_eyewear_allowance_year, null, null);
  push('hearing_aid', null, rawPlan.hearing_aid_allowance_year, null, null);
  push('otc_quarter', null, rawPlan.otc_allowance_per_quarter, null, null);
  push('food_card_month', null, rawPlan.food_card_allowance_per_month, null, null);
  if (rawPlan.silver_sneakers) push('fitness', null, null, null, 'SilverSneakers / fitness program');
  else if (rawPlan.fitness_program) push('fitness', null, null, null, rawPlan.fitness_program);
  if (rawPlan.transportation === true) push('transportation', null, null, null, 'Transportation included');
  push('transportation_trips', null, rawPlan.transportation_trips_per_year, null, null);
  if (rawPlan.otc_drugs === true) push('otc', null, null, null, 'OTC benefit included');
  if (rawPlan.telehealth === true) push('telehealth', null, null, null, 'Telehealth included');
  if (rawPlan.worldwide_emergency === true) push('worldwide_emergency', null, null, null, 'Worldwide emergency coverage');
  if (rawPlan.in_home_support === true) push('in_home_support', null, null, null, 'In-home support services');
  push('meals', null, rawPlan.post_discharge_meals_count, null, null);

  // Star rating + plan category metadata for richer downstream display.
  const stars = rawPlan.overall_star_rating?.rating;
  if (stars != null) push('star_rating', null, null, null, `${stars} stars`);

  // ── Detail layer (plan/{year}/{contract}/{plan}/{segment}) ──
  // ma_benefits[] is the canonical full cost-sharing breakdown — 50+
  // service rows with min/max copay + coinsurance for IN_NETWORK.
  // abstract_benefits.initial_coverage.tiers[] is the Rx tier table.
  if (detailCard) {
    for (const b of detailCard.ma_benefits ?? []) {
      const svc = b.service;
      const benefitType = SERVICE_TO_BENEFIT[svc] ?? `${(b.category || 'other').toLowerCase()}__${(svc || 'unknown').toLowerCase()}`;

      // Most rows have a flat cost_sharing[] with IN_NETWORK and
      // OUT_OF_NETWORK entries. Inpatient + SNF use tiered_cost_sharing
      // for day-stage breakdowns.
      const inNet = (b.cost_sharing ?? []).find((c) => c.network_status === 'IN_NETWORK');
      if (inNet) {
        const cMin = inNet.min_copay;
        const cMax = inNet.max_copay;
        const coMin = inNet.min_coinsurance;
        const coMax = inNet.max_coinsurance;
        const sameCopay = cMin === cMax;
        const sameCoins = coMin === coMax;
        if (sameCopay && sameCoins) {
          push(benefitType, null, cMin, coMin, null);
        } else {
          push(benefitType, 'min', cMin, coMin, null);
          push(benefitType, 'max', cMax, coMax, null);
        }
      }

      const tcs = b.tiered_cost_sharing;
      if (tcs && Array.isArray(tcs.in_network)) {
        for (const stage of tcs.in_network) {
          // Day-interval rows are the headline ("days 1-5: $295").
          // Per-stay rows we keep too tagged with 'per_stay'.
          const tier =
            stage.interval_type === 'INTERVAL_TYPE_DAY_INTERVAL' && stage.interval
              ? `days_${stage.interval}`
              : stage.interval_type === 'INTERVAL_TYPE_PER_STAY'
                ? 'per_stay'
                : `tier_${stage.tier ?? '?'}`;
          push(benefitType, tier, stage.copay, stage.coinsurance, null);
        }
      }
    }

    // Rx tiers from abstract_benefits.initial_coverage. Use
    // standard_retail.days_30 as the headline (matches what the v4
    // quote table renders by default).
    const rxTiers = detailCard.abstract_benefits?.initial_coverage?.tiers ?? [];
    for (const t of rxTiers) {
      const tierId = RX_TIER_LABEL_TO_ID[t.label] ?? String(t.tier_row_order ?? '');
      const display = t.standard_retail ?? t.preferred_retail ?? null;
      const cost = parseTierCost(display?.days_30);
      const desc = display?.days_30 || null;
      push('rx_tier', tierId, cost.copay, cost.coinsurance, desc);
      // Also capture 90-day standard retail as a separate tier row so
      // the downstream UI can show the per-fill jump if needed.
      const cost90 = parseTierCost(display?.days_90);
      if (cost90.copay != null || cost90.coinsurance != null) {
        push('rx_tier', `${tierId}_90`, cost90.copay, cost90.coinsurance, display?.days_90 || null);
      }
      // Mail-order standard 30 day for the savvy quote.
      const mo = t.standard_mail_order ?? t.preferred_mail_order ?? null;
      const moCost = parseTierCost(mo?.days_30);
      if (moCost.copay != null || moCost.coinsurance != null) {
        push('rx_tier', `${tierId}_mail`, moCost.copay, moCost.coinsurance, mo?.days_30 || null);
      }
    }

    // Coverage-gap + catastrophic — capture the headline cost-share
    // for each defined tier. Fields are sparse on most plans so just
    // the tier string is informational.
    const cgTiers = detailCard.abstract_benefits?.coverage_gap?.tiers ?? [];
    for (const t of cgTiers) {
      const tierId = `${RX_TIER_LABEL_TO_ID[t.label] ?? t.tier_row_order ?? '?'}_gap`;
      const cost = parseTierCost(t.standard_retail?.days_30);
      push('rx_tier', tierId, cost.copay, cost.coinsurance, t.standard_retail?.days_30 || null);
    }
  }

  return { triple, rows };
}

// ─── county targets ────────────────────────────────────────────────
async function resolveTargets({ zip, fips, state, plan, env, verbose }) {
  if (plan) {
    const [contract, pid] = plan.split('-');
    const rows = await sbGet(
      env,
      `/pm_plans?contract_id=eq.${contract}&plan_id=eq.${pid}&select=contract_id,plan_id,segment_id,state,county_name&limit=1`,
    );
    if (!rows.length) throw new Error(`no pm_plans row for ${plan}`);
    const county = rows[0].county_name;
    const zc = await sbGet(
      env,
      `/pm_zip_county?county=eq.${encodeURIComponent(county)}&state=eq.${rows[0].state}&select=zip,fips&limit=1`,
    );
    if (!zc.length) throw new Error(`no pm_zip_county for ${county}, ${rows[0].state}`);
    if (verbose) console.log(`  resolved ${plan} → ${zc[0].zip}/${zc[0].fips}`);
    return [{ zip: zc[0].zip, fips: zc[0].fips, planFilter: plan }];
  }
  if (zip && fips) return [{ zip, fips, planFilter: null }];
  if (state) {
    const rows = await sbGet(env, `/pm_zip_county?state=eq.${state}&select=zip,fips&limit=5000`);
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const key = `${r.zip}-${r.fips}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ zip: r.zip, fips: r.fips, planFilter: null });
    }
    if (verbose) console.log(`  state=${state} → ${out.length} (zip, fips) targets`);
    return out;
  }
  throw new Error('specify --zip and --fips, or --state, or --plan');
}

// Pull plan list out of whatever shape /plans/search returns. Tries
// the most common keys (plans, results, data.plans, ...).
function extractPlansFromApi(body) {
  if (!body) return [];
  if (Array.isArray(body.plans)) return body.plans;
  if (Array.isArray(body.results)) return body.results;
  if (body.data && Array.isArray(body.data.plans)) return body.data.plans;
  if (body.data && Array.isArray(body.data.results)) return body.data.results;
  if (Array.isArray(body)) return body;
  return [];
}

// ─── main ──────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  const verbose = args.verbose;
  console.log('scrape-medicare-gov (playwright)');
  console.log('  mode:', args.dryRun ? 'DRY RUN' : 'WRITE');
  if (args.write && (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for --write');
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const targets = await resolveTargets({ ...args, env, verbose });
  // --limit semantics: if multiple targets, slice the targets list;
  // if a single (zip,fips) target, slice plans-per-target instead.
  const planLimit = args.limit && targets.length === 1 ? args.limit : null;
  if (args.limit && targets.length > 1) {
    targets.length = Math.min(targets.length, args.limit);
  }
  console.log(
    `  ${targets.length} county target${targets.length === 1 ? '' : 's'}` +
      (planLimit ? `, max ${planLimit} plan${planLimit === 1 ? '' : 's'} per target` : ''),
  );

  let totalPlans = 0;
  let totalRows = 0;
  let totalWritten = 0;
  const failures = [];
  const browser = await launchBrowser({ verbose });
  let page = null;
  let bodyTemplate = null;
  try {
    const warmed = await warmPage(browser, { verbose });
    page = warmed.page;

    // Discover the real /plans/search request shape from the SPA's
    // own traffic — the geo args ride in the URL query string, not
    // the JSON body, so we capture both.
    if (!args.forceDom) {
      try {
        bodyTemplate = await discoverSearchSchema(page, {
          zip: targets[0].zip,
          fips: targets[0].fips,
          planType: args.planType,
          verbose,
        });
      } catch (err) {
        if (verbose) console.warn('  schema discovery failed:', err.message);
      }
    }

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];

      // ─── try API ───
      let usingDom = args.forceDom;
      let plans = [];
      let rawBody = null;
      if (!usingDom) {
        const apiResult = await searchPlansViaApi(page, {
          zip: t.zip,
          fips: t.fips,
          planType: args.planType,
          capturedTemplate: bodyTemplate,
          verbose,
        });
        if (apiResult.ok) {
          plans = extractPlansFromApi(apiResult.body);
          rawBody = apiResult.body;
          if (plans.length === 0) {
            if (verbose) console.log('  API returned 0 plans — falling back to DOM');
            usingDom = true;
          }
        } else {
          console.warn(
            `  ${t.zip}/${t.fips} API ${apiResult.status} (${apiResult.contentType}); falling back to DOM`,
          );
          if (verbose) console.warn(`    sample: ${apiResult.sample?.slice(0, 200)}`);
          usingDom = true;
        }
      }

      // ─── DOM fallback ───
      if (usingDom) {
        try {
          const domResult = await searchPlansViaDom(page, {
            zip: t.zip,
            fips: t.fips,
            planType: args.planType,
            planLimit,
            verbose,
          });
          plans = domResult.body.plans;
          rawBody = domResult.body;
        } catch (err) {
          failures.push({ target: t, source: 'dom', message: err.message });
          console.warn(`  ✗ ${t.zip}/${t.fips} DOM: ${err.message}`);
          continue;
        }
      } else if (planLimit) {
        plans = plans.slice(0, planLimit);
      }

      // ─── persist raw + normalize ───
      const payloadPath = path.join(OUT_DIR, `${t.zip}-${t.fips}.json`);
      fs.writeFileSync(payloadPath, JSON.stringify(rawBody ?? { plans }, null, 2));

      const upsertBatch = [];
      const planTriples = [];
      for (let pi = 0; pi < plans.length; pi++) {
        const raw = plans[pi];
        const planFilter = t.planFilter ?? args.plan;
        if (planFilter && `${raw.contract_id}-${raw.plan_id}` !== planFilter) continue;

        // ── Fetch the per-plan detail card for full ma_benefits + Rx
        // tiers + inpatient day-stage + supplemental enums. Throttle
        // 2s between detail calls to stay polite.
        let detailCard = null;
        if (!args.skipDetail) {
          if (pi > 0) await page.waitForTimeout(PER_PLAN_DELAY_MS);
          try {
            detailCard = await fetchPlanDetail(page, {
              year: raw.contract_year ?? String(YEAR),
              contract: raw.contract_id,
              plan: raw.plan_id,
              segment: raw.segment_id ?? '0',
              verbose,
            });
          } catch (err) {
            if (verbose) console.warn(`   detail fetch errored for ${raw.contract_id}-${raw.plan_id}:`, err.message);
          }
        }

        const { triple, rows } = normalizePlanToBenefits(raw, detailCard, planFilter);
        if (!triple) continue;
        planTriples.push(triple);
        totalPlans += 1;
        totalRows += rows.length;
        for (const r of rows) upsertBatch.push(r);
        if (verbose) {
          console.log(`   ${triple} → ${rows.length} rows${detailCard ? ' (with detail)' : ''}`);
        }
      }
      if (args.write && upsertBatch.length > 0) {
        await sbDeleteForPlans(env, planTriples);
        const CHUNK = 500;
        for (let j = 0; j < upsertBatch.length; j += CHUNK) {
          await sbInsert(env, upsertBatch.slice(j, j + CHUNK));
        }
        totalWritten += upsertBatch.length;
      }
      console.log(
        `  ✓ ${t.zip}/${t.fips} [${usingDom ? 'dom' : 'api'}] → ${plans.length} plan${plans.length === 1 ? '' : 's'}, ${upsertBatch.length} rows${args.write ? ` (wrote ${upsertBatch.length})` : ' (dry-run)'}`,
      );

      if (i < targets.length - 1) await page.waitForTimeout(PER_COUNTY_DELAY_MS);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log('\nsummary:');
  console.log(`  plans processed:    ${totalPlans}`);
  console.log(`  benefit rows:       ${totalRows}`);
  console.log(`  rows written to DB: ${totalWritten}`);
  console.log(`  failures:           ${failures.length}`);
  if (failures.length === targets.length && targets.length > 0) {
    console.error('\nEvery target failed. Inspect _tmp/medicare-gov/ payloads.');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
