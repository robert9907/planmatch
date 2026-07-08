// scripts/audit-pm-plans-snp-details.ts
//
// __benchFilters.audit() equivalent for the DB tier. Confirms the
// three Landscape-sourced columns added by migration 014 are populated
// on every eligible pm_plans row:
//
//   • Every snp_type='D-SNP' row has a non-null dsnp_integration_status
//   • Every snp_type='C-SNP' row has a non-null csnp_condition_type
//   • Every snp_type='D-SNP' row has a boolean zero_cost_sharing (not
//     null — the column NOT NULL DEFAULT false makes this trivially
//     true, but we check anyway to catch a silent DDL regression)
//
// Any row that fails the check is listed with (contract_id, plan_id,
// segment_id, state, county, plan_name, carrier) so the operator can
// track it down in Landscape or the CMS release notes.
//
// Run with:  npx tsx scripts/audit-pm-plans-snp-details.ts

import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

async function main() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const summary = await client.query<{
      snp_type: string;
      total: string;
      missing_integration: string;
      missing_condition: string;
      missing_zero_bool: string;
      zero_true: string;
    }>(`
      SELECT
        snp_type,
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE snp_type='D-SNP' AND dsnp_integration_status IS NULL)::text AS missing_integration,
        COUNT(*) FILTER (WHERE snp_type='C-SNP' AND csnp_condition_type   IS NULL)::text AS missing_condition,
        COUNT(*) FILTER (WHERE snp_type='D-SNP' AND zero_cost_sharing IS NULL)::text AS missing_zero_bool,
        COUNT(*) FILTER (WHERE snp_type='D-SNP' AND zero_cost_sharing = true)::text AS zero_true
      FROM pm_plans
      WHERE snp_type IN ('D-SNP','C-SNP','I-SNP')
      GROUP BY snp_type
      ORDER BY snp_type
    `);

    console.log(`═════════════════════════════════════════════════════════════`);
    console.log(`  pm_plans SNP-detail audit (migration 014)`);
    console.log(`═════════════════════════════════════════════════════════════`);
    let anyMissing = false;
    for (const r of summary.rows) {
      const total = Number(r.total);
      if (r.snp_type === 'D-SNP') {
        const missInt = Number(r.missing_integration);
        const missZero = Number(r.missing_zero_bool);
        const zeroT = Number(r.zero_true);
        console.log(
          `  D-SNP: ${total} rows | missing dsnp_integration_status=${missInt} | missing zero_cost_sharing (NULL)=${missZero} | zero_cost_sharing=true → ${zeroT}`,
        );
        if (missInt > 0 || missZero > 0) anyMissing = true;
      } else if (r.snp_type === 'C-SNP') {
        const missCond = Number(r.missing_condition);
        console.log(
          `  C-SNP: ${total} rows | missing csnp_condition_type=${missCond}`,
        );
        if (missCond > 0) anyMissing = true;
      } else {
        console.log(`  ${r.snp_type}: ${total} rows (no per-plan detail expected)`);
      }
    }

    if (anyMissing) {
      const gaps = await client.query<{
        snp_type: string;
        contract_id: string;
        plan_id: string;
        segment_id: string;
        state: string;
        county_name: string;
        carrier: string | null;
        plan_name: string;
        issue: string;
      }>(`
        SELECT snp_type, contract_id, plan_id, segment_id, state, county_name,
               carrier, plan_name,
               CASE
                 WHEN snp_type='D-SNP' AND dsnp_integration_status IS NULL THEN 'missing_dsnp_integration_status'
                 WHEN snp_type='C-SNP' AND csnp_condition_type IS NULL THEN 'missing_csnp_condition_type'
                 WHEN snp_type='D-SNP' AND zero_cost_sharing IS NULL THEN 'missing_zero_cost_sharing'
               END AS issue
          FROM pm_plans
         WHERE (snp_type='D-SNP' AND (dsnp_integration_status IS NULL OR zero_cost_sharing IS NULL))
            OR (snp_type='C-SNP' AND csnp_condition_type IS NULL)
         ORDER BY snp_type, contract_id, plan_id, segment_id, state
         LIMIT 100
      `);
      console.log(`\n  Gaps (first ${gaps.rows.length}):`);
      for (const g of gaps.rows) {
        console.log(
          `    [${g.issue}] ${g.snp_type} ${g.contract_id}-${g.plan_id}-${g.segment_id}  ${g.state} / ${g.county_name}  ${g.carrier ?? '—'} · ${g.plan_name}`,
        );
      }
    } else {
      console.log(`\n  PASS — every D-SNP has dsnp_integration_status + zero_cost_sharing; every C-SNP has csnp_condition_type.`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
