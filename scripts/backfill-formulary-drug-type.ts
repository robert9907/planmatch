// Backfill drug_type on existing pm_formulary_v2 rows using the same
// classification logic as the promote pipeline. One-shot script — after
// migration 017 adds the column, this fills it for rows that were
// promoted before the promote.ts change landed.
//
// Two-pass strategy so each pass has a narrow WHERE:
//   pass 1 → specialty from pm_beneficiary_cost_v2.tier_specialty at
//            (coverage_level=1, days_supply_code=1, pharmacy_type=pref)
//   pass 2 → generic / brand from pm_rxcui_meta.tty (RxNorm term type)
//
// Rxcuis whose tty isn't cached yet are left NULL — re-run the RxNav
// enrichment (scripts/enrich-rxcui-meta.ts / equivalent) and then this
// backfill to pick them up.
//
// Defaults to --dry-run: prints the predicted classification
// distribution and quits. Pass --apply to actually update rows.
//
// Run with:
//   npx tsx scripts/backfill-formulary-drug-type.ts           # dry-run
//   npx tsx scripts/backfill-formulary-drug-type.ts --apply   # commit

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

const APPLY = process.argv.includes('--apply');
const GENERIC_TTYS = ['SCD', 'SCDC', 'SCDG', 'SCDF', 'GPCK'] as const;
const BRAND_TTYS = ['SBD', 'SBDC', 'SBDG', 'SBDF', 'BPCK', 'BN'] as const;

const BATCH_SIZE = 20_000;

async function main() {
  const c = await pool.connect();
  try {
    // Session-level (not LOCAL — no explicit transaction here, and
    // LOCAL is silently dropped outside a txn on Supabase). Bumps the
    // 8s pooler default so batched UPDATEs don't hit
    // statement_timeout mid-flight.
    await c.query(`SET statement_timeout = 0`);

    // ── Predict: distribution the backfill would produce ──────────────
    const predict = await c.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE f.drug_type IS NOT NULL)              AS already_classified,
        COUNT(*) FILTER (WHERE f.drug_type IS NULL
                           AND COALESCE(bc.tier_specialty, false))    AS predict_specialty,
        COUNT(*) FILTER (WHERE f.drug_type IS NULL
                           AND NOT COALESCE(bc.tier_specialty, false)
                           AND m.tty = ANY($1))                       AS predict_generic,
        COUNT(*) FILTER (WHERE f.drug_type IS NULL
                           AND NOT COALESCE(bc.tier_specialty, false)
                           AND m.tty = ANY($2))                       AS predict_brand,
        COUNT(*) FILTER (WHERE f.drug_type IS NULL
                           AND NOT COALESCE(bc.tier_specialty, false)
                           AND (m.tty IS NULL
                                OR (m.tty <> ALL($1) AND m.tty <> ALL($2))))
                                                                       AS still_null,
        COUNT(*)                                                       AS total
      FROM pm_formulary_v2 f
      LEFT JOIN pm_beneficiary_cost_v2 bc
        ON bc.contract_id  = f.contract_id
       AND bc.plan_id      = f.plan_id
       AND bc.segment_id   = f.segment_id
       AND bc.plan_year    = f.plan_year
       AND bc.tier         = f.tier
       AND bc.coverage_level    = 1
       AND bc.days_supply_code  = 1
       AND bc.pharmacy_type     = 'pref'
      LEFT JOIN pm_rxcui_meta m ON m.rxcui = f.rxcui
      `,
      [GENERIC_TTYS, BRAND_TTYS],
    );

    console.log('Predicted classification distribution:');
    for (const [k, v] of Object.entries(predict.rows[0])) {
      console.log(`  ${k.padEnd(22)} : ${Number(v).toLocaleString()}`);
    }

    if (!APPLY) {
      console.log('\nDry-run — no rows updated. Re-run with --apply to commit.');
      return;
    }

    // ── Apply pass 1: specialty ───────────────────────────────────────
    // Batched — 4M-row updates against Supabase blow past the 8s
    // pooler statement_timeout even with SET statement_timeout = 0
    // (Supabase enforces a hard ceiling on the pooler side). CTE
    // picks a bounded slice, main UPDATE writes it, loop until zero.
    console.log('\nPass 1: UPDATE pm_formulary_v2 SET drug_type = specialty …');
    const t1 = Date.now();
    let pass1Total = 0;
    while (true) {
      const r = await c.query(
        `
        WITH batch AS (
          SELECT f.contract_id, f.plan_id, f.segment_id, f.plan_year, f.rxcui
            FROM pm_formulary_v2 f
            JOIN pm_beneficiary_cost_v2 bc
              ON bc.contract_id       = f.contract_id
             AND bc.plan_id           = f.plan_id
             AND bc.segment_id        = f.segment_id
             AND bc.plan_year         = f.plan_year
             AND bc.tier              = f.tier
             AND bc.coverage_level    = 1
             AND bc.days_supply_code  = 1
             AND bc.pharmacy_type     = 'pref'
           WHERE f.drug_type IS NULL
             AND bc.tier_specialty    = true
           LIMIT ${BATCH_SIZE}
        )
        UPDATE pm_formulary_v2 f
           SET drug_type = 'specialty'
          FROM batch b
         WHERE f.contract_id = b.contract_id
           AND f.plan_id     = b.plan_id
           AND f.segment_id  = b.segment_id
           AND f.plan_year   = b.plan_year
           AND f.rxcui       = b.rxcui
        `,
      );
      const n = r.rowCount ?? 0;
      pass1Total += n;
      if (n === 0) break;
      process.stdout.write(`  batch ${n.toLocaleString()} (total ${pass1Total.toLocaleString()})\r`);
    }
    console.log(
      `\n  ${pass1Total.toLocaleString()} rows in ${((Date.now() - t1) / 1000).toFixed(1)}s`,
    );

    // ── Apply pass 2: generic / brand ─────────────────────────────────
    // Same batching pattern for symmetry — no-op today (pm_rxcui_meta
    // .tty is empty in prod, per dry-run) but ready to fire once
    // RxNav enrichment lands.
    console.log('\nPass 2: UPDATE pm_formulary_v2 SET drug_type = generic|brand …');
    const t2 = Date.now();
    let pass2Total = 0;
    while (true) {
      const r = await c.query(
        `
        WITH batch AS (
          SELECT f.contract_id, f.plan_id, f.segment_id, f.plan_year, f.rxcui,
                 CASE
                   WHEN m.tty = ANY($1) THEN 'generic'
                   WHEN m.tty = ANY($2) THEN 'brand'
                 END AS new_type
            FROM pm_formulary_v2 f
            JOIN pm_rxcui_meta m ON m.rxcui = f.rxcui
           WHERE f.drug_type IS NULL
             AND (m.tty = ANY($1) OR m.tty = ANY($2))
           LIMIT ${BATCH_SIZE}
        )
        UPDATE pm_formulary_v2 f
           SET drug_type = b.new_type
          FROM batch b
         WHERE f.contract_id = b.contract_id
           AND f.plan_id     = b.plan_id
           AND f.segment_id  = b.segment_id
           AND f.plan_year   = b.plan_year
           AND f.rxcui       = b.rxcui
        `,
        [GENERIC_TTYS, BRAND_TTYS],
      );
      const n = r.rowCount ?? 0;
      pass2Total += n;
      if (n === 0) break;
      process.stdout.write(`  batch ${n.toLocaleString()} (total ${pass2Total.toLocaleString()})\r`);
    }
    console.log(
      `\n  ${pass2Total.toLocaleString()} rows in ${((Date.now() - t2) / 1000).toFixed(1)}s`,
    );

    // ── Post: actual distribution ─────────────────────────────────────
    const post = await c.query(
      `
      SELECT COALESCE(drug_type, '(null)') AS drug_type, COUNT(*) AS rows
        FROM pm_formulary_v2
       GROUP BY drug_type
       ORDER BY rows DESC
      `,
    );
    console.log('\nPost-backfill distribution:');
    for (const r of post.rows) {
      console.log(`  ${String(r.drug_type).padEnd(12)} : ${Number(r.rows).toLocaleString()}`);
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
