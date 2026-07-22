// Cleanup script: delete pm_formulary_v2 rows whose (contract_id,
// plan_id) has no match in pm_plans. These accumulate when a prior
// SPUF import loaded contracts outside our current state scope
// (NC/GA/TX) — the audited example is H4004 (Florida/PR), ~68k rows
// with no pm_plans presence. They're inert (no query paths hit them)
// but they inflate counts and confuse audits.
//
// Deletes from the BASE table pm_formulary_v2, not the view. Cascades
// nothing — pm_formulary_v2 has no FK dependents.
//
// Defaults to --dry-run: prints how many rows would be deleted and the
// top 10 contracts contributing. Pass --apply to actually delete.
//
// Safety: if pm_plans has fewer than 1,000 rows the script aborts —
// that condition means pm_plans hasn't been populated and the delete
// would nuke everything.
//
// Run with:
//   npx tsx scripts/cleanup-stale-formulary-rows.ts           # dry-run
//   npx tsx scripts/cleanup-stale-formulary-rows.ts --apply   # commit

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

async function main() {
  const c = await pool.connect();
  try {
    await c.query('SET LOCAL statement_timeout = 0');

    // ── Sanity gate: pm_plans must be populated ───────────────────────
    const gate = await c.query(`SELECT COUNT(*)::int AS n FROM pm_plans`);
    const planCount = gate.rows[0].n;
    if (planCount < 1000) {
      console.error(
        `pm_plans has only ${planCount} rows — aborting. If pm_plans hasn't been imported yet this cleanup would delete every formulary row.`,
      );
      process.exit(1);
    }
    console.log(`pm_plans has ${planCount.toLocaleString()} rows — safe to proceed.`);

    // ── Preview: total stale count + top contracts ────────────────────
    const total = await c.query(
      `
      SELECT COUNT(*)::bigint AS stale_rows
        FROM pm_formulary_v2 f
       WHERE NOT EXISTS (
         SELECT 1 FROM pm_plans p
          WHERE p.contract_id = f.contract_id
            AND p.plan_id     = f.plan_id
       )
      `,
    );
    const stale = Number(total.rows[0].stale_rows);
    console.log(`\nStale pm_formulary_v2 rows: ${stale.toLocaleString()}`);

    if (stale === 0) {
      console.log('Nothing to clean up.');
      return;
    }

    const top = await c.query(
      `
      SELECT f.contract_id, COUNT(*)::int AS rows,
             COUNT(DISTINCT f.plan_id)::int AS plans
        FROM pm_formulary_v2 f
       WHERE NOT EXISTS (
         SELECT 1 FROM pm_plans p
          WHERE p.contract_id = f.contract_id
            AND p.plan_id     = f.plan_id
       )
       GROUP BY f.contract_id
       ORDER BY rows DESC
       LIMIT 10
      `,
    );
    console.log('\nTop 10 stale contracts:');
    console.log(`  ${'contract'.padEnd(10)} ${'rows'.padStart(10)}  ${'plans'.padStart(6)}`);
    for (const r of top.rows) {
      console.log(
        `  ${String(r.contract_id).padEnd(10)} ${Number(r.rows).toLocaleString().padStart(10)}  ${String(r.plans).padStart(6)}`,
      );
    }

    if (!APPLY) {
      console.log('\nDry-run — no rows deleted. Re-run with --apply to commit.');
      return;
    }

    // ── Delete ────────────────────────────────────────────────────────
    console.log('\nDELETE FROM pm_formulary_v2 WHERE (contract_id, plan_id) NOT IN pm_plans …');
    const t0 = Date.now();
    const del = await c.query(
      `
      DELETE FROM pm_formulary_v2 f
       WHERE NOT EXISTS (
         SELECT 1 FROM pm_plans p
          WHERE p.contract_id = f.contract_id
            AND p.plan_id     = f.plan_id
       )
      `,
    );
    console.log(
      `Deleted ${(del.rowCount ?? 0).toLocaleString()} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );

    const after = await c.query(`SELECT COUNT(*)::bigint AS n FROM pm_formulary_v2`);
    console.log(`pm_formulary_v2 now has ${Number(after.rows[0].n).toLocaleString()} rows.`);
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
