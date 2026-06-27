/*!
 * populate-fixtures-from-cms.ts — read CMS source files directly,
 * write the extracted values into cms-ground-truth-fixtures.json so
 * the validator can compare agent /api/plans output to actual
 * CMS-filed values (not a prior snapshot of the agent's own output).
 *
 * Sources:
 *   ~/planmatch/planmatch/_tmp/cms-sync/landscape/CY2026_Landscape_202603/
 *     CY2026_Landscape_202603.csv
 *       → premium, moop_in_network, drug_deductible, star_rating
 *   ~/Code/plan-match/data/pbp/pbp_*.txt
 *       → all PBP-derivable cost-shares + Section D Part B giveback
 *   ~/Code/plan-match/data/pbp/pbp_mrx_tier.txt
 *       → rx_tiers.tier_1..tier_5 copay/coinsurance (1-month retail
 *         standard pharmacy)
 *
 * The extractor patterns mirror scripts/import-pbp-benefits.ts in the
 * consumer repo (which is the canonical writer of pm_plan_benefits
 * from the same files). Keeping the same field-pick logic means a
 * fixture written by this script SHOULD match what /api/plans
 * surfaces; any drift is a real bug in either the import pipeline
 * or the API layer.
 *
 * verifiedOn carries the Landscape file's release date (March 2026)
 * with a leading "CMS source 2026-03 +" tag so the validator's
 * report distinguishes a CMS-source-derived row from a
 * production-snapshot row from a hand-verified-on-medicare-gov row.
 *
 * Usage:
 *   pnpm tsx scripts/populate-fixtures-from-cms.ts
 *   pnpm tsx scripts/populate-fixtures-from-cms.ts --only H5253-041-000
 *   pnpm tsx scripts/populate-fixtures-from-cms.ts --dry-run
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HOME = homedir();
const FIXTURE_PATH = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  'cms-ground-truth-fixtures.json',
);
const LANDSCAPE_CSV = resolve(
  HOME,
  'planmatch/planmatch/_tmp/cms-sync/landscape/CY2026_Landscape_202603/CY2026_Landscape_202603.csv',
);
const PBP_DIR = resolve(HOME, 'Code/plan-match/data/pbp');
const CMS_RELEASE_LABEL = 'CMS source 2026-03';

// ─── Fixture types (mirror cms-ground-truth-validate.ts) ───────────────
interface CostShareExpected { copay: number | null; coinsurance: number | null }
interface ExtrasExpected {
  dental_annual_max: number | null;
  vision_eyewear_allowance_year: number | null;
  hearing_aid_allowance_year: number | null;
  otc_allowance_per_quarter: number | null;
  food_card_allowance_per_month: number | null;
  transportation_rides_per_year: number | null;
  fitness_enabled: boolean | null;
}
interface FixtureExpected {
  premium: number | null;
  moop_in_network: number | null;
  drug_deductible: number | null;
  star_rating: number | null;
  part_b_giveback: number | null;
  medical: Record<string, CostShareExpected>;
  extras: ExtrasExpected;
  rx_tiers: Record<string, CostShareExpected>;
}
interface Fixture {
  id: string;
  verifiedOn: string | null;
  state: string;
  county: string;
  carrier: string;
  plan_name: string;
  expected: FixtureExpected;
}
interface FixturesFile { _meta: Record<string, unknown>; fixtures: Fixture[] }

// ─── CLI ───────────────────────────────────────────────────────────────
interface CliArgs { only: string | null; dryRun: boolean }
function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { only: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only' && argv[i + 1]) { out.only = argv[i + 1]; i++; }
    else if (argv[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

// ─── Parse helpers (same shape as import-pbp-benefits.ts) ──────────────
function isYes(v: unknown): boolean {
  return typeof v === 'string' && v.trim() === '1';
}
function cleanText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}
function parseMoney(v: unknown): number | null {
  const t = cleanText(v);
  if (t == null) return null;
  const n = Number(t.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// RFC-4180 CSV line splitter (Landscape carries quoted "$2,100.00 " values).
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else cur += ch;
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"' && cur === '') inQuote = true;
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// ─── Landscape extraction ──────────────────────────────────────────────
interface LandscapeRow {
  premium: number | null;
  moop: number | null;
  drug_deductible: number | null;
  star_rating: number | null;
}

interface ResolvedFixture {
  fixtureId: string;
  contract: string;
  plan: string;
  segment: string; // resolved from landscape via fixture county
  county: string;
  landscape: LandscapeRow;
}

/**
 * Walk the Landscape CSV once: resolve each fixture's REAL segment (via
 * its county) and pull the plan-level metrics in the same pass. Multi-
 * segment plans (BCBSNC H3449-027 files segments 1 + 2 across NC; Durham
 * lives in segment 2) reject any fixture id with a hardcoded "000"
 * segment because there's no segment 000 row in CMS to scrape. We
 * resolve by (contract, plan, county) so the downstream PBP scan finds
 * the right cost-share rows.
 */
function resolveFixturesFromLandscape(
  fixtures: Fixture[],
): Map<string, ResolvedFixture> {
  const out = new Map<string, ResolvedFixture>();
  if (!existsSync(LANDSCAPE_CSV)) {
    console.warn(`  ! Landscape CSV not found at ${LANDSCAPE_CSV}`);
    return out;
  }
  // Index fixtures by (contract:plan) → list of fixtures wanting any
  // segment of that contract/plan. Then walk the landscape and pick
  // the segment matching each fixture's county.
  const byContractPlan = new Map<string, Fixture[]>();
  for (const f of fixtures) {
    const [contract, plan] = f.id.split('-');
    const key = `${contract}:${plan}`;
    if (!byContractPlan.has(key)) byContractPlan.set(key, []);
    byContractPlan.get(key)!.push(f);
  }

  const text = readFileSync(LANDSCAPE_CSV, 'utf8');
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return out;
  const headerCells = splitCsvLine(lines[0]).map((h) => h.replace(/^﻿/, '').trim());
  const idx = Object.fromEntries(headerCells.map((h, i) => [h, i] as const));
  const COL = {
    contract: idx['Contract ID'],
    plan: idx['Plan ID'],
    segment: idx['Segment ID'],
    county: idx['County Name'],
    premium: idx['Monthly Consolidated Premium (Part C + D)'],
    moop: idx['In-Network Maximum Out-of-Pocket (MOOP) Amount'],
    drug_ded: idx['Annual Part D Deductible Amount'],
    star: idx['Overall Star Rating'],
  };
  for (const [k, v] of Object.entries(COL)) {
    if (v === undefined) console.warn(`  ! Landscape missing column for ${k}`);
  }

  // Track which (contract:plan) keys we still need to find, for early-out.
  const wanted = new Set<string>(byContractPlan.keys());
  let scanned = 0;
  for (let li = 1; li < lines.length; li++) {
    if (wanted.size === 0) break;
    const line = lines[li];
    if (!line) continue;
    scanned += 1;
    const cells = splitCsvLine(line);
    const contract = (cells[COL.contract] ?? '').trim();
    const plan = (cells[COL.plan] ?? '').trim();
    const key = `${contract}:${plan}`;
    if (!wanted.has(key)) continue;
    const segment = (cells[COL.segment] ?? '0').trim() || '0';
    const county = (cells[COL.county] ?? '').trim();
    const candidates = byContractPlan.get(key)!;
    for (const f of candidates) {
      if (out.has(f.id)) continue;
      // Match county case-insensitively; also accept the "All Counties"
      // PDP wildcard row.
      if (
        county.toLowerCase() !== f.county.toLowerCase() &&
        county.toLowerCase() !== 'all counties'
      ) {
        continue;
      }
      const starRaw = (cells[COL.star] ?? '').trim();
      out.set(f.id, {
        fixtureId: f.id,
        contract,
        plan,
        segment,
        county,
        landscape: {
          premium: parseMoney(cells[COL.premium]),
          moop: parseMoney(cells[COL.moop]),
          drug_deductible: parseMoney(cells[COL.drug_ded]),
          star_rating: starRaw && /^\d/.test(starRaw) ? Number(starRaw) : null,
        },
      });
    }
    // If every fixture for this key is now resolved, remove from wanted.
    if (candidates.every((f) => out.has(f.id))) wanted.delete(key);
  }
  console.log(`  Landscape: scanned ${scanned.toLocaleString()} rows, resolved ${out.size}/${fixtures.length} fixtures`);
  for (const f of fixtures) {
    if (!out.has(f.id)) {
      console.warn(`  ! ${f.id}: no Landscape row found for ${f.county} ${f.state}`);
    } else {
      const r = out.get(f.id)!;
      if (r.segment !== (f.id.split('-')[2] ?? '0')) {
        console.log(`    ${f.id}: segment ${f.id.split('-')[2]} fixture id → segment ${r.segment} actual (${r.county})`);
      }
    }
  }
  return out;
}

// ─── PBP file streamer ─────────────────────────────────────────────────
// Each per-section extractor takes (row, idx, plan) and mutates a per-
// plan scratch object. We stream one file at a time, applying all
// registered extractors for that file against rows that match the
// fixture triple set.

type CSScratch = CostShareExpected;

interface PerPlanScratch {
  medical: Record<string, CSScratch>;
  extras: ExtrasExpected;
  rx_tiers: Record<string, CSScratch>;
  part_b_giveback: number | null;
}

function emptyScratch(): PerPlanScratch {
  return {
    medical: {
      primary_care:                { copay: null, coinsurance: null },
      specialist:                  { copay: null, coinsurance: null },
      urgent_care:                 { copay: null, coinsurance: null },
      emergency:                   { copay: null, coinsurance: null },
      inpatient:                   { copay: null, coinsurance: null },
      snf:                         { copay: null, coinsurance: null },
      outpatient_surgery_hospital: { copay: null, coinsurance: null },
      outpatient_surgery_asc:      { copay: null, coinsurance: null },
      lab_services:                { copay: null, coinsurance: null },
      diagnostic_procedures:       { copay: null, coinsurance: null },
      xray:                        { copay: null, coinsurance: null },
      advanced_imaging:            { copay: null, coinsurance: null },
      ambulance:                   { copay: null, coinsurance: null },
      telehealth:                  { copay: null, coinsurance: null },
      mental_health_individual:    { copay: null, coinsurance: null },
    },
    extras: {
      dental_annual_max:             null,
      vision_eyewear_allowance_year: null,
      hearing_aid_allowance_year:    null,
      otc_allowance_per_quarter:     null,
      food_card_allowance_per_month: null,
      transportation_rides_per_year: null,
      fitness_enabled:               null,
    },
    rx_tiers: {
      tier_1: { copay: null, coinsurance: null },
      tier_2: { copay: null, coinsurance: null },
      tier_3: { copay: null, coinsurance: null },
      tier_4: { copay: null, coinsurance: null },
      tier_5: { copay: null, coinsurance: null },
    },
    part_b_giveback: null,
  };
}

type RowExtractor = (
  row: string[],
  idx: Record<string, number>,
  s: PerPlanScratch,
) => void;

interface PbpSpec { filename: string; extractors: RowExtractor[] }

async function streamPbpFile(
  filePath: string,
  allowedTriples: Set<string>,
  scratchByTriple: Map<string, PerPlanScratch>,
  extractors: RowExtractor[],
): Promise<void> {
  if (!existsSync(filePath)) {
    console.warn(`  ! PBP file missing: ${filePath}`);
    return;
  }
  const reader = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
  });
  let header: string[] | null = null;
  let idx: Record<string, number> = {};
  for await (const line of reader) {
    if (!line) continue;
    const cells = line.split('\t');
    if (header === null) {
      header = cells.map((h) => h.trim().replace(/^﻿/, '').toLowerCase());
      idx = Object.fromEntries(header.map((h, i) => [h, i]));
      continue;
    }
    const contract = (cells[idx.pbp_a_hnumber] ?? '').trim();
    const plan = (cells[idx.pbp_a_plan_identifier] ?? '').trim();
    const segment = (cells[idx.segment_id] ?? '0').trim() || '0';
    if (!contract || !plan) continue;
    const tripleA = `${contract}:${plan}:${segment}`;
    const tripleB = `${contract}:${plan}:${segment.padStart(3, '0')}`;
    const triple = allowedTriples.has(tripleA)
      ? tripleA
      : allowedTriples.has(tripleB)
        ? tripleB
        : null;
    if (!triple) continue;
    const scratch = scratchByTriple.get(triple);
    if (!scratch) continue;
    for (const ex of extractors) ex(cells, idx, scratch);
  }
}

// ─── Per-section extractors ────────────────────────────────────────────
// Field-pick mirrors scripts/import-pbp-benefits.ts.

const extractB7HealthProf: RowExtractor = (row, idx, s) => {
  s.medical.primary_care.copay = parseMoney(row[idx.pbp_b7a_copay_amt_mc_min]);
  s.medical.primary_care.coinsurance = parseMoney(row[idx.pbp_b7a_coins_pct_mc_min]);
  s.medical.specialist.copay = parseMoney(row[idx.pbp_b7d_copay_amt_mc_min]);
  s.medical.specialist.coinsurance = parseMoney(row[idx.pbp_b7d_coins_pct_mc_min]);
  // B7e mental health individual (mcis)
  s.medical.mental_health_individual.copay =
    parseMoney(row[idx.pbp_b7e_copay_mcis_minamt]) ??
    parseMoney(row[idx.pbp_b7e_copay_mcis_maxamt]);
  s.medical.mental_health_individual.coinsurance =
    parseMoney(row[idx.pbp_b7e_coins_mcis_minpct]) ??
    parseMoney(row[idx.pbp_b7e_coins_mcis_maxpct]);
};

const extractB4EmergUrgent: RowExtractor = (row, idx, s) => {
  s.medical.emergency.copay = parseMoney(row[idx.pbp_b4a_copay_amt_mc_min]);
  s.medical.emergency.coinsurance = parseMoney(row[idx.pbp_b4a_coins_pct_mc_min]);
  s.medical.urgent_care.copay = parseMoney(row[idx.pbp_b4b_copay_amt_mc_min]);
  s.medical.urgent_care.coinsurance = parseMoney(row[idx.pbp_b4b_coins_pct_mc_min]);
};

const extractB1aInpatient: RowExtractor = (row, idx, s) => {
  if (isYes(row[idx.pbp_b1a_copay_yn])) {
    const day1 = parseMoney(row[idx.pbp_b1a_copay_mcs_amt_int1_t1]);
    if (day1 != null) s.medical.inpatient.copay = day1;
  }
  if (isYes(row[idx.pbp_b1a_mc_coins_cstshr_yn_t1])) {
    const pct = parseMoney(row[idx.pbp_b1a_coins_mcs_pct_t1]);
    if (pct != null) s.medical.inpatient.coinsurance = pct;
  }
};

const extractB2Snf: RowExtractor = (row, idx, s) => {
  // b2a sub-letter is common; fall back to b2 if not present.
  const day1A = parseMoney(row[idx.pbp_b2a_copay_mcs_amt_int1_t1]);
  const day1B = parseMoney(row[idx.pbp_b2_copay_mcs_amt_int1_t1]);
  if (day1A != null) s.medical.snf.copay = day1A;
  else if (day1B != null) s.medical.snf.copay = day1B;
  const pctA = parseMoney(row[idx.pbp_b2a_coins_mcs_pct_t1]);
  const pctB = parseMoney(row[idx.pbp_b2_coins_mcs_pct_t1]);
  if (pctA != null) s.medical.snf.coinsurance = pctA;
  else if (pctB != null) s.medical.snf.coinsurance = pctB;
};

const extractB8Lab: RowExtractor = (row, idx, s) => {
  // Lab — b8a lab-specific
  s.medical.lab_services.copay = parseMoney(row[idx.pbp_b8a_lab_copay_amt]);
  s.medical.lab_services.coinsurance = parseMoney(row[idx.pbp_b8a_coins_pct_lab]);
  // Diagnostic procedures (dmc)
  s.medical.diagnostic_procedures.copay = parseMoney(row[idx.pbp_b8a_copay_min_dmc_amt]);
  s.medical.diagnostic_procedures.coinsurance = parseMoney(row[idx.pbp_b8a_coins_pct_dmc]);
  // X-ray (drs in CMS-spec; mc_amt in swap convention — prefer drs)
  s.medical.xray.copay = parseMoney(row[idx.pbp_b8b_copay_amt_drs]) ?? parseMoney(row[idx.pbp_b8b_copay_mc_amt]);
  s.medical.xray.coinsurance = parseMoney(row[idx.pbp_b8b_coins_pct_drs]);
  // Advanced imaging (cmc — coinsurance only typically)
  s.medical.advanced_imaging.coinsurance = parseMoney(row[idx.pbp_b8b_coins_pct_cmc]);
  // When cmc coinsurance is unfiled, fall back to the composite copay
  if (s.medical.advanced_imaging.coinsurance == null) {
    s.medical.advanced_imaging.copay = parseMoney(row[idx.pbp_b8b_copay_mc_amt]);
  }
};

const extractB9Outpatient: RowExtractor = (row, idx, s) => {
  // B9a — outpatient hospital surgery (ohs)
  const ohsMin = parseMoney(row[idx.pbp_b9a_copay_ohs_amt_min]);
  const ohsMax = parseMoney(row[idx.pbp_b9a_copay_ohs_amt_max]);
  s.medical.outpatient_surgery_hospital.copay =
    ohsMin === 0 && ohsMax != null && ohsMax > 0 ? ohsMax : ohsMin;
  const ohsCoinsMin = parseMoney(row[idx.pbp_b9a_coins_ohs_pct_min]);
  const ohsCoinsMax = parseMoney(row[idx.pbp_b9a_coins_ohs_pct_max]);
  s.medical.outpatient_surgery_hospital.coinsurance =
    ohsCoinsMin === 0 && ohsCoinsMax != null && ohsCoinsMax > 0 ? ohsCoinsMax : ohsCoinsMin;
  // B9b — ASC
  const ascMin = parseMoney(row[idx.pbp_b9b_copay_mc_amt]);
  const ascMax = parseMoney(row[idx.pbp_b9b_copay_mc_amt_max]);
  s.medical.outpatient_surgery_asc.copay =
    ascMin === 0 && ascMax != null && ascMax > 0 ? ascMax : ascMin;
  s.medical.outpatient_surgery_asc.coinsurance = parseMoney(row[idx.pbp_b9b_coins_pct_mc]);
};

const extractB10Ambulance: RowExtractor = (row, idx, s) => {
  // B10a — ground ambulance (gas)
  s.medical.ambulance.copay = parseMoney(row[idx.pbp_b10a_copay_gas_amt_min]);
  s.medical.ambulance.coinsurance = parseMoney(row[idx.pbp_b10a_coins_gas_pct_min]);
};

const extractB1bMHInpatient: RowExtractor = (_row, _idx, _s) => {
  // mental_health_inpatient NOT in the current fixture taxonomy, so no
  // write target — but registering the extractor placeholder keeps the
  // file-spec list one-to-one with the import-pbp-benefits.ts mapping
  // for future extension.
};

const extractB16Dental: RowExtractor = (row, idx, s) => {
  // Comprehensive dental annual max — maxenr_pv first then maxplan_pv.
  const compMax =
    parseMoney(row[idx.pbp_b16b_maxenr_pv_amt]) ??
    parseMoney(row[idx.pbp_b16b_maxplan_pv_amt]);
  const prevMax = parseMoney(row[idx.pbp_b16a_maxenr_mc_amt]);
  let maxCov = compMax ?? prevMax;
  // Outlier cap per import-pbp-benefits.ts (the $20K H4513 carriers).
  if (maxCov != null && maxCov > 10000) maxCov = null;
  s.extras.dental_annual_max = maxCov;
};

const extractB17Vision: RowExtractor = (row, idx, s) => {
  let max =
    parseMoney(row[idx.pbp_b17a_maxenr_amt]) ??
    parseMoney(row[idx.pbp_b17a_maxplan_amt]);
  if (max != null && max > 500) max = null;
  s.extras.vision_eyewear_allowance_year = max;
};

const extractB18Hearing: RowExtractor = (row, idx, s) => {
  let max =
    parseMoney(row[idx.pbp_b18a_maxenr_amt]) ??
    parseMoney(row[idx.pbp_b18a_maxplan_amt]);
  if (max != null && max > 5000) max = null;
  s.extras.hearing_aid_allowance_year = max;
};

const extractB13OtcMealsFitness: RowExtractor = (row, idx, s) => {
  // OTC (b13b) — normalize to quarterly to match the agent's
  // allowance_per_quarter contract.
  if (isYes(row[idx.pbp_b13b_maxplan_yn]) || isYes(row[idx.pbp_b13b_maxenr_yn])) {
    const amt =
      parseMoney(row[idx.pbp_b13b_maxplan_amt]) ??
      parseMoney(row[idx.pbp_b13b_maxenr_amt]);
    if (amt != null && amt > 0) {
      const per =
        cleanText(row[idx.pbp_b13b_otc_maxplan_per]) ??
        cleanText(row[idx.pbp_b13b_maxenr_per]);
      // 1=month, 2=quarter, 3=year, others → assume quarter
      const quarterly = per === '1' ? amt * 3 : per === '3' ? amt / 4 : amt;
      s.extras.otc_allowance_per_quarter = Math.round(quarterly);
    }
  }
  // Meals (b13c) — normalize to monthly.
  if (isYes(row[idx.pbp_b13c_bendesc_service])) {
    const amt =
      parseMoney(row[idx.pbp_b13c_maxplan_amt]) ??
      parseMoney(row[idx.pbp_b13c_maxenr_amt]);
    const per =
      cleanText(row[idx.pbp_b13c_maxplan_per]) ??
      cleanText(row[idx.pbp_b13c_maxenr_per]);
    const monthly =
      amt != null
        ? per === '2'
          ? amt / 3
          : per === '3'
          ? amt / 12
          : amt
        : null;
    if (monthly != null) s.extras.food_card_allowance_per_month = Math.round(monthly);
  }
  // Fitness — PBP doesn't carry program name structurally; scan b13d-g
  // free-text descriptions for the keyword.
  const fitnessRe =
    /(fitness|gym|silversneakers|silver\s*sneakers|renew\s*active|active\s*&?\s*fit|onecall|one\s*call|yoga)/i;
  for (const sl of ['b13d', 'b13e', 'b13f', 'b13g']) {
    const desc = cleanText(row[idx[`pbp_${sl}_bendesc_service`]]);
    if (desc && fitnessRe.test(desc)) {
      s.extras.fitness_enabled = true;
      break;
    }
  }
};

const extractB10bTransport: RowExtractor = (row, idx, s) => {
  // PBP doesn't file rides/year cleanly — it carries either a $ cap
  // or a presence flag. Agent's buildBenefits derives rides_per_year
  // as 24/36/48 from the dollar cap. We mirror that derivation so
  // the fixture's expected matches what the agent surfaces.
  const offered = isYes(row[idx.pbp_b10b_bendesc_yn]);
  if (!offered) return;
  const cap =
    parseMoney(row[idx.pbp_b10b_maxenr_amt]) ??
    parseMoney(row[idx.pbp_b10b_maxplan_amt]);
  s.extras.transportation_rides_per_year =
    cap && cap > 500 ? 48 : cap && cap > 200 ? 36 : 24;
};

const extractSectionDGiveback: RowExtractor = (row, idx, s) => {
  if (isYes(row[idx.pbp_d_mco_pay_reduct_yn])) {
    const amt = parseMoney(row[idx.pbp_d_mco_pay_reduct_amt]);
    if (amt != null) s.part_b_giveback = amt;
  }
};

const extractMrxTier: RowExtractor = (row, idx, s) => {
  const tierId = cleanText(row[idx.mrx_tier_id]);
  if (!tierId || !/^[1-5]$/.test(tierId)) return;
  // Retail standard pharmacy, 1-month — first preference. Fall back to
  // preferred (rspfd) when standard is blank, mirroring the importer.
  const copay =
    parseMoney(row[idx.mrx_tier_rstd_copay_1m]) ??
    parseMoney(row[idx.mrx_tier_rspfd_copay_1m]);
  const coins =
    parseMoney(row[idx.mrx_tier_rstd_coins_1m]) ??
    parseMoney(row[idx.mrx_tier_rspfd_coins_1m]);
  const cell = s.rx_tiers[`tier_${tierId}`];
  if (cell) {
    if (cell.copay == null) cell.copay = copay;
    if (cell.coinsurance == null) cell.coinsurance = coins;
  }
};

// ─── File → extractor wiring (one read per file) ───────────────────────
const PBP_SPECS: PbpSpec[] = [
  { filename: 'pbp_b1a_inpat_hosp.txt',         extractors: [extractB1aInpatient] },
  { filename: 'pbp_b1b_inpat_hosp.txt',         extractors: [extractB1bMHInpatient] },
  { filename: 'pbp_b2_snf.txt',                 extractors: [extractB2Snf] },
  { filename: 'pbp_b4_emerg_urgent.txt',        extractors: [extractB4EmergUrgent] },
  { filename: 'pbp_b7_health_prof.txt',         extractors: [extractB7HealthProf] },
  { filename: 'pbp_b8_clin_diag_ther.txt',      extractors: [extractB8Lab] },
  { filename: 'pbp_b9_outpat_hosp.txt',         extractors: [extractB9Outpatient] },
  { filename: 'pbp_b10_amb_trans.txt',          extractors: [extractB10Ambulance, extractB10bTransport] },
  { filename: 'pbp_b13_other_services.txt',     extractors: [extractB13OtcMealsFitness] },
  { filename: 'pbp_b16_dental.txt',             extractors: [extractB16Dental] },
  { filename: 'pbp_b17_eye_exams_wear.txt',     extractors: [extractB17Vision] },
  { filename: 'pbp_b18_hearing_exams_aids.txt', extractors: [extractB18Hearing] },
  { filename: 'pbp_Section_D.txt',              extractors: [extractSectionDGiveback] },
  { filename: 'pbp_mrx_tier.txt',               extractors: [extractMrxTier] },
];

// ─── Main ──────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(FIXTURE_PATH)) {
    console.error('Fixture file not found at', FIXTURE_PATH);
    process.exit(1);
  }
  const file = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as FixturesFile;
  const targets = args.only
    ? file.fixtures.filter((f) => f.id === args.only)
    : file.fixtures;
  if (targets.length === 0) {
    console.log('No matching fixtures.');
    return;
  }

  console.log(`Populating ${targets.length} fixture(s) from CMS source files…`);
  console.log('Landscape:', LANDSCAPE_CSV);
  console.log('PBP dir  :', PBP_DIR);

  const resolved = resolveFixturesFromLandscape(targets);

  // Build the (contract:plan:segment) triple set using RESOLVED segments
  // (multi-segment plans land in the right segment for the fixture's
  // county; single-segment plans use their filed segment).
  const allowedTriples = new Set<string>();
  const tripleByFixtureId = new Map<string, string>();
  for (const f of targets) {
    const r = resolved.get(f.id);
    if (!r) continue;
    const triple = `${r.contract}:${r.plan}:${r.segment}`;
    allowedTriples.add(triple);
    tripleByFixtureId.set(f.id, triple);
  }

  const scratchByTriple = new Map<string, PerPlanScratch>();
  for (const triple of allowedTriples) scratchByTriple.set(triple, emptyScratch());

  for (const spec of PBP_SPECS) {
    const path = resolve(PBP_DIR, spec.filename);
    process.stdout.write(`  ${spec.filename.padEnd(34)} `);
    const before = Date.now();
    await streamPbpFile(path, allowedTriples, scratchByTriple, spec.extractors);
    process.stdout.write(`${((Date.now() - before) / 1000).toFixed(1)}s\n`);
  }

  // Merge scratch into fixture.expected.
  const today = new Date().toISOString().slice(0, 10);
  let written = 0;
  for (const f of targets) {
    const r = resolved.get(f.id);
    const triple = tripleByFixtureId.get(f.id);
    const scratch = triple ? scratchByTriple.get(triple) : undefined;
    if (!r && !scratch) {
      console.warn(`  ✗ ${f.id}: no CMS rows matched`);
      continue;
    }
    f.expected.premium = r?.landscape.premium ?? null;
    f.expected.moop_in_network = r?.landscape.moop ?? null;
    f.expected.drug_deductible = r?.landscape.drug_deductible ?? null;
    f.expected.star_rating = r?.landscape.star_rating ?? null;
    f.expected.part_b_giveback = scratch?.part_b_giveback ?? null;
    if (scratch) {
      f.expected.medical = scratch.medical;
      f.expected.extras = scratch.extras;
      f.expected.rx_tiers = scratch.rx_tiers;
    }
    f.verifiedOn = `${CMS_RELEASE_LABEL} + extracted ${today}`;
    written += 1;
    const hits =
      (r?.landscape.premium != null ? 1 : 0) +
      (r?.landscape.moop != null ? 1 : 0) +
      (r?.landscape.drug_deductible != null ? 1 : 0) +
      (r?.landscape.star_rating != null ? 1 : 0) +
      (scratch?.part_b_giveback != null ? 1 : 0) +
      Object.values(scratch?.medical ?? {}).filter((c) => c.copay != null || c.coinsurance != null).length +
      Object.values(scratch?.extras ?? {}).filter((v) => v != null).length +
      Object.values(scratch?.rx_tiers ?? {}).filter((c) => c.copay != null || c.coinsurance != null).length;
    console.log(`  ✓ ${f.id} (${f.carrier} ${f.state}/${f.county}) — populated ${hits} fields`);
  }

  if (args.dryRun) {
    console.log(`\n--dry-run: ${written} fixture(s) populated, file NOT written.`);
    return;
  }
  writeFileSync(FIXTURE_PATH, JSON.stringify(file, null, 2) + '\n', 'utf8');
  console.log(`\nWrote ${written} fixture(s) → ${FIXTURE_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
