// Medicare Plan Finder ("MPF") snapshot scraper for the parity audit.
//
// This is the "ground-truth" side of the 25-profile parity audit. Given a
// BeneficiaryProfile, we drive medicare.gov/plan-compare's undocumented
// JSON API and produce N typed PlanSnapshot objects (default: 5 MAPD +
// 2 PDP). A parallel module (pm-snapshot.ts) produces the Plan Match
// side; a diff engine compares field-by-field.
//
// The base scraping strategy — real Chrome via Playwright, Akamai bypass
// via SPA-context page.evaluate fetches, retry-with-backoff on 403s —
// is ported verbatim from ~/Code/plan-match/scripts/scrape-medicare-gov.ts.
// The load-bearing pieces (channel:'chrome', SPA warmup, page-context
// fetches, all-four SNP types, INTER_PLAN_DELAY_MS pacing) are copied
// exactly. See that file's header comment for the Akamai fingerprinting
// rationale.
//
// What DIVERGES from the consumer scraper:
//   1. Search body is profile-driven: `lis` is mapped from profile.lis;
//      `prescriptions[]` is populated from profile.drugs so MPF returns
//      per-plan drug-cost estimates.
//   2. Plan-detail URL uses the profile's LIS (LIS_FULL for duals with
//      full LIS, etc.) — not hardcoded LIS_NO_HELP.
//   3. Output shape is PlanSnapshot (13 categories per docs/parity-audit
//      SPEC), not the consumer's per-benefit_type upsert rows.
//   4. Cache is per-profile: _tmp/parity-audit/mpf/<profile-id>/…
//   5. No Supabase writes — this is an audit read.
//
// Do NOT run this repeatedly against medicare.gov during development —
// it's rate-limit sensitive and Akamai will IP-blacklist us. Use the
// cache. Type-check with:
//
//   npx tsc --noEmit --strict --module node16 --moduleResolution node16 \
//     --target es2022 --esModuleInterop --skipLibCheck \
//     scripts/parity-audit/lib/mpf-scrape.ts \
//     scripts/parity-audit/types.ts \
//     scripts/parity-audit/fixtures/profiles.ts

// NOTE: This repo installs playwright-core, not @playwright/test. The
// consumer scraper imports from '@playwright/test' but that's not in
// this repo's package.json — playwright-core exports the same
// `chromium` object and the same Browser/BrowserContext/Page types.
// TODO(playwright): if we later need @playwright/test's fixtures, add
// it to devDependencies; for now playwright-core is enough.
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import type {
  BeneficiaryProfile,
  Drug,
  DrugCoverage,
  DentalBenefits,
  HearingBenefits,
  InpatientCostSharing,
  LISLevel,
  OtherMedical,
  OutpatientCostSharing,
  PlanIdentification,
  PlanSnapshot,
  PremiumAndDeductible,
  RxPhases,
  RxStructure,
  RxTierCostSharing,
  SupplementalBenefits,
  TherapyAndDme,
  VisionBenefits,
} from '../types.js';

// ─── Config (ported from consumer scraper — keep in sync) ─────────────

const REPO_ROOT = process.cwd();
const CACHE_ROOT = path.resolve(REPO_ROOT, '_tmp/parity-audit/mpf');

const PLAN_COMPARE_BASE = 'https://www.medicare.gov/plan-compare';
const API_BASE = '/api/v1/data/plan-compare';
const YEAR = 2026;

const INTER_PLAN_DELAY_MS = 3_500;
const PAGE_LOAD_TIMEOUT_MS = 60_000;
const SPA_WARMUP_MS = 12_000;
const ROTATION_COOLDOWN_MS = 15_000;
const STARTUP_BACKOFFS_MS = [30_000, 120_000, 300_000, 600_000] as const;

const DEFAULT_MAX_MAPD = 5;
const DEFAULT_MAX_PDP = 2;

// All four SNP types — the SPA's default is NOT_SNP only, but for the
// parity audit we want D-SNP / C-SNP surfaced for dual + chronic
// profiles. Filter after the fact if needed.
const SNP_TYPES = [
  'SNP_TYPE_NOT_SNP',
  'SNP_TYPE_CHRONIC_OR_DISABLING',
  'SNP_TYPE_DUAL_ELIGIBLE',
  'SNP_TYPE_INSTITUTIONAL',
] as const;

// Profile LIS → MPF's LIS_LEVEL_* enum. MPF's protobuf schema for the
// /plans/search body's `lis` field accepts LIS_NO_HELP + LIS_LEVEL_1A /
// LIS_LEVEL_2 / LIS_LEVEL_3. There is no `LIS_FULL` enum value (verified
// via a 400 on james: "invalid value for enum field lis: \"LIS_FULL\"").
// Mapping mirrors src/lib/drugCosts.ts LIS_ENUM_MAP:
//   LIS_LEVEL_1A — institutional FBDE ($0/$0)
//   LIS_LEVEL_2  — full LIS community ≤100% FPL ($1.60/$4.90) — DEFAULT
//   LIS_LEVEL_3  — full LIS community >100% FPL ($5.10/$12.65)
// Full-dual (FBDE) and QMB auto-qualify for full LIS at LEVEL_2 (matches
// pm-snapshot::deriveLisTier which routes them to full_low/qmb_uniform,
// both of which map to $4.90 brand — same as LEVEL_2's ceiling).
function lisEnum(profile: BeneficiaryProfile): string {
  if (profile.medicaid === 'full-dual' || profile.medicaid === 'qmb') return 'LIS_LEVEL_2';
  if (profile.medicaid === 'slmb' || profile.medicaid === 'qi') return 'LIS_LEVEL_2';
  if (profile.lis === 'full') return 'LIS_LEVEL_2';
  return 'LIS_NO_HELP';
}

// Translate a profile Drug to the medicare.gov prescription payload.
// TODO(prescription-shape): the exact keys expected by the SPA are
// {rxcui, dosage, quantity, frequency, package}. Without RxNorm lookups
// we don't have rxcui — the SPA appears to accept a name/strength
// object as a search fallback (verified empirically in one manual
// scrape session, not confirmed against the SPA bundle source). If a
// future test call rejects these entries, add an RxNorm resolver step
// before this function. For now we send a best-guess object that at
// worst gets ignored and drug-cost estimates come back empty.
function toPrescription(drug: Drug): Record<string, unknown> {
  return {
    // TODO: verify against SPA bundle — likely needs an rxcui field
    // (RxNorm identifier). Without it, MPF may skip drug-cost estimation
    // for this row but should still return the plan in search results.
    name: drug.name,
    dosage: drug.strength,
    quantity: drug.quantityPerMonth,
    frequency: 'MONTHLY',
    package: drug.form ?? 'EACH',
  };
}

// ─── Browser bootstrap (ported verbatim from consumer scraper) ────────

interface BrowserSession {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

async function bootstrapBrowser(fips: string, zip: string): Promise<BrowserSession> {
  const headless = process.env.MG_HEADFUL !== '1';
  // channel:'chrome' is load-bearing — bundled Chromium's HTTP/2 TLS
  // fingerprint is dropped by Akamai. Real Chrome passes. Do NOT swap
  // to @sparticuz/chromium for serverless — that's Chromium too.
  const browser = await chromium.launch({
    headless,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  const landing = `${PLAN_COMPARE_BASE}/#/search-results?plan_type=PLAN_TYPE_MAPD&fips=${fips}&zip=${zip}&year=${YEAR}`;
  await page.goto(landing, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });
  await page.waitForTimeout(SPA_WARMUP_MS);

  // Session warm-up. pageFetch throws MpfApiError on non-200 which
  // aborts bootstrap and propagates to the caller (bootstrapWithBackoff).
  await pageFetch<{ launchDarklyStatus?: string }>(page, {
    method: 'GET',
    path: `${API_BASE}/status`,
  });

  return {
    context,
    page,
    async close() {
      await context.close();
      await browser.close();
    },
  };
}

interface FetchOpts {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

class AkamaiBlocked extends Error {
  constructor(public readonly path: string, public readonly bodySnippet: string) {
    super(`Akamai 403 on ${path}: ${bodySnippet.slice(0, 80)}`);
    this.name = 'AkamaiBlocked';
  }
}

class MpfApiError extends Error {
  constructor(
    public readonly path: string,
    public readonly method: string,
    public readonly status: number,
    public readonly bodySnippet: string,
  ) {
    super(
      `MPF ${method} ${path} → ${status}: ${bodySnippet.slice(0, 300)}`,
    );
    this.name = 'MpfApiError';
  }
}

// Retry with 3s backoff on 429 (rate limit) / 503 (transient).
const RETRY_STATUSES = new Set([429, 503]);
const DEFAULT_RETRIES = 3;
const RETRY_BACKOFF_MS = 3_000;

async function pageFetch<T>(
  page: Page,
  opts: FetchOpts,
  retryOpts?: { retries?: number },
): Promise<T> {
  const retries = retryOpts?.retries ?? DEFAULT_RETRIES;
  let attempt = 0;
  for (;;) {
    const response = await page.evaluate(async ({ method, path: p, body }) => {
      try {
        const init: RequestInit = {
          method,
          headers: {
            Accept: 'application/json',
            ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          },
        };
        if (body != null) init.body = JSON.stringify(body);
        const resp = await fetch(p, init);
        const text = await resp.text();
        return { status: resp.status, text };
      } catch (err) {
        return { status: -1, text: (err as Error).message };
      }
    }, opts);

    if (response.status === 403 || /Access Denied/i.test(response.text)) {
      throw new AkamaiBlocked(opts.path, response.text);
    }
    if (response.status === 200) {
      try {
        return JSON.parse(response.text) as T;
      } catch (err) {
        throw new MpfApiError(
          opts.path,
          opts.method,
          200,
          `JSON parse failed: ${(err as Error).message}`,
        );
      }
    }
    if (RETRY_STATUSES.has(response.status) && attempt < retries) {
      attempt += 1;
      console.warn(
        `[mpf-scrape] ${opts.method} ${opts.path} → ${response.status}, retry ${attempt}/${retries} in ${RETRY_BACKOFF_MS}ms`,
      );
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }
    console.error(
      `[mpf-scrape] ${opts.method} ${opts.path} → ${response.status}`,
    );
    console.error(
      `[mpf-scrape] response body (first 2000 chars): ${response.text.slice(0, 2000)}`,
    );
    throw new MpfApiError(
      opts.path,
      opts.method,
      response.status,
      response.text,
    );
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ─── Plan search + detail (raw response shapes) ───────────────────────

interface PlanSummary {
  id: number;
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_type: string;
  snp_type: string;
  name: string;
  organization_name: string;
  drug_plan_deductible?: number;
  partb_premium_reduction?: number;
  partc_premium?: number;
  partd_premium?: number;
  monthly_premium?: number;
  overall_star_rating?: { rating?: number };
  maximum_oopc?: string;
}

interface PlanSearchResponse {
  plans: PlanSummary[];
  total_results: number;
}

interface CostSharing {
  network_status: string;
  min_copay: number | null;
  max_copay: number | null;
  min_coinsurance: number | null;
  max_coinsurance: number | null;
}

interface TieredCostSharing {
  tier: number | null;
  interval_type: string;
  interval: string | null;
  copay: number | null;
  coinsurance: number | null;
}

interface MaBenefit {
  category: string;
  type: string;
  service: string;
  cost_sharing: CostSharing[];
  tiered_cost_sharing?: {
    in_network?: TieredCostSharing[];
    out_of_network?: TieredCostSharing[];
    no_network?: TieredCostSharing[];
  } | null;
  plan_limits?: boolean;
  plan_limits_details?: Array<{
    limit_type?: string;
    limit_value?: number;
    limit_period?: string;
  }>;
}

interface RxTier {
  label: string;
  tier_row_order: number;
  standard_retail?: { days_30?: string; days_90?: string; days_any?: string };
  preferred_retail?: { days_30?: string; days_90?: string } | null;
  standard_mail?: { days_30?: string; days_90?: string } | null;
  preferred_mail?: { days_30?: string; days_90?: string } | null;
}

interface PackageBenefits {
  BENEFIT_MAXIMUM_OOPC?: { value?: number } | number | null;
  BENEFIT_MEDICAL_DEDUCTIBLE?: { value?: number } | number | null;
  BENEFIT_MEDICAL_DEDUCTIBLE_OON?: { value?: number } | number | null;
  BENEFIT_PARTD_OOP_THRESHOLD?: { value?: number } | number | null;
  [k: string]: unknown;
}

interface PlanDetail {
  plan_card: {
    id: number;
    contract_id: string;
    plan_id: string;
    segment_id: string;
    name?: string;
    plan_type?: string;
    organization_name?: string;
    overall_star_rating?: { rating?: number };
    drug_plan_deductible?: number;
    monthly_premium?: number;
    partc_premium?: number;
    partd_premium?: number;
    partb_premium_reduction?: number;
    ma_benefits?: MaBenefit[];
    abstract_benefits?: {
      initial_coverage?: { tiers: RxTier[] } | null;
      catastrophic?: { tiers: RxTier[] } | null;
    } | null;
    package_benefits?: PackageBenefits;
  };
}

async function fetchPlans(
  page: Page,
  profile: BeneficiaryProfile,
  maxMapd: number,
  maxPdp: number,
): Promise<PlanSummary[]> {
  const fips = profile.countyFips;
  const zip = profile.zip;
  const snpParams = SNP_TYPES.map((s) => `snp_type=${s}`).join('&');
  // MPF /plans/search is drug-agnostic — plans are geographic. The
  // endpoint uses protobuf and rejects unknown fields (verified via
  // scripts/parity-audit/diagnose-mpf-api.ts, phase 4). Per-drug costs
  // are computed by a separate endpoint. Send empty prescriptions;
  // drugCoverage[] is populated downstream via formulary lookups (see
  // TODO(formulary) below).
  const body = {
    npis: [] as string[],
    prescriptions: [] as unknown[],
    lis: lisEnum(profile),
    starRatings: [] as string[],
    organizationNames: [] as string[],
  };

  const out: PlanSummary[] = [];
  const calls = [
    {
      label: 'MA/MAPD' as const,
      planTypes: 'plan_type=PLAN_TYPE_MA&plan_type=PLAN_TYPE_MAPD',
      sort: 'ANNUAL_TOTAL',
      cap: maxMapd,
    },
    {
      label: 'PDP' as const,
      planTypes: 'plan_type=PLAN_TYPE_PDP',
      sort: 'MONTHLY_PREMIUM',
      cap: maxPdp,
    },
  ];

  for (const call of calls) {
    if (call.cap <= 0) continue;
    let collected = 0;
    for (let pg = 0; pg < 20 && collected < call.cap; pg += 1) {
      const p = `${API_BASE}/plans/search?${call.planTypes}&${snpParams}&page=${pg}&year=${YEAR}&fips=${fips}&sort_order=${call.sort}&zip=${zip}`;
      const resp = await pageFetch<PlanSearchResponse>(page, { method: 'POST', path: p, body });
      if (!resp.plans || resp.plans.length === 0) break;
      for (const pl of resp.plans) {
        if (collected >= call.cap) break;
        out.push(pl);
        collected += 1;
      }
      if (resp.total_results != null && collected >= resp.total_results) break;
    }
  }
  return out;
}

// ─── Extraction helpers ───────────────────────────────────────────────

function pickNetwork(cs: CostSharing[]): CostSharing | null {
  return (
    cs.find((c) => c.network_status === 'IN_NETWORK') ??
    cs.find((c) => c.network_status === 'NO_NETWORK') ??
    cs.find((c) => c.network_status === 'OUT_OF_NETWORK') ??
    cs[0] ??
    null
  );
}

function copayOf(cs: CostSharing | null): number | null {
  if (!cs) return null;
  return cs.max_copay ?? cs.min_copay ?? null;
}

function coinsOf(cs: CostSharing | null): number | null {
  if (!cs) return null;
  return cs.max_coinsurance ?? cs.min_coinsurance ?? null;
}

function benefitByService(benefits: MaBenefit[], service: string): MaBenefit | null {
  return benefits.find((b) => b.service === service) ?? null;
}

function benefitCopayByService(benefits: MaBenefit[], service: string): number | null {
  const b = benefitByService(benefits, service);
  if (!b) return null;
  return copayOf(pickNetwork(b.cost_sharing ?? []));
}

function benefitCoinsByService(benefits: MaBenefit[], service: string): number | null {
  const b = benefitByService(benefits, service);
  if (!b) return null;
  return coinsOf(pickNetwork(b.cost_sharing ?? []));
}

function packageValue(pb: PackageBenefits | undefined, key: string): number | null {
  if (!pb) return null;
  const raw = pb[key];
  if (raw == null) return null;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'object' && 'value' in raw && typeof raw.value === 'number') {
    return raw.value;
  }
  return null;
}

// Parse "$5.00 copay" / "22% coinsurance". Returns {copay, coinsurance, isCoinsurance}.
function parseRxCell(cell: string | undefined): {
  copay: number | null;
  coinsurance: number | null;
  isCoinsurance: boolean;
} {
  if (!cell) return { copay: null, coinsurance: null, isCoinsurance: false };
  const s = cell.trim();
  if (!s) return { copay: null, coinsurance: null, isCoinsurance: false };
  const copayMatch = s.match(/\$\s*([\d,.]+)\s*copay/i);
  if (copayMatch) {
    const n = Number.parseFloat(copayMatch[1].replace(/,/g, ''));
    return { copay: Number.isFinite(n) ? n : null, coinsurance: null, isCoinsurance: false };
  }
  const coinsMatch = s.match(/([\d.]+)\s*%/);
  if (coinsMatch) {
    const n = Number.parseFloat(coinsMatch[1]);
    return { copay: null, coinsurance: Number.isFinite(n) ? n : null, isCoinsurance: true };
  }
  return { copay: null, coinsurance: null, isCoinsurance: false };
}

function emptyRxTier(): RxTierCostSharing {
  return {
    preferredPharmacy30: null,
    standardPharmacy30: null,
    preferredMailOrder90: null,
    standardMailOrder90: null,
    isCoinsurance: false,
  };
}

function extractRxTier(t: RxTier | undefined): RxTierCostSharing {
  if (!t) return emptyRxTier();
  const p30 = parseRxCell(t.preferred_retail?.days_30);
  const s30 = parseRxCell(t.standard_retail?.days_30);
  const pMail = parseRxCell(t.preferred_mail?.days_90 ?? t.preferred_retail?.days_90);
  const sMail = parseRxCell(t.standard_mail?.days_90 ?? t.standard_retail?.days_90);
  const anyCoins = p30.isCoinsurance || s30.isCoinsurance || pMail.isCoinsurance || sMail.isCoinsurance;
  return {
    preferredPharmacy30: p30.copay ?? p30.coinsurance,
    standardPharmacy30: s30.copay ?? s30.coinsurance,
    preferredMailOrder90: pMail.copay ?? pMail.coinsurance,
    standardMailOrder90: sMail.copay ?? sMail.coinsurance,
    isCoinsurance: anyCoins,
  };
}

function extractRxStructure(detail: PlanDetail): RxStructure {
  const tiers = detail.plan_card.abstract_benefits?.initial_coverage?.tiers ?? [];
  const byOrder = new Map<number, RxTier>();
  for (const t of tiers) byOrder.set(t.tier_row_order, t);
  const tier6 = byOrder.get(6);
  return {
    tier1: extractRxTier(byOrder.get(1)),
    tier2: extractRxTier(byOrder.get(2)),
    tier3: extractRxTier(byOrder.get(3)),
    tier4: extractRxTier(byOrder.get(4)),
    tier5: extractRxTier(byOrder.get(5)),
    tier6: tier6 ? extractRxTier(tier6) : null,
  };
}

// Extract inpatient tiered cost-sharing. Consumer scraper collapses to
// "first billed" for its per-benefit_type upsert; here we need the full
// per-day copay so the diff can compare tier-by-tier. We pick the
// smallest per-day copay > 0 as `perAdmissionCopay` when the plan bills
// per-admission (single tier), else null.
function extractInpatient(benefits: MaBenefit[]): InpatientCostSharing {
  const ip = benefitByService(benefits, 'INPATIENT_HOSPITAL');
  const psych = benefits.find(
    (b) => b.service === 'PSYCHIATRIC_HOSPITAL' || b.category === 'BENEFIT_MENTAL_HEALTH_INPATIENT',
  );
  const snf = benefits.find(
    (b) => b.service === 'SKILLED_NURSING_FACILITY' || b.category === 'BENEFIT_SKILLED_NURSING',
  );

  let perAdmissionCopay: number | null = null;
  let coinsurance: number | null = null;
  const perDayTiered: Array<{ dayRange: string; copay: number }> = [];
  if (ip) {
    const tiered = ip.tiered_cost_sharing?.in_network ?? [];
    for (const row of tiered) {
      if (row.copay != null && row.interval) {
        perDayTiered.push({ dayRange: row.interval, copay: row.copay });
      }
    }
    if (perDayTiered.length === 0) {
      perAdmissionCopay = copayOf(pickNetwork(ip.cost_sharing ?? []));
      coinsurance = coinsOf(pickNetwork(ip.cost_sharing ?? []));
    }
  }

  let snfDays1to20: number | null = null;
  let snfDays21to100: number | null = null;
  if (snf) {
    const rows = snf.tiered_cost_sharing?.in_network ?? [];
    for (const row of rows) {
      // SNF is universally billed as days 1-20 (usually $0) then 21-100.
      if (row.interval && row.copay != null) {
        if (row.interval.startsWith('1') && (row.interval.includes('-20') || row.interval.includes('-19'))) {
          snfDays1to20 = row.copay;
        } else if (row.interval.startsWith('21') || row.interval.startsWith('20')) {
          snfDays21to100 = row.copay;
        }
      }
    }
    if (snfDays1to20 == null && rows.length > 0 && rows[0].copay != null) {
      snfDays1to20 = rows[0].copay;
    }
    if (snfDays21to100 == null && rows.length > 1 && rows[1].copay != null) {
      snfDays21to100 = rows[1].copay;
    }
  }

  return {
    perAdmissionCopay,
    perDayTiered: perDayTiered.length > 0 ? perDayTiered : null,
    coinsurance,
    psychInpatientCopay: psych ? copayOf(pickNetwork(psych.cost_sharing ?? [])) : null,
    snfDays1to20,
    snfDays21to100,
  };
}

function extractOutpatient(benefits: MaBenefit[]): OutpatientCostSharing {
  return {
    pcpCopay: benefitCopayByService(benefits, 'SERVICE_PRIMARY'),
    specialistCopay: benefitCopayByService(benefits, 'SERVICE_SPECIALIST'),
    // ACA mandates $0 for in-network preventive; but capture MPF's value
    // so the diff can flag any plan that violates this.
    preventiveCopay: benefitCopayByService(benefits, 'SERVICE_PREVENTIVE') ?? 0,
    urgentCareCopay: benefitCopayByService(benefits, 'SERVICE_URGENT_CARE'),
    erCopay: benefitCopayByService(benefits, 'SERVICE_EMERGENCY'),
    ambulanceGroundCopay: benefitCopayByService(benefits, 'GROUND_AMBULANCE'),
    ambulanceAirCopay: benefitCopayByService(benefits, 'AIR_AMBULANCE'),
    outpatientSurgeryAsc: benefitCopayByService(benefits, 'SERVICE_OUTPATIENT_SURGERY_ASC'),
    outpatientSurgeryHospital: benefitCopayByService(benefits, 'SERVICE_OUTPATIENT_HOSPITAL_SERVICES'),
    diagnosticLabsCopay: benefitCopayByService(benefits, 'SERVICE_LAB_SERVICES'),
    diagnosticRadiologyCopay: benefitCopayByService(benefits, 'SERVICE_DIAGNOSTIC_RADIOLOGY_SERVICES'),
    advancedImagingCopay: benefitCopayByService(benefits, 'SERVICE_ADVANCED_IMAGING'),
    mhOutpatientIndividual: benefitCopayByService(benefits, 'SERVICE_MENTAL_HEALTH_INDIVIDUAL'),
    mhOutpatientGroup: benefitCopayByService(benefits, 'SERVICE_MENTAL_HEALTH_GROUP'),
    substanceAbuseCopay: benefitCopayByService(benefits, 'SERVICE_SUBSTANCE_ABUSE'),
  };
}

function extractTherapy(benefits: MaBenefit[]): TherapyAndDme {
  return {
    ptCopay: benefitCopayByService(benefits, 'SERVICE_PHYSICAL_THERAPY'),
    otCopay: benefitCopayByService(benefits, 'SERVICE_OCCUPATIONAL_THERAPY'),
    stCopay: benefitCopayByService(benefits, 'SERVICE_SPEECH_THERAPY'),
    cardiacRehabCopay: benefitCopayByService(benefits, 'SERVICE_CARDIAC_REHAB'),
    pulmonaryRehabCopay: benefitCopayByService(benefits, 'SERVICE_PULMONARY_REHAB'),
    dmeCoinsurance: benefitCoinsByService(benefits, 'SERVICE_DME'),
  };
}

function extractOtherMedical(benefits: MaBenefit[]): OtherMedical {
  return {
    homeHealthCopay: benefitCopayByService(benefits, 'SERVICE_HOME_HEALTH'),
    telehealthCopay: benefitCopayByService(benefits, 'TELEHEALTH'),
    partBDrugCoinsurance: benefitCoinsByService(benefits, 'SERVICE_PART_B_DRUGS'),
    dialysisCopay: benefitCopayByService(benefits, 'SERVICE_DIALYSIS'),
    skilledNursingHomeCopay: null,
    chiropracticCopay: benefitCopayByService(benefits, 'SERVICE_CHIROPRACTIC'),
    podiatryCopay: benefitCopayByService(benefits, 'SERVICE_PODIATRY'),
  };
}

// Post-IRA rx phases (C1, C2 in spec-corrections.md). We don't try to
// parse the ICL or coverage gap — those categories no longer exist.
// Catastrophic copays are $0 by law (IRA §11201). Part D vaccines $0
// per IRA §11401.
function extractRxPhases(detail: PlanDetail): RxPhases {
  const partDOopCap = packageValue(detail.plan_card.package_benefits, 'BENEFIT_PARTD_OOP_THRESHOLD');
  return {
    partDOopCap,
    catastrophicCopayGeneric: 0,
    catastrophicCopayBrand: 0,
    partDVaccinesZero: true,
  };
}

function extractDental(benefits: MaBenefit[]): DentalBenefits {
  const prev = benefits.find((b) => b.category === 'BENEFIT_PREVENTIVE_DENTAL');
  const compr = benefits.find((b) => b.category === 'BENEFIT_COMPREHENSIVE_DENTAL');
  const anyDental = prev ?? compr ?? null;
  let annualMax: number | null = null;
  if (anyDental) {
    for (const d of anyDental.plan_limits_details ?? []) {
      if (
        (d.limit_type === 'BENEFIT_LIMIT_TYPE_COVERAGE' ||
          d.limit_type === 'BENEFIT_LIMIT_TYPE_COMBINED_COVERAGE') &&
        d.limit_value != null
      ) {
        annualMax = d.limit_value;
        break;
      }
    }
  }
  return {
    preventiveCovered: prev != null,
    comprehensiveCovered: compr != null,
    annualMax,
    copay: prev ? copayOf(pickNetwork(prev.cost_sharing ?? [])) : null,
  };
}

function firstDollarLimit(details: MaBenefit['plan_limits_details']): number | null {
  if (!details) return null;
  for (const d of details) {
    if (
      d.limit_value != null &&
      d.limit_value > 0 &&
      (d.limit_type === 'BENEFIT_LIMIT_TYPE_COVERAGE' ||
        d.limit_type === 'BENEFIT_LIMIT_TYPE_COMBINED_COVERAGE' ||
        d.limit_type === 'BENEFIT_LIMIT_TYPE_DOLLAR')
    ) {
      return d.limit_value;
    }
  }
  return null;
}

function extractVision(benefits: MaBenefit[]): VisionBenefits {
  const exam = benefits.find((b) => b.service === 'VISION_ROUTINE_EYE_EXAMS');
  const eyewear = benefits.find(
    (b) => b.service === 'VISION_EYEGLASSES_FRAMES' || b.service === 'VISION_EYEGLASSES_LENSES',
  );
  const contacts = benefits.find((b) => b.service === 'VISION_CONTACT_LENSES');
  return {
    routineExamCovered: exam != null,
    eyewearAllowance: eyewear ? firstDollarLimit(eyewear.plan_limits_details) : null,
    contactLensAllowance: contacts ? firstDollarLimit(contacts.plan_limits_details) : null,
    examCopay: exam ? copayOf(pickNetwork(exam.cost_sharing ?? [])) : null,
  };
}

function extractHearing(benefits: MaBenefit[]): HearingBenefits {
  const exam = benefits.find((b) => b.service === 'ROUTINE_HEARING_EXAMS');
  const aids = benefits.find(
    (b) => b.service === 'OTC_HEARING_AIDS' || b.service === 'RX_HEARING_AIDS',
  );
  return {
    routineExamCovered: exam != null,
    hearingAidBenefit: aids ? firstDollarLimit(aids.plan_limits_details) : null,
    examCopay: exam ? copayOf(pickNetwork(exam.cost_sharing ?? [])) : null,
  };
}

const LIMIT_PERIOD_TO_ENUM: Record<string, 'monthly' | 'quarterly'> = {
  BENEFIT_LIMIT_PERIOD_EVERY_MONTH: 'monthly',
  BENEFIT_LIMIT_PERIOD_EVERY_QUARTER: 'quarterly',
};

function extractSupplemental(benefits: MaBenefit[]): SupplementalBenefits {
  const otc = benefits.find((b) => b.service === 'OTC_ITEMS');
  const food = benefits.find((b) => b.service === 'FOOD_PRODUCE');
  const transport = benefits.find((b) => b.category === 'BENEFIT_TRANSPORTATION' || b.service === 'TRANSPORTATION');
  const meals = benefits.find((b) => b.service === 'MEALS_SHORT_DURATION');
  const fitness = benefits.find((b) => b.service === 'FITNESS');
  const telehealth = benefits.find((b) => b.service === 'TELEHEALTH');
  const acupuncture = benefits.find((b) => b.service === 'ACUPUNCTURE');
  const inHome = benefits.find(
    (b) => b.service === 'IN_HOME_SUPPORT' || b.category === 'BENEFIT_IN_HOME_SUPPORT',
  );

  let otcAllowance: number | null = null;
  let otcPeriod: 'monthly' | 'quarterly' | null = null;
  if (otc) {
    for (const d of otc.plan_limits_details ?? []) {
      if (d.limit_value != null && d.limit_value > 0) {
        otcAllowance = d.limit_value;
        otcPeriod = d.limit_period ? LIMIT_PERIOD_TO_ENUM[d.limit_period] ?? null : null;
        break;
      }
    }
  }

  let transportationTrips: number | null = null;
  if (transport) {
    for (const d of transport.plan_limits_details ?? []) {
      if (d.limit_type === 'BENEFIT_LIMIT_TYPE_QUANTITY' && d.limit_value != null) {
        transportationTrips = d.limit_value;
        break;
      }
    }
  }

  let mealsDesc: string | null = null;
  if (meals) {
    const qty = meals.plan_limits_details?.find(
      (d) => d.limit_type === 'BENEFIT_LIMIT_TYPE_QUANTITY' && d.limit_value != null,
    );
    if (qty && qty.limit_value != null) {
      mealsDesc = `${qty.limit_value} meals${qty.limit_period ? ` (${qty.limit_period})` : ''}`;
    }
  }

  let acupunctureVisits: number | null = null;
  if (acupuncture) {
    const q = acupuncture.plan_limits_details?.find(
      (d) => d.limit_type === 'BENEFIT_LIMIT_TYPE_QUANTITY' && d.limit_value != null,
    );
    acupunctureVisits = q?.limit_value ?? null;
  }

  let inHomeHours: number | null = null;
  if (inHome) {
    const q = inHome.plan_limits_details?.find(
      (d) => d.limit_type === 'BENEFIT_LIMIT_TYPE_QUANTITY' && d.limit_value != null,
    );
    inHomeHours = q?.limit_value ?? null;
  }

  return {
    otcAllowance,
    otcAllowancePeriod: otcPeriod,
    transportationTripsPerYear: transportationTrips,
    mealsPostDischarge: mealsDesc,
    fitnessBenefit: fitness ? 'included' : null,
    telehealthAccess: telehealth != null,
    foodCardMonthly: food ? firstDollarLimit(food.plan_limits_details) : null,
    caregiverSupport: null,
    inHomeSupportHoursPerMonth: inHomeHours,
    acupunctureVisitsPerYear: acupunctureVisits,
    worldwideEmergency: null,
    nurseHotline: null,
  };
}

// Drug coverage — TODO: MPF's per-drug formulary lookup requires a
// separate endpoint whose exact contract we haven't reverse-engineered
// yet. The consumer scraper doesn't need it (it just extracts tier-
// level cost-sharing) so there's no precedent to port. Two plausible
// endpoints observed in the SPA:
//   GET /api/v1/data/plan-compare/plan/{year}/{c}/{p}/{s}/formulary?rxcui=…
//   POST /api/v1/data/plan-compare/plan/{year}/{c}/{p}/{s}/drug-costs
// Both require rxcui, which we don't currently resolve from the profile
// drug name/strength. Stub to [] and let the diff engine mark the
// drug-coverage subsection as N/A for now. When we add RxNorm resolution
// (or the SPA reveals a name-based lookup), populate here.
function extractDrugCoverage(_detail: PlanDetail, _profile: BeneficiaryProfile): DrugCoverage[] {
  // TODO(formulary): implement per-drug formulary lookup once endpoint
  // + rxcui resolution are in place. See header comment above.
  return [];
}

// MPF returns segment_id as 1-digit (e.g. "0", "2"); Plan Match stores it
// as 3-digit zero-padded ("000", "002"). Normalize to PM's canonical form
// so PlanSnapshot.ident matches across both sources for the pairing key
// in run.ts. plan_id from MPF is already 3-digit padded.
function padSegmentId(id: string): string {
  return id.padStart(3, '0');
}

function extractIdent(summary: PlanSummary, detail: PlanDetail): PlanIdentification {
  const card = detail.plan_card;
  return {
    planName: card.name ?? summary.name,
    contractId: card.contract_id ?? summary.contract_id,
    planId: card.plan_id ?? summary.plan_id,
    segmentId: padSegmentId(card.segment_id ?? summary.segment_id),
    planType: card.plan_type ?? summary.plan_type,
    starRating: card.overall_star_rating?.rating ?? summary.overall_star_rating?.rating ?? null,
    orgName: card.organization_name ?? summary.organization_name,
  };
}

function extractPremium(summary: PlanSummary, detail: PlanDetail): PremiumAndDeductible {
  const card = detail.plan_card;
  const pb = card.package_benefits;
  return {
    monthlyPremium: card.monthly_premium ?? summary.monthly_premium ?? null,
    partBPremiumReduction: card.partb_premium_reduction ?? summary.partb_premium_reduction ?? null,
    partDPremium: card.partd_premium ?? summary.partd_premium ?? null,
    medicalDeductibleIN: packageValue(pb, 'BENEFIT_MEDICAL_DEDUCTIBLE'),
    medicalDeductibleOON: packageValue(pb, 'BENEFIT_MEDICAL_DEDUCTIBLE_OON'),
    partDDrugDeductible: card.drug_plan_deductible ?? summary.drug_plan_deductible ?? null,
    drugDeductibleTierExceptions: null,
    annualMoopIN: packageValue(pb, 'BENEFIT_MAXIMUM_OOPC'),
  };
}

function toSnapshot(
  profile: BeneficiaryProfile,
  summary: PlanSummary,
  detail: PlanDetail,
): PlanSnapshot {
  const benefits = detail.plan_card.ma_benefits ?? [];
  return {
    source: 'mpf',
    capturedAt: new Date().toISOString(),
    profileId: profile.id,
    ident: extractIdent(summary, detail),
    premium: extractPremium(summary, detail),
    inpatient: extractInpatient(benefits),
    outpatient: extractOutpatient(benefits),
    therapy: extractTherapy(benefits),
    otherMedical: extractOtherMedical(benefits),
    rxStructure: extractRxStructure(detail),
    rxPhases: extractRxPhases(detail),
    drugCoverage: extractDrugCoverage(detail, profile),
    dental: extractDental(benefits),
    vision: extractVision(benefits),
    hearing: extractHearing(benefits),
    supplemental: extractSupplemental(benefits),
  };
}

// ─── Cache ────────────────────────────────────────────────────────────

function profileCacheDir(profileId: string): string {
  return path.join(CACHE_ROOT, profileId);
}

function snapshotCachePath(profileId: string): string {
  return path.join(profileCacheDir(profileId), 'snapshot.json');
}

function detailCachePath(profileId: string, contract: string, plan: string, segment: string): string {
  return path.join(profileCacheDir(profileId), `${contract}-${plan}-${segment}.json`);
}

function readCachedSnapshots(profileId: string): PlanSnapshot[] | null {
  const p = snapshotCachePath(profileId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as PlanSnapshot[];
  } catch {
    return null;
  }
}

function writeCachedSnapshots(profileId: string, snapshots: PlanSnapshot[]): void {
  mkdirSync(profileCacheDir(profileId), { recursive: true });
  writeFileSync(snapshotCachePath(profileId), JSON.stringify(snapshots, null, 2));
}

function readCachedDetail(profileId: string, c: string, p: string, s: string): PlanDetail | null {
  const fp = detailCachePath(profileId, c, p, s);
  if (!existsSync(fp)) return null;
  try {
    return JSON.parse(readFileSync(fp, 'utf8')) as PlanDetail;
  } catch {
    return null;
  }
}

function writeCachedDetail(
  profileId: string,
  c: string,
  p: string,
  s: string,
  detail: PlanDetail,
): void {
  mkdirSync(profileCacheDir(profileId), { recursive: true });
  writeFileSync(detailCachePath(profileId, c, p, s), JSON.stringify(detail, null, 2));
}

// ─── Public entrypoint ───────────────────────────────────────────────

export interface ScrapeMpfOptions {
  useCache?: boolean;
  refreshCache?: boolean;
  maxMapdPlans?: number;
  maxPdpPlans?: number;
}

export async function scrapeMpfSnapshot(
  profile: BeneficiaryProfile,
  opts: ScrapeMpfOptions = {},
): Promise<PlanSnapshot[]> {
  const useCache = opts.useCache ?? true;
  const refreshCache = opts.refreshCache ?? false;
  const maxMapd = opts.maxMapdPlans ?? DEFAULT_MAX_MAPD;
  const maxPdp = opts.maxPdpPlans ?? DEFAULT_MAX_PDP;

  if (useCache && !refreshCache) {
    const cached = readCachedSnapshots(profile.id);
    if (cached && cached.length > 0) return cached;
  }

  let session: BrowserSession | null = null;
  try {
    session = await bootstrapWithBackoff(profile.countyFips, profile.zip);

    let summaries: PlanSummary[] = [];
    try {
      summaries = await fetchPlans(session.page, profile, maxMapd, maxPdp);
    } catch (err) {
      if (err instanceof AkamaiBlocked) {
        // One rotation retry — mirror the consumer scraper's per-county
        // retry loop, but scoped to this profile.
        await session.close();
        session = await bootstrapWithBackoff(profile.countyFips, profile.zip);
        summaries = await fetchPlans(session.page, profile, maxMapd, maxPdp);
      } else {
        throw err;
      }
    }

    const snapshots: PlanSnapshot[] = [];
    const lis = lisEnum(profile);
    for (const summary of summaries) {
      const cachedDetail =
        useCache && !refreshCache
          ? readCachedDetail(profile.id, summary.contract_id, summary.plan_id, summary.segment_id)
          : null;
      let detail: PlanDetail | null = cachedDetail;
      if (!detail) {
        const detailPath = `${API_BASE}/plan/${YEAR}/${summary.contract_id}/${summary.plan_id}/${summary.segment_id}?lis=${lis}`;
        try {
          detail = await pageFetch<PlanDetail>(session.page, { method: 'GET', path: detailPath });
        } catch (err) {
          if (err instanceof AkamaiBlocked) {
            await session.close();
            session = await bootstrapWithBackoff(profile.countyFips, profile.zip);
            detail = await pageFetch<PlanDetail>(session.page, { method: 'GET', path: detailPath });
          } else {
            throw err;
          }
        }
        writeCachedDetail(profile.id, summary.contract_id, summary.plan_id, summary.segment_id, detail);
      }

      snapshots.push(toSnapshot(profile, summary, detail));
      await sleep(INTER_PLAN_DELAY_MS);
    }

    writeCachedSnapshots(profile.id, snapshots);
    return snapshots;
  } finally {
    if (session) {
      try { await session.close(); } catch (err) { console.warn('close failed:', err); }
    }
  }
}

async function bootstrapWithBackoff(fips: string, zip: string): Promise<BrowserSession> {
  let lastErr: unknown = null;
  for (let i = 0; i <= STARTUP_BACKOFFS_MS.length; i += 1) {
    try {
      return await bootstrapBrowser(fips, zip);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof AkamaiBlocked) || i === STARTUP_BACKOFFS_MS.length) break;
      const wait = STARTUP_BACKOFFS_MS[i];
      console.warn(
        `[mpf-scrape] bootstrap blocked. Waiting ${wait / 1000}s (attempt ${i + 2}/${STARTUP_BACKOFFS_MS.length + 1})`,
      );
      await sleep(wait);
      await sleep(ROTATION_COOLDOWN_MS);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
