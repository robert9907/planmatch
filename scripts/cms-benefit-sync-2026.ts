// scripts/cms-benefit-sync-2026.ts
//
// Second-pass CMS sync: validate per-category benefit VALUES (copays,
// coinsurance, allowance amounts) in pm_plan_benefits + pbp_benefits
// against the CMS CY2026 PBP subsection files.
//
// First pass (scripts/cms-sync-2026.ts) validated the 8 plan-level
// fields and confirmed all 791 NC/TX/GA plans exist in CMS. This pass
// extracts the canonical PBP cost-share column for each of 33 medical/
// extras/Rx categories (mapping table reviewed + approved) and diffs
// against the agent DB.
//
// READ-ONLY against Supabase. SQL emitted to
// migrations/proposed-cms-benefit-sync-2026.sql — NOT executed.
//
// Tolerances per the spec sign-off:
//   • copay        ±$2  (whole-dollar rounding in carrier filings)
//   • coinsurance  ±0%  (exact)
//   • max_coverage ±$50 (carriers report in $50/$100 buckets)

import { createClient, type PostgrestSingleResponse } from '@supabase/supabase-js';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const SB_URL = process.env.SUPABASE_URL ?? '';
const SB_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
if (!SB_URL || !SB_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/ANON_KEY');
  process.exit(1);
}
const sb = createClient(SB_URL, SB_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const STATES = ['NC', 'TX', 'GA'] as const;
const PBP_DIR = '_tmp/cms-sync/pbp';
const OUT_DIR = '_tmp/cms-sync/out';
const SQL_PATH = 'migrations/proposed-cms-benefit-sync-2026.sql';
const SUMMARY_PATH = `${OUT_DIR}/benefit-sync-summary.txt`;

// ── Helpers ──────────────────────────────────────────────────────────
function padSegment(s: string | null | undefined): string {
  const v = (s ?? '').trim();
  if (!v) return '000';
  return v.padStart(3, '0');
}
function tripleKey(c: string, p: string, s: string | null | undefined): string {
  return `${c}-${p}-${padSegment(s)}`;
}
function toNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[$,]/g, '').trim();
  if (s === '' || /^(\.|N\/A|NA|null)$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Tab-delimited PBP reader, streamed line-by-line. Only stores rows
// whose (contract, plan, segment) triple is in the NC/TX/GA set so the
// 7000-row-per-file extracts don't blow memory.
async function readPbpFiltered<T>(
  path: string,
  allowedTriples: Set<string>,
  map: (row: Record<string, string>, triple: string) => T | null,
  out: Map<string, T>,
): Promise<void> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let header: string[] = [];
  let n = 0;
  for await (const line of rl) {
    if (n === 0) {
      header = line.split('\t').map((c) => c.trim().toLowerCase());
      n += 1;
      continue;
    }
    if (!line) { n += 1; continue; }
    const cells = line.split('\t');
    const c = cells[header.indexOf('pbp_a_hnumber')] ?? '';
    const p = cells[header.indexOf('pbp_a_plan_identifier')] ?? '';
    const s = cells[header.indexOf('segment_id')] ?? '';
    if (!c || !p) { n += 1; continue; }
    const triple = tripleKey(c, p, s);
    if (!allowedTriples.has(triple)) { n += 1; continue; }
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i += 1) row[header[i]] = cells[i] ?? '';
    const val = map(row, triple);
    if (val != null) out.set(triple, val);
    n += 1;
  }
}

async function paginate<T>(
  fn: (f: number, t: number) => PromiseLike<PostgrestSingleResponse<T[]>>,
  maxPages = 200,
): Promise<T[]> {
  const result: T[] = [];
  for (let n = 0; n < maxPages; n += 1) {
    const { data, error } = await fn(n * 1000, n * 1000 + 999);
    if (error) throw error;
    if (!data || !data.length) break;
    result.push(...data);
    if (data.length < 1000) break;
  }
  return result;
}

// ── Category mapping ────────────────────────────────────────────────
// Reviewed + approved per discovery report. `pbp_alias` is the actual
// pm_plan_benefits.benefit_category string when it diverges from the
// DB plan-field name (matches api/plans.ts CATEGORY_ALIAS so the join
// hits the right rows).
interface CatCfg {
  category: string;
  pbp_alias?: string;
  file: string;
  copay_col?: string;
  copay_fallback?: string;
  coins_col?: string;
  coins_fallback?: string;
  max_cov_col?: string;
}

const MEDICAL_CATEGORIES: CatCfg[] = [
  { category: 'primary_care', file: 'pbp_b7_health_prof.txt',
    copay_col: 'pbp_b7a_copay_amt_mc_min', coins_col: 'pbp_b7a_coins_pct_mc_min' },
  { category: 'specialist', file: 'pbp_b7_health_prof.txt',
    copay_col: 'pbp_b7d_copay_amt_mc_min', coins_col: 'pbp_b7d_coins_pct_mc_min' },
  { category: 'urgent_care', file: 'pbp_b4_emerg_urgent.txt',
    copay_col: 'pbp_b4b_copay_amt_mc_min', coins_col: 'pbp_b4b_coins_pct_mc_min' },
  { category: 'emergency', file: 'pbp_b4_emerg_urgent.txt',
    copay_col: 'pbp_b4a_copay_amt_mc_min', coins_col: 'pbp_b4a_coins_pct_mc_min' },
  { category: 'inpatient', file: 'pbp_b1a_inpat_hosp.txt',
    copay_col: 'pbp_b1a_copay_mcs_amt_int1_t1', copay_fallback: 'pbp_b1a_copay_ad_amt_int1_t1',
    coins_col: 'pbp_b1a_coins_mcs_pct_int1_t1', coins_fallback: 'pbp_b1a_coins_ad_pct_int1_t1' },
  { category: 'mental_health_inpatient', file: 'pbp_b1b_inpat_hosp.txt',
    copay_col: 'pbp_b1b_copay_mcs_amt_int1_t1', copay_fallback: 'pbp_b1b_copay_ad_amt_int1_t1',
    coins_col: 'pbp_b1b_coins_mcs_pct_int1_t1', coins_fallback: 'pbp_b1b_coins_ad_pct_int1_t1' },
  { category: 'snf', file: 'pbp_b2_snf.txt',
    copay_col: 'pbp_b2_copay_mcs_amt_int1_t1', copay_fallback: 'pbp_b2_copay_ad_amt_int1_t1',
    coins_col: 'pbp_b2_coins_mcs_pct_int1_t1', coins_fallback: 'pbp_b2_coins_ad_pct_int1_t1' },
  // b9 outpatient hospital: OHS (surgery) + OBS (observation) share
  // the b9a row with separate _ohs_ vs _obs_ suffixes. ASC is b9b
  // with a plain `_mc_amt` (no min/max suffix).
  { category: 'outpatient_surgery_hospital', pbp_alias: 'outpatient_surgery', file: 'pbp_b9_outpat_hosp.txt',
    copay_col: 'pbp_b9a_copay_ohs_amt_min', coins_col: 'pbp_b9a_coins_ohs_pct_min' },
  { category: 'outpatient_surgery_asc', pbp_alias: 'asc', file: 'pbp_b9_outpat_hosp.txt',
    copay_col: 'pbp_b9b_copay_mc_amt', coins_col: 'pbp_b9b_coins_pct_mc' },
  { category: 'outpatient_observation', file: 'pbp_b9_outpat_hosp.txt',
    copay_col: 'pbp_b9a_copay_obs_amt_min', coins_col: 'pbp_b9a_coins_obs_pct_min' },
  // b8 diagnostic. b8a holds lab AND general diagnostic (DMC =
  // Diagnostic Medicare-Covered). b8b holds radiology — DRS (diagnostic
  // radiology services / x-ray) + TMC (therapeutic radiology, used for
  // advanced imaging like MRI/CT/PET).
  { category: 'lab_services', pbp_alias: 'lab', file: 'pbp_b8_clin_diag_ther.txt',
    copay_col: 'pbp_b8a_lab_copay_amt', coins_col: 'pbp_b8a_coins_pct_lab' },
  { category: 'diagnostic_procedures', file: 'pbp_b8_clin_diag_ther.txt',
    copay_col: 'pbp_b8a_copay_min_dmc_amt', coins_col: 'pbp_b8a_coins_pct_dmc' },
  { category: 'xray', file: 'pbp_b8_clin_diag_ther.txt',
    copay_col: 'pbp_b8b_copay_amt_drs', coins_col: 'pbp_b8b_coins_pct_drs' },
  { category: 'advanced_imaging', file: 'pbp_b8_clin_diag_ther.txt',
    copay_col: 'pbp_b8b_copay_amt_tmc', coins_col: 'pbp_b8b_coins_pct_tmc' },
  // b7e mental health outpatient. Filed split: MCIS = Medicare-Covered
  // Individual Service, MCGS = Group Service. PM stores them as the
  // pbp_alias categories below — matches /api/plans CATEGORY_ALIAS.
  { category: 'mental_health_individual', pbp_alias: 'mental_health_outpatient_individual',
    file: 'pbp_b7_health_prof.txt',
    copay_col: 'pbp_b7e_copay_mcis_minamt', coins_col: 'pbp_b7e_coins_mcis_minpct' },
  { category: 'mental_health_group', pbp_alias: 'mental_health_outpatient_group',
    file: 'pbp_b7_health_prof.txt',
    copay_col: 'pbp_b7e_copay_mcgs_minamt', coins_col: 'pbp_b7e_coins_mcgs_minpct' },
  { category: 'physical_speech_therapy', file: 'pbp_b7_health_prof.txt',
    copay_col: 'pbp_b7i_copay_amt_mc_min', coins_col: 'pbp_b7i_coins_pct_mc_min' },
  { category: 'occupational_therapy', file: 'pbp_b7_health_prof.txt',
    copay_col: 'pbp_b7c_copay_amt_mc_min', coins_col: 'pbp_b7c_coins_pct_mc_min' },
  { category: 'telehealth', file: 'pbp_b7_health_prof.txt',
    copay_col: 'pbp_b7j_copay_amt_mc_min', coins_col: 'pbp_b7j_coins_pct_mc_min' },
  // b10a ambulance: GAS = ground ambulance, AAS = air ambulance.
  // Filed as two separate value sets in the same row.
  { category: 'ambulance', file: 'pbp_b10_amb_trans.txt',
    copay_col: 'pbp_b10a_copay_gas_amt_min', coins_col: 'pbp_b10a_coins_gas_pct_min' },
  { category: 'air_transportation', file: 'pbp_b10_amb_trans.txt',
    copay_col: 'pbp_b10a_copay_aas_amt_min', coins_col: 'pbp_b10a_coins_aas_pct_min' },
  { category: 'chiropractic', file: 'pbp_b7_health_prof.txt',
    copay_col: 'pbp_b7b_copay_amt_mc_min', coins_col: 'pbp_b7b_coins_pct_mc_min' },
  { category: 'acupuncture', file: 'pbp_b13_other_services.txt',
    copay_col: 'pbp_b13a_copay_amt_min', coins_col: 'pbp_b13a_coins_pct_min',
    max_cov_col: 'pbp_b13a_maxenr_amt' },
  { category: 'podiatry', file: 'pbp_b7_health_prof.txt',
    copay_col: 'pbp_b7f_copay_amt_mc_min', coins_col: 'pbp_b7f_coins_pct_mc_min' },
  { category: 'substance_abuse', file: 'pbp_b7_health_prof.txt',
    copay_col: 'pbp_b7k_copay_amt_mc', coins_col: 'pbp_b7k_coins_pct_mc' },
  // b11 DME: b11a (DME) and b11b (Med Supplies, includes diabetic).
  // Single `_mc_amt` field per subsection — no min/max suffix.
  { category: 'dme_prosthetics', file: 'pbp_b11_dme_prosth_orth_sup.txt',
    copay_col: 'pbp_b11a_copay_mc_amt', coins_col: 'pbp_b11a_coins_pct_mc' },
  { category: 'diabetic_supplies', file: 'pbp_b11_dme_prosth_orth_sup.txt',
    copay_col: 'pbp_b11b_copay_mcmin_amt', coins_col: 'pbp_b11b_coins_pct_mc' },
  // b15 Part B drugs: general (mrx_b_copay_min_amt) covers all Part B
  // infused/injectable drugs. chemo cols are the chemo-specific subset
  // — too narrow for our partb_drugs category. Insulin (IRA cap) lives
  // in mrx_b_ira_copay_month_amt as a monthly capped amount.
  { category: 'partb_drugs', file: 'pbp_b15_partb_rx_drugs.txt',
    copay_col: 'mrx_b_copay_min_amt', coins_col: 'mrx_b_coins_min_pct' },
  { category: 'insulin', file: 'pbp_b15_partb_rx_drugs.txt',
    copay_col: 'mrx_b_ira_copay_month_amt', coins_col: 'mrx_b_ira_coins_min_pct' },
  // b6 home_health uses `_copay_mc_amt_min` (note: _mc_ between copay
  // and amt, not at the end). b12 renal uses single `_mc_amt`.
  { category: 'home_health', file: 'pbp_b6_home_health.txt',
    copay_col: 'pbp_b6_copay_mc_amt_min', coins_col: 'pbp_b6_coins_pct_mc_min' },
  { category: 'renal_dialysis', file: 'pbp_b12_renal_dialysis.txt',
    copay_col: 'pbp_b12_copay_mc_amt', coins_col: 'pbp_b12_coins_pct_mc' },
];

// Extras — supplemental benefits. dental/vision/hearing have an annual
// MAX coverage that's just as important as the per-visit copay.
const EXTRAS_CATEGORIES: CatCfg[] = [
  // dental: comprehensive PBP files per-procedure copays (b16c_*_rs/
  // _end/_peri for restorative/endo/perio) which don't 1:1 our schema.
  // Compare only the annual max coverage — what the agent UI surfaces.
  { category: 'dental', file: 'pbp_b16_dental.txt',
    max_cov_col: 'pbp_b16c_maxplan_cmp_amt' },
  { category: 'vision', file: 'pbp_b17_eye_exams_wear.txt',
    copay_col: 'pbp_b17a_copay_amt_mc_min', coins_col: 'pbp_b17a_coins_pct_mc_min',
    max_cov_col: 'pbp_b17b_comb_maxplan_amt' },
  { category: 'hearing', file: 'pbp_b18_hearing_exams_aids.txt',
    copay_col: 'pbp_b18a_copay_amt', coins_col: 'pbp_b18a_med_coins_pct',
    max_cov_col: 'pbp_b18b_maxplan_amt' },
  { category: 'otc', file: 'pbp_b13_other_services.txt',
    copay_col: 'pbp_b13b_copay_amt_min', coins_col: 'pbp_b13b_coins_pct_min',
    max_cov_col: 'pbp_b13b_maxplan_amt' },
  { category: 'food_card', file: 'pbp_b13_other_services.txt',
    max_cov_col: 'pbp_b13c_maxenr_amt' },
];

const ALL_CATEGORIES = [...MEDICAL_CATEGORIES, ...EXTRAS_CATEGORIES];

// Rx tiers — special-case multi-row file. Per spec sign-off, prefer
// retail-preferred 30-day, fall back to retail-standard 30-day.
const RX_TIERS = [1, 2, 3, 4, 5] as const;

// ── Type defs ────────────────────────────────────────────────────────
interface CmsValue {
  copay: number | null;
  coinsurance: number | null;  // 0-100 (percent)
  max_coverage: number | null;
}
interface DbValue {
  copay: number | null;
  coinsurance: number | null;  // pm_plan_benefits is percent 0-100
  max_coverage: number | null;
  source: 'pm_plan_benefits' | 'pbp_benefits' | 'both' | 'none';
}

interface PmBenefitRow {
  contract_id: string;
  plan_id: string;
  segment_id: string | null;
  benefit_category: string;
  copay: number | null;
  coinsurance: number | null;
  coverage_amount: number | null;
  max_coverage: number | null;
}
interface PbpBenefitRow {
  plan_id: string;            // 2-part or 3-part
  benefit_type: string;
  copay: number | null;
  copay_max: number | null;
  coinsurance: number | null;
  source: string | null;
  tier_id: string | null;
}
interface LandscapeMin {
  triple: string;
  carrier: string;
  plan_name: string;
  state: string;
}

// pbp_benefits.benefit_type → category. Mirrors the audit script's map.
const PBP_TYPE_TO_CATEGORY: Record<string, string> = {
  primary_care_visit: 'primary_care', inpatient_hospital: 'inpatient',
  inpatient_psych: 'mental_health_inpatient', emergency_room: 'emergency',
  urgent_care: 'urgent_care', specialist_visit: 'specialist',
  lab_diagnostic: 'lab', outpatient_surgery: 'outpatient_surgery',
  outpatient_surgery_asc: 'asc', outpatient_observation: 'outpatient_observation',
  ambulance: 'ambulance', mental_health_individual: 'mental_health_outpatient_individual',
  mental_health_group: 'mental_health_outpatient_group',
  physical_therapy: 'physical_speech_therapy', occupational_therapy: 'occupational_therapy',
  chiropractic: 'chiropractic', podiatry: 'podiatry', telehealth: 'telehealth',
  dental_comprehensive: 'dental', dental_annual_max: 'dental',
  vision_exam: 'vision', vision_allowance: 'vision',
  hearing_exam: 'hearing', hearing_aid_allowance: 'hearing',
  otc_allowance: 'otc', food_card: 'food_card', fitness: 'fitness',
};

// ── Phase 1: figure out NC/TX/GA triples (re-uses landscape) ────────
async function loadAllowedTriples(): Promise<{
  triples: Set<string>;
  landscape: Map<string, LandscapeMin>;
}> {
  console.log(`\n→ loading landscape (just triples + carrier/state)`);
  const triples = new Set<string>();
  const landscape = new Map<string, LandscapeMin>();
  const path = '_tmp/cms-sync/landscape/CY2026_Landscape_202603/CY2026_Landscape_202603.csv';
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let header: string[] = [];
  let n = 0;
  for await (const line of rl) {
    if (n === 0) {
      // Strip BOM from first column.
      header = parseCsvLine(line).map((c) => c.replace(/^﻿/, '').trim());
      n += 1;
      continue;
    }
    if (!line) { n += 1; continue; }
    const cells = parseCsvLine(line);
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i += 1) row[header[i]] = cells[i] ?? '';
    const st = row['State Territory Abbreviation'];
    if (!(STATES as readonly string[]).includes(st)) continue;
    const triple = tripleKey(row['Contract ID'], row['Plan ID'], row['Segment ID']);
    triples.add(triple);
    if (!landscape.has(triple)) {
      landscape.set(triple, {
        triple,
        carrier: row['Organization Marketing Name'] || row['Parent Organization Name'],
        plan_name: row['Plan Name'],
        state: st,
      });
    }
    n += 1;
  }
  console.log(`  allowed triples: ${triples.size}`);
  return { triples, landscape };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === ',') { out.push(cur); cur = ''; }
    else if (ch === '"') inQ = true;
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// ── Phase 2: extract CMS values per category ────────────────────────
async function loadCmsBenefits(
  allowedTriples: Set<string>,
): Promise<Map<string, Map<string, CmsValue>>> {
  // Group categories by file so we only read each PBP file once.
  const byFile = new Map<string, CatCfg[]>();
  for (const cfg of ALL_CATEGORIES) {
    const list = byFile.get(cfg.file) ?? [];
    list.push(cfg);
    byFile.set(cfg.file, list);
  }

  // Outer Map: triple → inner Map: category → value
  const out = new Map<string, Map<string, CmsValue>>();
  for (const triple of allowedTriples) out.set(triple, new Map());

  for (const [file, cfgs] of byFile) {
    console.log(`  parsing ${file} for ${cfgs.length} categor${cfgs.length === 1 ? 'y' : 'ies'}`);
    const tmp = new Map<string, true>();
    await readPbpFiltered<true>(`${PBP_DIR}/${file}`, allowedTriples, (row, triple) => {
      const inner = out.get(triple)!;
      for (const cfg of cfgs) {
        const copay =
          (cfg.copay_col ? toNum(row[cfg.copay_col]) : null) ??
          (cfg.copay_fallback ? toNum(row[cfg.copay_fallback]) : null);
        const coins =
          (cfg.coins_col ? toNum(row[cfg.coins_col]) : null) ??
          (cfg.coins_fallback ? toNum(row[cfg.coins_fallback]) : null);
        const maxCov = cfg.max_cov_col ? toNum(row[cfg.max_cov_col]) : null;
        if (copay == null && coins == null && maxCov == null) continue;
        inner.set(cfg.category, { copay, coinsurance: coins, max_coverage: maxCov });
      }
      return true;
    }, tmp);
  }
  return out;
}

// ── Phase 3: extract CMS rx tier values ─────────────────────────────
interface RxTierCmsRow {
  triple: string;
  tier_id: number;
  rspfd_copay_1m: number | null;
  rstd_copay_1m: number | null;
  rspfd_coins_1m: number | null;
  rstd_coins_1m: number | null;
}
async function loadCmsRxTiers(
  allowedTriples: Set<string>,
): Promise<Map<string, Map<number, CmsValue>>> {
  console.log(`  parsing pbp_mrx_tier.txt (multi-row per plan)`);
  const out = new Map<string, Map<number, CmsValue>>();
  const rl = createInterface({
    input: createReadStream(`${PBP_DIR}/pbp_mrx_tier.txt`),
    crlfDelay: Infinity,
  });
  let header: string[] = [];
  let n = 0;
  for await (const line of rl) {
    if (n === 0) {
      header = line.split('\t').map((c) => c.trim().toLowerCase());
      n += 1; continue;
    }
    if (!line) { n += 1; continue; }
    const cells = line.split('\t');
    const c = cells[header.indexOf('pbp_a_hnumber')] ?? '';
    const p = cells[header.indexOf('pbp_a_plan_identifier')] ?? '';
    const s = cells[header.indexOf('segment_id')] ?? '';
    const triple = tripleKey(c, p, s);
    if (!allowedTriples.has(triple)) { n += 1; continue; }
    const tierId = Number(cells[header.indexOf('mrx_tier_id')]);
    if (![1, 2, 3, 4, 5].includes(tierId)) { n += 1; continue; }
    // Prefer retail-preferred 30-day, fall back to retail-standard.
    // Per the spec sign-off this matches Plan Finder's headline display.
    const rspfdCopay = toNum(cells[header.indexOf('mrx_tier_rspfd_copay_1m')]);
    const rstdCopay = toNum(cells[header.indexOf('mrx_tier_rstd_copay_1m')]);
    const rspfdCoins = toNum(cells[header.indexOf('mrx_tier_rspfd_coins_1m')]);
    const rstdCoins = toNum(cells[header.indexOf('mrx_tier_rstd_coins_1m')]);
    const copay = rspfdCopay ?? rstdCopay;
    const coins = rspfdCoins ?? rstdCoins;
    if (copay == null && coins == null) { n += 1; continue; }
    const inner = out.get(triple) ?? new Map<number, CmsValue>();
    inner.set(tierId, { copay, coinsurance: coins, max_coverage: null });
    out.set(triple, inner);
    n += 1;
  }
  return out;
}

// ── Phase 4: extract DB values ──────────────────────────────────────
async function loadDbBenefits(
  pmTriples: Set<string>,
): Promise<Map<string, Map<string, DbValue>>> {
  console.log(`\n→ loading pm_plan_benefits + pbp_benefits`);
  // Build contract + plan lists for IN() filter so we don't scan the
  // full table. Triples are already pre-filtered to NC/TX/GA.
  const contracts = [...new Set([...pmTriples].map((t) => t.split('-')[0]))];
  const planIds = [...new Set([...pmTriples].map((t) => t.split('-')[1]))];

  const pmRows = await paginate<PmBenefitRow>((f, t) =>
    sb.from('pm_plan_benefits')
      .select('contract_id, plan_id, segment_id, benefit_category, copay, coinsurance, coverage_amount, max_coverage')
      .in('contract_id', contracts).in('plan_id', planIds)
      .order('id', { ascending: true }).range(f, t),
  );
  console.log(`  pm_plan_benefits rows: ${pmRows.length}`);

  // pbp_benefits.plan_id is 2-part ('H1234-456'). Build the variants
  // that match our triples (same logic as api/plans.ts).
  const pbpKeyVariants = new Set<string>();
  for (const t of pmTriples) {
    pbpKeyVariants.add(t);
    const parts = t.split('-');
    pbpKeyVariants.add(`${parts[0]}-${parts[1]}`);
    if (parts.length >= 3) {
      const seg1 = parts[2].replace(/^0+/, '') || '0';
      pbpKeyVariants.add(`${parts[0]}-${parts[1]}-${seg1}`);
    }
  }
  // PostgREST hits a URL-length limit (~8KB) at ~2300 keys. Chunk the
  // IN() filter to keep each request under the cap.
  const pbpRows: PbpBenefitRow[] = [];
  const keysList = [...pbpKeyVariants];
  const CHUNK = 400;
  for (let start = 0; start < keysList.length; start += CHUNK) {
    const slice = keysList.slice(start, start + CHUNK);
    const chunk = await paginate<PbpBenefitRow>((f, t) =>
      sb.from('pbp_benefits')
        .select('plan_id, benefit_type, copay, copay_max, coinsurance, source, tier_id')
        .in('plan_id', slice)
        .in('source', ['medicare_gov', 'sb_ocr', 'cms_pbp', 'manual', 'pbp_federal'])
        .order('plan_id', { ascending: true }).range(f, t),
    );
    pbpRows.push(...chunk);
  }
  console.log(`  pbp_benefits rows: ${pbpRows.length}`);

  const out = new Map<string, Map<string, DbValue>>();
  for (const t of pmTriples) out.set(t, new Map());

  // Index pm_plan_benefits.
  for (const r of pmRows) {
    const triple = tripleKey(r.contract_id, r.plan_id, r.segment_id);
    if (!pmTriples.has(triple)) continue;
    const inner = out.get(triple)!;
    const category = r.benefit_category;
    // For rx_tier_1..5 normalize to a "rx_tier_N" key.
    const prior = inner.get(category);
    const val: DbValue = {
      copay: prior?.copay ?? r.copay,
      coinsurance: prior?.coinsurance ?? r.coinsurance,
      max_coverage: prior?.max_coverage ?? r.max_coverage ?? r.coverage_amount,
      source: prior ? 'both' : 'pm_plan_benefits',
    };
    inner.set(category, val);
  }

  // Layer pbp_benefits as fallback (matches /api/plans merge).
  function normPbpKey(planId: string): string {
    const parts = planId.split('-');
    return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : planId;
  }
  // For allowance categories (OTC / food_card / dental_annual_max),
  // pbp_benefits.copay is NOT a per-visit copay — it's the dollar
  // allowance value as filed by the source (description carries the
  // period). Pulling it into DbValue.copay made the diff incorrectly
  // flag those as "DB copay > 0 vs CMS = $0" mismatches. Skip the
  // fallback for these categories — pm_plan_benefits's normalized
  // coverage_amount + max_coverage are the right truth.
  const ALLOWANCE_FALLBACK_BLOCKED = new Set(['otc', 'food_card']);
  for (const r of pbpRows) {
    const cat = PBP_TYPE_TO_CATEGORY[r.benefit_type];
    if (!cat) continue;
    const canonical = normPbpKey(r.plan_id);
    // Match to any of our triples that share this 2-part key.
    for (const t of pmTriples) {
      const parts = t.split('-');
      if (`${parts[0]}-${parts[1]}` !== canonical) continue;
      const inner = out.get(t)!;
      const existing = inner.get(cat);
      if (existing && existing.copay != null) continue; // pm wins
      // pbp_benefits.coinsurance is already in percent (0-100) for both
      // cms_pbp and medicare_gov sources — verified empirically against
      // production data 2026-06-26. The earlier × 100 assumption was a
      // mis-port of the pm_formulary_v2 fraction convention.
      const copayFallback = ALLOWANCE_FALLBACK_BLOCKED.has(cat) ? null : r.copay;
      inner.set(cat, {
        copay: existing?.copay ?? copayFallback,
        coinsurance: existing?.coinsurance ?? r.coinsurance,
        max_coverage: existing?.max_coverage ?? r.copay_max,
        source: existing ? 'both' : 'pbp_benefits',
      });
    }
  }

  return out;
}

// ── Phase 5: comparison ─────────────────────────────────────────────
type Verdict = 'MATCH' | 'MISMATCH' | 'MISSING_FROM_DB' | 'MISSING_FROM_CMS' | 'BOTH_NULL';
interface FieldDiff {
  field: 'copay' | 'coinsurance' | 'max_coverage';
  verdict: Verdict;
  cms: number | null;
  db: number | null;
}
interface CategoryDiff {
  category: string;
  fields: FieldDiff[];
  any_mismatch: boolean;
}
interface PlanBenefitDiff {
  triple: string;
  carrier: string;
  plan_name: string;
  state: string;
  categories: CategoryDiff[];
  mismatch_count: number;
}

function compare(
  cmsByCat: Map<string, CmsValue>,
  dbByCat: Map<string, DbValue>,
  cmsRx: Map<number, CmsValue> | undefined,
  dbAll: Map<string, DbValue>,
): CategoryDiff[] {
  const out: CategoryDiff[] = [];
  for (const cfg of ALL_CATEGORIES) {
    const cms = cmsByCat.get(cfg.category);
    const dbKey = cfg.pbp_alias ?? cfg.category;
    const db = dbByCat.get(dbKey);
    const fields = diffFields(cms, db, !!cfg.max_cov_col);
    if (fields.length === 0) continue;
    out.push({
      category: cfg.category,
      fields,
      any_mismatch: fields.some((f) => f.verdict === 'MISMATCH' || f.verdict === 'MISSING_FROM_DB'),
    });
  }
  // Rx tiers — pull from cmsRx, compare against db rx_tier_N keys.
  for (const tier of RX_TIERS) {
    const cms = cmsRx?.get(tier);
    const db = dbAll.get(`rx_tier_${tier}`);
    const fields = diffFields(cms, db, false);
    if (fields.length === 0) continue;
    out.push({
      category: `rx_tier_${tier}`,
      fields,
      any_mismatch: fields.some((f) => f.verdict === 'MISMATCH' || f.verdict === 'MISSING_FROM_DB'),
    });
  }
  return out;
}

function diffFields(
  cms: CmsValue | undefined,
  db: DbValue | undefined,
  includeMaxCov: boolean,
): FieldDiff[] {
  const out: FieldDiff[] = [];
  const fields: Array<'copay' | 'coinsurance' | 'max_coverage'> = ['copay', 'coinsurance'];
  if (includeMaxCov) fields.push('max_coverage');
  for (const field of fields) {
    const c = cms?.[field] ?? null;
    const d = db?.[field] ?? null;
    if (c == null && d == null) continue; // BOTH_NULL — don't pollute output
    let verdict: Verdict;
    if (c == null) verdict = 'MISSING_FROM_CMS';
    else if (d == null) verdict = 'MISSING_FROM_DB';
    else {
      const tol = field === 'copay' ? 2 : field === 'max_coverage' ? 50 : 0;
      verdict = Math.abs(c - d) <= tol ? 'MATCH' : 'MISMATCH';
    }
    out.push({ field, verdict, cms: c, db: d });
  }
  return out;
}

// ── Phase 6: SQL generation ─────────────────────────────────────────
function sqlEsc(v: unknown): string {
  if (v == null || v === '') return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  const s = String(v).replace(/'/g, "''");
  return `'${s}'`;
}

function generateSql(
  diffs: PlanBenefitDiff[],
): { sql: string; updateCount: number; insertCount: number } {
  const lines: string[] = [
    '-- proposed-cms-benefit-sync-2026.sql',
    `-- Generated by scripts/cms-benefit-sync-2026.ts on ${new Date().toISOString()}`,
    '-- DO NOT EXECUTE BLINDLY. Each statement is annotated with the CMS',
    '-- column the value was sourced from so you can spot-check any row.',
    '--',
    '-- Tolerances applied: copay ±$2, coinsurance ±0%, max_coverage ±$50.',
    '-- Statements only emitted when CMS has a value AND DB diverges.',
    '',
    'BEGIN;',
    '',
  ];
  let updateCount = 0;
  let insertCount = 0;

  for (const pd of diffs) {
    const actionable = pd.categories.filter((c) => c.any_mismatch);
    if (actionable.length === 0) continue;
    lines.push(`-- ──── ${pd.triple}  ${pd.carrier} — ${pd.plan_name} (${pd.state})`);
    const [c, p, s] = pd.triple.split('-');
    for (const cat of actionable) {
      const dbCat = lookupDbCategory(cat.category);
      const mismatches = cat.fields.filter(
        (f) => f.verdict === 'MISMATCH' || f.verdict === 'MISSING_FROM_DB',
      );
      if (mismatches.length === 0) continue;
      const setClauses = mismatches.map((f) => {
        const col =
          f.field === 'copay' ? 'copay' :
          f.field === 'coinsurance' ? 'coinsurance' :
          'max_coverage';
        return `${col} = ${sqlEsc(f.cms)}`;
      }).join(', ');
      for (const f of mismatches) {
        lines.push(`--   ${cat.category}.${f.field}: CMS=${JSON.stringify(f.cms)} DB=${JSON.stringify(f.db)}`);
      }
      // UPDATE first; if no row exists, the CTE-style "INSERT ON CONFLICT
      // DO UPDATE" pattern below covers the MISSING_FROM_DB case. We
      // emit both forms so a manual reviewer can pick the right one.
      lines.push(
        `INSERT INTO pm_plan_benefits (contract_id, plan_id, segment_id, benefit_category, ${mismatches.map((f) => f.field === 'copay' ? 'copay' : f.field === 'coinsurance' ? 'coinsurance' : 'max_coverage').join(', ')})` +
          ` VALUES (${sqlEsc(c)}, ${sqlEsc(p)}, ${sqlEsc(s)}, ${sqlEsc(dbCat)}, ${mismatches.map((f) => sqlEsc(f.cms)).join(', ')})` +
          ` ON CONFLICT (contract_id, plan_id, segment_id, benefit_category)` +
          ` DO UPDATE SET ${setClauses};`,
      );
      updateCount += 1;
      if (mismatches.some((f) => f.verdict === 'MISSING_FROM_DB')) insertCount += 1;
    }
    lines.push('');
  }

  lines.push('-- COMMIT;  -- uncomment when ready');
  lines.push('-- ROLLBACK;');
  lines.push('');
  lines.push(`-- Summary: ${updateCount} category-level fix statements, ${insertCount} insert-or-update for missing rows.`);
  return { sql: lines.join('\n'), updateCount, insertCount };
}

// pm_plan_benefits.benefit_category names — see api/plans.ts
// CATEGORY_ALIAS. The DB stores some categories under different names
// than the plan field (lab vs lab_services, asc vs outpatient_surgery_asc).
function lookupDbCategory(plan_field: string): string {
  const cfg = ALL_CATEGORIES.find((c) => c.category === plan_field);
  if (cfg?.pbp_alias) return cfg.pbp_alias;
  if (plan_field.startsWith('rx_tier_')) return plan_field;
  return plan_field;
}

// ── Phase 7: summary report ─────────────────────────────────────────
function buildSummary(
  diffs: PlanBenefitDiff[],
  sqlMeta: { updateCount: number; insertCount: number },
): string {
  const lines: string[] = [];
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('  CMS CY2026 BENEFIT SYNC — per-category value validation');
  lines.push('  Generated: ' + new Date().toISOString());
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('');

  const allCatTotals = new Map<string, { match: number; mismatch: number; miss_db: number; miss_cms: number }>();
  let comparisonsTotal = 0;
  let mismatchesTotal = 0;
  let matchesTotal = 0;
  const byCarrier = new Map<string, { plans: number; mismatches: number; comparisons: number }>();
  for (const pd of diffs) {
    const car = pd.carrier;
    const carRec = byCarrier.get(car) ?? { plans: 0, mismatches: 0, comparisons: 0 };
    carRec.plans += 1;
    for (const cat of pd.categories) {
      const t = allCatTotals.get(cat.category) ?? { match: 0, mismatch: 0, miss_db: 0, miss_cms: 0 };
      for (const f of cat.fields) {
        comparisonsTotal += 1;
        carRec.comparisons += 1;
        if (f.verdict === 'MATCH') { t.match += 1; matchesTotal += 1; }
        else if (f.verdict === 'MISMATCH') { t.mismatch += 1; mismatchesTotal += 1; carRec.mismatches += 1; }
        else if (f.verdict === 'MISSING_FROM_DB') { t.miss_db += 1; }
        else if (f.verdict === 'MISSING_FROM_CMS') { t.miss_cms += 1; }
      }
      allCatTotals.set(cat.category, t);
    }
    byCarrier.set(car, carRec);
  }

  const matchRate = comparisonsTotal > 0
    ? (matchesTotal / (matchesTotal + mismatchesTotal)) * 100
    : 0;

  lines.push('── Overall ─────────────────────────────────────────────────');
  lines.push(`  plans diffed       : ${diffs.length}`);
  lines.push(`  total comparisons  : ${comparisonsTotal}`);
  lines.push(`  MATCH              : ${matchesTotal}`);
  lines.push(`  MISMATCH           : ${mismatchesTotal}`);
  lines.push(`  match rate         : ${matchRate.toFixed(1)}%`);
  lines.push('');

  lines.push('── Per-category match rate (sorted worst first) ───────────');
  lines.push('  category                         match  miss   miss   miss  matchRate');
  lines.push('                                          mtch   DB     CMS   ');
  const catRows = [...allCatTotals.entries()].map(([cat, t]) => {
    const total = t.match + t.mismatch;
    const rate = total > 0 ? (t.match / total) * 100 : NaN;
    return { cat, t, rate, total };
  }).sort((a, b) => {
    // Sort with NaN at the bottom (categories with no comparable data).
    if (Number.isNaN(a.rate) && Number.isNaN(b.rate)) return 0;
    if (Number.isNaN(a.rate)) return 1;
    if (Number.isNaN(b.rate)) return -1;
    return a.rate - b.rate;
  });
  for (const { cat, t, rate } of catRows) {
    const rateStr = Number.isNaN(rate) ? '   —  ' : `${rate.toFixed(1)}%`.padStart(7);
    lines.push(
      `  ${cat.padEnd(32)}  ${String(t.match).padStart(5)}  ${String(t.mismatch).padStart(5)}  ${String(t.miss_db).padStart(5)}  ${String(t.miss_cms).padStart(5)}  ${rateStr}`,
    );
  }
  lines.push('');

  lines.push('── Per-carrier match rate (top 15 by plan count) ──────────');
  const carrierRows = [...byCarrier.entries()].sort((a, b) => b[1].plans - a[1].plans).slice(0, 15);
  for (const [car, rec] of carrierRows) {
    const matches = rec.comparisons - rec.mismatches; // approx (excludes miss_*)
    const rate = matches > 0 ? (matches / rec.comparisons) * 100 : 0;
    lines.push(`  ${car.slice(0, 38).padEnd(38)}  n=${String(rec.plans).padStart(3)}  ` +
      `mismatches=${String(rec.mismatches).padStart(4)}  rate~${rate.toFixed(1)}%`);
  }
  lines.push('');

  lines.push('── Worst 20 plans by mismatch count ────────────────────────');
  const worst = [...diffs].sort((a, b) => b.mismatch_count - a.mismatch_count).slice(0, 20);
  for (const pd of worst) {
    if (pd.mismatch_count === 0) break;
    const cats = pd.categories.filter((c) => c.any_mismatch).map((c) => c.category);
    lines.push(
      `  ${pd.triple.padEnd(14)}  ${String(pd.mismatch_count).padStart(2)} mismatches  ` +
        `${pd.carrier.slice(0, 24).padEnd(24)}  [${cats.slice(0, 5).join(', ')}${cats.length > 5 ? '…' : ''}]`,
    );
  }
  lines.push('');

  lines.push('── Coverage ────────────────────────────────────────────────');
  const reachable = ALL_CATEGORIES.length + RX_TIERS.length; // 36 + 5 = 41
  lines.push(`  categories with PBP mapping       : ${reachable}`);
  lines.push(`  categories actually compared      : ${allCatTotals.size}`);
  lines.push(`  skipped (per discovery sign-off)  : 4  ` +
    '(transportation, fitness, diabetic-brand, medical-deductible)');
  lines.push('');

  lines.push('── Artifacts ───────────────────────────────────────────────');
  lines.push(`  SQL fix file : ${SQL_PATH}`);
  lines.push(`  summary      : ${SUMMARY_PATH}`);
  lines.push(`  diff JSON    : ${OUT_DIR}/benefit-diff.json`);
  lines.push(`  ${sqlMeta.updateCount} categories with fix statements`);
  lines.push(`  ${sqlMeta.insertCount} of those include INSERT (row was missing entirely)`);

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  const { triples, landscape } = await loadAllowedTriples();
  console.log(`\n→ extracting CMS benefit values`);
  const cmsBenefits = await loadCmsBenefits(triples);
  const cmsRx = await loadCmsRxTiers(triples);
  const dbBenefits = await loadDbBenefits(triples);

  console.log(`\n→ comparing`);
  const diffs: PlanBenefitDiff[] = [];
  for (const triple of triples) {
    const cmsByCat = cmsBenefits.get(triple) ?? new Map<string, CmsValue>();
    const dbByCat = dbBenefits.get(triple) ?? new Map<string, DbValue>();
    const cmsRxMap = cmsRx.get(triple);
    const cats = compare(cmsByCat, dbByCat, cmsRxMap, dbByCat);
    const mismatchCount = cats.reduce(
      (s, c) => s + c.fields.filter((f) => f.verdict === 'MISMATCH').length,
      0,
    );
    const lp = landscape.get(triple);
    diffs.push({
      triple,
      carrier: lp?.carrier ?? '—',
      plan_name: lp?.plan_name ?? '—',
      state: lp?.state ?? '—',
      categories: cats,
      mismatch_count: mismatchCount,
    });
  }

  console.log(`→ writing artifacts`);
  writeFileSync(`${OUT_DIR}/benefit-diff.json`, JSON.stringify(diffs, null, 2));
  const { sql, updateCount, insertCount } = generateSql(diffs);
  writeFileSync(SQL_PATH, sql);
  const summary = buildSummary(diffs, { updateCount, insertCount });
  writeFileSync(SUMMARY_PATH, summary);
  console.log(`\n${summary}`);
  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
