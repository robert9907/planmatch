// Real monthly drug prices from Medicare.gov (Rob, 2026-10-21 — Cynthia Kline).
//
// pm_drug_cost_cache only carries ~73 NDCs, so most drugs had no real price
// and the brain priced them at a flat notional ($200/mo for Tier 3). That
// pushed every plan to the Part D out-of-pocket cap and made totals identical.
// This module asks /api/drug-costs for the client's actual drugs at their
// actual monthly quantity and returns Medicare.gov's gross (full_cost) price
// per rxcui. The brain then applies each plan's own deductible, tier
// cost-share and cap to that real price.

import { resolvePlanCatalogYear } from '../../api/library/planCatalogYear';

const SOLID_RE = /\b(tablet|tab|capsule|cap)s?\b/i;
const NON_SOLID_RE = /\b(cream|ointment|gel|lotion|spray|inhaler|inhalation|solution|suspension|injection|injector|pen|patch|drops?|vial|kit)\b/i;

/** Doses per day from a free-text sig; null when it can't be read. */
function dosesPerDay(sig: string): number | null {
  const s = sig.toLowerCase();
  // "1 to 2 tablets" → plan for the upper amount per dose.
  const range = s.match(/\b(\d+)\s*(?:to|-)\s*(\d+)\s*(?:tablet|tab|capsule|cap)/);
  const single = s.match(/\b(?:take|inhale|use)?\s*(\d+)\s*(?:tablet|tab|capsule|cap)/);
  const perDose = range ? Number(range[2]) : single ? Number(single[1]) : 1;
  let times: number | null = null;
  if (/every\s*4\s*hours|6 times/.test(s)) times = 6;
  else if (/every\s*6\s*hours|4 times|four times|\bqid\b/.test(s)) times = 4;
  else if (/every\s*8\s*hours|3 times|three times|\btid\b/.test(s)) times = 3;
  else if (/every\s*12\s*hours|2 times|twice|\bbid\b/.test(s)) times = 2;
  else if (/once (a )?day|once daily|\bdaily\b|every day|at bedtime|each morning|in the morning|\bqd\b|\bqhs\b/.test(s)) times = 1;
  if (times == null) return null;
  return perDose * times;
}

export interface QuantityInput {
  name?: string;
  form?: string;
  quantity?: string;
  frequency?: string;
  refillDays?: number;
}

/** Units the client uses in 30 days. Tablets/capsules come from the sig
 *  (doses/day × 30); other forms keep the filed package quantity. */
export function monthlyQuantity(m: QuantityInput): number {
  // medicare.gov's quantity is an int32 — a fractional package (42.5 g of
  // cream) fails the whole request. Round up to whole units.
  return Math.max(1, Math.ceil(rawMonthlyQuantity(m)));
}

function rawMonthlyQuantity(m: QuantityInput): number {
  const label = `${m.name ?? ''} ${m.form ?? ''}`;
  const qty = Number.parseFloat(String(m.quantity ?? '').replace(/[^\d.]/g, ''));
  const hasQty = Number.isFinite(qty) && qty > 0;
  if (NON_SOLID_RE.test(label) && !SOLID_RE.test(label)) {
    if (hasQty) return qty;
    if (/\bnasal\b|\bspray\b/i.test(label)) return 16; // one 16 g bottle
    return 1;
  }
  const perDay = m.frequency ? dosesPerDay(m.frequency) : null;
  if (perDay != null) return perDay * 30;
  if (hasQty) {
    const days = m.refillDays && m.refillDays > 0 ? m.refillDays : qty >= 90 ? 90 : 30;
    return Math.max(1, Math.round((qty * 30) / days));
  }
  return 30;
}

interface CostsResponse {
  costs?: Array<{ raw?: { costs?: Array<{ drug_costs?: Array<{ ndc?: string; full_cost?: number }> }> } }>;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** rxcui → gross monthly price (median full_cost across the plans priced).
 *  NDCs are matched back to their rxcui through every candidate NDC, since
 *  the server may have swapped in an alternate. */
export function grossMonthlyFromResponse(
  resp: CostsResponse,
  ndcsByRxcui: Record<string, string[]>,
): Map<string, number> {
  const rxcuiByNdc = new Map<string, string>();
  for (const [rx, ndcs] of Object.entries(ndcsByRxcui)) for (const n of ndcs) rxcuiByNdc.set(n, rx);
  const prices = new Map<string, number[]>();
  for (const c of resp.costs ?? []) {
    for (const pc of c.raw?.costs ?? []) {
      for (const d of pc.drug_costs ?? []) {
        const rx = d.ndc ? rxcuiByNdc.get(d.ndc) : undefined;
        if (!rx || typeof d.full_cost !== 'number' || !(d.full_cost > 0)) continue;
        const arr = prices.get(rx) ?? [];
        arr.push(d.full_cost);
        prices.set(rx, arr);
      }
    }
  }
  const out = new Map<string, number>();
  for (const [rx, arr] of prices) out.set(rx, Math.round(median(arr) * 100) / 100);
  return out;
}

export interface GrossPriceDrug extends QuantityInput {
  rxcui: string;
}

/** Ask Medicare.gov for the gross monthly price of each drug, using a few
 *  of the client's county plans (gross price barely varies by plan; the
 *  median smooths outliers). Returns an empty map on any failure — the
 *  brain then falls back exactly as before. */
export async function fetchGrossMonthlyPrices(
  drugs: GrossPriceDrug[],
  samplePlans: Array<{ contract_id: string; plan_number: string; segment_id: string }>,
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const withRx = drugs.filter((d) => d.rxcui);
  if (withRx.length === 0 || samplePlans.length === 0) return new Map();
  const ndcRes = await fetch('/api/drug-ndcs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rxcuis: withRx.map((d) => d.rxcui) }),
    signal,
  });
  if (!ndcRes.ok) throw new Error(`drug-ndcs ${ndcRes.status}`);
  const ndcsByRxcui = ((await ndcRes.json()) as { ndcs?: Record<string, string[]> }).ndcs ?? {};
  const priced = withRx.filter((d) => (ndcsByRxcui[d.rxcui]?.length ?? 0) > 0);
  if (priced.length === 0) return new Map();
  const year = String(resolvePlanCatalogYear());
  const res = await fetch('/api/drug-costs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      plans: samplePlans.map((p) => ({
        contract_id: p.contract_id,
        plan_id: p.plan_number,
        segment_id: p.segment_id,
        contract_year: year,
      })),
      prescriptions: priced.map((d) => ({
        ndc: ndcsByRxcui[d.rxcui][0],
        quantity: String(monthlyQuantity(d)),
        frequency: 'FREQUENCY_30_DAYS',
        alternates: ndcsByRxcui[d.rxcui].slice(1, 6),
      })),
      retail_only: false,
      lis: 'LIS_NO_HELP',
      npis: [],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`drug-costs ${res.status}`);
  return grossMonthlyFromResponse((await res.json()) as CostsResponse, ndcsByRxcui);
}
