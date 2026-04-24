#!/usr/bin/env node
// scripts/import-pbp-extras.mjs
//
// One-shot backfill of the benefit categories the original importer
// skipped. Reads three PBP 2026 structured files:
//
//   pbp_b7_health_prof.txt   → mental health, PT/OT/speech, telehealth
//   pbp_b8_clin_diag_ther.txt → lab, diagnostic tests, X-rays, MRI/CT, therapeutic rad
//   pbp_b9_outpat_hosp.txt    → outpatient surgery (hospital + ASC), observation
//
// Writes 12 new benefit_category rows per plan into pm_plan_benefits. The
// script DELETEs any existing rows for these categories before INSERTing
// so it's idempotent — safe to re-run if a file updates.
//
// Run: node scripts/import-pbp-extras.mjs
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY from .env.local.

import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

const PBP_DIR = '/Users/robertsimm/Desktop/Plan Match/pbp-benefits-2026';
const NEW_CATEGORIES = [
  'outpatient_surgery_hospital',
  'outpatient_surgery_asc',
  'outpatient_observation',
  'lab_services',
  'diagnostic_tests',
  'xray',
  'diagnostic_radiology',
  'therapeutic_radiology',
  'mental_health_individual',
  'mental_health_group',
  'physical_therapy',
  'telehealth',
];

const ENV_PATH = path.join(process.cwd(), '.env.local');
const env = Object.fromEntries(
  fs
    .readFileSync(ENV_PATH, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')];
    }),
);
const SUPABASE_URL = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

function num(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t || t === '.') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// Each plan's row is picked up, and for each new category we emit either
// a copay row, a coinsurance row, or nothing (filed but YN=0). The rule
// mirrors the existing importer: prefer min copay when present, else
// min coinsurance percent; drop rows where both are null — those mean
// the service isn't itemized in the PBP extract for this plan.
function toRow(cid, pid, sid, category, copay, coinsurance, desc) {
  if (copay == null && coinsurance == null) return null;
  return {
    contract_id: cid,
    plan_id: pid,
    segment_id: sid || '0',
    benefit_category: category,
    benefit_description: desc,
    coverage_amount: null,
    copay: copay != null ? Number(copay) : null,
    coinsurance: coinsurance != null ? Number(coinsurance) : null,
    max_coverage: null,
  };
}

async function parseFile(filename) {
  const filepath = path.join(PBP_DIR, filename);
  const stream = fs.createReadStream(filepath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header = null;
  const rows = [];
  for await (const line of rl) {
    const fields = line.split('\t');
    if (!header) {
      header = fields;
      continue;
    }
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = fields[i] ?? '';
    rows.push(obj);
  }
  return rows;
}

function buildOutputRows({ b7, b8, b9 }) {
  // Index by contract_id+plan_id+segment for fast joins.
  const key = (r) => `${r.pbp_a_hnumber}_${r.pbp_a_plan_identifier}_${r.segment_id || '0'}`;
  const b8Map = new Map(b8.map((r) => [key(r), r]));
  const b9Map = new Map(b9.map((r) => [key(r), r]));

  const out = [];
  for (const r7 of b7) {
    const cid = r7.pbp_a_hnumber;
    const pid = r7.pbp_a_plan_identifier;
    const sid = r7.segment_id || '0';
    if (!cid || !pid) continue;
    const k = key(r7);
    const r8 = b8Map.get(k);
    const r9 = b9Map.get(k);

    // b7e — outpatient mental health (individual / group)
    const mhiCopay = num(r7.pbp_b7e_copay_mcis_minamt);
    const mhiCoins = num(r7.pbp_b7e_coins_mcis_minpct);
    out.push(
      toRow(cid, pid, sid, 'mental_health_individual', mhiCopay, mhiCoins,
        mhiCopay != null ? `Outpatient MH individual · $${mhiCopay} copay` :
        mhiCoins != null ? `Outpatient MH individual · ${mhiCoins}% coinsurance` : ''),
    );
    const mhgCopay = num(r7.pbp_b7e_copay_mcgs_minamt);
    const mhgCoins = num(r7.pbp_b7e_coins_mcgs_minpct);
    out.push(
      toRow(cid, pid, sid, 'mental_health_group', mhgCopay, mhgCoins,
        mhgCopay != null ? `Outpatient MH group · $${mhgCopay} copay` :
        mhgCoins != null ? `Outpatient MH group · ${mhgCoins}% coinsurance` : ''),
    );

    // b7i — Physical therapy / OT / speech
    const ptCopay = num(r7.pbp_b7i_copay_mc_amt_min);
    const ptCoins = num(r7.pbp_b7i_coins_pct_mc_min);
    out.push(
      toRow(cid, pid, sid, 'physical_therapy', ptCopay, ptCoins,
        ptCopay != null ? `PT / OT / speech · $${ptCopay} copay` :
        ptCoins != null ? `PT / OT / speech · ${ptCoins}% coinsurance` : ''),
    );

    // b7j — Telehealth (single row — carrier scope varies via bendesc cats)
    const tlCopay = num(r7.pbp_b7j_copay_mc_amt_min);
    const tlCoins = num(r7.pbp_b7j_coins_pct_mc_min);
    out.push(
      toRow(cid, pid, sid, 'telehealth', tlCopay, tlCoins,
        tlCopay != null ? `Telehealth · $${tlCopay} copay` :
        tlCoins != null ? `Telehealth · ${tlCoins}% coinsurance` : ''),
    );

    // b8 — clinical diagnostic / therapeutic
    if (r8) {
      const labCopay = null; // PBP files lab under coinsurance only
      const labCoins = num(r8.pbp_b8a_coins_pct_lab);
      out.push(
        toRow(cid, pid, sid, 'lab_services', labCopay, labCoins,
          labCoins != null ? `Lab services · ${labCoins}% coinsurance` : 'Lab services · $0'),
      );
      // Covered under Original Medicare @ $0 when the plan doesn't file
      // a separate cost share — emit a $0 row so the UI shows a value.
      if (labCopay == null && labCoins == null) {
        out[out.length - 1] = toRow(cid, pid, sid, 'lab_services', 0, null, 'Lab services · $0');
      }

      const dmcCopay = num(r8.pbp_b8a_copay_min_dmc_amt);
      const dmcCoins = num(r8.pbp_b8a_coins_pct_dmc);
      out.push(
        toRow(cid, pid, sid, 'diagnostic_tests', dmcCopay, dmcCoins,
          dmcCopay != null ? `Diagnostic tests & procedures · $${dmcCopay}` :
          dmcCoins != null ? `Diagnostic tests · ${dmcCoins}% coinsurance` : ''),
      );

      const xrCopay = num(r8.pbp_b8b_copay_mc_amt);
      const xrCoins = num(r8.pbp_b8b_coins_pct_cmc);
      out.push(
        toRow(cid, pid, sid, 'xray', xrCopay, xrCoins,
          xrCopay != null ? `X-rays · $${xrCopay} copay` :
          xrCoins != null ? `X-rays · ${xrCoins}% coinsurance` : ''),
      );

      const drsCopay = num(r8.pbp_b8b_copay_amt_drs);
      const drsCoins = num(r8.pbp_b8b_coins_pct_drs);
      out.push(
        toRow(cid, pid, sid, 'diagnostic_radiology', drsCopay, drsCoins,
          drsCopay != null ? `Diagnostic radiology (MRI/CT) · $${drsCopay}` :
          drsCoins != null ? `Diagnostic radiology · ${drsCoins}% coinsurance` : ''),
      );

      const tmcCopay = num(r8.pbp_b8b_copay_amt_tmc);
      const tmcCoins = num(r8.pbp_b8b_coins_pct_tmc);
      out.push(
        toRow(cid, pid, sid, 'therapeutic_radiology', tmcCopay, tmcCoins,
          tmcCopay != null ? `Therapeutic radiology · $${tmcCopay}` :
          tmcCoins != null ? `Therapeutic radiology · ${tmcCoins}% coinsurance` : ''),
      );
    }

    // b9 — outpatient hospital + ASC + observation
    if (r9) {
      const ohsCopay = num(r9.pbp_b9a_copay_ohs_amt_min);
      const ohsCoins = num(r9.pbp_b9a_coins_ohs_pct_min);
      out.push(
        toRow(cid, pid, sid, 'outpatient_surgery_hospital', ohsCopay, ohsCoins,
          ohsCopay != null ? `Outpatient surgery (hospital) · $${ohsCopay}` :
          ohsCoins != null ? `Outpatient surgery (hospital) · ${ohsCoins}% coinsurance` : ''),
      );

      const ascCopay = num(r9.pbp_b9b_copay_mc_amt);
      const ascCoins = num(r9.pbp_b9b_coins_pct_mc);
      out.push(
        toRow(cid, pid, sid, 'outpatient_surgery_asc', ascCopay, ascCoins,
          ascCopay != null ? `Outpatient surgery (ASC) · $${ascCopay}` :
          ascCoins != null ? `Outpatient surgery (ASC) · ${ascCoins}% coinsurance` : ''),
      );

      const obsCopay = num(r9.pbp_b9a_copay_obs_amt_min);
      const obsCoins = num(r9.pbp_b9a_coins_obs_pct_min);
      out.push(
        toRow(cid, pid, sid, 'outpatient_observation', obsCopay, obsCoins,
          obsCopay != null ? `Outpatient observation · $${obsCopay}` :
          obsCoins != null ? `Outpatient observation · ${obsCoins}% coinsurance` : ''),
      );
    }
  }
  return out.filter((r) => r != null);
}

async function deleteOldRows() {
  const catsCsv = NEW_CATEGORIES.map((c) => `"${c}"`).join(',');
  const url = `${SUPABASE_URL}/rest/v1/pm_plan_benefits?benefit_category=in.(${catsCsv})`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      Prefer: 'return=minimal',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`delete failed ${res.status}: ${body.slice(0, 300)}`);
  }
}

async function bulkInsert(rows) {
  const CHUNK = 1000;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/pm_plan_benefits`, {
      method: 'POST',
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(slice),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`insert chunk ${i / CHUNK} failed ${res.status}: ${body.slice(0, 400)}`);
    }
    inserted += slice.length;
    process.stdout.write(`  inserted ${inserted}/${rows.length}\r`);
  }
  console.log(`\n  done: ${inserted} rows`);
}

async function main() {
  console.log('reading PBP files…');
  const [b7, b8, b9] = await Promise.all([
    parseFile('pbp_b7_health_prof.txt'),
    parseFile('pbp_b8_clin_diag_ther.txt'),
    parseFile('pbp_b9_outpat_hosp.txt'),
  ]);
  console.log(`  b7=${b7.length} b8=${b8.length} b9=${b9.length}`);

  console.log('building rows…');
  const rows = buildOutputRows({ b7, b8, b9 });
  // Per-category counts so we can spot an empty mapping before we overwrite.
  const counts = rows.reduce((m, r) => ((m[r.benefit_category] = (m[r.benefit_category] ?? 0) + 1), m), {});
  console.log('  per-category row counts:', counts);

  console.log(`deleting existing rows for ${NEW_CATEGORIES.length} categories…`);
  await deleteOldRows();

  console.log(`bulk inserting ${rows.length} rows…`);
  await bulkInsert(rows);

  console.log('verify sample (H1036-308):');
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/pm_plan_benefits?contract_id=eq.H1036&plan_id=eq.308&select=benefit_category,copay,coinsurance&benefit_category=in.(${NEW_CATEGORIES.map((c) => `"${c}"`).join(',')})`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } },
  );
  const sample = await res.json();
  console.table(sample);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
