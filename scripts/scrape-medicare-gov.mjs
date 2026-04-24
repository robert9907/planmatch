#!/usr/bin/env node
// scripts/scrape-medicare-gov.mjs
//
// Medicare.gov Plan Finder scraper — writes to pbp_benefits with
// source='medicare_gov'. The migration in scripts/migrations/
// 001_pbp_benefits.sql must be applied before --write can succeed.
//
// Usage:
//   node scripts/scrape-medicare-gov.mjs --zip 27713 --fips 37063
//   node scripts/scrape-medicare-gov.mjs --state NC
//   node scripts/scrape-medicare-gov.mjs --plan H5253-189
//   node scripts/scrape-medicare-gov.mjs --zip 27713 --fips 37063 --dry-run
//   node scripts/scrape-medicare-gov.mjs --zip 27713 --fips 37063 --limit 5
//   node scripts/scrape-medicare-gov.mjs --zip 27713 --fips 37063 --write
//
// Defaults: --dry-run is implied unless --write is passed.
//
// ─── IMPORTANT: endpoint discovery is still open ────────────────────
//
// As of this commit the user-suggested URL pattern
//   https://www.medicare.gov/api/v1/plans?zip={zip}&fips={fips}&year=2026
// returns HTTP 404. Reverse-engineering the public /plan-compare/ and
// /find-a-plan/ SPAs only surfaced the dental-compare bundle (CDT
// codes, not Plan Finder routes); every documented and undocumented
// pattern I probed returned 404 or 000 (WAF block). The real Plan
// Finder data path likely requires an authenticated session token or
// a host I can't reach from a scripted client without running through
// the actual website flow.
//
// This script is wired end-to-end against the user's suggested URL
// pattern and writes a --dry-run response to _tmp/medicare-gov/ for
// audit. If you flip ENDPOINT_BASE below to a working host the rest
// of the pipeline (extract → upsert into pbp_benefits) just works.
// Until then, --write will fail loudly with the HTTP status it got.
// ─────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '_tmp', 'medicare-gov');

// Flip this when Plan Finder's real endpoint is known. The scraper
// treats the full URL (minus the query string) as immutable so the
// rest of the code doesn't care.
const ENDPOINT_BASE = 'https://www.medicare.gov/api/v1/plans';
const YEAR = 2026;
const RATE_LIMIT_MS = 2000;

// ─── arg parsing ────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { dryRun: null, write: false, limit: null, zip: null, fips: null, state: null, plan: null, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--zip': out.zip = next; i++; break;
      case '--fips': out.fips = next; i++; break;
      case '--state': out.state = (next ?? '').toUpperCase(); i++; break;
      case '--plan': out.plan = next; i++; break;
      case '--limit': out.limit = Number(next); i++; break;
      case '--dry-run': out.dryRun = true; break;
      case '--write': out.write = true; break;
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

async function sbUpsert(env, rows, onConflict) {
  // Service-role keys go straight through RLS; use return=minimal so
  // we don't ship a response body for every chunk.
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/pbp_benefits?on_conflict=${onConflict}`,
    {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    const code = res.status;
    if (code === 404 || /PGRST205/.test(body)) {
      throw new Error(
        'pbp_benefits table is missing. Run scripts/migrations/001_pbp_benefits.sql in the Supabase SQL Editor first.',
      );
    }
    throw new Error(`supabase upsert ${code}: ${body.slice(0, 400)}`);
  }
}

// ─── scrape helpers ────────────────────────────────────────────────
function planFinderUrl({ zip, fips }) {
  const qs = new URLSearchParams({ zip, fips, year: String(YEAR) });
  return `${ENDPOINT_BASE}?${qs.toString()}`;
}

async function fetchCountyPlans({ zip, fips, verbose }) {
  const url = planFinderUrl({ zip, fips });
  if (verbose) console.log('  GET', url);
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent':
        'PlanMatchScraper/1.0 (https://planmatch.vercel.app · internal use)',
    },
  });
  const ct = res.headers.get('content-type') ?? '';
  if (!res.ok || !ct.includes('json')) {
    return {
      ok: false,
      status: res.status,
      contentType: ct,
      sample: (await res.text()).slice(0, 400),
      url,
    };
  }
  const body = await res.json();
  return { ok: true, body, url };
}

// Maps the Plan Finder JSON (whatever shape it ends up being) to our
// normalized benefit rows. The shape is declared here speculatively
// based on the user's spec — once the real response shape is known,
// only this function needs updating. Everything downstream consumes
// the normalized shape.
function normalizePlanToBenefits(rawPlan) {
  const triple = (rawPlan?.contract_id && rawPlan?.plan_id)
    ? `${rawPlan.contract_id}-${rawPlan.plan_id}-${rawPlan.segment_id ?? '000'}`
    : rawPlan?.plan_triple_id ?? rawPlan?.id;
  if (!triple) return { triple: null, rows: [] };

  const rows = [];
  const push = (benefit_type, tier_id, copay, coinsurance, description) => {
    if (copay == null && coinsurance == null && !description) return;
    rows.push({
      plan_id: triple,
      benefit_type,
      tier_id,
      copay: copay != null ? Number(copay) : null,
      coinsurance: coinsurance != null ? Number(coinsurance) : null,
      description: description ?? null,
      source: 'medicare_gov',
    });
  };

  // Medical
  push('premium', null, rawPlan.monthly_premium, null, null);
  push('moop_in_network', null, rawPlan.moop, null, null);
  push('rx_deductible', null, rawPlan.drug_deductible, null, null);
  push('primary_care', null, rawPlan.pcp_copay, null, null);
  push('specialist', null, rawPlan.specialist_copay, null, null);
  push('emergency', null, rawPlan.er_copay, null, null);
  push('urgent_care', null, rawPlan.urgent_care_copay, null, null);
  if (rawPlan.inpatient) {
    for (const [i, stage] of (rawPlan.inpatient.stages ?? []).entries()) {
      push(`inpatient_day_stage_${i + 1}`, String(i + 1), stage.copay, stage.coinsurance, stage.description);
    }
  }
  push('outpatient_surgery_hospital', null, rawPlan.outpatient_surgery_hospital, null, null);
  push('outpatient_surgery_asc', null, rawPlan.outpatient_surgery_asc, null, null);
  push('lab', null, rawPlan.lab_copay, null, null);
  push('diagnostic_radiology', null, rawPlan.imaging_copay, null, null);
  push('ambulance', null, rawPlan.ambulance_copay, null, null);

  // Rx tiers
  for (const t of rawPlan.rx_tiers ?? []) {
    push('rx_tier', String(t.tier), t.copay, t.coinsurance, t.description);
  }

  // Extras
  push('dental_max', null, rawPlan.dental_annual_max, null, null);
  push('vision_eyewear', null, rawPlan.vision_eyewear_allowance_year, null, null);
  push('hearing_aid', null, rawPlan.hearing_aid_allowance_year, null, null);
  push('otc_quarter', null, rawPlan.otc_allowance_per_quarter, null, null);
  push('food_card_month', null, rawPlan.food_card_allowance_per_month, null, null);
  push('fitness', null, null, null, rawPlan.fitness_program ?? null);
  push('transportation_trips', null, rawPlan.transportation_trips_per_year, null, null);
  push('meals', null, rawPlan.post_discharge_meals_count, null, null);

  return { triple, rows };
}

// ─── county targets ────────────────────────────────────────────────
async function resolveTargets({ zip, fips, state, plan, env, verbose }) {
  if (plan) {
    // --plan triggers a single-triple path. We still need a zip+fips
    // so the Plan Finder query is well-formed; look it up from any
    // row in pm_plans for that contract+plan.
    const [contract, pid] = plan.split('-');
    const rows = await sbGet(
      env,
      `/pm_plans?contract_id=eq.${contract}&plan_id=eq.${pid}&select=contract_id,plan_id,segment_id,state,county_name&limit=1`,
    );
    if (!rows.length) throw new Error(`no pm_plans row for ${plan}`);
    const county = rows[0].county_name;
    const zc = await sbGet(env, `/pm_zip_county?county=eq.${encodeURIComponent(county)}&state=eq.${rows[0].state}&select=zip,fips&limit=1`);
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

// ─── main ──────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  const verbose = args.verbose;
  console.log('scrape-medicare-gov');
  console.log('  mode:', args.dryRun ? 'DRY RUN' : 'WRITE');
  if (args.write && (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for --write');
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const targets = await resolveTargets({ ...args, env, verbose });
  if (args.limit) targets.length = Math.min(targets.length, args.limit);
  console.log(`  ${targets.length} county target${targets.length === 1 ? '' : 's'}`);

  let totalPlans = 0;
  let totalRows = 0;
  let totalWritten = 0;
  const failures = [];

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const result = await fetchCountyPlans({ zip: t.zip, fips: t.fips, verbose });
    if (!result.ok) {
      failures.push({ target: t, status: result.status, contentType: result.contentType, url: result.url, sample: result.sample });
      console.warn(`  ✗ ${t.zip}/${t.fips} → HTTP ${result.status} (${result.contentType})`);
    } else {
      let plans = Array.isArray(result.body?.plans) ? result.body.plans : Array.isArray(result.body) ? result.body : [];
      if (args.plan) plans = plans.filter((p) => `${p.contract_id}-${p.plan_id}` === args.plan);
      const payloadPath = path.join(OUT_DIR, `${t.zip}-${t.fips}.json`);
      fs.writeFileSync(payloadPath, JSON.stringify(result.body, null, 2));

      const upsertBatch = [];
      for (const raw of plans) {
        const { triple, rows } = normalizePlanToBenefits(raw);
        if (!triple) continue;
        totalPlans += 1;
        totalRows += rows.length;
        for (const r of rows) upsertBatch.push(r);
      }
      if (args.write && upsertBatch.length > 0) {
        const CHUNK = 500;
        for (let j = 0; j < upsertBatch.length; j += CHUNK) {
          await sbUpsert(env, upsertBatch.slice(j, j + CHUNK), 'plan_id,benefit_type,tier_id');
        }
        totalWritten += upsertBatch.length;
      }
      console.log(
        `  ✓ ${t.zip}/${t.fips} → ${plans.length} plan${plans.length === 1 ? '' : 's'}, ${upsertBatch.length} rows${args.write ? ` (wrote ${upsertBatch.length})` : ' (dry-run)'}`,
      );
    }
    if (i < targets.length - 1) await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
  }

  console.log('\nsummary:');
  console.log(`  plans processed:    ${totalPlans}`);
  console.log(`  benefit rows:       ${totalRows}`);
  console.log(`  rows written to DB: ${totalWritten}`);
  console.log(`  failures:           ${failures.length}`);
  if (failures.length > 0) {
    console.log('\nfailures (first 3):');
    for (const f of failures.slice(0, 3)) {
      console.log(`  ${f.target.zip}/${f.target.fips}  HTTP ${f.status}`);
      console.log(`    url:    ${f.url}`);
      console.log(`    sample: ${(f.sample ?? '').slice(0, 240)}`);
    }
  }
  if (failures.length === targets.length) {
    console.error(
      '\nEvery request failed. The endpoint at',
      ENDPOINT_BASE,
      'is returning non-JSON responses.',
    );
    console.error('Update ENDPOINT_BASE in scripts/scrape-medicare-gov.mjs to the real Plan Finder endpoint once it is known.');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
