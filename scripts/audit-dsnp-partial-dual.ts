// scripts/audit-dsnp-partial-dual.ts
//
// Diffs pm_plans.dsnp_accepted_populations against the "Partial Dual"
// flag CMS files in the monthly SNP Comprehensive Report. Read-only.
//
// RUN THIS IMMEDIATELY AFTER import-snp-comprehensive-report.ts.
// That is the whole point: the July inversion survived about a month
// because nothing compared the importer's output back against CMS. This
// exits non-zero, so it can sit in the ingest sequence rather than in
// someone's memory.
//
// STATE AS OF 2026-09-14 (CMS June 2026 report): clean.
//   CMS Partial Dual = No  → 153 plan segments (all seven populations)
//   CMS Partial Dual = Yes →  13 plan segments (SLMB, QDWI, QI only)
//   pm_plans partial-only  →  13 plans, the SAME 13, exactly.
//   Zero inversions, zero per-plan mismatches.
//
// EXIT CODES
//   0  every D-SNP plan's populations agree with CMS
//   1  at least one disagrees (message names a wholesale inversion when
//      that is the pattern, rather than printing 166 separate failures)
//   2  the report could not be read, or the join covered nothing — an
//      audit that compared nothing must not report success
//
// Run:
//   npx tsx scripts/audit-dsnp-partial-dual.ts
//     [--snp-xlsx <path>] [--states NC,TX,GA]
//
// Requires DATABASE_URL in .env.local pointing at plan-match-prod.

import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as XLSX from 'xlsx';
import { isDualSnpType, planKey } from './_lib/dsnp-integration.ts';
import {
  parsePartialDual,
  checkPlan,
  summarise,
  type PlanPopulationCheck,
} from './_lib/dsnp-populations.ts';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const DATABASE_URL = process.env.DATABASE_URL ?? '';
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL in .env.local');
  process.exit(2);
}

let xlsxPath = '_tmp/cms-sync/snp-report/SNP_2026_06/SNP_2026_06.xlsx';
let states = ['NC', 'TX', 'GA'];
for (let i = 0; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--snp-xlsx' && process.argv[i + 1]) { xlsxPath = process.argv[i + 1]; i += 1; }
  if (process.argv[i] === '--states' && process.argv[i + 1]) {
    states = process.argv[i + 1].split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    i += 1;
  }
}
xlsxPath = resolve(xlsxPath);

function loadPartialDualFlags(): Map<string, 'Yes' | 'No'> {
  if (!existsSync(xlsxPath)) {
    console.error(`SNP report not found at ${xlsxPath} — pass --snp-xlsx <path>.`);
    process.exit(2);
  }
  const wb = XLSX.read(readFileSync(xlsxPath), { type: 'buffer' });
  const ws = wb.Sheets['SNP_REPORT_PART_17'];
  if (!ws) {
    console.error(`Sheet SNP_REPORT_PART_17 not found. Sheets: ${wb.SheetNames.join(', ')}`);
    process.exit(2);
  }
  const out = new Map<string, 'Yes' | 'No'>();
  let blanks = 0;
  for (const r of XLSX.utils.sheet_to_json<Record<string, unknown>>(ws)) {
    if (!isDualSnpType(r['Special Needs Plan Type'])) continue;
    const rowStates = String(r['State(s)'] ?? '').split(',').map((s) => s.trim().toUpperCase());
    if (!rowStates.some((s) => states.includes(s))) continue;
    const flag = parsePartialDual(r['Partial Dual']);
    if (!flag) { blanks += 1; continue; }
    out.set(planKey(r['Contract Number'], r['Plan ID'], r['SEGMENT_ID']), flag);
  }
  if (blanks > 0) {
    console.log(`→ ${blanks} D-SNP row(s) carried no Partial Dual flag — skipped, not guessed.`);
  }
  return out;
}

async function main(): Promise<void> {
  console.log(`→ CMS report: ${xlsxPath}`);
  const flags = loadPartialDualFlags();
  const yes = [...flags.values()].filter((f) => f === 'Yes').length;
  console.log(`→ CMS D-SNP segments in ${states.join('/')}: ${flags.size} (Partial Dual Yes=${yes}, No=${flags.size - yes})`);

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  const { rows } = await client.query<{
    contract_id: string; plan_id: string; segment_id: string;
    state: string; pops: string[] | null;
  }>(
    `select distinct contract_id, plan_id, segment_id, state,
            dsnp_accepted_populations as pops
       from pm_plans
      where snp_type = 'D-SNP' and state = any($1)`,
    [states],
  );
  await client.end();

  const checks: PlanPopulationCheck[] = [];
  const noPops: string[] = [];
  let unmatched = 0;
  for (const r of rows) {
    const key = planKey(r.contract_id, r.plan_id, r.segment_id);
    const flag = flags.get(key);
    if (!flag) { unmatched += 1; continue; }
    if (!r.pops || r.pops.length === 0) { noPops.push(`${r.state} ${key}`); continue; }
    checks.push(checkPlan(key, flag, r.pops));
  }

  const s = summarise(checks);
  console.log(`→ pm_plans D-SNP plans: ${rows.length}, compared: ${s.total}, unmatched in report: ${unmatched}`);

  if (noPops.length) {
    console.log(`\n⚠ ${noPops.length} D-SNP plan(s) carry NO accepted_populations at all:`);
    for (const k of noPops.slice(0, 20)) console.log(`   ${k}`);
    console.log('   Not counted as pass or fail — the importer never wrote them.');
  }

  if (s.total === 0) {
    console.error(
      `\n✗ FAIL: compared 0 of ${rows.length} D-SNP plans. Nothing was verified.\n` +
      `  Check the report month and the key shape before trusting a clean result.`,
    );
    process.exit(2);
  }

  if (s.failed > 0) {
    if (s.wholesaleInversion) {
      console.error(
        `\n✗ FAIL — PARTIAL-DUAL INVERSION. All ${s.failed} mismatched plans hold exactly\n` +
        `  the set the OPPOSITE flag implies. This is the July 2026 bug returning:\n` +
        `  CMS "No" means NOT restricted to partial duals (all seven populations);\n` +
        `  "Yes" means partial duals ONLY (SLMB, QDWI, QI). Check the mapping in\n` +
        `  scripts/import-snp-comprehensive-report.ts before re-running the import.`,
      );
    } else {
      console.error(`\n✗ FAIL: ${s.failed} plan(s) disagree with CMS (${s.inverted} of them inverted):`);
    }
    for (const c of checks.filter((x) => !x.ok).slice(0, 25)) {
      console.error(`   ${c.key} CMS PartialDual=${c.flag} stored={${c.stored.join(',')}} expected={${c.expected.join(',')}}`);
    }
    process.exit(1);
  }

  console.log(`\n✓ PASS: all ${s.total} D-SNP plans match the CMS Partial Dual filing.`);
}

main().catch((err) => { console.error(err); process.exit(2); });
