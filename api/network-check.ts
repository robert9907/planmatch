// POST /api/network-check
//
// Real provider network lookup against pm_provider_network_cache,
// with a live Medicare.gov fallback for cache misses. Replaces the
// hash mock in src/lib/networkCheck.ts.
//
// Body:
//   {
//     npi:       "1619976297",
//     plan_ids:  ["H5253-189-000", "H1036-335-2", ...],   // triple ids
//     zip?:      "27713",          // optional — required for live miss
//     fips?:     "37063",          // optional — required for live miss
//     plan_type?:"PLAN_TYPE_MAPD", // defaults MAPD
//     year?:     2026,
//   }
//
// Response:
//   {
//     source:  "cache" | "mixed" | "live" | "empty",
//     results: [
//       { plan_id: "H5253-189-000", contract_id, plan_number, segment_id,
//         status: "in" | "out" | "unknown",
//         from:   "cache" | "live" | "miss",
//         covered: boolean | null }
//     ],
//     stats: { cacheHits, liveHits, misses, total },
//     fhir_diagnostic?: { ... raw upstream payload sample ... }
//   }
//
// Strategy:
//   1) Parse plan_ids → contract / plan / segment triples; the cache
//      table keys on (plan_id="<contract>-<plan>", segment_id, npi).
//   2) SELECT pm_provider_network_cache for the intersection.
//   3) For misses, if zip+fips supplied, warm Akamai and POST
//      /plans/search?...&providers=<npi>. Parse the response with a
//      tolerant extractor (the SPA's response shape isn't documented;
//      we look for any provider-coverage signal on each plan card).
//   4) Upsert hits into pm_provider_network_cache so the next agent
//      session sees them as cache hits.
//
// pm_provider_network_cache schema (per api/plan-brain-data.ts +
// the consumer-side writer): { plan_id text, segment_id text,
// npi text, covered bool, ... }. Upsert key: (plan_id, segment_id, npi).

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson } from './_lib/http.js';
import { supabase } from './_lib/supabase.js';

export const config = { maxDuration: 60 };

const PLAN_SEARCH_URL = 'https://www.medicare.gov/api/v1/data/plan-compare/plans/search';
const WARM_URL = 'https://www.medicare.gov/plan-compare/';
const COOKIE_WARM_MS = 6_000;
const FE_VER = '2.69.0';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface NetworkCheckBody {
  npi: string;
  plan_ids: string[];
  zip?: string;
  fips?: string;
  plan_type?: string;
  year?: number;
}

interface ResultRow {
  plan_id: string;        // triple id as the caller supplied it
  contract_id: string;
  plan_number: string;
  segment_id: string;
  status: 'in' | 'out' | 'unknown';
  from: 'cache' | 'live' | 'miss';
  covered: boolean | null;
}

interface CacheRow {
  plan_id: string;        // contract-plan
  segment_id: string | null;
  npi: string;
  covered: boolean | null;
}

interface Triple {
  triple: string;         // "H5253-189-000"
  contract: string;
  plan: string;
  segment: string;        // normalized "000" | "001" | ...
  contractPlan: string;   // "H5253-189"
}

function splitTriple(id: string): Triple | null {
  const parts = id.split('-');
  if (parts.length < 2) return null;
  const seg = (parts[2] ?? '0').replace(/^0+/, '') || '0';
  const segPad = seg === '0' ? '000' : seg.padStart(3, '0');
  return {
    triple: `${parts[0]}-${parts[1]}-${segPad}`,
    contract: parts[0],
    plan: parts[1],
    segment: segPad,
    contractPlan: `${parts[0]}-${parts[1]}`,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  const raw = (req.body ?? {}) as Partial<NetworkCheckBody>;
  const npi = String(raw.npi ?? '').trim();
  const planIds = Array.isArray(raw.plan_ids) ? raw.plan_ids.map(String) : [];
  if (!npi) return badRequest(res, 'npi required');
  if (planIds.length === 0) return badRequest(res, 'plan_ids required');

  const zip = typeof raw.zip === 'string' ? raw.zip : null;
  const fips = typeof raw.fips === 'string' ? raw.fips : null;
  const planType = typeof raw.plan_type === 'string' ? raw.plan_type : 'PLAN_TYPE_MAPD';
  const year = Number(raw.year ?? new Date().getFullYear());

  const triples: Triple[] = planIds
    .map(splitTriple)
    .filter((t): t is Triple => !!t);
  if (triples.length === 0) return badRequest(res, 'no valid triple ids');

  const sb = supabase();

  // ─── Cache read ────────────────────────────────────────────────────
  const contractPlans = [...new Set(triples.map((t) => t.contractPlan))];
  let cacheRows: CacheRow[] = [];
  try {
    const { data, error } = await sb
      .from('pm_provider_network_cache')
      .select('plan_id, segment_id, npi, covered')
      .eq('npi', npi)
      .in('plan_id', contractPlans);
    if (error) throw error;
    cacheRows = (data ?? []) as CacheRow[];
  } catch (err) {
    console.warn('[network-check] cache read error:', (err as Error).message);
  }

  const cacheBy = new Map<string, CacheRow>();
  for (const r of cacheRows) {
    const seg = (r.segment_id ?? '0').replace(/^0+/, '') || '0';
    const segPad = seg === '0' ? '000' : seg.padStart(3, '0');
    cacheBy.set(`${r.plan_id}-${segPad}`, r);
  }

  // ─── Build result rows from cache; collect misses ──────────────────
  const results: ResultRow[] = triples.map((t) => {
    const hit = cacheBy.get(t.triple);
    if (hit) {
      return {
        plan_id: t.triple,
        contract_id: t.contract,
        plan_number: t.plan,
        segment_id: t.segment,
        status: hit.covered === true ? 'in' : hit.covered === false ? 'out' : 'unknown',
        from: 'cache',
        covered: hit.covered,
      };
    }
    return {
      plan_id: t.triple,
      contract_id: t.contract,
      plan_number: t.plan,
      segment_id: t.segment,
      status: 'unknown',
      from: 'miss',
      covered: null,
    };
  });

  const misses = results.filter((r) => r.from === 'miss');

  // ─── Live fallback for misses ──────────────────────────────────────
  let liveDiagnostic: unknown = null;
  if (misses.length > 0 && zip && fips) {
    try {
      const live = await fetchLive({ npi, zip, fips, planType, year });
      liveDiagnostic = live.diagnostic;

      // Index the live response by (contract-plan, segment).
      const liveBy = new Map<string, boolean | null>();
      for (const row of live.rows) {
        const seg = (row.segment_id ?? '0').replace(/^0+/, '') || '0';
        const segPad = seg === '0' ? '000' : seg.padStart(3, '0');
        liveBy.set(`${row.contract_id}-${row.plan_id}-${segPad}`, row.covered);
      }

      // Apply live results to miss rows.
      const upserts: Array<{ plan_id: string; segment_id: string; npi: string; covered: boolean | null }> = [];
      for (const r of results) {
        if (r.from !== 'miss') continue;
        const cov = liveBy.get(r.plan_id);
        if (typeof cov === 'undefined') continue;
        r.covered = cov;
        r.status = cov === true ? 'in' : cov === false ? 'out' : 'unknown';
        r.from = 'live';
        upserts.push({
          plan_id: `${r.contract_id}-${r.plan_number}`,
          segment_id: r.segment_id,
          npi,
          covered: cov,
        });
      }

      // ─── Cache write-back ────────────────────────────────────────
      if (upserts.length > 0) {
        try {
          await sb
            .from('pm_provider_network_cache')
            .upsert(upserts, { onConflict: 'plan_id,segment_id,npi' });
        } catch (err) {
          console.warn('[network-check] cache write failed:', (err as Error).message);
        }
      }
    } catch (err) {
      console.warn('[network-check] live fetch threw:', (err as Error).message);
      liveDiagnostic = { error: (err as Error).message };
    }
  } else if (misses.length > 0) {
    console.info(
      `[network-check] ${misses.length} cache miss(es) for npi=${npi} but zip/fips not supplied — skipping live fetch`,
    );
  }

  const cacheHits = results.filter((r) => r.from === 'cache').length;
  const liveHits = results.filter((r) => r.from === 'live').length;
  const stillMissing = results.filter((r) => r.from === 'miss').length;
  const source: 'cache' | 'live' | 'mixed' | 'empty' =
    cacheHits + liveHits === 0
      ? 'empty'
      : cacheHits === 0
        ? 'live'
        : liveHits === 0
          ? 'cache'
          : 'mixed';

  res.setHeader('Cache-Control', 'no-store');
  return sendJson(res, 200, {
    source,
    results,
    stats: {
      cacheHits,
      liveHits,
      misses: stillMissing,
      total: results.length,
    },
    ...(liveDiagnostic ? { fhir_diagnostic: liveDiagnostic } : {}),
  });
}

// ─── Live fetch via Medicare.gov plans/search ────────────────────────
//
// medicare.gov accepts ?providers=<NPI> on /plans/search; the response
// includes per-plan coverage flags. The exact field name varies by SPA
// build (we've observed `providers_covered`, `provider_coverage`, and
// `provider_in_network`). The extractor below walks the response with
// a tolerant search so a future field rename doesn't silently break us.

async function fetchLive(args: {
  npi: string;
  zip: string;
  fips: string;
  planType: string;
  year: number;
}): Promise<{
  rows: Array<{ contract_id: string; plan_id: string; segment_id: string; covered: boolean | null }>;
  diagnostic: unknown;
}> {
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
    await page.waitForTimeout(COOKIE_WARM_MS);

    const qs = new URLSearchParams({
      zip: args.zip,
      fips: args.fips,
      plan_type: args.planType,
      year: String(args.year),
      lang: 'en',
      providers: args.npi,
    });
    const url = `${PLAN_SEARCH_URL}?${qs.toString()}`;

    const reqBody = {
      npis: [],
      prescriptions: [],
      lis: 'LIS_NO_HELP',
      starRatings: [],
      organizationNames: [],
    };
    const traceId = randomHex(32);
    const spanId = randomHex(16);

    const resp = await page.request.post(url, {
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
      timeout: 60_000,
    });
    const status = resp.status();
    if (!resp.ok()) {
      const sample = (await resp.text()).slice(0, 600);
      console.warn(`[network-check] medicare.gov ${status}: ${sample}`);
      return { rows: [], diagnostic: { status, sample } };
    }
    const data = (await resp.json()) as Record<string, unknown>;

    const rows = extractCoverage(data, args.npi);
    console.info(
      `[network-check] live npi=${args.npi}: ${rows.length} plan(s) parsed; sample=${
        rows.slice(0, 3).map((r) => `${r.contract_id}-${r.plan_id}=${r.covered}`).join(',') || 'none'
      }`,
    );
    return {
      rows,
      diagnostic: {
        url,
        npi: args.npi,
        plan_count: rows.length,
        first_plan: rows[0] ?? null,
        // Keep raw response shape sample for the diagnostic but truncated.
        response_keys: Object.keys(data),
      },
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

// Tolerant extractor — walks the response looking for plan-shaped
// objects that carry both a contract id and a coverage signal for the
// requested NPI. Returns whatever we can parse; logs cardinality so
// Rob can spot if the SPA ever changes its key names.
function extractCoverage(
  payload: unknown,
  npi: string,
): Array<{ contract_id: string; plan_id: string; segment_id: string; covered: boolean | null }> {
  const out: Array<{ contract_id: string; plan_id: string; segment_id: string; covered: boolean | null }> = [];
  const visited = new WeakSet<object>();

  function visit(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (visited.has(obj)) return;
    visited.add(obj);

    // Plan-shaped: has contract_id + plan_id (or contract / plan).
    const contract = pickString(obj, ['contract_id', 'contractId', 'contract']);
    const plan = pickString(obj, ['plan_id', 'planId', 'plan', 'plan_number']);
    const segment = pickString(obj, ['segment_id', 'segmentId', 'segment']) ?? '0';
    if (contract && plan) {
      const covered = extractProviderCoverage(obj, npi);
      if (covered !== undefined) {
        out.push({
          contract_id: String(contract),
          plan_id: String(plan),
          segment_id: String(segment),
          covered,
        });
      }
    }

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    for (const v of Object.values(obj)) visit(v);
  }

  visit(payload);
  return out;
}

function extractProviderCoverage(
  plan: Record<string, unknown>,
  npi: string,
): boolean | null | undefined {
  // Shape A: per-plan boolean — when the request had a single npi,
  // some SPA builds collapse coverage to a top-level flag.
  for (const k of [
    'providers_in_network',
    'providers_covered',
    'provider_in_network',
    'provider_covered',
    'all_providers_in_network',
  ]) {
    const v = plan[k];
    if (typeof v === 'boolean') return v;
  }

  // Shape B: provider_coverage / providers map keyed by NPI.
  for (const k of ['provider_coverage', 'providers_coverage', 'providersCoverage']) {
    const v = plan[k];
    if (v && typeof v === 'object') {
      const inner = (v as Record<string, unknown>)[npi];
      if (typeof inner === 'boolean') return inner;
      if (inner && typeof inner === 'object') {
        const cov = (inner as Record<string, unknown>).covered ?? (inner as Record<string, unknown>).in_network;
        if (typeof cov === 'boolean') return cov;
      }
    }
  }

  // Shape C: providers[] array of { npi, in_network } records.
  for (const k of ['providers', 'in_network_providers', 'practitioners']) {
    const v = plan[k];
    if (Array.isArray(v)) {
      const match = (v as Array<Record<string, unknown>>).find(
        (item) => String(item?.npi ?? item?.identifier ?? '') === npi,
      );
      if (match) {
        const cov = match.in_network ?? match.covered ?? match.is_in_network;
        if (typeof cov === 'boolean') return cov;
        // Presence in the list = in-network (default heuristic).
        return true;
      }
      // Array exists but our NPI isn't in it — explicit out.
      if (v.length > 0) return false;
    }
  }

  return undefined;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}

function randomHex(len: number): string {
  return [...Array(len)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
}
