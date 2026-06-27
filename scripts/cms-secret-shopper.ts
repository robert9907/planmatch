// scripts/cms-secret-shopper.ts
//
// Plan Match vs Medicare.gov accuracy audit (SECRET-SHOPPER PATTERN).
//
// VERTICAL SLICE — currently runs Margaret (Durham/NC) only. Once the
// diff schema + output format is reviewed, the persona list expands to
// all 6 (James/Rosa/William/Linda/John) without changing the engine.
//
// What it does for one persona:
//   1. Warm a Playwright/Chromium session against medicare.gov.
//   2. /plans/search across all pages — collect contract/plan/segment
//      triples for the persona's county_fips. Cache to
//      _tmp/cms-audit/cache/{persona}-search-{plan_type}-p{N}.json.
//   3. For each triple, GET /api/v1/data/plan-compare/plan/{year}/
//      {contract}/{plan}/{segment} (the detail endpoint). Cache to
//      _tmp/cms-audit/cache/{persona}-detail-{c}-{p}-{s}.json.
//      Rate-limited 500ms between calls.
//   4. Query pm_plans + pm_plan_benefits for the same fips.
//   5. Diff scalar fields per plan; categorize RED/ORANGE/YELLOW/GREEN.
//      Track plan-level MISSING (CMS-only) and EXTRA (Plan-Match-only).
//   6. Write per-persona JSON + per-persona detail.md.
//
// Drug-aware diff (formulary tier + drug copays) is a follow-up — the
// schema work for /plans/search prescriptions[] + pm_drug_cost_cache
// joins is non-trivial. Currently flagged with "// TODO: drugs" markers
// at the right hand-off points.
//
// Run: npx tsx scripts/cms-secret-shopper.ts
// Override persona list: PERSONAS=margaret,john npx tsx ...
// Skip cache: NO_CACHE=1 npx tsx ...

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
    silver_sneakers?: boolean;
  };
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
  const rows = await paginate<PmScalar & { county_fips: string }>((from, to) =>
    sb.from('pm_plans')
      .select('contract_id, plan_id, segment_id, plan_name, carrier:carrier, organization_name:carrier, plan_type, snp, snp_type, monthly_premium, annual_deductible, drug_deductible, moop, star_rating, county_fips')
      .eq('state', persona.state)
      .eq('county_fips', persona.fips)
      .range(from, to)
  );
  return rows;
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

function diffPlan(cms: CmsScalar, pm: PmScalar, cmsBenefits?: CmsBenefitRow[], pmBenefits?: PmBenefitRow[]): PlanDiff {
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
    // (those come from the formulary endpoint, not ma_benefits).
    const allCats = new Set<string>([
      ...cmsByPm.keys(),
      ...[...pmByCat.keys()].filter(c => !c.startsWith('rx_tier_') && c !== 'rx_deductible' && c !== 'insulin'),
    ]);
    for (const cat of [...allCats].sort()) {
      out.push(diffBenefit(cat, cmsByPm.get(cat) ?? [], pmByCat.get(cat)));
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

// ─── Per-persona runner ───────────────────────────────────────────────
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
}

async function runPersona(persona: Persona, page: Page): Promise<PersonaSummary> {
  console.log(`\n━━━ ${persona.name.toUpperCase()} (${persona.state}/${persona.county} fips=${persona.fips}) ━━━`);

  // 1. CMS plan list
  const cmsList = await searchAll(page, persona);
  console.log(`  [cms] ${cmsList.length} plans found`);

  // 2. CMS details (scalar + benefits)
  const cmsScalars = new Map<string, CmsScalar>();
  const cmsBenefitsByKey = new Map<string, CmsBenefitRow[]>();
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

  // 4. Diff
  const planDiffs: PlanDiff[] = [];
  const cmsOnly: CmsScalar[] = [];
  const pmOnly: PmScalar[] = [];

  for (const [key, cms] of cmsScalars) {
    const pm = pmByKey.get(key);
    if (!pm) { cmsOnly.push(cms); continue; }
    planDiffs.push(diffPlan(cms, pm, cmsBenefitsByKey.get(key), pmBenefitsByKey.get(key)));
  }
  for (const [key, pm] of pmByKey) {
    if (!cmsScalars.has(key)) pmOnly.push(pm);
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

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US' });
  const page = await ctx.newPage();
  console.log('[warm] navigating to medicare.gov...');
  await page.goto(WARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(6_000);

  const summaries: PersonaSummary[] = [];
  for (const persona of PERSONAS) {
    summaries.push(await runPersona(persona, page));
  }

  await browser.close();
  writeAuditSummary(summaries);
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
