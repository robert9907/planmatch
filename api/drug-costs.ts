// POST /api/drug-costs
//
// Body:
//   {
//     plans:         [{ contract_id, plan_id, segment_id, contract_year }],
//     prescriptions: [{ ndc, quantity, frequency }],  // frequency = FREQUENCY_30_DAYS | FREQUENCY_90_DAYS
//     retail_only?:  boolean     // false = allow mail-order prices
//     lis?:          string      // defaults LIS_NO_HELP
//     npis?:         string[]    // preferred pharmacy NPIs (optional)
//   }
//
// Resp: { source, costs: [{ contract_id, plan_id, segment_id, monthly_cost, annual_cost, ... }] }
//
// Server-side Playwright session that warms Akamai (GET /plan-compare/ →
// wait for `_abck` + `bm_sz` sensor cookies) and then replays the drug
// cost request via `page.request.post()` — the only approach that gets
// past Akamai's fetch instrumentation. Results cache 24h in
// drug_cost_cache keyed on a sha256 of the canonical request. A 429
// from upstream short-circuits to a 5-minute cache so we don't hammer
// the origin while rate-limited.
//
// Runtime: playwright-core + @sparticuz/chromium — the standard
// Vercel-compatible pairing. maxDuration bumped to 60s (default from
// vercel.json). Cold start adds 1-3s; warmed instance reuses across
// concurrent Fluid Compute invocations.

import crypto from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';
import { supabase } from './_lib/supabase.js';

export const config = { maxDuration: 60 };

const ENDPOINT = 'https://www.medicare.gov/api/v1/data/plan-compare/drugs/cost';
const FORMS_BASE = 'https://www.medicare.gov/api/v1/data/plan-compare/drugs';
const WARM_URL = 'https://www.medicare.gov/plan-compare/';
const COOKIE_WARM_MS = 6_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// medicare.gov SPA ships a build version header on every XHR. Stale
// values still work but the server logs a warning; keeping this in sync
// with the real SPA avoids that and lowers odds of being fingerprinted.
const FE_VER = '2.69.0';

const CACHE_TTL_SEC = 24 * 3600;
const RATE_LIMIT_TTL_SEC = 5 * 60;
const ERROR_TTL_SEC = 5 * 60;
// medicare.gov accepts multi-plan requests in a single body. Six
// finalists is the v4 table max, so one batch handles a whole quote.
// Kept as a guard so the function doesn't fire a giant payload if a
// future caller passes 50 plans.
const MAX_PLANS_PER_BATCH = 10;
const BATCH_DELAY_MS = 2_000;

interface PlanInput {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  contract_year: string;
}
interface PrescriptionInput {
  ndc: string;
  quantity: string;
  frequency: 'FREQUENCY_30_DAYS' | 'FREQUENCY_90_DAYS';
  /** Other NDCs for the same drug, in order. medicare.gov silently drops an
   *  NDC it doesn't recognize; the next alternate is tried in its place. */
  alternates?: string[];
  /** RxNorm id of the exact drug. Used to ask medicare.gov which NDC it
   *  prices for this drug, so a repackager code it doesn't know is never
   *  the one we send. */
  rxcui?: string;
}

/** One prescription's current NDC plus the alternates not yet tried.
 *  `origin` is the NDC the caller sent; responses are reported back under it. */
export interface NdcSlot {
  ndc: string;
  alternates: string[];
  origin?: string;
}

interface FormsResponse {
  dosages?: Array<{ rxcui?: string; packages?: Array<{ ndc?: string }> }>;
}

/** The NDC medicare.gov itself uses for this exact rxcui (first package of
 *  the matching dosage). Null when it lists no dosage for that rxcui — never
 *  borrowed from a different strength. */
export function medicareNdcFor(forms: FormsResponse | null | undefined, rxcui: string): string | null {
  const dosage = forms?.dosages?.find((d) => String(d.rxcui ?? '') === rxcui);
  const ndc = dosage?.packages?.map((p) => String(p.ndc ?? '')).find((n) => /^\d{11}$/.test(n));
  return ndc ?? null;
}

/** Make medicare.gov's NDC the one sent; the caller's NDC becomes the first
 *  alternate. */
export function preferNdc(slot: NdcSlot, ndc: string): void {
  if (slot.ndc === ndc) return;
  slot.alternates = [slot.ndc, ...slot.alternates.filter((n) => n !== ndc)];
  slot.ndc = ndc;
}

/** Report every drug cost under the NDC the caller sent, so callers that key
 *  results by their own NDCs still find a drug priced under a substitute. */
export function restoreOriginNdcs(data: Record<string, unknown>, slots: NdcSlot[]): void {
  const back = new Map<string, string>();
  for (const s of slots) if (s.origin && s.origin !== s.ndc) back.set(s.ndc, s.origin);
  if (back.size === 0) return;
  const plans = (Array.isArray(data.plans) ? data.plans : []) as Array<Record<string, unknown>>;
  for (const p of plans) {
    for (const c of (Array.isArray(p.costs) ? p.costs : []) as Array<Record<string, unknown>>) {
      for (const d of (Array.isArray(c.drug_costs) ? c.drug_costs : []) as Array<Record<string, unknown>>) {
        const o = typeof d.ndc === 'string' ? back.get(d.ndc) : undefined;
        if (o) d.ndc = o;
      }
    }
  }
}

const MAX_ALTERNATES = 5;
const MAX_NDC_ROUNDS = 3;

/** Swap every slot whose NDC medicare.gov did not price for its next
 *  alternate. Returns true when anything changed (another round is worth it). */
export function swapUnpricedNdcs(slots: NdcSlot[], priced: Set<string>): boolean {
  let changed = false;
  for (const slot of slots) {
    if (priced.has(slot.ndc)) continue;
    const next = slot.alternates.shift();
    if (next) {
      slot.ndc = next;
      changed = true;
    }
  }
  return changed;
}

/** NDCs medicare.gov priced anywhere in a response (recognition is a drug-
 *  database property, not plan-specific). */
function pricedNdcs(data: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const plans = (Array.isArray(data.plans) ? data.plans : []) as Array<Record<string, unknown>>;
  for (const p of plans) {
    for (const c of (Array.isArray(p.costs) ? p.costs : []) as Array<Record<string, unknown>>) {
      for (const d of (Array.isArray(c.drug_costs) ? c.drug_costs : []) as Array<Record<string, unknown>>) {
        if (typeof d.ndc === 'string') out.add(d.ndc);
      }
    }
  }
  return out;
}
interface DrugCostBody {
  plans: PlanInput[];
  prescriptions: PrescriptionInput[];
  retail_only: boolean;
  lis: string;
  npis: string[];
}

interface PlanDrugCost {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  monthly_cost: number | null;
  annual_cost: number | null;
  deductible: unknown;
  /** Requested NDCs this plan's response did not price. Non-empty means the
   *  total would leave those drugs out, so annual/monthly are null. */
  unpriced_ndcs: string[];
  raw: unknown;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  const raw = (req.body ?? {}) as Partial<DrugCostBody>;
  if (!Array.isArray(raw.plans) || raw.plans.length === 0) return badRequest(res, 'plans required');
  if (!Array.isArray(raw.prescriptions) || raw.prescriptions.length === 0)
    return badRequest(res, 'prescriptions required');

  const defaultYear = String(new Date().getFullYear());
  const plans: PlanInput[] = raw.plans.map((p) => ({
    contract_id: String((p as PlanInput).contract_id ?? ''),
    plan_id: String((p as PlanInput).plan_id ?? ''),
    segment_id: String((p as PlanInput).segment_id ?? '0'),
    contract_year: String((p as PlanInput).contract_year ?? defaultYear),
  }));
  const prescriptions: PrescriptionInput[] = raw.prescriptions.map((p) => ({
    ndc: String((p as PrescriptionInput).ndc ?? ''),
    alternates: (Array.isArray((p as PrescriptionInput).alternates)
      ? ((p as PrescriptionInput).alternates as unknown[]).map(String)
      : []
    )
      .filter((n, i, arr) => /^\d{11}$/.test(n) && n !== String((p as PrescriptionInput).ndc ?? '') && arr.indexOf(n) === i)
      .slice(0, MAX_ALTERNATES),
    // medicare.gov's quantity is an int32; a fractional value (42.5 g of
    // cream) fails the whole request, so round up.
    rxcui: /^\d+$/.test(String((p as PrescriptionInput).rxcui ?? '')) ? String((p as PrescriptionInput).rxcui) : undefined,
    quantity: String(Math.max(1, Math.ceil(Number((p as PrescriptionInput).quantity ?? '30') || 30))),
    frequency:
      (p as PrescriptionInput).frequency === 'FREQUENCY_90_DAYS'
        ? 'FREQUENCY_90_DAYS'
        : 'FREQUENCY_30_DAYS',
  }));
  if (plans.some((p) => !p.contract_id || !p.plan_id))
    return badRequest(res, 'each plan needs contract_id and plan_id');
  if (prescriptions.some((p) => !p.ndc)) return badRequest(res, 'each prescription needs ndc');

  const body: DrugCostBody = {
    plans,
    prescriptions,
    retail_only: raw.retail_only === true,
    lis: typeof raw.lis === 'string' ? raw.lis : 'LIS_NO_HELP',
    npis: Array.isArray(raw.npis) ? raw.npis.map(String) : [],
  };
  // v2: parser rewrite (2026-10-20). Entries cached by the old parser hold
  // blank plan ids / null totals; versioning the key skips them.
  // v4: medicare.gov's own NDC per rxcui (2026-10-21).
  const cacheKey = sha256(`v4::${canonicalize(body)}`);
  const sb = supabase();

  // ─── Cache hit? ────────────────────────────────────────────────────
  try {
    const { data, error } = await sb
      .from('drug_cost_cache')
      .select('payload, source, expires_at')
      .eq('cache_key', cacheKey)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (error && error.code !== 'PGRST205' && error.code !== '42P01') {
      console.warn('[drug-costs] cache read error:', error.message);
    }
    if (data) {
      const payload = (data as { payload: { costs: PlanDrugCost[] }; source: string }).payload;
      return sendJson(res, 200, {
        source: `cache:${(data as { source: string }).source}`,
        costs: payload.costs ?? [],
      });
    }
  } catch (err) {
    console.warn('[drug-costs] cache lookup threw:', (err as Error).message);
  }

  // ─── Live fetch ────────────────────────────────────────────────────
  let result: { source: 'live' | 'rate_limited'; costs: PlanDrugCost[] };
  try {
    result = await fetchDrugCostsShared(cacheKey, body);
  } catch (err) {
    const expires = new Date(Date.now() + ERROR_TTL_SEC * 1000).toISOString();
    try {
      await sb
        .from('drug_cost_cache')
        .upsert(
          {
            cache_key: cacheKey,
            payload: { costs: [], error: (err as Error).message },
            source: 'error',
            expires_at: expires,
          },
          { onConflict: 'cache_key' },
        );
    } catch {
      // Cache write failure is non-fatal; surface the upstream error.
    }
    return serverError(res, err);
  }

  // ─── Upsert cache ──────────────────────────────────────────────────
  const ttlSec = result.source === 'rate_limited' ? RATE_LIMIT_TTL_SEC : CACHE_TTL_SEC;
  const expires = new Date(Date.now() + ttlSec * 1000).toISOString();
  try {
    await sb
      .from('drug_cost_cache')
      .upsert(
        {
          cache_key: cacheKey,
          payload: { costs: result.costs },
          source: result.source,
          expires_at: expires,
        },
        { onConflict: 'cache_key' },
      );
  } catch (err) {
    console.warn('[drug-costs] cache write failed:', (err as Error).message);
  }

  return sendJson(res, 200, { source: result.source, costs: result.costs });
}

// ─── canonicalization + hashing ────────────────────────────────────────

function canonicalize(body: DrugCostBody): string {
  const plans = [...body.plans]
    .map((p) => `${p.contract_id}-${p.plan_id}-${p.segment_id}-${p.contract_year}`)
    .sort()
    .join('|');
  const rx = [...body.prescriptions]
    .map((p) => `${p.ndc}:${p.quantity}:${p.frequency}:${(p.alternates ?? []).join('+')}:${p.rxcui ?? ''}`)
    .sort()
    .join(',');
  const npis = [...body.npis].sort().join(',');
  return `${plans}::${rx}::retail=${body.retail_only ? 1 : 0}::lis=${body.lis}::npis=${npis}`;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ─── Playwright fetch ──────────────────────────────────────────────────

// A fresh Chromium per medicare.gov session, closed afterwards. A browser
// shared across invocations died between requests on Vercel (sparticuz runs
// Chromium single-process; closing a context takes the browser down) and a
// relaunch in the same instance failed the same way (2026-10-21). Sessions
// are serialized per instance and identical requests share one fetch, which
// is what fixed the ERR_INSUFFICIENT_RESOURCES overload — not the sharing.
async function launchBrowser() {
  const { chromium } = await import('playwright-core');
  const sparticuz = (await import('@sparticuz/chromium')).default;
  const executablePath = await sparticuz.executablePath();
  return chromium.launch({ args: sparticuz.args, executablePath, headless: true });
}

// Serialize medicare.gov sessions within an instance (one page at a time).
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

// Identical requests that arrive together share one live fetch.
const inFlight = new Map<string, Promise<{ source: 'live' | 'rate_limited'; costs: PlanDrugCost[] }>>();

function fetchDrugCostsShared(
  key: string,
  body: DrugCostBody,
): Promise<{ source: 'live' | 'rate_limited'; costs: PlanDrugCost[] }> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = serialized(() => fetchDrugCosts(body)).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function fetchDrugCosts(
  body: DrugCostBody,
): Promise<{ source: 'live' | 'rate_limited'; costs: PlanDrugCost[] }> {
  const browser = await launchBrowser();
  const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US' });
  const page = await ctx.newPage();
  try {

    await page.goto(WARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Akamai's _abck sensor script runs async post-DOMContentLoaded.
    // Real-browser sensors complete within ~3s — 6s is a safety buffer.
    await page.waitForTimeout(COOKIE_WARM_MS);

    // medicare.gov only prices retail for a chosen pharmacy (npis). With no
    // pharmacy, a retail-only request prices nothing, so ask for both
    // channels and take the lowest valid total.
    const retailOnly = body.retail_only && body.npis.length > 0;

    // Working NDC per prescription. Recognition is plan-independent, so once
    // a batch settles which NDC medicare.gov prices, later batches reuse it.
    const slots: NdcSlot[] = body.prescriptions.map((p) => ({
      ndc: p.ndc,
      alternates: [...(p.alternates ?? [])],
      origin: p.ndc,
    }));
    const origins = () => slots.map((slot) => slot.origin ?? slot.ndc);

    const apiHeaders = {
      Accept: 'application/json',
      Referer: 'https://www.medicare.gov/plan-compare/',
      'fe-ver': FE_VER,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    };

    // Send the NDC medicare.gov itself lists for each rxcui. RxNorm's NDC
    // list is mostly repackager codes medicare.gov doesn't recognize
    // (hydrocodone-APAP 10-325: 313 codes, medicare.gov's is #50), so
    // guessing from that list left common generics unpriced.
    const year = body.plans[0]?.contract_year ?? String(new Date().getFullYear());
    await Promise.all(
      body.prescriptions.map(async (p, k) => {
        if (!p.rxcui) return;
        try {
          const r = await page.request.get(
            `${FORMS_BASE}/${encodeURIComponent(p.rxcui)}/forms?year=${encodeURIComponent(year)}`,
            { headers: apiHeaders },
          );
          if (!r.ok()) return;
          const ndc = medicareNdcFor((await r.json()) as FormsResponse, p.rxcui);
          if (ndc) preferNdc(slots[k], ndc);
        } catch {
          // Lookup failure leaves the caller's NDCs in place.
        }
      }),
    );

    const post = async (plans: PlanInput[]) => {
      const reqBody = {
        npis: body.npis,
        prescriptions: slots.map((slot, k) => ({
          ndc: slot.ndc,
          quantity: body.prescriptions[k].quantity,
          frequency: body.prescriptions[k].frequency,
        })),
        lis: body.lis,
        full_year: false,
        retailOnly: retailOnly,
        plans,
      };
      const traceId = [...Array(32)]
        .map(() => Math.floor(Math.random() * 16).toString(16))
        .join('');
      const spanId = [...Array(16)]
        .map(() => Math.floor(Math.random() * 16).toString(16))
        .join('');
      return page.request.post(ENDPOINT, {
        data: reqBody,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Origin: 'https://www.medicare.gov',
          Referer: 'https://www.medicare.gov/plan-compare/',
          'fe-ver': FE_VER,
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
          traceparent: `00-${traceId}-${spanId}-01`,
        },
      });
    };

    const batches: PlanInput[][] = [];
    for (let i = 0; i < body.plans.length; i += MAX_PLANS_PER_BATCH) {
      batches.push(body.plans.slice(i, i + MAX_PLANS_PER_BATCH));
    }

    const costs: PlanDrugCost[] = [];
    let anyRateLimited = false;

    for (let i = 0; i < batches.length; i++) {
      if (i > 0) await page.waitForTimeout(BATCH_DELAY_MS);
      const resp = await post(batches[i]);
      const status = resp.status();
      if (status === 429) {
        anyRateLimited = true;
        console.warn('[drug-costs] 429 from medicare.gov — caching short-TTL and bailing');
        break;
      }
      // medicare.gov 404s the WHOLE batch ("Plan not found") when any one
      // plan is unknown to it. Retry plan-by-plan so the rest still price;
      // an unknown plan is simply left out (its cost stays unknown).
      if (status === 404 && batches[i].length > 1) {
        console.warn(`[drug-costs] batch 404 — retrying ${batches[i].length} plans individually`);
        for (const plan of batches[i]) {
          const one = await post([plan]);
          if (one.status() === 429) { anyRateLimited = true; break; }
          if (!one.ok()) continue;
          const oneData = (await one.json()) as Record<string, unknown>;
          restoreOriginNdcs(oneData, slots);
          costs.push(...extractCosts(oneData, retailOnly, origins()));
        }
        if (anyRateLimited) break;
        continue;
      }
      if (!resp.ok()) {
        const preview = (await resp.text()).slice(0, 300);
        throw new Error(`medicare.gov ${status}: ${preview}`);
      }
      let data = (await resp.json()) as Record<string, unknown>;
      // medicare.gov silently drops an NDC it doesn't recognize and totals
      // the rest. Swap each unpriced NDC for its next alternate and re-ask,
      // so the drug is counted instead of quietly left out.
      for (let round = 0; round < MAX_NDC_ROUNDS; round++) {
        const priced = pricedNdcs(data);
        // Nothing priced at all is not an NDC-recognition problem (e.g. no
        // pharmacy for a retail price) — swapping every NDC would just burn
        // the alternates. Only swap when some drugs priced and others didn't.
        if (priced.size === 0) break;
        if (!swapUnpricedNdcs(slots, priced)) break;
        console.info(`[drug-costs] unpriced NDC — retrying with alternates: ${slots.map((x) => x.ndc).join(',')}`);
        const retry = await post(batches[i]);
        if (retry.status() === 429) { anyRateLimited = true; break; }
        if (!retry.ok()) break;
        data = (await retry.json()) as Record<string, unknown>;
      }
      restoreOriginNdcs(data, slots);
      costs.push(...extractCosts(data, retailOnly, origins()));
      if (anyRateLimited) break;
    }

    return {
      source: anyRateLimited && costs.length === 0 ? 'rate_limited' : 'live',
      costs,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── response parsing ──────────────────────────────────────────────────
//
// medicare.gov returns a plans[] array (confirmed from HAR capture) but
// the field names for per-plan totals aren't stable across releases —
// different endpoints use `monthly_cost`, `avg_monthly_cost`, or nested
// `plan_year_costs.total_annual_cost`. Read everything tolerantly and
// fall back to scanning for any number-shaped total in a known set of
// keys. Surface the raw plan object too so the frontend can introspect
// if a future call shows a new shape.

export function extractCosts(
  data: Record<string, unknown>,
  retailOnly: boolean,
  requestedNdcs: string[] = [],
): PlanDrugCost[] {
  const list =
    (Array.isArray(data.plans) && (data.plans as unknown[])) ||
    (Array.isArray(data.plan_costs) && (data.plan_costs as unknown[])) ||
    [];
  return list.map((p) => extractPlanCost(p as Record<string, unknown>, retailOnly, requestedNdcs));
}

const numeric = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function extractPlanCost(
  p: Record<string, unknown>,
  retailOnly: boolean,
  requestedNdcs: string[],
): PlanDrugCost {
  // Current (2027) shape: { plan: {contract_id, plan_id, segment_id},
  // costs: [{ mail_order, drug_costs[], estimated_yearly_total,
  // phase_information: {deductible_amount} }], lowest_retail_total,
  // lowest_mail_total, lowest_retail_valid, lowest_mail_valid }.
  // Legacy flat fields are still read as a fallback.
  const plan = (p.plan && typeof p.plan === 'object' ? p.plan : p) as Record<string, unknown>;
  const yearCosts = (p.plan_year_costs ?? p.planYearCosts) as Record<string, unknown> | undefined;
  const pharmacyCosts = (Array.isArray(p.costs) ? p.costs : []) as Array<Record<string, unknown>>;

  // Annual: lowest VALID total for the allowed channels. An invalid / unpriced
  // channel reports 0 — that is "no price", never "$0", so it is skipped and
  // the plan stays unknown (null) rather than looking free.
  const totals: number[] = [];
  const retail = numeric(p.lowest_retail_total);
  const mail = numeric(p.lowest_mail_total);
  if (p.lowest_retail_valid === true && retail != null) totals.push(retail);
  if (!retailOnly && p.lowest_mail_valid === true && mail != null) totals.push(mail);
  if (totals.length === 0) {
    for (const c of pharmacyCosts) {
      if (retailOnly && c.mail_order === true) continue;
      const priced = Array.isArray(c.drug_costs) && c.drug_costs.length > 0;
      const yr = numeric(c.estimated_yearly_total);
      if (priced && yr != null) totals.push(yr);
    }
  }
  const legacyAnnual =
    numeric(p.annual_cost) ??
    numeric(p.annual_drug_cost) ??
    numeric(p.total_drug_cost) ??
    numeric(yearCosts?.total_annual_cost) ??
    numeric(yearCosts?.total_cost) ??
    numeric(yearCosts?.annual_cost) ??
    null;
  const legacyMonthly =
    numeric(p.monthly_cost) ??
    numeric(p.avg_monthly_cost) ??
    numeric(p.monthly_drug_cost) ??
    numeric(yearCosts?.avg_monthly_cost) ??
    numeric(yearCosts?.monthly_cost) ??
    null;
  // Every requested drug must be priced for this plan; otherwise the total
  // silently leaves drugs out, so it is unknown rather than too low.
  const pricedHere = new Set<string>();
  for (const c of pharmacyCosts) {
    for (const d of (Array.isArray(c.drug_costs) ? c.drug_costs : []) as Array<Record<string, unknown>>) {
      if (typeof d.ndc === 'string') pricedHere.add(d.ndc);
    }
  }
  const unpriced = requestedNdcs.filter((n) => !pricedHere.has(n));

  const annual = unpriced.length > 0 ? null : totals.length > 0 ? Math.min(...totals) : legacyAnnual;
  const mo = unpriced.length > 0 ? null : annual != null ? annual / 12 : legacyMonthly;
  const yr = unpriced.length > 0 ? null : annual ?? (legacyMonthly != null ? legacyMonthly * 12 : null);

  const phase = pharmacyCosts[0]?.phase_information as Record<string, unknown> | undefined;
  return {
    contract_id: String(plan.contract_id ?? (plan as { contractId?: unknown }).contractId ?? ''),
    plan_id: String(plan.plan_id ?? (plan as { planId?: unknown }).planId ?? ''),
    segment_id: String(plan.segment_id ?? (plan as { segmentId?: unknown }).segmentId ?? '0'),
    monthly_cost: mo,
    annual_cost: yr,
    deductible: numeric(phase?.deductible_amount) ?? p.deductible ?? yearCosts?.deductible ?? null,
    unpriced_ndcs: unpriced,
    raw: p,
  };
}
