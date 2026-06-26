// scripts/cms-sync-2026.ts
//
// Ground-truth validation of every NC/TX/GA Medicare plan in pm_plans
// against the official CMS CY2026 datasets:
//
//   • CY2026 Landscape  (premium / plan_name / organization / Plan
//                        Type / SNP type / overall star rating / MOOP
//                        / drug deductible / Part D total premium)
//   • CY2026 PBP Benefits — Section C (MOOP + medical deductible),
//                            Section D (Part D structure)
//
// Reads source files from ./_tmp/cms-sync/{landscape,pbp}/ and writes:
//
//   _tmp/cms-sync/out/step2-reconciliation.json
//   _tmp/cms-sync/out/step3-fielddiff.json
//   _tmp/cms-sync/out/step5-summary.txt
//   migrations/proposed-cms-sync-2026.sql
//
// READ-ONLY against Supabase. Generated SQL is NOT executed — Rob
// reviews the .sql file and runs it manually.
//
// Plan key is (contract_id, plan_id, segment_id) where segment_id is
// zero-padded to 3 chars to match pm_plans.id.

import { createClient, type PostgrestSingleResponse } from '@supabase/supabase-js';
import { readFileSync, existsSync, writeFileSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// ── Env loading ──────────────────────────────────────────────────────
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
const STATE_SET = new Set<string>(STATES);
const LANDSCAPE_CSV =
  '_tmp/cms-sync/landscape/CY2026_Landscape_202603/CY2026_Landscape_202603.csv';
const PBP_DIR = '_tmp/cms-sync/pbp';
const OUT_DIR = '_tmp/cms-sync/out';
const SQL_PATH = 'migrations/proposed-cms-sync-2026.sql';

// ── Types ────────────────────────────────────────────────────────────
type State = (typeof STATES)[number];

interface LandscapePlan {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  triple: string;
  states: Set<string>;
  counties: Map<string, Set<string>>; // state → counties
  parent_organization: string;
  organization_marketing_name: string;
  contract_name: string;
  plan_name: string;
  plan_type: string;
  snp_indicator: string;
  snp_type: string;
  part_d_coverage: string;
  drug_deductible: number | null;
  partc_premium: number | null;
  partd_total_premium: number | null;
  monthly_consolidated_premium: number | null;
  moop: number | null;
  overall_star_rating: number | null;
  partc_star_rating: number | null;
  partd_star_rating: number | null;
  sanctioned: boolean;
}

interface PmPlanRow {
  contract_id: string;
  plan_id: string;
  segment_id: string | null;
  plan_name: string | null;
  carrier: string | null;
  parent_organization: string | null;
  plan_type: string | null;
  state: string;
  county_name: string;
  monthly_premium: number | null;
  annual_deductible: number | null;
  moop: number | null;
  drug_deductible: number | null;
  star_rating: number | null;
  snp: boolean;
  snp_type: string | null;
  sanctioned: boolean;
}

interface PmPlanDistinct {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  triple: string;
  states: Set<string>;
  head: PmPlanRow;
}

interface SectionCRow {
  triple: string;
  ded_amt: number | null;
  maxenr_amt: number | null; // in-network MOOP
}

interface SectionDRow {
  triple: string;
  ann_deduct_yn: string;
  ann_deduct_amt: number | null;
}

type Verdict = 'MATCH' | 'MISMATCH' | 'MISSING_FROM_DB' | 'MISSING_FROM_CMS' | 'BOTH_NULL';

interface FieldDiff {
  field: string;
  verdict: Verdict;
  cms: unknown;
  db: unknown;
}

interface PlanDiff {
  triple: string;
  states: string[];
  cms_carrier: string;
  cms_plan_name: string;
  cms_plan_type: string;
  in_cms: boolean;
  in_db: boolean;
  fields: FieldDiff[];
  mismatch_count: number;
}

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
  if (s === '' || /^(\.|N\/A|NA|—|-|null)$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Money comparison with $1 tolerance — CMS landscape rounds Part C
// premium to whole dollars while pm_plans.monthly_premium ingests
// decimal cents from the same source. $1 covers rounding without
// hiding real diffs.
function moneyEq(a: number | null, b: number | null, tol = 1): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= tol;
}
function starEq(a: number | null, b: number | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < 0.25; // half-star bucketing
}
function strEq(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

// Carrier comparison — pm_plans.carrier is the Organization Marketing
// Name (often shortened, e.g. "UnitedHealthcare" vs Landscape
// "UnitedHealthcare Insurance Company"). We accept a substring/
// containment match in either direction so common shorthand survives.
function carrierEq(db: string | null | undefined, cms: string | null | undefined): boolean {
  const d = (db ?? '').trim().toLowerCase();
  const c = (cms ?? '').trim().toLowerCase();
  if (!d && !c) return true;
  if (!d || !c) return false;
  if (d === c) return true;
  return d.includes(c) || c.includes(d);
}

// pm_plans.plan_type stores the landscape's raw "Plan Type" string
// verbatim (e.g. "HMO", "Local PPO", "HMO-POS", "Regional PPO", "PDP").
// Strict equality is fine here.
function planTypeEq(db: string | null | undefined, cms: string | null | undefined): boolean {
  return strEq(db, cms);
}

// SNP type normalization — CMS landscape uses full names while
// pm_plans stores the short codes. Empirically derived from the
// landscape file:
//   "Dual-Eligible"                       → D-SNP   (DB stores "D-SNP")
//   "Chronic or Disabling Condition"      → C-SNP   (DB stores "C-SNP")
//   "Institutional"                       → I-SNP   (DB stores "I-SNP")
//   "Not Applicable" / "Non-SNP" / blank  → null    (DB stores NULL)
// Returns the normalized DB-shaped value so the diff comparison and
// SQL generation both use the same key.
function normalizeSnpType(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === 'not applicable' || lower === 'non-snp' || lower === 'n/a') return null;
  if (lower.startsWith('dual')) return 'D-SNP';
  if (lower.startsWith('chronic')) return 'C-SNP';
  if (lower.startsWith('institutional')) return 'I-SNP';
  // Already short-code: pass through (handles both DB and the rare
  // landscape row that already uses D-SNP/C-SNP/I-SNP shorthand).
  return s;
}
function snpTypeEq(db: string | null | undefined, cms: string | null | undefined): boolean {
  return (normalizeSnpType(db) ?? '') === (normalizeSnpType(cms) ?? '');
}

// ── CSV reader ──────────────────────────────────────────────────────
// CMS landscape uses standard RFC4180 CSV with quoted fields containing
// commas. The naive `split(',')` would break on Organization names like
// "UnitedHealthcare Insurance Company, Inc." — this parser handles
// quote escaping correctly. ~138K rows / 79MB file streamed line-by-line.
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

async function readCsvStream(
  path: string,
  onRow: (row: Record<string, string>, header: string[]) => void,
): Promise<void> {
  const rl = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  let header: string[] = [];
  let n = 0;
  for await (const line of rl) {
    if (n === 0) {
      header = parseCsvLine(line).map((c) => c.replace(/^﻿/, '').trim());
      n += 1;
      continue;
    }
    if (!line) {
      n += 1;
      continue;
    }
    const cells = parseCsvLine(line);
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i += 1) row[header[i]] = cells[i] ?? '';
    onRow(row, header);
    n += 1;
  }
}

// Tab-delimited PBP files. Headers in row 1, columns named in lowercase
// (matches the .sas definitions). Streaming reader so the 5MB+ files
// don't blow memory.
async function readPbpTxt(
  path: string,
  onRow: (row: Record<string, string>) => void,
): Promise<void> {
  const rl = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  let header: string[] = [];
  let n = 0;
  for await (const line of rl) {
    if (n === 0) {
      header = line.split('\t').map((c) => c.trim().toLowerCase());
      n += 1;
      continue;
    }
    if (!line) {
      n += 1;
      continue;
    }
    const cells = line.split('\t');
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i += 1) row[header[i]] = cells[i] ?? '';
    onRow(row);
    n += 1;
  }
}

// ── Phase 1: Load Landscape ─────────────────────────────────────────
async function loadLandscape(): Promise<Map<string, LandscapePlan>> {
  console.log(`\n→ loading landscape: ${LANDSCAPE_CSV}`);
  const byTriple = new Map<string, LandscapePlan>();
  let totalRows = 0;
  let stateRows = 0;
  await readCsvStream(LANDSCAPE_CSV, (row) => {
    totalRows += 1;
    const st = row['State Territory Abbreviation'];
    if (!STATE_SET.has(st)) return;
    stateRows += 1;
    const c = row['Contract ID'];
    const p = row['Plan ID'];
    const s = padSegment(row['Segment ID']);
    if (!c || !p) return;
    const triple = `${c}-${p}-${s}`;
    let hit = byTriple.get(triple);
    if (!hit) {
      hit = {
        contract_id: c,
        plan_id: p,
        segment_id: s,
        triple,
        states: new Set(),
        counties: new Map(),
        parent_organization: row['Parent Organization Name'] ?? '',
        organization_marketing_name: row['Organization Marketing Name'] ?? '',
        contract_name: row['Contract Name'] ?? '',
        plan_name: row['Plan Name'] ?? '',
        plan_type: row['Plan Type'] ?? '',
        snp_indicator: row['Special Needs Plan (SNP) Indicator'] ?? '',
        snp_type: row['SNP Type'] ?? '',
        part_d_coverage: row['Part D Coverage Indicator'] ?? '',
        drug_deductible: toNum(row['Annual Part D Deductible Amount']),
        partc_premium: toNum(row['Part C Premium']),
        partd_total_premium: toNum(row['Part D Total Premium']),
        monthly_consolidated_premium: toNum(row['Monthly Consolidated Premium (Part C + D)']),
        moop: toNum(row['In-Network Maximum Out-of-Pocket (MOOP) Amount']),
        overall_star_rating: toNum(row['Overall Star Rating']),
        partc_star_rating: toNum(row['Part C Summary Star Rating']),
        partd_star_rating: toNum(row['Part D Summary Star Rating']),
        sanctioned: (row['Sanctioned Plan'] ?? '').trim().toLowerCase() === 'yes',
      };
      byTriple.set(triple, hit);
    }
    hit.states.add(st);
    const cset = hit.counties.get(st) ?? new Set<string>();
    if (row['County Name']) cset.add(row['County Name']);
    hit.counties.set(st, cset);
  });
  console.log(
    `  landscape rows total=${totalRows.toLocaleString()} ` +
      `state-rows=${stateRows.toLocaleString()} distinct-triples=${byTriple.size}`,
  );
  return byTriple;
}

// ── Phase 2: Load pm_plans ──────────────────────────────────────────
async function paginate<T>(
  fn: (f: number, t: number) => PromiseLike<PostgrestSingleResponse<T[]>>,
  maxPages = 200,
): Promise<T[]> {
  const out: T[] = [];
  for (let n = 0; n < maxPages; n += 1) {
    const { data, error } = await fn(n * 1000, n * 1000 + 999);
    if (error) throw error;
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function loadPmPlans(): Promise<Map<string, PmPlanDistinct>> {
  console.log(`\n→ loading pm_plans for NC/TX/GA`);
  const rows = await paginate<PmPlanRow>((f, t) =>
    sb
      .from('pm_plans')
      .select(
        'contract_id, plan_id, segment_id, plan_name, carrier, parent_organization, plan_type, state, county_name, monthly_premium, annual_deductible, moop, drug_deductible, star_rating, snp, snp_type, sanctioned',
      )
      .in('state', [...STATES])
      .order('contract_id', { ascending: true })
      .range(f, t),
  );
  const byTriple = new Map<string, PmPlanDistinct>();
  for (const r of rows) {
    const triple = tripleKey(r.contract_id, r.plan_id, r.segment_id);
    const hit = byTriple.get(triple);
    if (hit) {
      hit.states.add(r.state);
    } else {
      byTriple.set(triple, {
        contract_id: r.contract_id,
        plan_id: r.plan_id,
        segment_id: padSegment(r.segment_id),
        triple,
        states: new Set([r.state]),
        head: r,
      });
    }
  }
  console.log(`  pm_plans rows=${rows.length} distinct-triples=${byTriple.size}`);
  return byTriple;
}

// ── Phase 3: Load pbp_Section_C (MOOP + medical deductible) ─────────
async function loadSectionC(allowedTriples: Set<string>): Promise<Map<string, SectionCRow>> {
  console.log(`\n→ parsing pbp_Section_C.txt`);
  const out = new Map<string, SectionCRow>();
  await readPbpTxt(`${PBP_DIR}/pbp_Section_C.txt`, (row) => {
    const triple = tripleKey(
      row['pbp_a_hnumber'],
      row['pbp_a_plan_identifier'],
      row['segment_id'],
    );
    if (!allowedTriples.has(triple)) return;
    out.set(triple, {
      triple,
      // PBP_C_DED_AMT — annual medical deductible (in-network)
      ded_amt: toNum(row['pbp_c_ded_amt']),
      // PBP_C_MAXENR_AMT — in-network MOOP. Coded "0" means $0 MOOP
      // (D-SNP plans); blank means not filed.
      maxenr_amt: toNum(row['pbp_c_maxenr_amt']),
    });
  });
  console.log(`  section_c rows scoped to NC/TX/GA: ${out.size}`);
  return out;
}

// ── Phase 4: Load pbp_Section_D (Part D structure) ──────────────────
async function loadSectionD(allowedTriples: Set<string>): Promise<Map<string, SectionDRow>> {
  console.log(`\n→ parsing pbp_Section_D.txt`);
  const out = new Map<string, SectionDRow>();
  await readPbpTxt(`${PBP_DIR}/pbp_Section_D.txt`, (row) => {
    const triple = tripleKey(
      row['pbp_a_hnumber'],
      row['pbp_a_plan_identifier'],
      row['segment_id'],
    );
    if (!allowedTriples.has(triple)) return;
    out.set(triple, {
      triple,
      ann_deduct_yn: row['pbp_d_ann_deduct_yn'] ?? '',
      ann_deduct_amt: toNum(row['pbp_d_ann_deduct_amt']),
    });
  });
  console.log(`  section_d rows scoped to NC/TX/GA: ${out.size}`);
  return out;
}

// ── Step 2: Plan-count reconciliation ───────────────────────────────
interface Step2Report {
  by_state: Record<State, { cms: number; db: number; in_both: number; cms_only: number; db_only: number }>;
  totals: { cms: number; db: number; in_both: number; cms_only: number; db_only: number };
  cms_only_plans: Array<{ triple: string; states: string[]; carrier: string; plan_name: string; plan_type: string }>;
  db_only_plans: Array<{ triple: string; states: string[]; carrier: string; plan_name: string; plan_type: string }>;
}

function runStep2(
  landscape: Map<string, LandscapePlan>,
  pmPlans: Map<string, PmPlanDistinct>,
): Step2Report {
  const cmsTriples = new Set(landscape.keys());
  const dbTriples = new Set(pmPlans.keys());

  const cmsOnly = [...cmsTriples].filter((t) => !dbTriples.has(t));
  const dbOnly = [...dbTriples].filter((t) => !cmsTriples.has(t));
  const inBoth = [...cmsTriples].filter((t) => dbTriples.has(t));

  // Per-state counts using each plan's full state list (a plan can
  // serve multiple states; we count it once per state it serves).
  const byState = {} as Step2Report['by_state'];
  for (const st of STATES) {
    let cms = 0, db = 0, both = 0, cmsOnlyN = 0, dbOnlyN = 0;
    for (const [t, lp] of landscape) {
      if (!lp.states.has(st)) continue;
      cms += 1;
      if (dbTriples.has(t)) both += 1;
      else cmsOnlyN += 1;
    }
    for (const [t, pm] of pmPlans) {
      if (!pm.states.has(st)) continue;
      db += 1;
      if (!cmsTriples.has(t)) dbOnlyN += 1;
    }
    byState[st] = { cms, db, in_both: both, cms_only: cmsOnlyN, db_only: dbOnlyN };
  }

  return {
    by_state: byState,
    totals: {
      cms: cmsTriples.size,
      db: dbTriples.size,
      in_both: inBoth.length,
      cms_only: cmsOnly.length,
      db_only: dbOnly.length,
    },
    cms_only_plans: cmsOnly.slice(0, 5000).map((t) => {
      const lp = landscape.get(t)!;
      return {
        triple: t,
        states: [...lp.states].sort(),
        carrier: lp.organization_marketing_name || lp.parent_organization,
        plan_name: lp.plan_name,
        plan_type: lp.plan_type,
      };
    }),
    db_only_plans: dbOnly.slice(0, 5000).map((t) => {
      const pm = pmPlans.get(t)!;
      return {
        triple: t,
        states: [...pm.states].sort(),
        carrier: pm.head.carrier ?? pm.head.parent_organization ?? '',
        plan_name: pm.head.plan_name ?? '',
        plan_type: pm.head.plan_type ?? '',
      };
    }),
  };
}

// ── Step 3: Field-by-field diff ─────────────────────────────────────
function diffField(
  field: string,
  cms: unknown,
  db: unknown,
  comparator: (a: unknown, b: unknown) => boolean,
): FieldDiff {
  const cmsMissing = cms == null || cms === '';
  const dbMissing = db == null || db === '';
  let verdict: Verdict;
  if (cmsMissing && dbMissing) verdict = 'BOTH_NULL';
  else if (cmsMissing) verdict = 'MISSING_FROM_CMS';
  else if (dbMissing) verdict = 'MISSING_FROM_DB';
  else verdict = comparator(cms, db) ? 'MATCH' : 'MISMATCH';
  return { field, verdict, cms, db };
}

function runStep3(
  landscape: Map<string, LandscapePlan>,
  pmPlans: Map<string, PmPlanDistinct>,
  sectionC: Map<string, SectionCRow>,
  sectionD: Map<string, SectionDRow>,
): PlanDiff[] {
  const out: PlanDiff[] = [];
  const allTriples = new Set([...landscape.keys(), ...pmPlans.keys()]);
  for (const triple of allTriples) {
    const lp = landscape.get(triple);
    const pm = pmPlans.get(triple);
    const sc = sectionC.get(triple);
    const sd = sectionD.get(triple);

    if (!lp && !pm) continue;
    if (!lp || !pm) {
      // Counted in Step 2; skip detail diff here.
      continue;
    }

    // Premium: pm_plans.monthly_premium is the Part C premium for MA
    // plans and the Part D total premium for PDPs. Landscape splits the
    // two — pick whichever applies per plan_type.
    const isPdp = (lp.plan_type ?? '').toUpperCase() === 'PDP';
    const cmsPremium = isPdp ? lp.partd_total_premium : lp.partc_premium;

    // Deductible: pm_plans.annual_deductible is the MEDICAL deductible
    // (not Part D). Landscape doesn't carry the medical deductible —
    // that's in pbp_Section_C.pbp_c_ded_amt.
    const cmsAnnualDed = sc?.ded_amt ?? null;

    // MOOP: prefer landscape's published value (matches Plan Finder).
    // Fall back to pbp_Section_C when landscape is blank.
    const cmsMoop = lp.moop ?? sc?.maxenr_amt ?? null;

    // Drug deductible: landscape's "Annual Part D Deductible Amount"
    // is canonical. pbp_Section_D agrees but lands later in the year.
    const cmsDrugDed = lp.drug_deductible ?? sd?.ann_deduct_amt ?? null;

    const fields: FieldDiff[] = [
      diffField('premium', cmsPremium, pm.head.monthly_premium, (a, b) =>
        moneyEq(a as number, b as number),
      ),
      diffField('moop', cmsMoop, pm.head.moop, (a, b) =>
        moneyEq(a as number, b as number, 5),
      ),
      diffField('annual_deductible', cmsAnnualDed, pm.head.annual_deductible, (a, b) =>
        moneyEq(a as number, b as number, 5),
      ),
      diffField('drug_deductible', cmsDrugDed, pm.head.drug_deductible, (a, b) =>
        moneyEq(a as number, b as number),
      ),
      diffField('star_rating', lp.overall_star_rating, pm.head.star_rating, (a, b) =>
        starEq(a as number, b as number),
      ),
      diffField('plan_type', lp.plan_type, pm.head.plan_type, (a, b) =>
        planTypeEq(a as string, b as string),
      ),
      diffField(
        'carrier',
        lp.organization_marketing_name || lp.parent_organization,
        pm.head.carrier ?? pm.head.parent_organization,
        (a, b) => carrierEq(b as string, a as string),
      ),
      // Pre-normalize SNP values BEFORE the missing-value check so
      // CMS "Not Applicable" / "Non-SNP" → null matches DB null as
      // BOTH_NULL instead of MISSING_FROM_DB.
      diffField(
        'snp_type',
        normalizeSnpType(lp.snp_type),
        normalizeSnpType(pm.head.snp_type),
        (a, b) => snpTypeEq(b as string, a as string),
      ),
    ];

    const mismatchCount = fields.filter((f) => f.verdict === 'MISMATCH').length;

    out.push({
      triple,
      states: [...lp.states].sort(),
      cms_carrier: lp.organization_marketing_name || lp.parent_organization,
      cms_plan_name: lp.plan_name,
      cms_plan_type: lp.plan_type,
      in_cms: true,
      in_db: true,
      fields,
      mismatch_count: mismatchCount,
    });
  }
  return out;
}

// ── Step 4: SQL generation ──────────────────────────────────────────
function sqlEsc(v: unknown): string {
  if (v == null || v === '') return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const s = String(v).replace(/'/g, "''");
  return `'${s}'`;
}

const FIELD_TO_COL: Record<string, string> = {
  premium: 'monthly_premium',
  moop: 'moop',
  annual_deductible: 'annual_deductible',
  drug_deductible: 'drug_deductible',
  star_rating: 'star_rating',
  plan_type: 'plan_type',
  carrier: 'carrier',
  snp_type: 'snp_type',
};

function runStep4(
  diffs: PlanDiff[],
  step2: Step2Report,
  landscape: Map<string, LandscapePlan>,
): string {
  const lines: string[] = [
    '-- proposed-cms-sync-2026.sql',
    '-- Generated by scripts/cms-sync-2026.ts on ' + new Date().toISOString(),
    '-- DO NOT EXECUTE BLINDLY. Review before applying.',
    '--',
    '-- Source of truth: CMS CY2026 Landscape + PBP Section_C/D.',
    '-- This file proposes UPDATE statements for every field where the',
    '-- DB disagrees with CMS, plus INSERT shells for plans missing from',
    '-- pm_plans. Plans MISSING_FROM_CMS are listed as comments — most',
    '-- are stale historical plans we should manually de-list, not auto',
    '-- DELETE (some are non-MA products in our DB that don\'t round-trip',
    '-- through landscape).',
    '',
    '-- ── Section 1: UPDATE mismatches in pm_plans ────────────────',
    '',
    'BEGIN;',
    '',
  ];

  let updateCount = 0;
  for (const d of diffs) {
    const mismatches = d.fields.filter(
      (f) => f.verdict === 'MISMATCH' || f.verdict === 'MISSING_FROM_DB',
    );
    if (mismatches.length === 0) continue;
    const sets = mismatches
      .map((f) => `${FIELD_TO_COL[f.field]} = ${sqlEsc(f.cms)}`)
      .join(', ');
    const [c, p, s] = d.triple.split('-');
    lines.push(
      `-- ${d.triple}  ${d.cms_carrier}  ${d.cms_plan_name}`,
    );
    for (const f of mismatches) {
      lines.push(
        `--   ${f.field}: CMS=${JSON.stringify(f.cms)}  DB=${JSON.stringify(f.db)}`,
      );
    }
    lines.push(
      `UPDATE pm_plans SET ${sets}` +
        ` WHERE contract_id=${sqlEsc(c)} AND plan_id=${sqlEsc(p)} AND segment_id=${sqlEsc(s)};`,
    );
    lines.push('');
    updateCount += 1;
  }

  // Section 2 — INSERT shells for plans missing from DB.
  lines.push('-- ── Section 2: INSERT shells for plans missing from DB ────');
  lines.push('-- pm_plans is per-county. For each missing plan we emit ONE');
  lines.push('-- INSERT per (state, county) row the landscape carries.');
  lines.push('');

  let insertCount = 0;
  let insertRowCount = 0;
  for (const cmsOnly of step2.cms_only_plans) {
    const lp = landscape.get(cmsOnly.triple);
    if (!lp) continue;
    const isPdp = (lp.plan_type ?? '').toUpperCase() === 'PDP';
    const premium = isPdp ? lp.partd_total_premium : lp.partc_premium;
    lines.push(
      `-- INSERT ${cmsOnly.triple}  ${lp.organization_marketing_name}  ${lp.plan_name}`,
    );
    insertCount += 1;
    for (const st of [...lp.states].sort()) {
      const counties = [...(lp.counties.get(st) ?? [])].sort();
      for (const cty of counties.length ? counties : ['All Counties']) {
        lines.push(
          `INSERT INTO pm_plans (contract_id, plan_id, segment_id, plan_name, carrier, parent_organization, plan_type, state, county_name, monthly_premium, annual_deductible, moop, drug_deductible, star_rating, snp, snp_type, sanctioned)` +
            ` VALUES (${sqlEsc(lp.contract_id)}, ${sqlEsc(lp.plan_id)}, ${sqlEsc(lp.segment_id)}, ${sqlEsc(lp.plan_name)}, ${sqlEsc(lp.organization_marketing_name)}, ${sqlEsc(lp.parent_organization)}, ${sqlEsc(lp.plan_type)}, ${sqlEsc(st)}, ${sqlEsc(cty)}, ${sqlEsc(premium)}, NULL, ${sqlEsc(lp.moop)}, ${sqlEsc(lp.drug_deductible)}, ${sqlEsc(lp.overall_star_rating)}, ${(lp.snp_indicator ?? '').toLowerCase() === 'yes' ? 'TRUE' : 'FALSE'}, ${sqlEsc(lp.snp_type === 'Non-SNP' ? null : lp.snp_type)}, ${lp.sanctioned ? 'TRUE' : 'FALSE'});`,
        );
        insertRowCount += 1;
      }
    }
    lines.push('');
  }

  // Section 3 — MISSING_FROM_CMS audit comments.
  lines.push('-- ── Section 3: plans in DB but NOT in 2026 landscape ────');
  lines.push('-- These look stale. NOT auto-deleted — review manually.');
  lines.push('');
  for (const dbOnly of step2.db_only_plans.slice(0, 1000)) {
    lines.push(
      `-- DB-only ${dbOnly.triple}  ${dbOnly.carrier}  ${dbOnly.plan_name} ` +
        `[states: ${dbOnly.states.join(',')}]`,
    );
  }

  lines.push('');
  lines.push('-- COMMIT;  -- uncomment when ready');
  lines.push('-- ROLLBACK;');
  lines.push('');
  lines.push(`-- Summary: ${updateCount} UPDATEs, ${insertCount} new plans (${insertRowCount} plan-county rows), ${step2.db_only_plans.length} stale plans flagged.`);

  return lines.join('\n');
}

// ── Step 5: Summary report ──────────────────────────────────────────
function runStep5(
  step2: Step2Report,
  diffs: PlanDiff[],
  sqlPath: string,
): string {
  const lines: string[] = [];
  const inBothDiffs = diffs.filter((d) => d.in_cms && d.in_db);
  const totalFieldComparisons = inBothDiffs.reduce((s, d) => s + d.fields.length, 0);
  const totalMismatches = inBothDiffs.reduce(
    (s, d) => s + d.fields.filter((f) => f.verdict === 'MISMATCH').length,
    0,
  );
  const totalMatches = inBothDiffs.reduce(
    (s, d) => s + d.fields.filter((f) => f.verdict === 'MATCH').length,
    0,
  );
  const matchRate = totalFieldComparisons > 0
    ? (totalMatches / (totalMatches + totalMismatches)) * 100
    : 0;

  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('  CMS CY2026 SYNC AUDIT — NC / TX / GA');
  lines.push('  Generated: ' + new Date().toISOString());
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('');
  lines.push('── Plan count reconciliation (Step 2) ──────────────────────');
  lines.push('');
  lines.push('  State     CMS    DB   inBoth  CMS-only  DB-only');
  for (const st of STATES) {
    const x = step2.by_state[st];
    lines.push(
      `  ${st.padEnd(4)}  ${String(x.cms).padStart(5)}  ${String(x.db).padStart(5)}  ` +
        `${String(x.in_both).padStart(6)}  ${String(x.cms_only).padStart(8)}  ${String(x.db_only).padStart(7)}`,
    );
  }
  lines.push(
    `  TOTAL ${String(step2.totals.cms).padStart(5)}  ${String(step2.totals.db).padStart(5)}  ` +
      `${String(step2.totals.in_both).padStart(6)}  ${String(step2.totals.cms_only).padStart(8)}  ${String(step2.totals.db_only).padStart(7)}`,
  );
  lines.push('');

  lines.push('── Field match rate (Step 3) ───────────────────────────────');
  lines.push('');
  lines.push(`  plans diffed       : ${inBothDiffs.length}`);
  lines.push(`  field comparisons  : ${totalFieldComparisons}`);
  lines.push(`  MATCH              : ${totalMatches}`);
  lines.push(`  MISMATCH           : ${totalMismatches}`);
  lines.push(`  match rate         : ${matchRate.toFixed(1)}%`);
  lines.push('');

  lines.push('── Per-field breakdown ─────────────────────────────────────');
  const perField = new Map<string, { match: 0; mismatch: 0; missing_db: 0; missing_cms: 0; both_null: 0 }>();
  for (const d of inBothDiffs) {
    for (const f of d.fields) {
      const hit = perField.get(f.field) ?? { match: 0, mismatch: 0, missing_db: 0, missing_cms: 0, both_null: 0 };
      if (f.verdict === 'MATCH') (hit.match as number) += 1;
      else if (f.verdict === 'MISMATCH') (hit.mismatch as number) += 1;
      else if (f.verdict === 'MISSING_FROM_DB') (hit.missing_db as number) += 1;
      else if (f.verdict === 'MISSING_FROM_CMS') (hit.missing_cms as number) += 1;
      else (hit.both_null as number) += 1;
      perField.set(f.field, hit);
    }
  }
  lines.push('');
  lines.push('  field               match  mismatch  missDB  missCMS  bothNull');
  for (const [field, x] of perField) {
    lines.push(
      `  ${field.padEnd(18)}  ${String(x.match).padStart(5)}  ${String(x.mismatch).padStart(8)}  ` +
        `${String(x.missing_db).padStart(6)}  ${String(x.missing_cms).padStart(7)}  ${String(x.both_null).padStart(8)}`,
    );
  }
  lines.push('');

  lines.push('── Top 25 plans by mismatch count ──────────────────────────');
  const worst = [...inBothDiffs].sort((a, b) => b.mismatch_count - a.mismatch_count).slice(0, 25);
  for (const d of worst) {
    if (d.mismatch_count === 0) break;
    const fields = d.fields
      .filter((f) => f.verdict === 'MISMATCH')
      .map((f) => f.field)
      .join(', ');
    lines.push(
      `  ${d.triple.padEnd(14)}  ${String(d.mismatch_count).padStart(2)} mismatches  ` +
        `${d.cms_carrier.slice(0, 28).padEnd(28)}  [${fields}]`,
    );
  }
  lines.push('');

  lines.push('── CMS-only (need INSERT) — first 30 ───────────────────────');
  for (const p of step2.cms_only_plans.slice(0, 30)) {
    lines.push(
      `  ${p.triple.padEnd(14)}  ${p.states.join('/').padEnd(5)}  ` +
        `${p.carrier.slice(0, 28).padEnd(28)}  ${p.plan_name.slice(0, 50)}`,
    );
  }
  if (step2.cms_only_plans.length > 30) {
    lines.push(`  ... and ${step2.cms_only_plans.length - 30} more (full list in JSON)`);
  }
  lines.push('');

  lines.push('── DB-only (probably stale) — first 30 ─────────────────────');
  for (const p of step2.db_only_plans.slice(0, 30)) {
    lines.push(
      `  ${p.triple.padEnd(14)}  ${p.states.join('/').padEnd(5)}  ` +
        `${p.carrier.slice(0, 28).padEnd(28)}  ${p.plan_name.slice(0, 50)}`,
    );
  }
  if (step2.db_only_plans.length > 30) {
    lines.push(`  ... and ${step2.db_only_plans.length - 30} more (full list in JSON)`);
  }
  lines.push('');

  lines.push('── Output artifacts ────────────────────────────────────────');
  lines.push(`  SQL fix file    : ${sqlPath}`);
  lines.push(`  Step 2 JSON     : ${OUT_DIR}/step2-reconciliation.json`);
  lines.push(`  Step 3 JSON     : ${OUT_DIR}/step3-fielddiff.json`);
  lines.push('');
  lines.push('Notes:');
  lines.push('  • Medical/Rx/Extras per-category PBP value compare is NOT in');
  lines.push('    this pass. The CMS PBP cost-share encoding (multi-interval');
  lines.push('    tiered copays per subsection) is genuinely complex and would');
  lines.push('    take a second pass to map reliably. The 8 plan-level fields');
  lines.push('    above cover everything Landscape/Plan Finder surfaces.');
  lines.push('  • pm_plan_benefits/pbp_benefits are already populated from CMS');
  lines.push('    sources via scripts/import-*.ts; the prior audit-plan-');
  lines.push('    completeness.ts script scores their internal completeness.');
  lines.push('  • Premium tolerance: $1 (covers whole-dollar rounding in');
  lines.push('    Landscape). MOOP/deductible tolerance: $5. Stars: 0.25.');

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  const landscape = await loadLandscape();
  const pmPlans = await loadPmPlans();
  const allTriples = new Set<string>([...landscape.keys(), ...pmPlans.keys()]);
  const sectionC = await loadSectionC(allTriples);
  const sectionD = await loadSectionD(allTriples);

  console.log('\n→ running step 2 reconciliation');
  const step2 = runStep2(landscape, pmPlans);

  console.log('→ running step 3 field-by-field diff');
  const diffs = runStep3(landscape, pmPlans, sectionC, sectionD);

  console.log('→ writing JSON artifacts');
  writeFileSync(`${OUT_DIR}/step2-reconciliation.json`, JSON.stringify(step2, null, 2));
  writeFileSync(
    `${OUT_DIR}/step3-fielddiff.json`,
    JSON.stringify(
      diffs.map((d) => ({
        triple: d.triple,
        states: d.states,
        carrier: d.cms_carrier,
        plan_name: d.cms_plan_name,
        plan_type: d.cms_plan_type,
        mismatch_count: d.mismatch_count,
        fields: d.fields,
      })),
      null,
      2,
    ),
  );

  console.log('→ generating proposed SQL');
  const sql = runStep4(diffs, step2, landscape);
  writeFileSync(SQL_PATH, sql);

  console.log('→ generating summary report\n');
  const summary = runStep5(step2, diffs, SQL_PATH);
  writeFileSync(`${OUT_DIR}/step5-summary.txt`, summary);
  console.log(summary);
  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
