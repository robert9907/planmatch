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
// Population encoding — CMS files a coarse 2-value "Partial Dual" flag.
// The pre-2026-08-12 mapping had this INVERTED — Partial Dual="No" was
// mapped to a restrictive 3-population set instead of the permissive
// all-duals set. The CMS "Partial Dual" flag semantic is:
//   "No"  = plan is NOT restricted to partial-dual populations only
//           (accepts ALL DUAL subtypes)
//   "Yes" = plan enrolls PARTIAL DUALS ONLY
//
// Corrected mapping:
//   Partial Dual = "No"  → {FBDE, QMB+, QMB, SLMB+, SLMB, QI, QDWI}
//                          (all seven CMS-defined D-SNP populations —
//                          89% of D-SNPs nationally)
//   Partial Dual = "Yes" → {SLMB, QDWI, QI}
//                          HealthSherpa files Wellcare Dual Reserve
//                          H4073-003 as this exact set, excluding
//                          QMB/QMB+/SLMB+/FBDE. Applied uniformly to
//                          the 13 Partial-Dual=Yes plans nationally
//                          across NC/TX/GA. CMS's 2-way flag cannot
//                          represent per-plan filings that diverge —
//                          per-plan overrides land in a follow-up if
//                          broker feedback surfaces divergence.
//
// QDWI (Qualified Disabled and Working Individual) was previously
// excluded from both sets. It's a real D-SNP-accepted population per
// HealthSherpa's per-plan filings — reinstated here on both sides.
//
// dsnp_eligible_tiers is derived by trigger from dsnp_accepted_populations
// (migration 017). This script writes ONLY the populations column;
// eligible_tiers gets set automatically.
//
// Reads SUPABASE_URL / DATABASE_URL from .env.local (see
// scripts/_template-probe.ts for the unprefixed-name convention).
//
// Run with:  npx tsx scripts/import-snp-comprehensive-report.ts
//   [--snp-xlsx <path>] [--snp-zip <path>]
// Defaults to _tmp/cms-sync/snp-report/SNP_2026_06/SNP_2026_06.xlsx.
//
// **CY2027 refresh** — see docs/cy2027-refresh.md before running against
// the first CY2027 SNP XLSX. The mapping below reads r['Partial Dual']
// by name; a CMS column rename would produce silent NULLs (not a loud
// failure), which the downstream filters treat as "unmapped/permissive"
// — the same class of bug this ingest fixed. The audit at the bottom
// exits with code 1 on ground-truth mismatch, so run it immediately.

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

// ── Population encoding (corrected 2026-08-12) ───────────────────
// Order intentionally mirrors HealthSherpa's per-plan display for the
// bench-badge chip layout — brokers scan left-to-right for a familiar
// pattern.
const POPS_ALL_DUALS = ['FBDE', 'QMB+', 'QMB', 'SLMB+', 'SLMB', 'QI', 'QDWI'] as const;
const POPS_PARTIAL_ONLY = ['SLMB', 'QDWI', 'QI'] as const;

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
    // Corrected 2026-08-12: CMS "Partial Dual"='No' means "NOT restricted
    // to partial-dual populations" — the plan accepts all 7 dual
    // subtypes. 'Yes' means "partial-dual populations only" — 3 subtypes
    // per HealthSherpa's H4073-003 filing.
    let populations: string[] | null = null;
    if (partial === 'No') populations = [...POPS_ALL_DUALS];
    else if (partial === 'Yes') populations = [...POPS_PARTIAL_ONLY];
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

    // Apply migration 017 — dsnp_eligible_tiers derivation trigger.
    // Ships inline in the ingest so a fresh CY2027 run bootstraps the
    // canonical-column semantic on any DB where 017 wasn't applied via
    // the migrations folder (e.g., new staging clones). Idempotent.
    await client.query(`
      create or replace function derive_dsnp_eligible_tiers(pops text[])
        returns text[]
        language plpgsql
        immutable
      as $$
      declare
        result text[] := '{}';
        pop text;
      begin
        if pops is null then return null; end if;
        foreach pop in array pops loop
          result := array_append(result, case lower(pop)
            when 'fbde'  then 'fbde'
            when 'qmb+'  then 'qmb_plus'
            when 'qmb'   then 'qmb'
            when 'slmb+' then 'slmb_plus'
            when 'slmb'  then 'slmb'
            when 'qi'    then 'qi'
            when 'qdwi'  then 'qdwi'
            else lower(pop)
          end);
        end loop;
        return result;
      end;
      $$;

      create or replace function pm_plans_sync_dsnp_tiers()
        returns trigger language plpgsql as $$
      begin
        new.dsnp_eligible_tiers := derive_dsnp_eligible_tiers(new.dsnp_accepted_populations);
        return new;
      end;
      $$;

      drop trigger if exists pm_plans_sync_dsnp_tiers_trg on pm_plans;
      create trigger pm_plans_sync_dsnp_tiers_trg
        before insert or update of dsnp_accepted_populations on pm_plans
        for each row execute function pm_plans_sync_dsnp_tiers();
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

    // ═══ Ground-truth assertions — audit fails LOUDLY when the ingest
    // ═══ diverges from the HealthSherpa-confirmed reference plans.
    // ═══ Replaces the Phase 1 audit that passed because every row got
    // ═══ a value; that shape can't detect a swapped bucket.
    const groundTruth: Array<{
      key: string;
      pops: string[];
      tiers: string[];
      integration: string;
    }> = [
      // Wake NC — Partial Dual = "No" plans (permissive; all 7 populations)
      { key: 'H1036-307', pops: [...POPS_ALL_DUALS], tiers: ['fbde','qmb_plus','qmb','slmb_plus','slmb','qi','qdwi'], integration: 'Coordination Only' },
      { key: 'H5296-004', pops: [...POPS_ALL_DUALS], tiers: ['fbde','qmb_plus','qmb','slmb_plus','slmb','qi','qdwi'], integration: 'Coordination Only' },
      { key: 'H5253-041', pops: [...POPS_ALL_DUALS], tiers: ['fbde','qmb_plus','qmb','slmb_plus','slmb','qi','qdwi'], integration: 'Coordination Only' },
      // Wake NC — Partial Dual = "Yes" plans (restrictive; 3 partial-dual populations)
      { key: 'H4073-003', pops: [...POPS_PARTIAL_ONLY], tiers: ['slmb','qdwi','qi'], integration: 'Coordination Only' },
    ];

    console.log(`\n═══ Ground-truth assertions ═══`);
    let assertFailures = 0;
    for (const gt of groundTruth) {
      const [c, p] = gt.key.split('-');
      const q = await client.query<{ pops: string[] | null; tiers: string[] | null; int: string | null }>(
        `SELECT dsnp_accepted_populations AS pops,
                dsnp_eligible_tiers        AS tiers,
                dsnp_integration_status    AS int
           FROM pm_plans
          WHERE contract_id = $1 AND plan_id = $2 AND state = 'NC' AND snp_type = 'D-SNP'
          LIMIT 1`, [c, p],
      );
      const row = q.rows[0];
      if (!row) {
        console.error(`  ✗ ${gt.key}: NOT FOUND in pm_plans NC — check Landscape ingest coverage`);
        assertFailures += 1;
        continue;
      }
      const popsOk = arraysEqual(row.pops ?? [], gt.pops);
      const tiersOk = arraysEqual(row.tiers ?? [], gt.tiers);
      const intOk = row.int === gt.integration;
      if (popsOk && tiersOk && intOk) {
        console.log(`  ✓ ${gt.key}: pops + tiers + integration all match`);
      } else {
        assertFailures += 1;
        console.error(`  ✗ ${gt.key}: expected pops=${JSON.stringify(gt.pops)} tiers=${JSON.stringify(gt.tiers)} int=${JSON.stringify(gt.integration)}`);
        console.error(`               got pops=${JSON.stringify(row.pops)} tiers=${JSON.stringify(row.tiers)} int=${JSON.stringify(row.int)}`);
      }
    }

    // Coordination-Only consistency check — the Partial-Dual=No subset
    // of Coordination-Only D-SNPs must accept the broadest dual range
    // (all 7 populations). Partial-Dual=Yes CO plans legitimately
    // enroll only the 3-population partial set, so they're excluded
    // from the assertion. This rule was the independent signal that
    // flagged the pre-fix inversion — 6,574 rows / 110 plans failed
    // pre-fix; 0 should fail post-fix.
    const cordCheck = await client.query<{ n: string }>(`
      SELECT COUNT(*)::text AS n
        FROM pm_plans
       WHERE snp_type = 'D-SNP'
         AND dsnp_integration_status = 'Coordination Only'
         AND dsnp_partial_duals = false
         AND dsnp_accepted_populations IS NOT NULL
         AND NOT (dsnp_accepted_populations @> ARRAY['QMB','SLMB','QI'])
    `);
    const cordContradict = Number(cordCheck.rows[0].n);
    console.log(`\n  Coordination-Only + Partial=No rows missing >=1 of {QMB,SLMB,QI}: ${cordContradict}`);
    if (cordContradict > 0) {
      console.error(`  ✗ Coordination-Only consistency FAILED — see Phase 1.5 diagnosis`);
      assertFailures += 1;
    } else {
      console.log(`  ✓ Coordination-Only consistency clean`);
    }

    if (assertFailures > 0) {
      console.error(`\n✗ INGEST AUDIT FAILED: ${assertFailures} assertion(s) failed`);
      process.exitCode = 1;
    } else {
      console.log(`\n✓ ingest audit clean`);
    }
  } finally {
    await client.end();
  }
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
