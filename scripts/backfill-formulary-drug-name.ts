// Backfill pm_rxcui_meta from pm_drugs so the pm_formulary view exposes
// real drug_name strings.
//
// pm_formulary is a view over pm_formulary_v2 LEFT JOIN pm_rxcui_meta
// USING (rxcui). pm_formulary_v2 (populated by the SPUF importer) has
// no drug_name column — names come from pm_rxcui_meta. That table is
// currently empty, so every formulary read returns drug_name = null.
//
// Fix: copy (rxcui, name) from pm_drugs (which the RxNorm import
// populates with 21k clinical-drug rxcuis and names) into pm_rxcui_meta.
// Future RxNorm refreshes should keep both tables in sync; this script
// is the immediate one-shot backfill.
//
// Run with: npx tsx scripts/backfill-formulary-drug-name.ts

import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL in .env.local');
  process.exit(1);
}

import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const c = await pool.connect();
  try {
    await c.query('SET LOCAL statement_timeout = 0');

    const pre = await c.query(`
      SELECT
        (SELECT COUNT(*) FROM pm_rxcui_meta) AS meta_total,
        (SELECT COUNT(*) FROM pm_drugs) AS drugs_total,
        (SELECT COUNT(*) FROM pm_formulary_v2) AS v2_total,
        (SELECT COUNT(DISTINCT rxcui) FROM pm_formulary_v2) AS v2_distinct_rxcui,
        (SELECT COUNT(*) FROM pm_formulary WHERE drug_name IS NULL) AS view_null_name
    `);
    console.log('Before backfill:');
    for (const [k, v] of Object.entries(pre.rows[0])) {
      console.log(`  ${k.padEnd(25)} : ${Number(v).toLocaleString()}`);
    }

    console.log('\nINSERT INTO pm_rxcui_meta (rxcui, drug_name, fetched_at) SELECT rxcui, name, now() FROM pm_drugs ON CONFLICT (rxcui) DO UPDATE SET drug_name = EXCLUDED.drug_name, fetched_at = EXCLUDED.fetched_at …');
    const t0 = Date.now();
    // ON CONFLICT requires a unique constraint on rxcui. Try it; if it
    // fails, fall back to plain INSERT (table is empty).
    let inserted = 0;
    try {
      const r = await c.query(`
        INSERT INTO pm_rxcui_meta (rxcui, drug_name, fetched_at)
        SELECT rxcui, name, now() FROM pm_drugs
        ON CONFLICT (rxcui) DO UPDATE
          SET drug_name = EXCLUDED.drug_name,
              fetched_at = EXCLUDED.fetched_at
      `);
      inserted = r.rowCount ?? 0;
    } catch (err: any) {
      if (err.code === '42P10') {
        console.log('  No unique constraint on rxcui — using plain INSERT.');
        const r2 = await c.query(`
          INSERT INTO pm_rxcui_meta (rxcui, drug_name, fetched_at)
          SELECT rxcui, name, now() FROM pm_drugs
        `);
        inserted = r2.rowCount ?? 0;
      } else {
        throw err;
      }
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`Inserted/updated ${inserted.toLocaleString()} rows in ${elapsed}s`);

    const post = await c.query(`
      SELECT
        (SELECT COUNT(*) FROM pm_rxcui_meta) AS meta_total,
        (SELECT COUNT(*) FROM pm_rxcui_meta WHERE drug_name IS NOT NULL) AS meta_with_name,
        (SELECT COUNT(*) FROM pm_formulary WHERE drug_name IS NOT NULL) AS view_filled,
        (SELECT COUNT(*) FROM pm_formulary WHERE drug_name IS NULL) AS view_still_null,
        (SELECT COUNT(DISTINCT rxcui) FROM pm_formulary_v2 WHERE rxcui NOT IN (SELECT rxcui FROM pm_rxcui_meta WHERE drug_name IS NOT NULL)) AS missing_rxcui_count
    `);
    console.log('\nAfter backfill:');
    for (const [k, v] of Object.entries(post.rows[0])) {
      console.log(`  ${k.padEnd(25)} : ${Number(v).toLocaleString()}`);
    }
    const missing = Number(post.rows[0].missing_rxcui_count ?? 0);
    if (missing > 0) {
      console.log(`\n${missing} distinct rxcuis used by pm_formulary_v2 are NOT in pm_drugs.`);
      const sample = await c.query(`
        SELECT DISTINCT rxcui FROM pm_formulary_v2
        WHERE rxcui NOT IN (SELECT rxcui FROM pm_rxcui_meta WHERE drug_name IS NOT NULL)
        LIMIT 20
      `);
      console.log('Sample rxcuis missing from pm_drugs:');
      for (const r of sample.rows) console.log(`  ${r.rxcui}`);
      console.log('Re-run the RxNorm import (scripts/import-rxnorm.ts in the consumer repo) to pick these up, then re-run this backfill.');
    }
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
