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
    quantity: String((p as PrescriptionInput).quantity ?? '30'),
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
  const cacheKey = sha256(canonicalize(body));
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
    result = await fetchDrugCosts(body);
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
    .map((p) => `${p.ndc}:${p.quantity}:${p.frequency}`)
    .sort()
    .join(',');
  const npis = [...body.npis].sort().join(',');
  return `${plans}::${rx}::retail=${body.retail_only ? 1 : 0}::lis=${body.lis}::npis=${npis}`;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ─── Playwright fetch ──────────────────────────────────────────────────

async function fetchDrugCosts(
  body: DrugCostBody,
): Promise<{ source: 'live' | 'rate_limited'; costs: PlanDrugCost[] }> {
  // Dynamic import keeps the module out of the Vite client bundle and
  // lets local dev run without @sparticuz/chromium when the binary is
  // already on PATH.
  const { chromium } = await import('playwright-core');
  const sparticuz = (await import('@sparticuz/chromium')).default;
  const executablePath = await sparticuz.executablePath();

  const browser = await chromium.launch({
    args: sparticuz.args,
    executablePath,
    headless: true,
  });
  try {
    const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US' });
    const page = await ctx.newPage();

    await page.goto(WARM_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Akamai's _abck sensor script runs async post-DOMContentLoaded.
    // Real-browser sensors complete within ~3s — 6s is a safety buffer.
    await page.waitForTimeout(COOKIE_WARM_MS);

    const batches: PlanInput[][] = [];
    for (let i = 0; i < body.plans.length; i += MAX_PLANS_PER_BATCH) {
      batches.push(body.plans.slice(i, i + MAX_PLANS_PER_BATCH));
    }

    const costs: PlanDrugCost[] = [];
    let anyRateLimited = false;

    for (let i = 0; i < batches.length; i++) {
      if (i > 0) await page.waitForTimeout(BATCH_DELAY_MS);

      const reqBody = {
        npis: body.npis,
        prescriptions: body.prescriptions,
        lis: body.lis,
        full_year: false,
        retailOnly: body.retail_only,
        plans: batches[i],
      };
      const traceId = [...Array(32)]
        .map(() => Math.floor(Math.random() * 16).toString(16))
        .join('');
      const spanId = [...Array(16)]
        .map(() => Math.floor(Math.random() * 16).toString(16))
        .join('');

      const resp = await page.request.post(ENDPOINT, {
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
      const status = resp.status();
      if (status === 429) {
        anyRateLimited = true;
        console.warn('[drug-costs] 429 from medicare.gov — caching short-TTL and bailing');
        break;
      }
      if (!resp.ok()) {
        const preview = (await resp.text()).slice(0, 300);
        throw new Error(`medicare.gov ${status}: ${preview}`);
      }
      const data = (await resp.json()) as Record<string, unknown>;
      costs.push(...extractCosts(data));
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

function extractCosts(data: Record<string, unknown>): PlanDrugCost[] {
  const list =
    (Array.isArray(data.plans) && (data.plans as unknown[])) ||
    (Array.isArray(data.plan_costs) && (data.plan_costs as unknown[])) ||
    [];
  return list.map((p) => extractPlanCost(p as Record<string, unknown>));
}

function extractPlanCost(p: Record<string, unknown>): PlanDrugCost {
  const yearCosts = (p.plan_year_costs ?? p.planYearCosts) as Record<string, unknown> | undefined;
  const numeric = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  const monthly =
    numeric(p.monthly_cost) ??
    numeric(p.avg_monthly_cost) ??
    numeric(p.monthly_drug_cost) ??
    numeric(yearCosts?.avg_monthly_cost) ??
    numeric(yearCosts?.monthly_cost) ??
    null;

  const annual =
    numeric(p.annual_cost) ??
    numeric(p.annual_drug_cost) ??
    numeric(p.total_drug_cost) ??
    numeric(yearCosts?.total_annual_cost) ??
    numeric(yearCosts?.total_cost) ??
    numeric(yearCosts?.annual_cost) ??
    null;

  // If we only got one of monthly/annual, derive the other.
  const mo = monthly ?? (annual != null ? annual / 12 : null);
  const yr = annual ?? (monthly != null ? monthly * 12 : null);

  return {
    contract_id: String(p.contract_id ?? (p as { contractId?: unknown }).contractId ?? ''),
    plan_id: String(p.plan_id ?? (p as { planId?: unknown }).planId ?? ''),
    segment_id: String(p.segment_id ?? (p as { segmentId?: unknown }).segmentId ?? '0'),
    monthly_cost: mo,
    annual_cost: yr,
    deductible: p.deductible ?? yearCosts?.deductible ?? null,
    raw: p,
  };
}
