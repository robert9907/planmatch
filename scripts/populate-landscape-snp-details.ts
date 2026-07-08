// scripts/populate-landscape-snp-details.ts
//
// Backfills the three SNP-detail columns added by migration
// 014_pm_plans_snp_details.sql from the CY2026 Landscape CSV:
//
//   dsnp_integration_status ← col 23 "Dual Eligible SNP (D-SNP)
//                              Integration Status"                  (D-SNP)
//   csnp_condition_type     ← col 25 "Chronic or Disabling Condition
//                              SNP (C-SNP) Condition Type"          (C-SNP)
//   zero_cost_sharing       ← col 26 "Medicare Zero-Dollar Cost
//                              Sharing D-SNP Plan"                  (D-SNP)
//
// Landscape is per (contract, plan, segment, county) so we collapse to
// distinct (contract_id, plan_id) triples first. pm_plans rows are per
// (contract, plan, segment, state, county); we UPDATE all rows sharing
// the (contract_id, plan_id) key. Landscape files the same SNP
// integration/condition value across every county of a plan, so this
// collapse is safe — verified via unique-value check inside main().
//
// Guards:
//   • Only rows with snp_type='D-SNP' get dsnp_integration_status +
//     zero_cost_sharing writes.
//   • Only rows with snp_type='C-SNP' get csnp_condition_type writes.
//   • Landscape values like "Not Applicable" / "N/A" / "" are treated
//     as NULL — CMS uses these on non-SNP rows.
//
// Applies the DDL first so this script is safe to run on a fresh DB
// (migration 014 is idempotent).
//
// Run with:  npx tsx scripts/populate-landscape-snp-details.ts
// Reads DATABASE_URL from .env.local.

import { createReadStream, existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import pg from 'pg';

// ─── .env.local loader (unprefixed names; VITE_* would crash) ─────
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

const LANDSCAPE_CSV = resolve(
  '_tmp/cms-sync/landscape/CY2026_Landscape_202603/CY2026_Landscape_202603.csv',
);

// ─── RFC-4180 CSV parser (Landscape has quoted "$2,100.00 " cells) ─
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else if (ch === '"') {
      inQuotes = true;
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

interface LandscapeSnp {
  contract_id: string;
  plan_id: string;
  snp_type_raw: 'D-SNP' | 'C-SNP' | 'I-SNP';
  dsnp_integration_status: string | null;
  csnp_condition_type: string | null;
  zero_cost_sharing: boolean;
}

// Landscape ships "Not Applicable" / "N/A" / "" on non-SNP rows. Also
// occasionally trailing whitespace on the value.
function cleanLandscapeText(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === 'not applicable' || lower === 'n/a' || lower === 'na') return null;
  return s;
}

// CMS Landscape files "Yes" / "No" on the zero-dollar column.
function parseYesNo(raw: string | undefined): boolean {
  if (!raw) return false;
  return raw.trim().toLowerCase() === 'yes';
}

// Normalize SNP type. Landscape's raw values differ from what pm_plans
// stores in snp_type — Landscape files the long form ("Dual-Eligible",
// "Chronic or Disabling Condition", "Institutional") while pm_plans
// stores the shortcodes ("D-SNP" / "C-SNP" / "I-SNP") that
// cms-sync-2026's normalizeSnpType translates them to. Mirror that
// mapping here so the UPDATE key matches.
function normalizeSnpType(raw: string | undefined): 'D-SNP' | 'C-SNP' | 'I-SNP' | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === 'not applicable' || lower === 'non-snp' || lower === 'n/a') return null;
  if (lower === 'dual-eligible' || lower === 'd-snp') return 'D-SNP';
  if (lower === 'chronic or disabling condition' || lower === 'c-snp') return 'C-SNP';
  if (lower === 'institutional' || lower === 'i-snp') return 'I-SNP';
  return null;
}

// Landscape's D-SNP integration status uses "CO" for coordination-only
// plans and "FIDE" / "HIDE" for the integrated variants. Expand "CO"
// to "Coordination Only" so the bench-filter dropdown shows a readable
// label without a display-side map. FIDE / HIDE / AIP are left as-is.
function normalizeDsnpIntegration(raw: string | null): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  if (upper === 'CO') return 'Coordination Only';
  return trimmed;
}

async function loadLandscapeSnp(): Promise<Map<string, LandscapeSnp>> {
  if (!existsSync(LANDSCAPE_CSV)) {
    console.error(`Landscape CSV not found at ${LANDSCAPE_CSV}`);
    process.exit(1);
  }
  console.log(`→ reading ${LANDSCAPE_CSV}`);

  const rl = createInterface({
    input: createReadStream(LANDSCAPE_CSV),
    crlfDelay: Infinity,
  });

  let header: string[] = [];
  let idxContract = -1;
  let idxPlan = -1;
  let idxSnpType = -1;
  let idxDsnpIntegration = -1;
  let idxCsnpCondition = -1;
  let idxZeroCost = -1;

  const byKey = new Map<string, LandscapeSnp>();
  // Guard: assert one landscape value per (contract, plan). If a
  // (contract, plan) files different values across counties we want to
  // hear about it — indicates the collapse assumption is wrong.
  const conflicts: Array<{ key: string; first: LandscapeSnp; other: LandscapeSnp; county: string }> = [];

  let n = 0;
  let countyCol = -1;
  for await (const rawLine of rl) {
    n += 1;
    if (n === 1) {
      header = parseCsvLine(rawLine).map((h) => h.replace(/^﻿/, '').trim());
      idxContract = header.indexOf('Contract ID');
      idxPlan = header.indexOf('Plan ID');
      idxSnpType = header.indexOf('SNP Type');
      idxDsnpIntegration = header.indexOf('Dual Eligible SNP (D-SNP) Integration Status');
      idxCsnpCondition = header.indexOf('Chronic or Disabling Condition SNP (C-SNP) Condition Type');
      idxZeroCost = header.indexOf('Medicare Zero-Dollar Cost Sharing D-SNP Plan');
      countyCol = header.indexOf('County Name');
      const missing: string[] = [];
      if (idxContract < 0) missing.push('Contract ID');
      if (idxPlan < 0) missing.push('Plan ID');
      if (idxSnpType < 0) missing.push('SNP Type');
      if (idxDsnpIntegration < 0) missing.push('Dual Eligible SNP (D-SNP) Integration Status');
      if (idxCsnpCondition < 0) missing.push('Chronic or Disabling Condition SNP (C-SNP) Condition Type');
      if (idxZeroCost < 0) missing.push('Medicare Zero-Dollar Cost Sharing D-SNP Plan');
      if (missing.length > 0) {
        console.error(`Landscape header missing columns: ${missing.join(', ')}`);
        process.exit(1);
      }
      continue;
    }
    if (!rawLine) continue;
    const cells = parseCsvLine(rawLine);
    const contract = (cells[idxContract] ?? '').trim();
    const plan = (cells[idxPlan] ?? '').trim();
    if (!contract || !plan) continue;
    const snpType = normalizeSnpType(cells[idxSnpType]);
    if (!snpType) continue; // non-SNP row — nothing to backfill

    const row: LandscapeSnp = {
      contract_id: contract,
      plan_id: plan,
      snp_type_raw: snpType,
      dsnp_integration_status:
        snpType === 'D-SNP'
          ? normalizeDsnpIntegration(cleanLandscapeText(cells[idxDsnpIntegration]))
          : null,
      csnp_condition_type:
        snpType === 'C-SNP' ? cleanLandscapeText(cells[idxCsnpCondition]) : null,
      zero_cost_sharing:
        snpType === 'D-SNP' ? parseYesNo(cells[idxZeroCost]) : false,
    };

    const key = `${contract}-${plan}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    // Conflict check — same (contract, plan) with different values
    // across counties. Landscape shouldn't do this, but flag if it does.
    const conflict =
      existing.dsnp_integration_status !== row.dsnp_integration_status ||
      existing.csnp_condition_type !== row.csnp_condition_type ||
      existing.zero_cost_sharing !== row.zero_cost_sharing;
    if (conflict) {
      conflicts.push({
        key,
        first: existing,
        other: row,
        county: (cells[countyCol] ?? '').trim(),
      });
    }
  }

  console.log(`  landscape rows scanned=${(n - 1).toLocaleString()}  SNP (contract,plan) keys=${byKey.size}`);
  if (conflicts.length > 0) {
    console.warn(`  ! ${conflicts.length} (contract,plan) key(s) had conflicting SNP details across counties:`);
    for (const c of conflicts.slice(0, 10)) {
      console.warn(
        `    ${c.key} @ ${c.county}: dsnp=${JSON.stringify(c.first.dsnp_integration_status)}/` +
          `${JSON.stringify(c.other.dsnp_integration_status)} ` +
          `csnp=${JSON.stringify(c.first.csnp_condition_type)}/${JSON.stringify(c.other.csnp_condition_type)} ` +
          `zero=${c.first.zero_cost_sharing}/${c.other.zero_cost_sharing}`,
      );
    }
  }
  return byKey;
}

// ─── SQL exec ─────────────────────────────────────────────────────
async function main() {
  const landscape = await loadLandscapeSnp();

  const client = new pg.Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    // 1. Apply migration 014 up-front (idempotent — CREATE INDEX IF
    //    NOT EXISTS + ADD COLUMN IF NOT EXISTS). Lets this script run
    //    end-to-end against a fresh DB.
    console.log(`\n→ ensuring migration 014 columns exist`);
    await client.query(`
      ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS dsnp_integration_status text;
      ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS zero_cost_sharing boolean NOT NULL DEFAULT false;
      ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS csnp_condition_type text;
      CREATE INDEX IF NOT EXISTS pm_plans_dsnp_integration_idx
        ON pm_plans (dsnp_integration_status)
        WHERE dsnp_integration_status IS NOT NULL;
      CREATE INDEX IF NOT EXISTS pm_plans_csnp_condition_idx
        ON pm_plans (csnp_condition_type)
        WHERE csnp_condition_type IS NOT NULL;
    `);

    // 2. Pre-count pm_plans D-SNP / C-SNP totals so the report can show
    //    coverage rate ("updated 240/247 D-SNP plans").
    const preTotals = await client.query<{ snp_type: string | null; n: string }>(`
      SELECT snp_type, COUNT(*)::text AS n
        FROM pm_plans
       WHERE snp_type IN ('D-SNP','C-SNP','I-SNP')
       GROUP BY snp_type
       ORDER BY snp_type
    `);
    const totals = new Map(preTotals.rows.map((r) => [r.snp_type ?? '', Number(r.n)]));
    console.log(`\n→ pm_plans SNP row counts (all states):`);
    for (const [k, v] of totals) console.log(`   ${k}: ${v}`);

    // 3. UPDATE loop. Batch by SNP type + contract, one query per
    //    (contract, plan) key. Total keys are only ~few hundred — a
    //    per-key UPDATE is simpler than a temp-table bulk load and
    //    still finishes in under a minute.
    let dsnpUpdated = 0;
    let dsnpUnmatched = 0;
    let csnpUpdated = 0;
    let csnpUnmatched = 0;

    console.log(`\n→ updating pm_plans`);
    for (const row of landscape.values()) {
      if (row.snp_type_raw === 'D-SNP') {
        const r = await client.query(
          `UPDATE pm_plans
              SET dsnp_integration_status = $3,
                  zero_cost_sharing       = $4
            WHERE contract_id = $1
              AND plan_id     = $2
              AND snp_type    = 'D-SNP'`,
          [row.contract_id, row.plan_id, row.dsnp_integration_status, row.zero_cost_sharing],
        );
        if ((r.rowCount ?? 0) > 0) dsnpUpdated += r.rowCount ?? 0;
        else dsnpUnmatched += 1;
      } else if (row.snp_type_raw === 'C-SNP') {
        const r = await client.query(
          `UPDATE pm_plans
              SET csnp_condition_type = $3
            WHERE contract_id = $1
              AND plan_id     = $2
              AND snp_type    = 'C-SNP'`,
          [row.contract_id, row.plan_id, row.csnp_condition_type],
        );
        if ((r.rowCount ?? 0) > 0) csnpUpdated += r.rowCount ?? 0;
        else csnpUnmatched += 1;
      }
      // I-SNPs: nothing to backfill; the memory tracks them via snp_type only.
    }

    // 4. Post-audit: count non-null coverage vs total to catch any
    //    D-SNP/C-SNP rows Landscape didn't touch.
    const post = await client.query<{
      snp_type: string;
      total: string;
      dsnp_ok: string;
      csnp_ok: string;
      zero_true: string;
    }>(`
      SELECT
        snp_type,
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE snp_type='D-SNP' AND dsnp_integration_status IS NOT NULL)::text AS dsnp_ok,
        COUNT(*) FILTER (WHERE snp_type='C-SNP' AND csnp_condition_type   IS NOT NULL)::text AS csnp_ok,
        COUNT(*) FILTER (WHERE snp_type='D-SNP' AND zero_cost_sharing = true)::text AS zero_true
      FROM pm_plans
      WHERE snp_type IN ('D-SNP','C-SNP','I-SNP')
      GROUP BY snp_type
      ORDER BY snp_type
    `);

    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`  populate-landscape-snp-details — done`);
    console.log(`═══════════════════════════════════════════════════════`);
    console.log(`  D-SNP: ${dsnpUpdated} pm_plans row(s) updated; ${dsnpUnmatched} landscape key(s) with no matching D-SNP row`);
    console.log(`  C-SNP: ${csnpUpdated} pm_plans row(s) updated; ${csnpUnmatched} landscape key(s) with no matching C-SNP row`);
    console.log(``);
    console.log(`  Post-audit (per snp_type in pm_plans):`);
    for (const r of post.rows) {
      const total = Number(r.total);
      if (r.snp_type === 'D-SNP') {
        const ok = Number(r.dsnp_ok);
        const zero = Number(r.zero_true);
        console.log(
          `    D-SNP: ${ok}/${total} rows have dsnp_integration_status (${((ok / total) * 100).toFixed(1)}%); ${zero} rows flagged zero_cost_sharing`,
        );
      } else if (r.snp_type === 'C-SNP') {
        const ok = Number(r.csnp_ok);
        console.log(
          `    C-SNP: ${ok}/${total} rows have csnp_condition_type (${((ok / total) * 100).toFixed(1)}%)`,
        );
      } else {
        console.log(`    ${r.snp_type}: ${total} rows (no backfill needed)`);
      }
    }

    // Enumerate distinct values for the two text columns so the UI can
    // sanity-check the dropdown option set.
    const dsnpValues = await client.query<{ v: string; n: string }>(`
      SELECT dsnp_integration_status AS v, COUNT(DISTINCT (contract_id, plan_id))::text AS n
        FROM pm_plans
       WHERE snp_type='D-SNP' AND dsnp_integration_status IS NOT NULL
       GROUP BY dsnp_integration_status
       ORDER BY 2 DESC
    `);
    console.log(`\n  D-SNP integration status distribution (distinct plans):`);
    for (const r of dsnpValues.rows) console.log(`    ${r.v}: ${r.n}`);

    const csnpValues = await client.query<{ v: string; n: string }>(`
      SELECT csnp_condition_type AS v, COUNT(DISTINCT (contract_id, plan_id))::text AS n
        FROM pm_plans
       WHERE snp_type='C-SNP' AND csnp_condition_type IS NOT NULL
       GROUP BY csnp_condition_type
       ORDER BY 2 DESC
    `);
    console.log(`\n  C-SNP condition type distribution (distinct plans):`);
    for (const r of csnpValues.rows) console.log(`    ${r.v}: ${r.n}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
