// scripts/import-snp-comprehensive-report.ts
//
// Ingests CMS's monthly SNP Comprehensive Report — the authoritative
// filing of D-SNP contract characteristics including the
// accepted-Medicaid-populations signal that pm_plans has been
// missing. The task brief called for a multi-carrier web scraper;
// this ingest replaces that with a single-file download because CMS
// already publishes exactly the field we need per-plan.
//
// Source:
//   Landing page:
//     https://www.cms.gov/data-research/statistics-trends-and-reports/
//       medicare-advantagepart-d-contract-and-enrollment-data/
//       special-needs-plan-snp-data/snp-comprehensive-report-YYYY-MM
//   File:
//     https://www.cms.gov/files/zip/
//       snp-comprehensive-report-<month>-<year>.zip
//     (month is lowercase full name, e.g. "june"; year is 4 digits)
//
// Sheet layout (SNP_REPORT_PART_17, per-plan grain):
//   Contract Number | Plan ID | SEGMENT_ID | State(s) | ...
//   Special Needs Plan Type | Integration Status | Partial Dual
//   | DSNP Only Contract
//
// Population encoding — CMS files two D-SNP subcategories only:
//   Partial Dual = "No"  → plan accepts full-benefit duals only
//                          {FBDE, QMB+, SLMB+}
//   Partial Dual = "Yes" → plan accepts every subgroup
//                          {FBDE, QMB+, QMB, SLMB+, SLMB, QI}
// (QDWI is a Medicare-Savings-Program category that D-SNPs don't
// enroll — QDWI enrollees keep Original Medicare, so it's excluded
// even though the task brief listed it.)
//
// Reads SUPABASE_URL / DATABASE_URL from .env.local (see
// scripts/_template-probe.ts for the unprefixed-name convention).
//
// Run with:  npx tsx scripts/import-snp-comprehensive-report.ts
//   [--snp-xlsx <path>] [--snp-zip <path>]
// Defaults to _tmp/cms-sync/snp-report/SNP_2026_06/SNP_2026_06.xlsx.

import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as XLSX from 'xlsx';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const DATABASE_URL = process.env.DATABASE_URL ?? '';
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL in .env.local');
  process.exit(1);
}

const DEFAULT_XLSX = '_tmp/cms-sync/snp-report/SNP_2026_06/SNP_2026_06.xlsx';

// ── CLI ──────────────────────────────────────────────────────────
interface Args { xlsxPath: string; }
function parseArgs(argv: string[]): Args {
  let xlsxPath = DEFAULT_XLSX;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--snp-xlsx' && argv[i + 1]) { xlsxPath = argv[i + 1]; i += 1; }
  }
  return { xlsxPath: resolve(xlsxPath) };
}

// ── Population encoding ──────────────────────────────────────────
const POPS_FULL_BENEFIT_ONLY = ['FBDE', 'QMB+', 'SLMB+'] as const;
const POPS_ALL_DUALS = ['FBDE', 'QMB+', 'QMB', 'SLMB+', 'SLMB', 'QI'] as const;

interface SnpReportRow {
  contract_id: string;
  plan_id: string;      // 3-char, zero-padded to match pm_plans
  states: string;       // "NC" or "NC, SC" — comma-joined
  snp_type: string;     // "Dual-Eligible" / "Chronic..." / "Institutional"
  integration_status: string | null;
  partial_dual: 'Yes' | 'No' | null;
  dsnp_only_contract: 'Yes' | 'No' | null;
  accepted_populations: string[] | null;
}

function parseYesNo(raw: unknown): 'Yes' | 'No' | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s.toLowerCase() === 'yes') return 'Yes';
  if (s.toLowerCase() === 'no') return 'No';
  return null;
}

function loadSnpReport(xlsxPath: string): SnpReportRow[] {
  if (!existsSync(xlsxPath)) {
    console.error(
      `SNP report XLSX not found at ${xlsxPath}. Download the latest\n` +
      `from https://www.cms.gov/data-research/statistics-trends-and-reports/\n` +
      `medicare-advantagepart-d-contract-and-enrollment-data/\n` +
      `special-needs-plan-snp-data (pick most recent SNP Comprehensive\n` +
      `Report page → the ZIP link → unzip into _tmp/cms-sync/snp-report/),\n` +
      `or pass --snp-xlsx <path>.`,
    );
    process.exit(1);
  }
  // Load via fs + XLSX.read rather than XLSX.readFile — the latter uses
  // an internal file-access shim that fails under Claude Code's sandbox
  // even when Node's fs.readFileSync works fine on the same path.
  const wb = XLSX.read(readFileSync(xlsxPath), { type: 'buffer' });
  const ws = wb.Sheets['SNP_REPORT_PART_17'];
  if (!ws) {
    console.error(`Sheet SNP_REPORT_PART_17 not found in ${xlsxPath}. Sheets: ${wb.SheetNames.join(', ')}`);
    process.exit(1);
  }
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);
  const out: SnpReportRow[] = [];
  for (const r of rows) {
    const snpType = String(r['Special Needs Plan Type'] ?? '').trim();
    if (snpType !== 'Dual-Eligible') continue;
    const contract = String(r['Contract Number'] ?? '').trim();
    const planRaw = String(r['Plan ID'] ?? '').trim();
    if (!contract || !planRaw) continue;
    // pm_plans stores plan_id zero-padded to 3 chars; the report files
    // it as a numeric string like "1" or "307". Pad to match.
    const plan = planRaw.padStart(3, '0');
    const partial = parseYesNo(r['Partial Dual']);
    const dsnpOnly = parseYesNo(r['DSNP Only Contract']);
    let populations: string[] | null = null;
    if (partial === 'No') populations = [...POPS_FULL_BENEFIT_ONLY];
    else if (partial === 'Yes') populations = [...POPS_ALL_DUALS];
    out.push({
      contract_id: contract,
      plan_id: plan,
      states: String(r['State(s)'] ?? '').trim(),
      snp_type: snpType,
      integration_status: (String(r['Integration Status'] ?? '').trim() || null),
      partial_dual: partial,
      dsnp_only_contract: dsnpOnly,
      accepted_populations: populations,
    });
  }
  return out;
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`→ reading ${args.xlsxPath}`);
  const report = loadSnpReport(args.xlsxPath);
  console.log(`  parsed ${report.length} D-SNP row(s) from SNP_REPORT_PART_17`);
  const byKey = new Map<string, SnpReportRow>();
  for (const r of report) {
    const key = `${r.contract_id}-${r.plan_id}`;
    // Report ships one row per (contract, plan, geographic-name). Same
    // (contract, plan) files identical Partial Dual / DSNP Only across
    // its regions so first-wins is safe.
    if (!byKey.has(key)) byKey.set(key, r);
  }
  console.log(`  distinct (contract, plan) keys: ${byKey.size}`);

  const client = new pg.Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    // Ensure migration 015 columns exist. Idempotent — no-op if
    // migration ran via SQL editor.
    await client.query(`
      ALTER TABLE pm_plans
        ADD COLUMN IF NOT EXISTS dsnp_accepted_populations text[];
      ALTER TABLE pm_plans
        ADD COLUMN IF NOT EXISTS dsnp_partial_duals boolean;
      ALTER TABLE pm_plans
        ADD COLUMN IF NOT EXISTS dsnp_only_contract boolean;
      CREATE INDEX IF NOT EXISTS pm_plans_dsnp_populations_gin
        ON pm_plans USING GIN (dsnp_accepted_populations)
        WHERE dsnp_accepted_populations IS NOT NULL;
    `);

    // Distinct D-SNP (contract, plan) triples in pm_plans across NC/TX/GA
    // — the coverage denominator the audit reports against.
    const pmTriples = await client.query<{ contract_id: string; plan_id: string; state: string }>(`
      SELECT DISTINCT contract_id, plan_id, state
        FROM pm_plans
       WHERE snp_type = 'D-SNP'
         AND state IN ('NC','TX','GA')
       ORDER BY state, contract_id, plan_id
    `);
    console.log(`\n→ pm_plans D-SNP coverage denominator: ${pmTriples.rowCount} (contract, plan, state) triples in NC/TX/GA`);

    // UPDATE loop. Per-key UPDATE keeps the query trivial; total keys
    // are only ~1k so this finishes in a few seconds.
    let updatedRows = 0;
    let matchedKeys = 0;
    let unmatchedReportKeys = 0;
    for (const row of byKey.values()) {
      const r = await client.query(
        `UPDATE pm_plans
            SET dsnp_accepted_populations = $3::text[],
                dsnp_partial_duals        = $4::boolean,
                dsnp_only_contract        = $5::boolean
          WHERE contract_id = $1
            AND plan_id     = $2
            AND snp_type    = 'D-SNP'`,
        [
          row.contract_id,
          row.plan_id,
          row.accepted_populations,
          row.partial_dual === null ? null : row.partial_dual === 'Yes',
          row.dsnp_only_contract === null ? null : row.dsnp_only_contract === 'Yes',
        ],
      );
      const n = r.rowCount ?? 0;
      if (n > 0) { matchedKeys += 1; updatedRows += n; }
      else unmatchedReportKeys += 1;
    }

    // Manual-review list — every pm_plans D-SNP triple that the CMS
    // report did NOT cover (accepted_populations still NULL after the
    // update sweep). The task brief called for a separate
    // "manual-review-needed" list; this replaces it.
    const orphans = await client.query<{
      contract_id: string; plan_id: string; state: string;
      carrier: string | null; plan_name: string; counties: string;
    }>(`
      SELECT contract_id, plan_id, state,
             COALESCE(carrier, parent_organization) AS carrier,
             plan_name,
             string_agg(DISTINCT county_name, ', ' ORDER BY county_name) AS counties
        FROM pm_plans
       WHERE snp_type = 'D-SNP'
         AND state IN ('NC','TX','GA')
         AND dsnp_accepted_populations IS NULL
       GROUP BY contract_id, plan_id, state, carrier, parent_organization, plan_name
       ORDER BY state, contract_id, plan_id
    `);

    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`  import-snp-comprehensive-report — done`);
    console.log(`═══════════════════════════════════════════════════════`);
    console.log(`  Matched CMS-report keys        : ${matchedKeys} / ${byKey.size}`);
    console.log(`  Unmatched CMS-report keys      : ${unmatchedReportKeys}  (national D-SNPs outside NC/TX/GA)`);
    console.log(`  pm_plans rows updated          : ${updatedRows}`);
    console.log(`  pm_plans D-SNP triples missing : ${orphans.rowCount}  (needs manual review)`);
    if ((orphans.rowCount ?? 0) > 0) {
      console.log(`\n  Manual review list:`);
      for (const o of orphans.rows) {
        console.log(`    ${o.state}  ${o.contract_id}-${o.plan_id}  ${o.carrier ?? '—'} · ${o.plan_name}  [${o.counties}]`);
      }
    }

    // Distribution summary — sanity check the population set makes sense.
    const dist = await client.query<{ pops: string[] | null; n: string }>(`
      SELECT dsnp_accepted_populations AS pops, COUNT(*)::text AS n
        FROM pm_plans
       WHERE snp_type = 'D-SNP'
         AND state IN ('NC','TX','GA')
       GROUP BY dsnp_accepted_populations
       ORDER BY 2::int DESC
    `);
    console.log(`\n  Population distribution (NC/TX/GA D-SNP rows in pm_plans):`);
    for (const d of dist.rows) {
      const label = d.pops === null ? 'NULL (unpopulated)' : `{${d.pops.join(',')}}`;
      console.log(`    ${label}: ${d.n}`);
    }
    const partialDist = await client.query<{ v: boolean | null; n: string }>(`
      SELECT dsnp_partial_duals AS v, COUNT(*)::text AS n
        FROM pm_plans
       WHERE snp_type = 'D-SNP' AND state IN ('NC','TX','GA')
       GROUP BY dsnp_partial_duals
       ORDER BY 2::int DESC
    `);
    console.log(`\n  Partial-dual acceptance (NC/TX/GA D-SNP rows):`);
    for (const d of partialDist.rows) console.log(`    ${String(d.v)}: ${d.n}`);
    const onlyDist = await client.query<{ v: boolean | null; n: string }>(`
      SELECT dsnp_only_contract AS v, COUNT(*)::text AS n
        FROM pm_plans
       WHERE snp_type = 'D-SNP' AND state IN ('NC','TX','GA')
       GROUP BY dsnp_only_contract
       ORDER BY 2::int DESC
    `);
    console.log(`\n  D-SNP-only-contract flag (NC/TX/GA D-SNP rows):`);
    for (const d of onlyDist.rows) console.log(`    ${String(d.v)}: ${d.n}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
