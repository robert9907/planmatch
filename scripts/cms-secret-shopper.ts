// scripts/cms-secret-shopper.ts
//
// Plan Match vs Medicare.gov accuracy audit (SECRET-SHOPPER PATTERN).
//
// What it does per persona (6 personas: Margaret, James, Rosa, William,
// Linda, John — defined inline):
//
//   1. Warm a fresh Playwright/Chromium context (recycled per persona
//      so Akamai bot-detection state from one persona doesn't bleed
//      into the next).
//   2. /plans/search across all pages — collect contract/plan/segment
//      triples for the persona's county_fips. Cache to
//      _tmp/cms-audit/cache/{persona}-search-{plan_type}-p{N}.json.
//   3. For each triple, GET /api/v1/data/plan-compare/plan/{year}/
//      {contract}/{plan}/{segment} (the detail endpoint). Cache to
//      _tmp/cms-audit/cache/{persona}-detail-{c}-{p}-{s}.json.
//      Rate-limited 500ms between calls.
//   4. Query pm_plans + pm_plan_benefits + pm_formulary for the same
//      fips (and persona drugs).
//   5. Diff scalar fields per plan; categorize RED/ORANGE/YELLOW/GREEN.
//      Track plan-level MISSING (CMS-only) and EXTRA (Plan-Match-only).
//   6. Per-persona drug pass: compare CMS rx-tier cost table (from
//      detail.plan_card.abstract_benefits.initial_coverage.tiers) vs
//      pm_plan_benefits.rx_tier_{1..5} + verify each persona drug
//      resolves to a tier via pm_formulary (with RxNorm ingredient
//      fallback expansion done up front).
//   7. Run a fixed regression suite covering the six known fixes from
//      Jun 26-28 (atorvastatin TBD, vision/hearing/dental data,
//      specialist coinsurance, food card $0, $1 sentinel, ingredient
//      fallback). Surfaces PASS/FAIL in audit-summary.md.
//   8. Write per-persona JSON + per-persona detail.md.
//
// Run: npx tsx scripts/cms-secret-shopper.ts
// Override persona list: PERSONAS=margaret,john npx tsx ...
// Skip cache: NO_CACHE=1 npx tsx ...
// Skip drug pass: NO_DRUGS=1 npx tsx ...

import { chromium, type Page } from 'playwright-core';
import { createClient, type PostgrestSingleResponse } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';

// ─── env ──────────────────────────────────────────────────────────────
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const SUPA_URL = process.env.SUPABASE_URL ?? '';
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
if (!SUPA_URL || !SUPA_KEY) { console.error('Missing SUPABASE env'); process.exit(1); }
const sb = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// ─── constants ────────────────────────────────────────────────────────
const YEAR = 2026;
const WARM_URL = 'https://www.medicare.gov/plan-compare/';
const PLAN_SEARCH_URL = 'https://www.medicare.gov/api/v1/data/plan-compare/plans/search';
const PLAN_DETAIL_BASE = 'https://www.medicare.gov/api/v1/data/plan-compare/plan';
const FE_VER = '2.69.0';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PLAN_TYPES = ['PLAN_TYPE_MAPD', 'PLAN_TYPE_MA'] as const;

const OUT_DIR = '_tmp/cms-audit';
const CACHE_DIR = `${OUT_DIR}/cache`;
const DETAIL_DELAY_MS = 500;
const USE_CACHE = process.env.NO_CACHE !== '1';
const SKIP_DRUGS = process.env.NO_DRUGS === '1';

// ─── RxCUI map ────────────────────────────────────────────────────────
//
// Persona drug names → SCD/SBD-level rxcuis. Values come from the prompt
// (cross-checked against RxNorm). The /api/formulary endpoint expands
// each rxcui via RxNorm's /related.json to siblings + ingredient-anchored
// clinical drugs at request time — see api/formulary.ts:expandRxcui —
// so a strength-level miss against pm_formulary still resolves through
// the ingredient fallback that backs fix da90c17 (regression #6).
const DRUG_RXCUI: Record<string, string> = {
  Eliquis: '1364430',           // apixaban — SBD
  Metformin: '6809',            // IN
  Lisinopril: '29046',          // IN
  Amlodipine: '17767',          // IN
  Jardiance: '1545653',         // empagliflozin — SBD
  Atorvastatin: '83367',        // IN
  Omeprazole: '7646',           // IN
  Humira: '327361',             // adalimumab — SBD
  Metoprolol: '6918',           // IN
  Gabapentin: '25480',          // IN
  Entresto: '1656328',          // sacubitril-valsartan — SBD
  Xarelto: '1114195',           // rivaroxaban — SBD
  Rosuvastatin: '301542',       // IN
  Levothyroxine: '10582',       // IN
  'Potassium Chloride': '8588', // IN
};

function rxcuiFor(drug: string): string | null {
  return DRUG_RXCUI[drug] ?? null;
}

// Brand → generic-name anchor for the drug-name fallback path. pm_formulary
// stores rows under the generic ingredient name (apixaban, empagliflozin,
// ...), so a raw ILIKE 'Eliquis%' returns 0 rows even when the drug is
// fully covered. The deployed /api/formulary's RxNorm expansion handles
// this automatically; the audit harness needs an explicit table.
const BRAND_GENERIC_ANCHORS: Record<string, string[]> = {
  Eliquis: ['eliquis', 'apixaban'],
  Jardiance: ['jardiance', 'empagliflozin'],
  Humira: ['humira', 'adalimumab'],
  Entresto: ['entresto', 'sacubitril'],
  Xarelto: ['xarelto', 'rivaroxaban'],
};

function nameAnchorsFor(drug: string): string[] {
  return BRAND_GENERIC_ANCHORS[drug] ?? [drug.split(/\s+/)[0].toLowerCase()];
}

// CMS rx-tier labels (from detail.plan_card.abstract_benefits.initial_coverage.tiers[].label)
// → pm_plan_benefits.benefit_category for rx_tier rows.
const CMS_TIER_LABEL_TO_PM: Record<string, string> = {
  COST_SHARE_TIER_PREFERRED_GENERIC: 'rx_tier_1',
  COST_SHARE_TIER_GENERIC: 'rx_tier_2',
  COST_SHARE_TIER_PREFERRED_BRAND: 'rx_tier_3',
  COST_SHARE_TIER_NON_PREFERRED_DRUG: 'rx_tier_4',
  COST_SHARE_TIER_SPECIALTY_TIER: 'rx_tier_5',
  COST_SHARE_TIER_SELECT_CARE: 'rx_tier_6',
};

// ─── personas ─────────────────────────────────────────────────────────
interface Persona {
  key: string;
  name: string;
  state: string;
  county: string;
  fips: string;
  zip: string;
  age: number;
  drugs: string[];
  dsnp: boolean;
  notes: string;
}
const ALL_PERSONAS: Persona[] = [
  { key: 'margaret', name: 'Margaret', state: 'NC', county: 'Durham',    fips: '37063', zip: '27713', age: 72, drugs: ['Eliquis', 'Metformin', 'Lisinopril', 'Amlodipine'],                          dsnp: false, notes: 'Common 4-drug cardiac combo. Most-audited county.' },
  { key: 'james',    name: 'James',    state: 'TX', county: 'Harris',    fips: '48201', zip: '77001', age: 68, drugs: ['Jardiance', 'Atorvastatin', 'Omeprazole'],                                    dsnp: false, notes: 'Highest plan count county (~49). Jardiance hits coverage gap math.' },
  { key: 'rosa',     name: 'Rosa',     state: 'TX', county: 'Bexar',     fips: '48029', zip: '78201', age: 75, drugs: ['Humira', 'Metoprolol', 'Gabapentin'],                                         dsnp: true,  notes: 'Specialty tier drug (Humira). D-SNP eligible. Tests coinsurance display.' },
  { key: 'william',  name: 'William',  state: 'GA', county: 'Fulton',    fips: '13121', zip: '30301', age: 80, drugs: [],                                                                             dsnp: false, notes: 'Pure benefits comparison — no drug noise. Tests premium/MOOP/deductible/star/dental/vision/hearing/OTC/fitness.' },
  { key: 'linda',    name: 'Linda',    state: 'NC', county: 'Alleghany', fips: '37005', zip: '28675', age: 66, drugs: ['Entresto', 'Xarelto', 'Rosuvastatin', 'Levothyroxine', 'Potassium Chloride'], dsnp: false, notes: 'Rural county, 5-drug depth test. Stresses formulary lookup + RxCUI resolver.' },
  { key: 'john',     name: 'John',     state: 'NC', county: 'Ashe',      fips: '37009', zip: '28640', age: 65, drugs: ['Atorvastatin', 'Lisinopril'],                                                 dsnp: false, notes: "Turning 65, healthy. Atorvastatin is the copay-TBD regression test drug. Rob's home county." },
];

const SELECT = (process.env.PERSONAS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const PERSONAS = SELECT.length > 0
  ? ALL_PERSONAS.filter(p => SELECT.includes(p.key))
  : ALL_PERSONAS;

// ─── helpers ──────────────────────────────────────────────────────────
function randomHex(n: number): string { return randomBytes(n / 2).toString('hex'); }

function commonHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: 'https://www.medicare.gov',
    Referer: 'https://www.medicare.gov/plan-compare/',
    'fe-ver': FE_VER,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    traceparent: `00-${randomHex(32)}-${randomHex(16)}-01`,
  };
}

function cachedJsonRead<T>(path: string): T | null {
  if (!USE_CACHE) return null;
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
}

function cachedJsonWrite(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// Parse "$5,400 In-network" → 5400; "$0" → 0; "Free" → 0; "Not Covered" → null.
function parseDollar(s: string | number | null | undefined): number | null {
  if (s === null || s === undefined) return null;
  if (typeof s === 'number') return s;
  const trimmed = s.trim();
  if (!trimmed || /not covered|n\/a/i.test(trimmed)) return null;
  if (/^(free|\$0)/i.test(trimmed)) return 0;
  const m = trimmed.match(/\$?([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1].replace(/,/g, ''));
}

// MOOP parser. PPO plans return both an in-network and a combined cost_share
// in one string, e.g.:
//   "$10,100 In and Out-of-network<br />$6,750 In-network"
// pm_plans.moop stores the IN-NETWORK amount, so we prefer the explicit
// "In-network" figure when present (HMO plans only have one number and
// "In and Out-of-network" doesn't contain the literal substring
// "In-network", so the regex is unambiguous).
function parseMoop(s: string | number | null | undefined): number | null {
  if (s === null || s === undefined) return null;
  if (typeof s === 'number') return s;
  const text = s.trim();
  if (!text || /not covered|n\/a/i.test(text)) return null;
  const inNet = text.match(/\$?([\d,]+(?:\.\d+)?)\s*In-network/i);
  if (inNet) return Number(inNet[1].replace(/,/g, ''));
  return parseDollar(text);
}

// ─── Medicare.gov fetchers ────────────────────────────────────────────
interface CmsSearchPlan {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_name: string;
  carrier: string;
}

async function searchOnePage(page: Page, persona: Persona, planType: string, pageNum: number): Promise<{ plans: CmsSearchPlan[]; total: number; ok: boolean }> {
  const cachePath = `${CACHE_DIR}/${persona.key}-search-${planType}-p${pageNum}.json`;
  const cached = cachedJsonRead<{ plans: CmsSearchPlan[]; total: number }>(cachePath);
  if (cached) return { ...cached, ok: true };

  const qs = new URLSearchParams({
    zip: persona.zip, fips: persona.fips, plan_type: planType,
    year: String(YEAR), lang: 'en', page: String(pageNum),
  });
  const resp = await page.request.post(`${PLAN_SEARCH_URL}?${qs.toString()}`, {
    data: { npis: [], prescriptions: [], lis: 'LIS_NO_HELP', starRatings: [], organizationNames: [] },
    headers: commonHeaders(), timeout: 60_000,
  });
  if (!resp.ok()) {
    console.warn(`  [search] ${planType} p${pageNum} → ${resp.status()}`);
    return { plans: [], total: 0, ok: false };
  }
  const body = (await resp.json()) as Record<string, unknown>;
  const raws = Array.isArray(body.plans) ? body.plans as Record<string, unknown>[] : [];
  const plans: CmsSearchPlan[] = [];
  for (const r of raws) {
    const c = (r.contract_id ?? r.contractId) as string | undefined;
    const p = (r.plan_id ?? r.planId) as string | undefined;
    const s = (r.segment_id ?? r.segmentId ?? '0') as string;
    if (!c || !p) continue;
    plans.push({
      contract_id: String(c),
      plan_id: String(p),
      segment_id: String(s),
      plan_name: String(r.plan_name ?? r.name ?? ''),
      carrier: String(r.organization_name ?? r.carrier ?? ''),
    });
  }
  const total = typeof body.total_results === 'number' ? body.total_results : plans.length;
  cachedJsonWrite(cachePath, { plans, total });
  return { plans, total, ok: true };
}

async function searchAll(page: Page, persona: Persona): Promise<CmsSearchPlan[]> {
  // One running map across both plan_types so the final list is deduped
  // (MA and MAPD often overlap by contract_id-plan_id). Per-plan_type
  // counters drive the stop condition — using all.size compared to a
  // specific plan_type's total was the source of the "26/36 missed 10
  // plans" bug in v1.
  const all = new Map<string, CmsSearchPlan>();
  for (const pt of PLAN_TYPES) {
    let lastTotal = 0;
    let collectedForType = 0;
    for (let pn = 1; pn <= 30; pn += 1) {
      const r = await searchOnePage(page, persona, pt, pn);
      if (!r.ok) break;
      lastTotal = r.total;
      collectedForType += r.plans.length;
      for (const p of r.plans) {
        const k = `${p.contract_id}-${p.plan_id}-${p.segment_id}`;
        if (!all.has(k)) all.set(k, p);
      }
      // Stop ONLY on empty page or when we've collected the full reported
      // total for THIS plan_type. The previous "r.plans.length < 10" check
      // tripped on the natural last (partial) page and missed plans.
      if (r.plans.length === 0) break;
      if (lastTotal > 0 && collectedForType >= lastTotal) break;
    }
    console.log(`  [search] ${pt}: collected=${collectedForType}/${lastTotal} (cumulative unique=${all.size})`);
  }
  return [...all.values()];
}

// ─── Detail-endpoint shape (from probe-detail.json) ───────────────────
interface CmsRxTierRow {
  label: string;
  preferred_retail?: { days_30?: string; days_90?: string };
  standard_retail?: { days_30?: string; days_90?: string };
  mail_order?: { days_30?: string; days_90?: string };
}

interface CmsDetail {
  plan_card?: {
    contract_id: string;
    plan_id: string;
    segment_id: string;
    name: string;
    organization_name: string;
    plan_type: string;       // PLAN_TYPE_MAPD / PLAN_TYPE_MA
    category: string;        // PLAN_CATEGORY_HMOPOS / PPO / ...
    snp_type: string;        // SNP_TYPE_NOT_SNP / SNP_TYPE_DSNP / ...
    calculated_monthly_premium: number;
    annual_deductible: string;       // "$0" / "$365"
    drug_plan_deductible: number;    // int $
    package_benefits?: Record<string, {
      network_costs?: Record<string, { cost_share?: string }>;
    }>;
    overall_star_rating?: { rating?: number | null };
    ma_benefits?: Array<{
      category: string;
      service?: string;
      cost_sharing?: Array<{
        network_status: string;
        min_copay: number | null;
        max_copay: number | null;
        min_coinsurance: number | null;
        max_coinsurance: number | null;
      }>;
    }>;
    abstract_benefits?: {
      initial_coverage?: {
        tiers?: CmsRxTierRow[];
      };
    };
    silver_sneakers?: boolean;
  };
}

// Parse a CMS tier cost-share string into a {copay, coinsurance} pair.
// Examples seen:
//   "$0.00 copay"          → copay 0
//   "$4.00 copay"          → copay 4
//   "25% coinsurance"      → coinsurance 25
//   ""                     → both null (drug-tier not offered at this
//                            channel — e.g. specialty tier at 90-day)
// Defensive on any other shape — bare numbers, "$X-$Y copay", etc.
function parseTierCostShare(s: string | undefined): { copay: number | null; coinsurance: number | null } {
  if (!s) return { copay: null, coinsurance: null };
  const t = s.trim();
  if (!t) return { copay: null, coinsurance: null };
  const coinsM = t.match(/(\d+(?:\.\d+)?)\s*%/);
  if (coinsM) return { copay: null, coinsurance: Number(coinsM[1]) };
  // Take the max on a range so "$5-$10 copay" diffs against the upper
  // bound (consumer-safe — no understatement, matches cmsBenefitCost).
  const range = t.match(/\$?([\d,]+(?:\.\d+)?)\s*-\s*\$?([\d,]+(?:\.\d+)?)/);
  if (range) return { copay: Number(range[2].replace(/,/g, '')), coinsurance: null };
  const copayM = t.match(/\$?([\d,]+(?:\.\d+)?)/);
  if (copayM) return { copay: Number(copayM[1].replace(/,/g, '')), coinsurance: null };
  return { copay: null, coinsurance: null };
}

interface CmsRxTier {
  pm_category: string;     // rx_tier_1 .. rx_tier_6
  cms_label: string;
  copay_30: number | null;
  coinsurance_30: number | null;
}

function extractCmsRxTiers(d: CmsDetail | null): CmsRxTier[] {
  const tiers = d?.plan_card?.abstract_benefits?.initial_coverage?.tiers ?? [];
  const out: CmsRxTier[] = [];
  for (const t of tiers) {
    const pmCat = CMS_TIER_LABEL_TO_PM[t.label];
    if (!pmCat) continue;
    // Prefer preferred_retail for the 30-day reference (matches what
    // the consumer surface shows; pm_plan_benefits.rx_tier_N rows also
    // reflect the preferred-retail 30-day filing).
    const pref = parseTierCostShare(t.preferred_retail?.days_30);
    const std = parseTierCostShare(t.standard_retail?.days_30);
    const copay = pref.copay ?? std.copay;
    const coins = pref.coinsurance ?? std.coinsurance;
    out.push({
      pm_category: pmCat,
      cms_label: t.label,
      copay_30: copay,
      coinsurance_30: coins,
    });
  }
  return out;
}

async function fetchDetail(page: Page, persona: Persona, ids: CmsSearchPlan): Promise<CmsDetail | null> {
  const cachePath = `${CACHE_DIR}/${persona.key}-detail-${ids.contract_id}-${ids.plan_id}-${ids.segment_id}.json`;
  const cached = cachedJsonRead<CmsDetail>(cachePath);
  if (cached) return cached;

  const url = `${PLAN_DETAIL_BASE}/${YEAR}/${ids.contract_id}/${ids.plan_id}/${ids.segment_id}?lis=LIS_NO_HELP`;
  const resp = await page.request.get(url, { headers: commonHeaders(), timeout: 60_000 });
  if (!resp.ok()) {
    console.warn(`  [detail] ${ids.contract_id}-${ids.plan_id}-${ids.segment_id} → ${resp.status()}`);
    await sleep(DETAIL_DELAY_MS);
    return null;
  }
  const body = (await resp.json()) as CmsDetail;
  cachedJsonWrite(cachePath, body);
  await sleep(DETAIL_DELAY_MS);
  return body;
}

// Extract the comparable scalar shape from the CMS detail response.
interface CmsScalar {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_name: string;
  organization_name: string;
  plan_type: string;          // normalized below to 'MAPD' / 'MA-only'
  plan_category: string;      // HMO / PPO / HMOPOS / ...
  snp_type: string;           // NOT_SNP / DSNP / CSNP / ISNP
  monthly_premium: number | null;
  annual_deductible: number | null;
  drug_deductible: number | null;
  moop: number | null;
  star_rating: number | null;
}

function normalizePlanType(s: string): string {
  return s.replace(/^PLAN_TYPE_/, '') || 'UNKNOWN';
}
function normalizeCategory(s: string): string {
  return s.replace(/^PLAN_CATEGORY_/, '') || 'UNKNOWN';
}
function normalizeSnp(s: string): string {
  return s.replace(/^SNP_TYPE_/, '') || 'UNKNOWN';
}

function extractCmsScalar(d: CmsDetail | null): CmsScalar | null {
  if (!d?.plan_card) return null;
  const pc = d.plan_card;
  const moopRaw = pc.package_benefits?.BENEFIT_MAXIMUM_OOPC?.network_costs?.NETWORK_TYPE_NA?.cost_share
    ?? pc.package_benefits?.BENEFIT_MAXIMUM_OOPC?.network_costs?.NETWORK_TYPE_IN_NETWORK?.cost_share;
  return {
    contract_id: pc.contract_id,
    plan_id: pc.plan_id,
    segment_id: pc.segment_id,
    plan_name: pc.name,
    organization_name: pc.organization_name,
    plan_type: normalizePlanType(pc.plan_type),
    plan_category: normalizeCategory(pc.category),
    snp_type: normalizeSnp(pc.snp_type),
    monthly_premium: typeof pc.calculated_monthly_premium === 'number' ? pc.calculated_monthly_premium : null,
    annual_deductible: parseDollar(pc.annual_deductible),
    drug_deductible: typeof pc.drug_plan_deductible === 'number' ? pc.drug_plan_deductible : null,
    moop: parseMoop(moopRaw),
    star_rating: typeof pc.overall_star_rating?.rating === 'number' ? pc.overall_star_rating.rating : null,
  };
}

// ─── CMS ma_benefits → pm_plan_benefits.benefit_category mapping ──────
//
// CMS returns benefits as (category, service) pairs. pm_plan_benefits
// uses single snake_case category names. Map is best-effort and built
// from the H3449-023 probe — categories that only appear in other
// markets may be missing.
//
// Strategy:
//   - Each CMS row maps to AT MOST ONE pm_category.
//   - Multiple CMS rows can map to the same pm_category (e.g.,
//     COMPREHENSIVE_DENTAL has 6 services that all roll up to 'dental'
//     in pm). When the comparison runs, we pick the closest-cost match.
//   - When a CMS row has no pm equivalent (e.g.,
//     SERVICE_WORLDWIDE_EMERGENCY, BENEFIT_OPTIONAL_SUPPLEMENTAL_BENEFITS),
//     it's silently skipped — those are categories pm intentionally
//     doesn't track.
//   - rx_tier_* benefits live in a different CMS endpoint (the
//     formulary one) and are not in ma_benefits[]; diff'd later.
//   - Vision/dental/hearing collapse multiple CMS services into a
//     single pm row; comparison best-effort.
function mapCmsBenefitToPm(category: string, service: string | undefined): string | null {
  const key = `${category}:${service ?? ''}`;
  const exact: Record<string, string> = {
    'BENEFIT_AMBULANCE:GROUND_AMBULANCE': 'ambulance',
    'BENEFIT_AMBULANCE:AIR_AMBULANCE': 'air_transportation',
    'BENEFIT_TRANSPORTATION:NON_EMERGENCY_CARE_ANY_HEALTH_LOCATION': 'transportation',
    'BENEFIT_DOCTOR_VISITS:SERVICE_PRIMARY': 'primary_care',
    'BENEFIT_DOCTOR_VISITS:SERVICE_SPECIALIST': 'specialist',
    'BENEFIT_DOCTOR_VISITS:SERVICE_OCCUPATIONAL_THERAPY_VISIT': 'occupational_therapy',
    'BENEFIT_EMERGENCY_CARE:SERVICE_EMERGENCY': 'emergency',
    'BENEFIT_EMERGENCY_CARE:SERVICE_URGENT_CARE': 'urgent_care',
    'BENEFIT_DIAGNOSTIC_PROCEDURES:SERVICE_LAB_SERVICES': 'lab',
    'BENEFIT_DIAGNOSTIC_PROCEDURES:SERVICE_OUTPATIENT_XRAYS': 'xray',
    'BENEFIT_DIAGNOSTIC_PROCEDURES:SERVICE_DIAGNOSTIC_RADIOLOGY_SERVICES': 'advanced_imaging',
    'BENEFIT_DIAGNOSTIC_PROCEDURES:SERVICE_DIAGNOSTIC_TESTS': 'diagnostic_procedures',
    'BENEFIT_INPATIENT_HOSPITAL:INPATIENT_HOSPITAL': 'inpatient',
    'BENEFIT_OUTPATIENT_HOSPITAL:SERVICE_OUTPATIENT_HOSPITAL_SERVICES': 'outpatient_surgery',
    'BENEFIT_SKILLED_NURSING_FACILITY:SKILLED_NURSING_FACILITY': 'snf',
    'BENEFIT_MENTAL_HEALTH:SERVICE_OUTPATIENT_GROUP_THERAPY_VISIT': 'mental_health_outpatient_group',
    'BENEFIT_MENTAL_HEALTH:SERVICE_OUTPATIENT_GROUP_THERAPY_VISIT_WITH_PSYCHIATRIST': 'mental_health_outpatient_group',
    'BENEFIT_MENTAL_HEALTH:SERVICE_OUTPATIENT_INDIVIDUAL_THERAPY_VISIT': 'mental_health_outpatient_individual',
    'BENEFIT_MENTAL_HEALTH:SERVICE_OUTPATIENT_INDIVIDUAL_THERAPY_VISIT_WITH_PSYCHIATRIST': 'mental_health_outpatient_individual',
    'BENEFIT_MENTAL_HEALTH:SERVICE_PHYSICAL_THERAPY_AND_SPEECH_AND_LANGUAGE_THERAPY_VISIT': 'physical_speech_therapy',
    'BENEFIT_MENTAL_HEALTH:SERVICE_OPIOID_TREATMENT_PROGRAM_SERVICES': 'substance_abuse',
    'BENEFIT_VISION:VISION_ROUTINE_EYE_EXAMS': 'vision',
    'HEARING_AIDS:RX_HEARING_AIDS': 'hearing',
    'HEARING_EXAMS:ROUTINE_HEARING_EXAMS': 'hearing',
    'HEARING_EXAMS:FITTING_EVALUATION_HEARING_AIDS': 'hearing',
    'OTHER_SERVICES:OTC_ITEMS': 'otc',
    'OTHER_SERVICES:MEALS_SHORT_DURATION': 'meals',
    'OTHER_SERVICES:SERVICE_DIABETES_SUPPLIES': 'diabetic_supplies',
    'OTHER_SERVICES:SERVICE_DIALYSIS': 'renal_dialysis',
    'OTHER_SERVICES:SERVICE_DURABLE_MEDICAL_EQUIPMENT': 'dme_prosthetics',
    'OTHER_SERVICES:SERVICE_PROSTHETICS': 'dme_prosthetics',
    'PROFESSIONAL_SERVICES:TELEHEALTH': 'telehealth',
    'PREVENTIVE_SERVICES:ANNUAL_PHYSICAL': 'physical_exam',
    'PREVENTIVE_SERVICES:FITNESS': 'fitness',
  };
  if (exact[key]) return exact[key];
  // Family fallbacks for less stable services.
  if (category === 'BENEFIT_COMPREHENSIVE_DENTAL' || category === 'BENEFIT_PREVENTIVE_DENTAL') return 'dental';
  if (category === 'BENEFIT_VISION') return 'vision';
  if (category === 'PART_B_DRUGS') return 'partb_drugs';
  if (category === 'BENEFIT_MEDICARE_COVERED_ZERO_COSTSHARING_PREVENTIVE_SERVICES') return 'preventive';
  if (category === 'BENEFIT_DOCTOR_VISITS') return 'primary_care'; // catch-all
  if (category === 'HEARING_EXAMS' || category === 'HEARING_AIDS') return 'hearing';
  return null;
}

// Reduce a CMS cost_sharing[] to the in-network {copay, coinsurance}
// pair we'll diff against pm. Picks IN_NETWORK; falls back to the first
// entry. Uses max_copay so a "$10-$30 copay" range diffs against the
// upper bound — consumer-safe (no understatement).
function cmsBenefitCost(entry: { cost_sharing?: Array<{ network_status: string; min_copay: number | null; max_copay: number | null; min_coinsurance: number | null; max_coinsurance: number | null }> }): { copay: number | null; coinsurance: number | null } {
  const sharings = entry.cost_sharing ?? [];
  const inNet = sharings.find(s => s.network_status === 'IN_NETWORK') ?? sharings[0];
  if (!inNet) return { copay: null, coinsurance: null };
  const copay = inNet.max_copay ?? inNet.min_copay ?? null;
  const coins = inNet.max_coinsurance ?? inNet.min_coinsurance ?? null;
  return { copay, coinsurance: coins };
}

interface CmsBenefitRow {
  pm_category: string;
  cms_category: string;
  cms_service: string;
  copay: number | null;
  coinsurance: number | null;
}

function extractCmsBenefits(d: CmsDetail | null): CmsBenefitRow[] {
  if (!d?.plan_card?.ma_benefits) return [];
  const out: CmsBenefitRow[] = [];
  for (const b of d.plan_card.ma_benefits) {
    const pm = mapCmsBenefitToPm(b.category, b.service);
    if (!pm) continue;
    const { copay, coinsurance } = cmsBenefitCost(b);
    out.push({
      pm_category: pm,
      cms_category: b.category,
      cms_service: b.service ?? '',
      copay,
      coinsurance,
    });
  }
  return out;
}

// ─── Plan Match (Supabase) side ───────────────────────────────────────
interface PmScalar {
  contract_id: string;
  plan_id: string;
  segment_id: string | null;
  plan_name: string | null;
  organization_name: string | null;    // pm has parent_organization + carrier; we read carrier
  plan_type: string | null;            // pm uses 'HMO-POS' style
  snp_type: string | null;
  snp: boolean | null;
  monthly_premium: number | null;
  annual_deductible: number | null;
  drug_deductible: number | null;
  moop: number | null;
  star_rating: number | null;
}

async function paginate<T>(pageFn: (from: number, to: number) => PromiseLike<PostgrestSingleResponse<T[]>>): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let pageNum = 0; pageNum < 20; pageNum += 1) {
    const from = pageNum * PAGE;
    const { data, error } = await pageFn(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

async function loadPmPlans(persona: Persona): Promise<PmScalar[]> {
  // pm_plans.county_fips is 100% NULL across NC/TX/GA in plan-match-prod
  // (see project memory "pm_plans.county_fips wiped"), so a .eq on
  // county_fips silently returns 0 rows. Resolve by county_name with
  // prefix matching — same pattern as scripts/audit-planfinder-spotcheck.ts.
  const bare = persona.county.replace(/\s+(county|parish|borough)\s*$/i, '').trim();
  const rows = await paginate<PmScalar>((from, to) =>
    sb.from('pm_plans')
      .select('contract_id, plan_id, segment_id, plan_name, carrier:carrier, organization_name:carrier, plan_type, snp, snp_type, monthly_premium, annual_deductible, drug_deductible, moop, star_rating')
      .eq('state', persona.state)
      .or(`county_name.ilike.${bare},county_name.ilike.${bare} County,county_name.ilike.${bare} %`)
      .range(from, to)
  );
  // pm_plans rows are denormalized per county — the same (contract, plan,
  // segment) repeats for every county the plan serves. Dedupe to a
  // single row per plan key.
  const seen = new Map<string, PmScalar>();
  for (const r of rows) {
    const seg = r.segment_id ?? '0';
    const k = `${r.contract_id}-${r.plan_id}-${seg}`;
    if (!seen.has(k)) seen.set(k, r);
  }
  return [...seen.values()];
}

interface PmBenefitRow {
  contract_id: string;
  plan_id: string;
  segment_id: string | null;
  benefit_category: string;
  copay: number | null;
  coinsurance: number | null;
}

async function loadPmBenefits(plans: PmScalar[]): Promise<Map<string, PmBenefitRow[]>> {
  if (plans.length === 0) return new Map();
  const contracts = [...new Set(plans.map(p => p.contract_id))];
  const planIds = [...new Set(plans.map(p => p.plan_id))];
  // Pre-screen by contract/plan; we filter by segment_id in-memory because
  // pm uses '0' / '' / '<n>' inconsistently for segments.
  const rows = await paginate<PmBenefitRow>((from, to) =>
    sb.from('pm_plan_benefits')
      .select('contract_id, plan_id, segment_id, benefit_category, copay, coinsurance')
      .in('contract_id', contracts)
      .in('plan_id', planIds)
      .range(from, to)
  );
  const byPlanKey = new Map<string, PmBenefitRow[]>();
  for (const r of rows) {
    const seg = r.segment_id ?? '0';
    const key = `${r.contract_id}-${r.plan_id}-${seg}`;
    const arr = byPlanKey.get(key) ?? [];
    arr.push(r);
    byPlanKey.set(key, arr);
  }
  return byPlanKey;
}

// ─── Diff engine ──────────────────────────────────────────────────────
type Severity = 'RED' | 'ORANGE' | 'YELLOW' | 'GREEN';

interface FieldDiff {
  field: string;
  severity: Severity;
  cms: unknown;
  pm: unknown;
  note?: string;
}

function moneyDiff(field: string, cmsV: number | null, pmV: number | null, severity: Severity = 'RED'): FieldDiff {
  if (cmsV == null && pmV == null) return { field, severity: 'GREEN', cms: cmsV, pm: pmV };
  if (cmsV == null || pmV == null) return { field, severity, cms: cmsV, pm: pmV, note: 'one side null' };
  // $1 tolerance for rounding.
  if (Math.abs(cmsV - pmV) <= 1) return { field, severity: 'GREEN', cms: cmsV, pm: pmV };
  return { field, severity, cms: cmsV, pm: pmV, note: `Δ $${Math.abs(cmsV - pmV)}` };
}

function strDiff(field: string, cmsV: string | null, pmV: string | null, severity: Severity, opts: { caseInsensitive?: boolean; substring?: boolean } = {}): FieldDiff {
  const norm = (s: string | null) => s == null ? '' : (opts.caseInsensitive ? s.toLowerCase() : s).trim();
  const a = norm(cmsV);
  const b = norm(pmV);
  if (!a && !b) return { field, severity: 'GREEN', cms: cmsV, pm: pmV };
  if (a === b) return { field, severity: 'GREEN', cms: cmsV, pm: pmV };
  if (opts.substring && (a.includes(b) || b.includes(a)) && a && b) return { field, severity: 'YELLOW', cms: cmsV, pm: pmV, note: 'substring match' };
  return { field, severity, cms: cmsV, pm: pmV };
}

function numericDiff(field: string, cmsV: number | null, pmV: number | null, severity: Severity): FieldDiff {
  if (cmsV == null && pmV == null) return { field, severity: 'GREEN', cms: cmsV, pm: pmV };
  if (cmsV === pmV) return { field, severity: 'GREEN', cms: cmsV, pm: pmV };
  return { field, severity, cms: cmsV, pm: pmV };
}

// Map CMS plan_category (HMOPOS / HMO / LOCAL_PPO / ...) → pm plan_type
// (HMO-POS / HMO / Local PPO / ...). Best-effort substring match against
// the YELLOW tier — exact mismatch goes ORANGE because plan_type drives
// network behavior the consumer sees.
function planTypesMatch(cmsCat: string, pmType: string | null): boolean {
  if (!pmType) return false;
  const a = cmsCat.toLowerCase().replace(/[^a-z]/g, '');
  const b = pmType.toLowerCase().replace(/[^a-z]/g, '');
  return a === b || a.includes(b) || b.includes(a);
}

interface PlanDiff {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_name: string;
  status: 'BOTH' | 'CMS_ONLY' | 'PM_ONLY';
  diffs: FieldDiff[];
  counts: { RED: number; ORANGE: number; YELLOW: number; GREEN: number };
}

// Diff a single benefit category. Picks the closest-cost CMS row when
// multiple map to the same pm category (dental, hearing). Cost-match
// rule: both copay OR both coinsurance, $1 / 1% tolerance.
function diffBenefit(category: string, cmsRows: CmsBenefitRow[], pmRow: PmBenefitRow | undefined): FieldDiff {
  const field = `benefit:${category}`;
  if (cmsRows.length === 0 && !pmRow) {
    return { field, severity: 'GREEN', cms: null, pm: null };
  }
  if (cmsRows.length === 0 && pmRow) {
    // pm has the row but no CMS source — usually means our mapping missed
    // a CMS row. Note but don't penalize the data.
    return { field, severity: 'YELLOW', cms: null, pm: `copay=${pmRow.copay}/coins=${pmRow.coinsurance}`, note: 'no CMS mapping for this category' };
  }
  if (cmsRows.length > 0 && !pmRow) {
    const cms = cmsRows[0];
    const fmt = cms.copay != null ? `$${cms.copay}` : cms.coinsurance != null ? `${cms.coinsurance}%` : 'n/a';
    return { field, severity: 'ORANGE', cms: fmt, pm: null, note: 'missing benefit row in pm_plan_benefits' };
  }
  // Both sides have data — find the CMS row whose dominant cost matches pm best.
  const pm = pmRow!;
  let best: { row: CmsBenefitRow; sev: Severity; note?: string } | null = null;
  for (const c of cmsRows) {
    if (c.copay != null && pm.copay != null) {
      const delta = Math.abs(c.copay - pm.copay);
      const sev: Severity = delta <= 1 ? 'GREEN' : delta <= 5 ? 'YELLOW' : 'ORANGE';
      if (!best || rank(sev) < rank(best.sev)) {
        best = { row: c, sev, note: delta === 0 ? undefined : `Δ $${delta} copay` };
      }
    } else if (c.coinsurance != null && pm.coinsurance != null) {
      const delta = Math.abs(c.coinsurance - pm.coinsurance);
      const sev: Severity = delta <= 1 ? 'GREEN' : delta <= 5 ? 'YELLOW' : 'ORANGE';
      if (!best || rank(sev) < rank(best.sev)) {
        best = { row: c, sev, note: delta === 0 ? undefined : `Δ ${delta}% coins` };
      }
    } else if (c.copay != null && pm.coinsurance != null) {
      if (!best) best = { row: c, sev: 'ORANGE', note: 'CMS copay vs PM coinsurance' };
    } else if (c.coinsurance != null && pm.copay != null) {
      if (!best) best = { row: c, sev: 'ORANGE', note: 'CMS coinsurance vs PM copay' };
    } else if (c.copay == null && c.coinsurance == null && pm.copay == null && pm.coinsurance == null) {
      if (!best) best = { row: c, sev: 'GREEN' };
    } else {
      if (!best) best = { row: c, sev: 'ORANGE', note: 'one side null' };
    }
  }
  const b = best!;
  const cmsFmt = b.row.copay != null ? `$${b.row.copay}` : b.row.coinsurance != null ? `${b.row.coinsurance}%` : 'null';
  const pmFmt = pm.copay != null ? `$${pm.copay}` : pm.coinsurance != null ? `${pm.coinsurance}%` : 'null';
  return { field, severity: b.sev, cms: cmsFmt, pm: pmFmt, note: b.note };
}

function rank(s: Severity): number {
  return { GREEN: 0, YELLOW: 1, ORANGE: 2, RED: 3 }[s];
}

// Diff one rx tier (rx_tier_1..6) between CMS detail and pm_plan_benefits.
//
// Important: pm_plan_benefits.coinsurance for rx_tier rows is stored as
// the percent integer (25 = 25%, same surface convention as CMS). This
// is DIFFERENT from pm_formulary.coinsurance which is a fraction
// (0.20 = 20%); see api/formulary.ts:43 for the v2 fraction convention.
// We're diffing benefit-side rx_tier rows here, so percent-to-percent.
function diffRxTier(category: string, cms: CmsRxTier | undefined, pm: PmBenefitRow | undefined): FieldDiff {
  const field = `rx:${category}`;
  if (!cms && !pm) return { field, severity: 'GREEN', cms: null, pm: null };
  if (!cms && pm) return { field, severity: 'YELLOW', cms: null, pm: `copay=${pm.copay}/coins=${pm.coinsurance}`, note: 'CMS tier table absent' };
  if (cms && !pm) {
    const fmt = cms.copay_30 != null ? `$${cms.copay_30}` : cms.coinsurance_30 != null ? `${cms.coinsurance_30}%` : 'n/a';
    return { field, severity: 'ORANGE', cms: fmt, pm: null, note: 'missing rx_tier row in pm_plan_benefits' };
  }
  const c = cms!, p = pm!;
  // Both copay: $1 tol = GREEN, ≤5 = YELLOW, else RED (drug copays are
  // consumer-critical).
  if (c.copay_30 != null && p.copay != null) {
    const delta = Math.abs(c.copay_30 - p.copay);
    const sev: Severity = delta <= 1 ? 'GREEN' : delta <= 5 ? 'YELLOW' : 'RED';
    return { field, severity: sev, cms: `$${c.copay_30}`, pm: `$${p.copay}`, note: delta === 0 ? undefined : `Δ $${delta}` };
  }
  if (c.coinsurance_30 != null && p.coinsurance != null) {
    const delta = Math.abs(c.coinsurance_30 - p.coinsurance);
    const sev: Severity = delta <= 1 ? 'GREEN' : delta <= 5 ? 'YELLOW' : 'RED';
    return { field, severity: sev, cms: `${c.coinsurance_30}%`, pm: `${p.coinsurance}%`, note: delta === 0 ? undefined : `Δ ${delta}%` };
  }
  // Mixed copay/coinsurance — usually means CMS files copay and pm
  // surfaces coinsurance for the same tier (or vice versa). RED because
  // the consumer sees a different cost shape.
  const cFmt = c.copay_30 != null ? `$${c.copay_30}` : c.coinsurance_30 != null ? `${c.coinsurance_30}%` : 'null';
  const pFmt = p.copay != null ? `$${p.copay}` : p.coinsurance != null ? `${p.coinsurance}%` : 'null';
  return { field, severity: 'RED', cms: cFmt, pm: pFmt, note: 'copay/coinsurance shape mismatch' };
}

function diffPlan(cms: CmsScalar, pm: PmScalar, cmsBenefits?: CmsBenefitRow[], pmBenefits?: PmBenefitRow[], cmsRxTiers?: CmsRxTier[]): PlanDiff {
  const out: FieldDiff[] = [];

  // RED — consumer sees wrong $
  out.push(moneyDiff('monthly_premium', cms.monthly_premium, pm.monthly_premium, 'RED'));
  out.push(moneyDiff('moop', cms.moop, pm.moop, 'RED'));
  out.push(moneyDiff('annual_deductible', cms.annual_deductible, pm.annual_deductible, 'RED'));
  out.push(moneyDiff('drug_deductible', cms.drug_deductible, pm.drug_deductible, 'RED'));

  // ORANGE — plan_type / SNP designation
  out.push({
    field: 'plan_type/category',
    severity: planTypesMatch(cms.plan_category, pm.plan_type) ? 'GREEN' : 'ORANGE',
    cms: cms.plan_category,
    pm: pm.plan_type,
  });
  // SNP: pm has both snp(bool) and snp_type(string|null). CMS has snp_type
  // string. Treat NOT_SNP <-> false/null as a match.
  const cmsIsSnp = cms.snp_type !== 'NOT_SNP';
  const pmIsSnp = pm.snp === true || (pm.snp_type && pm.snp_type !== 'NOT_SNP');
  out.push({
    field: 'is_snp',
    severity: cmsIsSnp === !!pmIsSnp ? 'GREEN' : 'ORANGE',
    cms: cmsIsSnp ? cms.snp_type : 'NOT_SNP',
    pm: pmIsSnp ? (pm.snp_type ?? 'SNP') : 'NOT_SNP',
  });

  // YELLOW — star_rating + carrier formatting
  out.push(numericDiff('star_rating', cms.star_rating, pm.star_rating, 'YELLOW'));
  out.push(strDiff('organization_name', cms.organization_name, pm.organization_name, 'YELLOW', { caseInsensitive: true, substring: true }));
  out.push(strDiff('plan_name', cms.plan_name, pm.plan_name, 'YELLOW', { caseInsensitive: true, substring: true }));
  out.push(strDiff('segment_id', cms.segment_id, pm.segment_id, 'YELLOW'));

  // Benefit-category diff (ORANGE tier per spec)
  if (cmsBenefits && pmBenefits) {
    const cmsByPm = new Map<string, CmsBenefitRow[]>();
    for (const b of cmsBenefits) {
      const arr = cmsByPm.get(b.pm_category) ?? [];
      arr.push(b);
      cmsByPm.set(b.pm_category, arr);
    }
    const pmByCat = new Map<string, PmBenefitRow>();
    for (const b of pmBenefits) {
      // Multiple pm rows per category exist (one per segment was filtered
      // upstream, but some plans still have multiple rows per category for
      // tier variants — take the first).
      if (!pmByCat.has(b.benefit_category)) pmByCat.set(b.benefit_category, b);
    }
    // Union of all categories present on either side, excluding rx_tier_*
    // (those are diffed below against abstract_benefits.initial_coverage.tiers).
    const allCats = new Set<string>([
      ...cmsByPm.keys(),
      ...[...pmByCat.keys()].filter(c => !c.startsWith('rx_tier_') && c !== 'rx_deductible' && c !== 'insulin'),
    ]);
    for (const cat of [...allCats].sort()) {
      out.push(diffBenefit(cat, cmsByPm.get(cat) ?? [], pmByCat.get(cat)));
    }

    // RX tier diff — uses detail.plan_card.abstract_benefits.initial_coverage.tiers.
    // RED severity because drug copays are consumer-critical.
    if (cmsRxTiers && cmsRxTiers.length > 0) {
      const cmsByTier = new Map<string, CmsRxTier>();
      for (const t of cmsRxTiers) cmsByTier.set(t.pm_category, t);
      const tierCats = new Set<string>([
        ...cmsByTier.keys(),
        ...[...pmByCat.keys()].filter(c => c.startsWith('rx_tier_')),
      ]);
      for (const cat of [...tierCats].sort()) {
        out.push(diffRxTier(cat, cmsByTier.get(cat), pmByCat.get(cat)));
      }
    }
  }

  const counts = { RED: 0, ORANGE: 0, YELLOW: 0, GREEN: 0 };
  for (const d of out) counts[d.severity] += 1;
  return {
    contract_id: cms.contract_id,
    plan_id: cms.plan_id,
    segment_id: cms.segment_id,
    plan_name: cms.plan_name,
    status: 'BOTH',
    diffs: out,
    counts,
  };
}

// ─── PM formulary lookup (direct supabase, no HTTP) ───────────────────
//
// We pull every pm_formulary row across the persona's plan set in one
// paginated sweep, then bucket by (contract_id, plan_id) → rxcui → row.
// Direct query is fine here because the regression check we care about
// (fix da90c17 — brand-name ingredient fallback) is data-shape, not
// HTTP-behavioral: if a brand-name rxcui is on the persona but the
// formulary row lives under a sibling/ingredient rxcui, that gap is
// visible at the pm_formulary level. The deployed /api/formulary handles
// the RxNorm expansion at request time; we surface "exact miss" here so
// the run highlights drugs that NEED the expansion to resolve.
interface PmFormularyHit {
  contract_id: string;
  plan_id: string;
  rxcui: string;
  drug_name: string | null;
  tier: number | null;
  copay: number | null;        // pm_formulary stores fraction for coins
  coinsurance: number | null;  // 0..1 — we surface as fraction
  prior_auth: boolean | null;
  step_therapy: boolean | null;
  quantity_limit: boolean | null;
}

// Loads pm_formulary hits for the persona's plan set across BOTH the
// rxcui-exact route and the drug-name route. The prompt's rxcui list
// is mostly ingredient-level (IN), but pm_formulary keys on strength-
// level (SCD/SBD). An exact-rxcui-only sweep returns 0 for every
// ingredient query, which is technically correct but useless for the
// "is this drug covered?" question. The drug_name route matches what
// the deployed /api/formulary's RxNorm fallback resolves to at runtime.
async function loadPmFormularyForDrugs(
  plans: PmScalar[],
  drugs: { drug: string; rxcui: string | null }[],
): Promise<Map<string, PmFormularyHit[]>> {
  if (plans.length === 0 || drugs.length === 0) return new Map();
  const contracts = [...new Set(plans.map(p => p.contract_id))];
  const planIds = [...new Set(plans.map(p => p.plan_id))];
  const rxcuis = drugs.map(d => d.rxcui).filter((r): r is string => !!r);

  // Sweep 1: exact rxcui match.
  const exactRows = rxcuis.length === 0 ? [] : await paginate<PmFormularyHit>((from, to) =>
    sb.from('pm_formulary')
      .select('contract_id, plan_id, rxcui, drug_name, tier, copay, coinsurance, prior_auth, step_therapy, quantity_limit')
      .in('contract_id', contracts)
      .in('plan_id', planIds)
      .in('rxcui', rxcuis)
      .range(from, to)
  );

  // Sweep 2: drug_name ILIKE per drug. One query per (drug × anchor)
  // because PostgREST .or() across many ILIKE clauses gets gnarly. For
  // brand drugs, the anchor list includes the generic name (apixaban
  // for Eliquis, etc.) so pm_formulary's generic-keyed rows match.
  //
  // SUBSTRING match (%anchor%) not prefix: pm_formulary stores SCD/SBD
  // names that frequently lead with the strength or package size, e.g.
  // "0.8 ML adalimumab 50 MG/ML Auto-Injector [Humira]" — a prefix
  // match for "adalimumab" misses every row of that shape, which was
  // R6's false-positive source for Rosa's Humira finding.
  const nameRows: PmFormularyHit[] = [];
  for (const d of drugs) {
    for (const anchor of nameAnchorsFor(d.drug)) {
      const { data, error } = await sb.from('pm_formulary')
        .select('contract_id, plan_id, rxcui, drug_name, tier, copay, coinsurance, prior_auth, step_therapy, quantity_limit')
        .in('contract_id', contracts)
        .in('plan_id', planIds)
        .ilike('drug_name', `%${anchor}%`)
        .range(0, 9999);
      if (error) throw error;
      if (data) for (const r of data as PmFormularyHit[]) nameRows.push(r);
    }
  }

  const byPlan = new Map<string, PmFormularyHit[]>();
  const seen = new Set<string>();
  for (const r of [...exactRows, ...nameRows]) {
    // Dedupe rows that appear in both sweeps (exact-rxcui + name-match).
    const dedup = `${r.contract_id}-${r.plan_id}-${r.rxcui}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    const k = `${r.contract_id}-${r.plan_id}`;
    const arr = byPlan.get(k) ?? [];
    arr.push(r);
    byPlan.set(k, arr);
  }
  return byPlan;
}

interface PersonaDrugCoverage {
  drug: string;
  rxcui: string | null;
  /** Plans where pm_formulary has a row matching the exact rxcui. The
   *  consumer/agent code resolves brand→generic via RxNorm expansion at
   *  request time (api/formulary.ts:expandRxcui); this number is the
   *  HARD floor before fallback. */
  plans_exact_match: number;
  /** Plans where pm_formulary has any row whose drug_name starts with
   *  the persona's drug name (the rxcui may differ — strength variants,
   *  brand→generic equivalents). This is the realistic "is the drug
   *  covered?" answer; the deployed /api/formulary's RxNorm fallback
   *  would also resolve through these rows. */
  plans_name_match: number;
  plans_total_with_pm: number;
  exact_match_rate: number;
  name_match_rate: number;
  /** True when ALL coverage comes from drug-name fallback (zero exact-
   *  rxcui hits across the persona's whole plan set) — flags drugs where
   *  fix da90c17's ingredient fallback is load-bearing. */
  requires_ingredient_fallback: boolean;
}

// ─── Per-persona runner ───────────────────────────────────────────────
interface RegressionResult {
  id: string;
  fix_commit: string;
  description: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
}

interface PersonaSummary {
  persona: Persona;
  counts: {
    cms_plans: number;
    pm_plans: number;
    both: number;
    cms_only_missing: number;
    pm_only_extra: number;
  };
  diffs_by_severity: { RED: number; ORANGE: number; YELLOW: number; GREEN: number };
  worst_fields: Array<{ field: string; RED: number; ORANGE: number; YELLOW: number; total: number; mismatch_rate: number }>;
  plan_diffs: PlanDiff[];
  cms_only: CmsScalar[];
  pm_only: Array<{ key: string; plan_name: string | null; snp_type: string | null }>;
  drug_coverage: PersonaDrugCoverage[];
  regression: RegressionResult[];
}

// ─── Regression checks ────────────────────────────────────────────────
//
// Each entry corresponds to a fix landed Jun 26-28. The checks are
// programmatic assertions against the data, not UI scraping — the
// underlying data shape is what UI rendering depends on, and a
// regression at the data layer would surface a UI bug.
//
// Per-persona applicability is filtered up front so a "SKIP" entry is
// honestly not-applicable rather than a silent pass.
interface RegressionContext {
  pmList: PmScalar[];
  pmBenefitsByKey: Map<string, PmBenefitRow[]>;
  drugCoverage: PersonaDrugCoverage[];
  cmsBenefitsByKey: Map<string, CmsBenefitRow[]>;
  planDiffs: PlanDiff[];
}

function runRegressionChecks(persona: Persona, ctx: RegressionContext): RegressionResult[] {
  const out: RegressionResult[] = [];

  // (1) Atorvastatin copay-TBD (fix 0a9d5ef) — atorvastatin should
  // be on formulary with a tier across the persona's plan set. Uses
  // drug-name match (not exact rxcui) because pm_formulary keys on
  // strength-level rxcuis and the prompt's IN-level rxcui won't match
  // directly — the consumer surface gets there via /api/formulary's
  // RxNorm expansion. Threshold is 80% — atorvastatin is a generic
  // statin, should be on virtually every MA-PD formulary.
  if (persona.drugs.includes('Atorvastatin')) {
    const ator = ctx.drugCoverage.find(d => d.drug === 'Atorvastatin');
    const hit = ator?.plans_name_match ?? 0;
    const total = ator?.plans_total_with_pm ?? 0;
    const rate = total === 0 ? 0 : hit / total;
    const status: 'PASS' | 'FAIL' = rate >= 0.8 ? 'PASS' : 'FAIL';
    out.push({
      id: 'R1_atorvastatin_tbd',
      fix_commit: '0a9d5ef',
      description: 'Atorvastatin resolves to a tier (no copay-TBD)',
      status,
      detail: `Drug-name match on ${hit}/${total} plans (${(rate * 100).toFixed(1)}%)`,
    });
  } else {
    out.push({ id: 'R1_atorvastatin_tbd', fix_commit: '0a9d5ef', description: 'Atorvastatin resolves to a tier', status: 'SKIP', detail: 'persona has no Atorvastatin' });
  }

  // (2) Vision/hearing/dental data (fix ed99546) — the pm_plan_benefits
  // sweep should have a vision row + a hearing row + a dental row on at
  // least 50% of pm plans (these categories are universal on MA-PD).
  // Strongest for William (pure-benefits persona, no drug noise) but
  // applicable everywhere.
  {
    const total = ctx.pmList.length;
    let vis = 0, hear = 0, dent = 0;
    for (const p of ctx.pmList) {
      const seg = p.segment_id ?? '0';
      const k = `${p.contract_id}-${p.plan_id}-${seg}`;
      const rows = ctx.pmBenefitsByKey.get(k) ?? [];
      const cats = new Set(rows.map(r => r.benefit_category));
      if (cats.has('vision')) vis += 1;
      if (cats.has('hearing')) hear += 1;
      if (cats.has('dental')) dent += 1;
    }
    const min = Math.min(vis, hear, dent);
    const status: 'PASS' | 'FAIL' = total > 0 && min / total >= 0.5 ? 'PASS' : 'FAIL';
    out.push({
      id: 'R2_vision_hearing_dental_data',
      fix_commit: 'ed99546',
      description: 'Vision/hearing/dental rows present on ≥50% of plans',
      status: total === 0 ? 'SKIP' : status,
      detail: `vision=${vis}/${total} hearing=${hear}/${total} dental=${dent}/${total}`,
    });
  }

  // (3) Specialist coinsurance (fix 1058189) — when CMS files a
  // coinsurance for the specialist benefit, pm should have a non-null
  // value (copay OR coinsurance) on the matching plan.
  {
    let cmsHas = 0, pmCovered = 0;
    for (const pd of ctx.planDiffs) {
      const cms = ctx.cmsBenefitsByKey.get(`${pd.contract_id}-${pd.plan_id}-${pd.segment_id}`) ?? [];
      const specRows = cms.filter(r => r.pm_category === 'specialist');
      const cmsCoins = specRows.find(r => r.coinsurance != null);
      if (!cmsCoins) continue;
      cmsHas += 1;
      // Look at pd.diffs for the specialist benefit row to see if pm filled it.
      const specDiff = pd.diffs.find(d => d.field === 'benefit:specialist');
      // pm filled it if specDiff is not 'missing benefit row' note.
      if (specDiff && specDiff.note !== 'missing benefit row in pm_plan_benefits') pmCovered += 1;
    }
    const status: 'PASS' | 'FAIL' | 'SKIP' = cmsHas === 0 ? 'SKIP' : (pmCovered / cmsHas >= 0.9 ? 'PASS' : 'FAIL');
    out.push({
      id: 'R3_specialist_coinsurance',
      fix_commit: '1058189',
      description: 'Specialist coinsurance present in pm when CMS files one',
      status,
      detail: `${pmCovered}/${cmsHas} plans with CMS specialist coinsurance have a pm row`,
    });
  }

  // (4) Food card $0 (fix d6a3952) — D-SNP plans should NOT have a
  // benefit row with category='food_card' or 'meals' with copay=0 AND
  // null coinsurance — that's the regression shape (rendering as
  // "$0 copay" instead of allowance description). Only applicable to
  // D-SNP-flagged personas (Rosa).
  if (persona.dsnp) {
    let bad = 0, total = 0;
    for (const p of ctx.pmList) {
      if (!p.snp) continue;
      const seg = p.segment_id ?? '0';
      const k = `${p.contract_id}-${p.plan_id}-${seg}`;
      const rows = ctx.pmBenefitsByKey.get(k) ?? [];
      const food = rows.find(r => r.benefit_category === 'food_card' || r.benefit_category === 'meals');
      if (!food) continue;
      total += 1;
      if (food.copay === 0 && food.coinsurance == null) bad += 1;
    }
    out.push({
      id: 'R4_food_card_zero',
      fix_commit: 'd6a3952',
      description: 'D-SNP food/meals benefit does not render as "$0 copay"',
      status: total === 0 ? 'SKIP' : (bad === 0 ? 'PASS' : 'FAIL'),
      detail: `${bad}/${total} D-SNP plans show food_card with copay=0 + null coinsurance`,
    });
  } else {
    out.push({ id: 'R4_food_card_zero', fix_commit: 'd6a3952', description: 'D-SNP food/meals shape', status: 'SKIP', detail: 'persona not D-SNP eligible' });
  }

  // (5) $1 sentinel (fix f33d6eb) — coverage_amount=1 in extras/perks
  // (food_card, otc, vision, hearing, transportation) surfaces as
  // description text, not "$1/mo". pm_plan_benefits.copay==1 in those
  // categories is the regression shape. EXCLUDE rx_tier_* — some D-SNPs
  // genuinely file $1 generic copays (Tier 1/2 Preferred Generic at
  // 30-day retail) and flagging those would degrade the surfaced data.
  // Verified against the data 2026-06-28: every copay=1 row in the
  // snapshot was in rx_tier_1/rx_tier_2 with description "Tier N ·
  // Generic · 30-day retail · $1 copay" — real values, not sentinels.
  {
    let sentinel = 0;
    for (const rows of ctx.pmBenefitsByKey.values()) {
      for (const r of rows) {
        if (r.copay !== 1) continue;
        if (r.benefit_category.startsWith('rx_tier_')) continue;
        sentinel += 1;
      }
    }
    out.push({
      id: 'R5_dollar_one_sentinel',
      fix_commit: 'f33d6eb',
      description: 'No $1-sentinel rows leaking through pm_plan_benefits (excl. rx_tier_*)',
      status: sentinel === 0 ? 'PASS' : 'FAIL',
      detail: `${sentinel} non-rx_tier_* rows with copay exactly = 1`,
    });
  }

  // (6) Formulary ingredient fallback (fix da90c17) — brand-name drugs
  // (Eliquis, Jardiance, Humira, Entresto, Xarelto) should resolve to
  // coverage via the drug-name path when the exact brand rxcui isn't in
  // pm_formulary. PASS when every brand drug has SOME plan coverage
  // (exact rxcui OR drug_name match ≥ 50% of plans). FAIL when a brand
  // drug has zero coverage at all — meaning neither the strength-level
  // rxcui nor the ingredient fallback would resolve it.
  {
    const brands = ['Eliquis', 'Jardiance', 'Humira', 'Entresto', 'Xarelto'];
    const personaBrands = ctx.drugCoverage.filter(d => brands.includes(d.drug));
    if (personaBrands.length === 0) {
      out.push({ id: 'R6_ingredient_fallback', fix_commit: 'da90c17', description: 'Brand drugs resolve via ingredient fallback', status: 'SKIP', detail: 'persona has no brand-name drugs in test set' });
    } else {
      // "Resolved" = at least 50% of plans show some hit (either path).
      const zeroCoverage = personaBrands.filter(b => b.plans_exact_match === 0 && b.plans_name_match === 0);
      const needFallback = personaBrands.filter(b => b.requires_ingredient_fallback);
      const status: 'PASS' | 'FAIL' = zeroCoverage.length === 0 ? 'PASS' : 'FAIL';
      out.push({
        id: 'R6_ingredient_fallback',
        fix_commit: 'da90c17',
        description: 'Brand drugs resolve (via exact rxcui or ingredient fallback)',
        status,
        detail: zeroCoverage.length === 0
          ? `${personaBrands.length} brand drugs covered (${needFallback.length} via name-match fallback only${needFallback.length > 0 ? ': ' + needFallback.map(b => b.drug).join(', ') : ''})`
          : `${zeroCoverage.length} brand drugs with ZERO coverage: ${zeroCoverage.map(b => b.drug).join(', ')}`,
      });
    }
  }

  return out;
}

async function runPersona(persona: Persona, page: Page): Promise<PersonaSummary> {
  console.log(`\n━━━ ${persona.name.toUpperCase()} (${persona.state}/${persona.county} fips=${persona.fips}) ━━━`);

  // 1. CMS plan list
  const cmsList = await searchAll(page, persona);
  console.log(`  [cms] ${cmsList.length} plans found`);

  // 2. CMS details (scalar + benefits + rx tier table)
  const cmsScalars = new Map<string, CmsScalar>();
  const cmsBenefitsByKey = new Map<string, CmsBenefitRow[]>();
  const cmsRxTiersByKey = new Map<string, CmsRxTier[]>();
  let idx = 0;
  for (const p of cmsList) {
    idx += 1;
    if (idx % 10 === 0) console.log(`  [detail] ${idx}/${cmsList.length}`);
    const detail = await fetchDetail(page, persona, p);
    const sc = extractCmsScalar(detail);
    if (sc) {
      const k = `${sc.contract_id}-${sc.plan_id}-${sc.segment_id}`;
      cmsScalars.set(k, sc);
      cmsBenefitsByKey.set(k, extractCmsBenefits(detail));
      cmsRxTiersByKey.set(k, extractCmsRxTiers(detail));
    }
  }
  console.log(`  [cms] extracted scalar for ${cmsScalars.size}/${cmsList.length} plans`);

  // 3. PM plans + benefits
  const pmList = await loadPmPlans(persona);
  console.log(`  [pm]  ${pmList.length} plans in pm_plans for fips=${persona.fips}`);
  const pmByKey = new Map<string, PmScalar>();
  for (const p of pmList) {
    const seg = p.segment_id ?? '0';
    pmByKey.set(`${p.contract_id}-${p.plan_id}-${seg}`, p);
  }
  const pmBenefitsByKey = await loadPmBenefits(pmList);
  console.log(`  [pm]  ${[...pmBenefitsByKey.values()].reduce((a, b) => a + b.length, 0)} benefit rows across ${pmBenefitsByKey.size} plan keys`);

  // 3b. PM formulary — bucketed by (contract-plan), looked up per drug
  // via BOTH exact-rxcui and drug_name routes. Skips the network/api/
  // formulary HTTP path; the RxNorm expansion is tested separately via
  // the brand-name regression check below.
  const drugLookups = persona.drugs.map(d => ({ drug: d, rxcui: rxcuiFor(d) }));
  const formularyByPlan = SKIP_DRUGS
    ? new Map<string, PmFormularyHit[]>()
    : await loadPmFormularyForDrugs(pmList, drugLookups);
  if (!SKIP_DRUGS && persona.drugs.length > 0) {
    console.log(`  [pm]  ${[...formularyByPlan.values()].reduce((a, b) => a + b.length, 0)} formulary rows across ${formularyByPlan.size} plans (${persona.drugs.length} drugs)`);
  }

  // 4. Diff
  const planDiffs: PlanDiff[] = [];
  const cmsOnly: CmsScalar[] = [];
  const pmOnly: PmScalar[] = [];

  for (const [key, cms] of cmsScalars) {
    const pm = pmByKey.get(key);
    if (!pm) { cmsOnly.push(cms); continue; }
    planDiffs.push(diffPlan(cms, pm, cmsBenefitsByKey.get(key), pmBenefitsByKey.get(key), cmsRxTiersByKey.get(key)));
  }
  for (const [key, pm] of pmByKey) {
    if (!cmsScalars.has(key)) pmOnly.push(pm);
  }

  // 4b. Per-drug coverage summary on PM side. Tracks exact-rxcui hits
  // (the floor before /api/formulary's RxNorm fallback runs) and
  // drug-name hits across brand + generic anchors (the realistic
  // coverage answer).
  const drugCoverage: PersonaDrugCoverage[] = [];
  for (const drug of persona.drugs) {
    const rx = rxcuiFor(drug);
    const anchors = nameAnchorsFor(drug);
    let exact = 0, byName = 0;
    for (const p of pmList) {
      const hits = formularyByPlan.get(`${p.contract_id}-${p.plan_id}`) ?? [];
      if (rx && hits.some(h => h.rxcui === rx)) exact += 1;
      if (hits.some(h => {
        const dn = (h.drug_name ?? '').toLowerCase();
        // Substring (includes) not startsWith — pm_formulary names lead
        // with strength/package size ("0.8 ML adalimumab..."), so
        // prefix matching missed real Humira/Stelara/Cosentyx rows and
        // produced R6's false positive for Rosa.
        return anchors.some(a => dn.includes(a));
      })) byName += 1;
    }
    drugCoverage.push({
      drug,
      rxcui: rx,
      plans_exact_match: exact,
      plans_name_match: byName,
      plans_total_with_pm: pmList.length,
      exact_match_rate: pmList.length === 0 ? 0 : exact / pmList.length,
      name_match_rate: pmList.length === 0 ? 0 : byName / pmList.length,
      requires_ingredient_fallback: exact === 0 && byName > 0,
    });
  }

  // 5. Aggregates
  const agg = { RED: 0, ORANGE: 0, YELLOW: 0, GREEN: 0 };
  for (const pd of planDiffs) {
    agg.RED += pd.counts.RED;
    agg.ORANGE += pd.counts.ORANGE;
    agg.YELLOW += pd.counts.YELLOW;
    agg.GREEN += pd.counts.GREEN;
  }
  const fieldCounts = new Map<string, { RED: number; ORANGE: number; YELLOW: number; total: number }>();
  for (const pd of planDiffs) {
    for (const d of pd.diffs) {
      const fc = fieldCounts.get(d.field) ?? { RED: 0, ORANGE: 0, YELLOW: 0, total: 0 };
      fc.total += 1;
      if (d.severity !== 'GREEN') fc[d.severity] += 1;
      fieldCounts.set(d.field, fc);
    }
  }

  // 5b. Regression checks (the six known-bug fixes from Jun 26-28).
  const regression = runRegressionChecks(persona, {
    pmList,
    pmBenefitsByKey,
    drugCoverage,
    cmsBenefitsByKey,
    planDiffs,
  });

  // 6. Write outputs
  const summary: PersonaSummary = {
    persona: { ...persona },
    counts: {
      cms_plans: cmsList.length,
      pm_plans: pmList.length,
      both: planDiffs.length,
      cms_only_missing: cmsOnly.length,
      pm_only_extra: pmOnly.length,
    },
    diffs_by_severity: agg,
    worst_fields: [...fieldCounts.entries()]
      .map(([field, c]) => ({ field, ...c, mismatch_rate: ((c.RED + c.ORANGE + c.YELLOW) / Math.max(1, c.total)) }))
      .sort((a, b) => (b.RED + b.ORANGE) - (a.RED + a.ORANGE))
      .slice(0, 10),
    plan_diffs: planDiffs,
    cms_only: cmsOnly,
    pm_only: pmOnly.map(p => ({
      key: `${p.contract_id}-${p.plan_id}-${p.segment_id ?? '0'}`,
      plan_name: p.plan_name, snp_type: p.snp_type,
    })),
    drug_coverage: drugCoverage,
    regression,
  };

  cachedJsonWrite(`${OUT_DIR}/persona-${persona.key}.json`, summary);
  writeDetailMarkdown(persona, summary);
  printPersonaSummary(persona, summary);
  return summary;
}

function writeAuditSummary(all: PersonaSummary[]) {
  const lines: string[] = [];
  lines.push('# CMS Secret-Shopper Audit — Aggregate Summary');
  lines.push('');
  lines.push(`Run: ${new Date().toISOString()}`);
  lines.push(`Personas: ${all.map(s => s.persona.name).join(', ')}`);
  lines.push('');
  lines.push('## Plan coverage per persona');
  lines.push('');
  lines.push('| Persona | County | CMS | Plan Match | Both | 🚨 Missing | Extra |');
  lines.push('|---------|--------|-----|-----------|------|-----------|-------|');
  for (const s of all) {
    const c = s.counts;
    const missing = c.cms_only_missing > 0 ? `**${c.cms_only_missing}**` : '0';
    lines.push(`| ${s.persona.name} | ${s.persona.state}/${s.persona.county} | ${c.cms_plans} | ${c.pm_plans} | ${c.both} | ${missing} | ${c.pm_only_extra} |`);
  }
  lines.push('');
  lines.push('## Diff severity per persona');
  lines.push('');
  lines.push('| Persona | 🔴 RED | 🟠 ORANGE | 🟡 YELLOW | 🟢 GREEN | Total fields | Mismatch % |');
  lines.push('|---------|------|--------|--------|-------|--------------|-----------|');
  for (const s of all) {
    const sev = s.diffs_by_severity;
    const total = sev.RED + sev.ORANGE + sev.YELLOW + sev.GREEN;
    const mismatch = total > 0 ? ((sev.RED + sev.ORANGE + sev.YELLOW) / total * 100).toFixed(1) : '0.0';
    lines.push(`| ${s.persona.name} | ${sev.RED} | ${sev.ORANGE} | ${sev.YELLOW} | ${sev.GREEN} | ${total} | ${mismatch}% |`);
  }
  lines.push('');

  // Cross-persona aggregate worst fields
  const fieldAgg = new Map<string, { RED: number; ORANGE: number; YELLOW: number; total: number }>();
  for (const s of all) {
    for (const f of s.worst_fields) {
      const cur = fieldAgg.get(f.field) ?? { RED: 0, ORANGE: 0, YELLOW: 0, total: 0 };
      cur.RED += f.RED;
      cur.ORANGE += f.ORANGE;
      cur.YELLOW += f.YELLOW;
      cur.total += f.total;
      fieldAgg.set(f.field, cur);
    }
  }
  const sortedFields = [...fieldAgg.entries()]
    .map(([field, c]) => ({ field, ...c, mismatch_rate: (c.RED + c.ORANGE + c.YELLOW) / Math.max(1, c.total) }))
    .sort((a, b) => (b.RED + b.ORANGE) - (a.RED + a.ORANGE));
  lines.push('## Worst-offending fields (all personas)');
  lines.push('');
  lines.push('| Field | RED | ORANGE | YELLOW | Total | Mismatch % |');
  lines.push('|-------|-----|--------|--------|-------|-----------|');
  for (const f of sortedFields) {
    lines.push(`| ${f.field} | ${f.RED} | ${f.ORANGE} | ${f.YELLOW} | ${f.total} | ${(f.mismatch_rate * 100).toFixed(1)}% |`);
  }
  lines.push('');

  // Regression suite — PASS/FAIL roll-up per known-bug fix.
  lines.push('## Regression suite (Jun 26-28 fixes)');
  lines.push('');
  lines.push('| Persona | R1 atorvastatin | R2 vis/hear/dent | R3 specialist coins | R4 food $0 | R5 $1 sentinel | R6 brand-rxcui |');
  lines.push('|---------|----------|----------|----------|----------|----------|----------|');
  const ICON: Record<RegressionResult['status'], string> = { PASS: '✅', FAIL: '❌', SKIP: '⊘' };
  for (const s of all) {
    const byId = new Map(s.regression.map(r => [r.id, r]));
    const cell = (id: string) => {
      const r = byId.get(id);
      return r ? ICON[r.status] : '·';
    };
    lines.push(`| ${s.persona.name} | ${cell('R1_atorvastatin_tbd')} | ${cell('R2_vision_hearing_dental_data')} | ${cell('R3_specialist_coinsurance')} | ${cell('R4_food_card_zero')} | ${cell('R5_dollar_one_sentinel')} | ${cell('R6_ingredient_fallback')} |`);
  }
  lines.push('');
  lines.push('### Regression failures (detail)');
  lines.push('');
  let anyFail = false;
  for (const s of all) {
    for (const r of s.regression) {
      if (r.status !== 'FAIL') continue;
      anyFail = true;
      lines.push(`- ❌ **${s.persona.name} · ${r.id}** (fix ${r.fix_commit}) — ${r.description}`);
      lines.push(`    - ${r.detail}`);
    }
  }
  if (!anyFail) lines.push('_All regression checks PASS or SKIP across every persona._');
  lines.push('');

  // Drug coverage per persona
  const personasWithDrugs = all.filter(s => s.drug_coverage.length > 0);
  if (personasWithDrugs.length > 0) {
    lines.push('## Drug coverage (PM-side)');
    lines.push('');
    lines.push('| Persona | Drug | rxcui | Exact rxcui | Drug-name | Total | Exact % | Name % |');
    lines.push('|---------|------|-------|-------------|-----------|-------|---------|--------|');
    for (const s of personasWithDrugs) {
      for (const d of s.drug_coverage) {
        const fallbackTag = d.requires_ingredient_fallback ? ' 🔄' : '';
        lines.push(`| ${s.persona.name} | ${d.drug}${fallbackTag} | ${d.rxcui ?? '—'} | ${d.plans_exact_match} | ${d.plans_name_match} | ${d.plans_total_with_pm} | ${(d.exact_match_rate * 100).toFixed(1)}% | ${(d.name_match_rate * 100).toFixed(1)}% |`);
      }
    }
    lines.push('');
    lines.push('🔄 = brand-name rxcui has zero exact pm_formulary hits but drug-name path resolves — RxNorm ingredient fallback is load-bearing (fix da90c17).');
    lines.push('');
  }

  // Cross-persona worst plans (highest RED + ORANGE)
  type PlanRow = { persona: string; key: string; name: string; red: number; orange: number; yellow: number };
  const planRows: PlanRow[] = [];
  for (const s of all) {
    for (const pd of s.plan_diffs) {
      planRows.push({
        persona: s.persona.name,
        key: `${pd.contract_id}-${pd.plan_id}-${pd.segment_id}`,
        name: pd.plan_name,
        red: pd.counts.RED,
        orange: pd.counts.ORANGE,
        yellow: pd.counts.YELLOW,
      });
    }
  }
  planRows.sort((a, b) => (b.red + b.orange) - (a.red + a.orange));
  const topPlans = planRows.filter(p => p.red + p.orange > 0).slice(0, 20);
  if (topPlans.length > 0) {
    lines.push('## Worst-offending plans (top 20 by RED+ORANGE count, all personas)');
    lines.push('');
    lines.push('| Persona | Plan key | Plan name | 🔴 | 🟠 | 🟡 |');
    lines.push('|---------|----------|-----------|----|----|----|');
    for (const p of topPlans) {
      lines.push(`| ${p.persona} | ${p.key} | ${p.name.slice(0, 60)} | ${p.red} | ${p.orange} | ${p.yellow} |`);
    }
    lines.push('');
  }

  // Action items: every RED + ORANGE mismatch, grouped by field
  lines.push('## Action items — every RED + ORANGE mismatch');
  lines.push('');
  const byField = new Map<string, Array<{ persona: string; key: string; sev: Severity; cms: unknown; pm: unknown; note?: string }>>();
  for (const s of all) {
    for (const pd of s.plan_diffs) {
      for (const d of pd.diffs) {
        if (d.severity !== 'RED' && d.severity !== 'ORANGE') continue;
        const cur = byField.get(d.field) ?? [];
        cur.push({
          persona: s.persona.name,
          key: `${pd.contract_id}-${pd.plan_id}-${pd.segment_id}`,
          sev: d.severity,
          cms: d.cms,
          pm: d.pm,
          note: d.note,
        });
        byField.set(d.field, cur);
      }
    }
  }
  if (byField.size === 0) {
    lines.push('_No RED or ORANGE mismatches across any persona._');
  } else {
    for (const [field, rows] of [...byField.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`### ${field} (${rows.length} mismatches)`);
      lines.push('');
      lines.push('| Persona | Plan key | Severity | Medicare.gov | Plan Match | Note |');
      lines.push('|---------|----------|----------|--------------|-----------|------|');
      for (const r of rows) {
        const sev = r.sev === 'RED' ? '🔴' : '🟠';
        const fmt = (v: unknown) => v === null || v === undefined ? '_null_' : `\`${String(v)}\``;
        lines.push(`| ${r.persona} | ${r.key} | ${sev} | ${fmt(r.cms)} | ${fmt(r.pm)} | ${r.note ?? ''} |`);
      }
      lines.push('');
    }
  }

  writeFileSync(`${OUT_DIR}/audit-summary.md`, lines.join('\n'));
  console.log(`\n✓ wrote ${OUT_DIR}/audit-summary.md`);
}

function writeDetailMarkdown(persona: Persona, s: PersonaSummary) {
  const lines: string[] = [];
  lines.push(`# CMS Secret-Shopper Audit — ${persona.name} (${persona.state}/${persona.county}, fips=${persona.fips})`);
  lines.push('');
  lines.push(`Run: ${new Date().toISOString()}`);
  lines.push(`Notes: ${persona.notes}`);
  lines.push('');
  lines.push('## Counts');
  lines.push('');
  lines.push('| Side | Count |');
  lines.push('|------|-------|');
  lines.push(`| Medicare.gov plans | ${s.counts.cms_plans} |`);
  lines.push(`| Plan Match plans | ${s.counts.pm_plans} |`);
  lines.push(`| Both sides | ${s.counts.both} |`);
  lines.push(`| **CMS only (MISSING from Plan Match)** | **${s.counts.cms_only_missing}** |`);
  lines.push(`| Plan Match only (EXTRA — SNPs expected) | ${s.counts.pm_only_extra} |`);
  lines.push('');
  lines.push('## Diff severity totals');
  lines.push('');
  lines.push('| 🔴 RED | 🟠 ORANGE | 🟡 YELLOW | 🟢 GREEN |');
  lines.push('|------|--------|--------|-------|');
  lines.push(`| ${s.diffs_by_severity.RED} | ${s.diffs_by_severity.ORANGE} | ${s.diffs_by_severity.YELLOW} | ${s.diffs_by_severity.GREEN} |`);
  lines.push('');
  lines.push('## Worst-offending fields (top 10)');
  lines.push('');
  lines.push('| Field | RED | ORANGE | YELLOW | Total | Mismatch % |');
  lines.push('|-------|-----|--------|--------|-------|-----------|');
  for (const f of s.worst_fields) {
    lines.push(`| ${f.field} | ${f.RED} | ${f.ORANGE} | ${f.YELLOW} | ${f.total} | ${(f.mismatch_rate * 100).toFixed(1)}% |`);
  }
  lines.push('');
  if (s.counts.cms_only_missing > 0) {
    lines.push('## ❌ MISSING from Plan Match');
    lines.push('');
    lines.push('| Contract | Plan | Seg | Carrier | Plan Name |');
    lines.push('|----------|------|-----|---------|-----------|');
    for (const c of s.cms_only) {
      lines.push(`| ${c.contract_id} | ${c.plan_id} | ${c.segment_id} | ${c.organization_name} | ${c.plan_name} |`);
    }
    lines.push('');
  }
  if (s.regression.length > 0) {
    lines.push('## Regression checks');
    lines.push('');
    lines.push('| Check | Fix | Status | Detail |');
    lines.push('|-------|-----|--------|--------|');
    const icon = (st: 'PASS' | 'FAIL' | 'SKIP') => st === 'PASS' ? '✅ PASS' : st === 'FAIL' ? '❌ FAIL' : '⊘ SKIP';
    for (const r of s.regression) {
      lines.push(`| ${r.id} — ${r.description} | \`${r.fix_commit}\` | ${icon(r.status)} | ${r.detail} |`);
    }
    lines.push('');
  }
  if (s.drug_coverage.length > 0) {
    lines.push('## Drug coverage (PM-side)');
    lines.push('');
    lines.push('| Drug | rxcui | Exact rxcui | Drug-name | Total | Exact % | Name % |');
    lines.push('|------|-------|-------------|-----------|-------|---------|--------|');
    for (const d of s.drug_coverage) {
      const tag = d.requires_ingredient_fallback ? ' 🔄' : '';
      lines.push(`| ${d.drug}${tag} | ${d.rxcui ?? '—'} | ${d.plans_exact_match} | ${d.plans_name_match} | ${d.plans_total_with_pm} | ${(d.exact_match_rate * 100).toFixed(1)}% | ${(d.name_match_rate * 100).toFixed(1)}% |`);
    }
    lines.push('');
    lines.push('🔄 = brand rxcui misses pm_formulary but drug-name path resolves — RxNorm ingredient fallback is load-bearing (fix da90c17).');
    lines.push('');
  }
  lines.push('## Per-plan diffs');
  lines.push('');
  for (const pd of s.plan_diffs) {
    const flags = [
      pd.counts.RED > 0 ? `🔴×${pd.counts.RED}` : '',
      pd.counts.ORANGE > 0 ? `🟠×${pd.counts.ORANGE}` : '',
      pd.counts.YELLOW > 0 ? `🟡×${pd.counts.YELLOW}` : '',
    ].filter(Boolean).join(' ');
    lines.push(`### ${pd.contract_id}-${pd.plan_id}-${pd.segment_id} — ${pd.plan_name} ${flags || '✅'}`);
    lines.push('');
    lines.push('| Field | Severity | Medicare.gov | Plan Match | Note |');
    lines.push('|-------|----------|--------------|-----------|------|');
    for (const d of pd.diffs) {
      if (d.severity === 'GREEN') continue;
      const sev = d.severity === 'RED' ? '🔴' : d.severity === 'ORANGE' ? '🟠' : '🟡';
      const fmt = (v: unknown) => v === null || v === undefined ? '_null_' : `\`${String(v)}\``;
      lines.push(`| ${d.field} | ${sev} ${d.severity} | ${fmt(d.cms)} | ${fmt(d.pm)} | ${d.note ?? ''} |`);
    }
    lines.push('');
  }
  writeFileSync(`${OUT_DIR}/audit-detail-${persona.key}.md`, lines.join('\n'));
}

function printPersonaSummary(persona: Persona, s: PersonaSummary) {
  console.log(`\n  ┌─ ${persona.name} summary`);
  console.log(`  │  cms=${s.counts.cms_plans} pm=${s.counts.pm_plans} both=${s.counts.both} missing=${s.counts.cms_only_missing} extra=${s.counts.pm_only_extra}`);
  console.log(`  │  diffs: 🔴 ${s.diffs_by_severity.RED}  🟠 ${s.diffs_by_severity.ORANGE}  🟡 ${s.diffs_by_severity.YELLOW}  🟢 ${s.diffs_by_severity.GREEN}`);
  console.log(`  │  worst field: ${s.worst_fields[0]?.field ?? '(none)'} (${s.worst_fields[0]?.RED ?? 0} RED + ${s.worst_fields[0]?.ORANGE ?? 0} ORANGE)`);
  const pass = s.regression.filter(r => r.status === 'PASS').length;
  const fail = s.regression.filter(r => r.status === 'FAIL').length;
  const skip = s.regression.filter(r => r.status === 'SKIP').length;
  console.log(`  │  regression: ✅ ${pass}  ❌ ${fail}  ⊘ ${skip}`);
  console.log(`  └─ wrote persona-${persona.key}.json + audit-detail-${persona.key}.md`);
}

// ─── main ─────────────────────────────────────────────────────────────
async function main() {
  if (PERSONAS.length === 0) {
    console.error('No personas selected. Set PERSONAS=margaret or remove the filter.');
    process.exit(1);
  }
  mkdirSync(CACHE_DIR, { recursive: true });

  console.log(`Personas: ${PERSONAS.map(p => p.key).join(', ')}`);
  console.log(`Cache: ${USE_CACHE ? 'ON' : 'OFF'} (${CACHE_DIR})`);
  console.log(`Drug pass: ${SKIP_DRUGS ? 'OFF' : 'ON'}`);

  const browser = await chromium.launch({ headless: true });
  const summaries: PersonaSummary[] = [];

  // One Playwright context per persona. Each context gets its own cookie
  // jar / cache state, which resets Akamai bot-detection between personas
  // — a long unbroken stream of /plans/search + /detail calls under one
  // context tripped 403s mid-run during dev. The warm step is repeated
  // per persona for the same reason (fresh fingerprint each time).
  for (const persona of PERSONAS) {
    const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US' });
    const page = await ctx.newPage();
    console.log(`\n[warm] (${persona.key}) navigating to medicare.gov...`);
    try {
      await page.goto(WARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(6_000);
      summaries.push(await runPersona(persona, page));
    } catch (err) {
      console.error(`[error] persona ${persona.key} failed: ${(err as Error).message}`);
      // Partial output is fine — the prompt expressly asks for it on
      // Akamai mid-run blocks. Cached responses for completed personas
      // stay on disk so a follow-up run resumes cheaply.
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  await browser.close();
  if (summaries.length > 0) writeAuditSummary(summaries);
  else console.warn('No personas completed — skipping aggregate summary.');
  console.log(`\nDone. ${summaries.length}/${PERSONAS.length} personas completed.`);
}

main().catch(e => { console.error(e); process.exit(1); });
