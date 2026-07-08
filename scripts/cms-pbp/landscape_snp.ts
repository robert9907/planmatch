// scripts/cms-pbp/landscape_snp.ts
//
// Landscape-sourced SNP-detail loader + pm_plans updater. Extracted
// from scripts/populate-landscape-snp-details.ts so it can also run at
// the tail of the PBP promote() flow — that way every full CMS sync
// (PBP + Landscape) automatically re-populates pm_plans.dsnp_integration_status,
// pm_plans.zero_cost_sharing, and pm_plans.csnp_condition_type
// without a manual second script.
//
// Landscape file locations:
//   • Default:  _tmp/cms-sync/landscape/CY2026_Landscape_202603/
//                 CY2026_Landscape_202603.csv
//   • Override via env LANDSCAPE_CSV_PATH or the caller's argument.
//
// The three columns land on pm_plans (Landscape-sourced), NOT
// pbp_plan_facts_v2 (PBP-sourced). pbp_a_dsnp_zerodollar in PBP is the
// only overlap — it's mapped into pbp_plan_facts_v2 by promote.ts's
// main SQL. dsnp_integration_status (FIDE/HIDE/CO/AIP) and
// csnp_condition_type are Landscape-only in the CMS distribution.

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type pg from 'pg';

const DEFAULT_LANDSCAPE_CSV =
  '_tmp/cms-sync/landscape/CY2026_Landscape_202603/CY2026_Landscape_202603.csv';

// ─── CSV helpers ──────────────────────────────────────────────────
// RFC-4180 parser — Landscape ships quoted "$2,100.00 " cells and
// commas inside Organization Marketing Name values.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === ',') { out.push(cur); cur = ''; }
    else if (ch === '"') inQuotes = true;
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function cleanText(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === 'not applicable' || lower === 'n/a' || lower === 'na') return null;
  return s;
}

function parseYesNo(raw: string | undefined): boolean {
  if (!raw) return false;
  return raw.trim().toLowerCase() === 'yes';
}

// Landscape's SNP Type column uses long-form values while pm_plans
// stores the shortcodes (verified against normalizeSnpType() in
// scripts/cms-sync-2026.ts). Mirror that mapping so UPDATE keys match.
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

// "CO" → "Coordination Only". FIDE / HIDE / AIP stay as-is.
function normalizeDsnpIntegration(raw: string | null): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.toUpperCase() === 'CO') return 'Coordination Only';
  return trimmed;
}

export interface LandscapeSnpRow {
  contract_id: string;
  plan_id: string;
  snp_type: 'D-SNP' | 'C-SNP' | 'I-SNP';
  dsnp_integration_status: string | null;
  csnp_condition_type: string | null;
  zero_cost_sharing: boolean;
}

export async function loadLandscapeSnpDetails(
  landscapeCsvPath: string = process.env.LANDSCAPE_CSV_PATH || DEFAULT_LANDSCAPE_CSV,
): Promise<Map<string, LandscapeSnpRow>> {
  if (!existsSync(landscapeCsvPath)) {
    throw new Error(`Landscape CSV not found at ${landscapeCsvPath}`);
  }
  const rl = createInterface({
    input: createReadStream(landscapeCsvPath),
    crlfDelay: Infinity,
  });

  let header: string[] = [];
  let idxContract = -1;
  let idxPlan = -1;
  let idxSnpType = -1;
  let idxDsnpIntegration = -1;
  let idxCsnpCondition = -1;
  let idxZeroCost = -1;

  const byKey = new Map<string, LandscapeSnpRow>();
  let n = 0;
  for await (const raw of rl) {
    n += 1;
    if (n === 1) {
      header = parseCsvLine(raw).map((h) => h.replace(/^﻿/, '').trim());
      idxContract = header.indexOf('Contract ID');
      idxPlan = header.indexOf('Plan ID');
      idxSnpType = header.indexOf('SNP Type');
      idxDsnpIntegration = header.indexOf('Dual Eligible SNP (D-SNP) Integration Status');
      idxCsnpCondition = header.indexOf('Chronic or Disabling Condition SNP (C-SNP) Condition Type');
      idxZeroCost = header.indexOf('Medicare Zero-Dollar Cost Sharing D-SNP Plan');
      const missing: string[] = [];
      if (idxContract < 0) missing.push('Contract ID');
      if (idxPlan < 0) missing.push('Plan ID');
      if (idxSnpType < 0) missing.push('SNP Type');
      if (idxDsnpIntegration < 0) missing.push('Dual Eligible SNP (D-SNP) Integration Status');
      if (idxCsnpCondition < 0) missing.push('Chronic or Disabling Condition SNP (C-SNP) Condition Type');
      if (idxZeroCost < 0) missing.push('Medicare Zero-Dollar Cost Sharing D-SNP Plan');
      if (missing.length > 0) {
        throw new Error(`Landscape header missing columns: ${missing.join(', ')}`);
      }
      continue;
    }
    if (!raw) continue;
    const cells = parseCsvLine(raw);
    const contract = (cells[idxContract] ?? '').trim();
    const plan = (cells[idxPlan] ?? '').trim();
    if (!contract || !plan) continue;
    const snpType = normalizeSnpType(cells[idxSnpType]);
    if (!snpType) continue;
    const key = `${contract}-${plan}`;
    if (byKey.has(key)) continue; // Landscape files identical values across counties — first wins.
    byKey.set(key, {
      contract_id: contract,
      plan_id: plan,
      snp_type: snpType,
      dsnp_integration_status:
        snpType === 'D-SNP' ? normalizeDsnpIntegration(cleanText(cells[idxDsnpIntegration])) : null,
      csnp_condition_type:
        snpType === 'C-SNP' ? cleanText(cells[idxCsnpCondition]) : null,
      zero_cost_sharing:
        snpType === 'D-SNP' ? parseYesNo(cells[idxZeroCost]) : false,
    });
  }
  return byKey;
}

export interface RefreshResult {
  dsnpUpdated: number;
  dsnpUnmatched: number;
  csnpUpdated: number;
  csnpUnmatched: number;
  scanned: number;
}

// Runs migration 014's ALTER TABLE + backfill UPDATEs against pm_plans.
// Idempotent; safe to call from promote() after every PBP sync so the
// three Landscape-sourced columns stay in lockstep with pm_plans's
// canonical (contract, plan) key set.
export async function refreshLandscapeSnpDetails(
  client: pg.PoolClient | pg.Client,
  landscapeCsvPath?: string,
): Promise<RefreshResult> {
  const landscape = await loadLandscapeSnpDetails(landscapeCsvPath);

  // Idempotent ALTER TABLE — no-op if migration 014 already ran, but
  // guards against a fresh DB that skipped the migration.
  await client.query(`
    ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS dsnp_integration_status text;
    ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS zero_cost_sharing boolean NOT NULL DEFAULT false;
    ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS csnp_condition_type text;
  `);

  let dsnpUpdated = 0;
  let dsnpUnmatched = 0;
  let csnpUpdated = 0;
  let csnpUnmatched = 0;

  for (const row of landscape.values()) {
    if (row.snp_type === 'D-SNP') {
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
    } else if (row.snp_type === 'C-SNP') {
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
  }

  return {
    dsnpUpdated,
    dsnpUnmatched,
    csnpUpdated,
    csnpUnmatched,
    scanned: landscape.size,
  };
}
