// drugCosts — browser-side client for /api/drug-ndcs and /api/drug-costs,
// plus the shared monthly-cost helper used by every per-drug $ display
// path (Compare table, Medications screen, Quote table).
//
// Two API calls chained:
//   1. /api/drug-ndcs  →  resolve rxcuis to representative NDCs
//   2. /api/drug-costs →  Medicare.gov drug-cost call (Playwright server
//                         side) for a list of plans + NDCs
//
// The Quote page fires both once per (plans × rxcuis × pharmacy mode)
// tuple; the server caches 24h so toggling retail↔mail within a session
// only hits upstream twice.

import type { LisTier } from './dual-eligible';

// Medicare.gov plan-compare API accepts these LIS enum values.
// The level→copay mapping was PINNED empirically 2026-10-26 by a per-DRUG-COPAY
// probe (consumer repo) — Eliquis tier-3 brand on H5302-022 at each level, real
// in-network chain NPI, 2027: LIS_LEVEL_2 → $5.00 brand (= full LIS ≤100% FPL /
// FBDE community), LIS_LEVEL_1A → $14.40 (= full LIS higher-FPL), LIS_LEVEL_3 →
// $0 (= institutional). This SUPERSEDES the earlier 2026-07-22 PDP probe
// (scripts/_lis-probe-pdp.mjs), which only observed premium→$0 for 1A/2/3 — that
// confirms subsidy recognition, NOT the per-copay tier, and its CMS-convention
// inference mapped 1A/3 backwards. Kept in sync with the consumer enum map; see
// memory reference_medicare_gov_lis_enum. LIS_LEVEL_4_100 is the pre-IRA partial
// tier — post-IRA §11404 all partials migrated to full LIS, so no LisTier maps to it.
export const LIS_ENUM_MAP: Record<LisTier, string> = {
  none: 'LIS_NO_HELP',
  full_institutional: 'LIS_LEVEL_3',
  full_low: 'LIS_LEVEL_2',
  full_high: 'LIS_LEVEL_1A',
};

// CMS-typical retail prices per Part D tier, used to convert
// coinsurance-only formulary rows (no flat copay filed — e.g. Ozempic at
// Tier 3 with 25% coinsurance on most NC plans) into an estimated
// monthly $ amount. Matches the table in broker-rules.ts so the broker
// score and the consumer/agent UI use the same notional. Tiers 6-8 are
// carrier-specific buckets that map back to generic / brand / specialty
// equivalents.
const TIER_NOTIONAL_RETAIL_MONTHLY: Record<number, number> = {
  1: 8,
  2: 30,
  3: 200,
  4: 500,
  5: 1500,
  6: 8,
  7: 30,
  8: 200,
};

/**
 * Compute a monthly $ cost from a formulary row's cost-share. Used by
 * the Compare / Medications / Quote per-drug displays so coinsurance-
 * only drugs (Ozempic + Tier 3 + 25% coinsurance, etc.) show ~$50/mo
 * instead of $0.
 *
 * Inputs:
 *   - copay:        flat $/fill from pm_formulary.copay_default
 *   - coinsurance:  fraction from pm_formulary.coinsurance_default
 *                   (0.25 = 25%); values > 1 are auto-normalized as
 *                   percentages for callers that mix pm_plan_benefits'
 *                   percent-integer convention with pm_formulary's
 *                   fraction convention.
 *   - tier:         Part D tier (1-8); required for the coinsurance
 *                   branch since the notional retail depends on tier.
 *
 * Returns 0 only when both copay and coinsurance are absent or zero
 * (the call site should treat 0 as "no per-drug $ signal" and render
 * "—" rather than "$0" to stay compliance-safe).
 */
export function monthlyCostFromFormulary(args: {
  tier: number | null;
  copay: number | null;
  coinsurance: number | null;
}): number {
  if (typeof args.copay === 'number' && args.copay >= 0) {
    return args.copay;
  }
  if (
    typeof args.coinsurance === 'number' &&
    args.coinsurance > 0 &&
    args.tier != null
  ) {
    const notional = TIER_NOTIONAL_RETAIL_MONTHLY[args.tier] ?? 200;
    const frac = args.coinsurance > 1 ? args.coinsurance / 100 : args.coinsurance;
    return Math.round(notional * frac);
  }
  return 0;
}

export interface PlanDrugCost {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  monthly_cost: number | null;
  annual_cost: number | null;
  /** NDCs medicare.gov did not price for this plan even after alternates.
   *  When non-empty, monthly/annual are null (the total would omit them). */
  unpriced_ndcs?: string[];
}

export interface DrugCostResponse {
  source: string;
  costs: PlanDrugCost[];
}

export interface DrugCostPlanInput {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  contract_year: string;
}

export type PharmacyMode = 'retail' | 'mail';

export async function resolveRxcuisToNdcs(
  rxcuis: string[],
): Promise<Record<string, string[]>> {
  if (rxcuis.length === 0) return {};
  const res = await fetch('/api/drug-ndcs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rxcuis }),
  });
  if (!res.ok) throw new Error(`drug-ndcs ${res.status}`);
  const body = (await res.json()) as { ndcs?: Record<string, string[]> };
  return body.ndcs ?? {};
}

/** Units to price for one fill: the 30-day amount, tripled for a 90-day
 *  mail fill. medicare.gov's quantity is a whole number. */
export function fillQuantity(monthly: number, mode: PharmacyMode): number {
  const m = Math.max(1, Math.ceil(monthly));
  return mode === 'mail' ? m * 3 : m;
}

export async function fetchDrugCosts(params: {
  plans: DrugCostPlanInput[];
  ndcs: string[];               // one representative NDC per prescription
  /** Per prescription (aligned with `ndcs`): other NDCs for the same drug,
   *  tried in order when medicare.gov doesn't recognize the first. */
  alternates?: string[][];
  /** Per prescription (aligned with `ndcs`): the drug's rxcui, so the server
   *  can send medicare.gov's own NDC for it. */
  rxcuis?: string[];
  /** Per prescription (aligned with `ndcs`): units used in 30 days
   *  (monthlyQuantity). A tube or spray is 1 package, not 30. Missing →
   *  the old 30-a-month assumption. */
  monthlyQuantities?: number[];
  mode: PharmacyMode;
  /** Client's LIS tier. Omitted / undefined is treated as 'none' — the
   *  API receives LIS_NO_HELP and cache buckets remain separate from
   *  subsidized-client requests (api/drug-costs.ts:201 keys on lis). */
  lisTier?: LisTier;
}): Promise<DrugCostResponse> {
  const { plans, ndcs, alternates, rxcuis, monthlyQuantities, mode, lisTier } = params;
  if (plans.length === 0 || ndcs.length === 0) {
    return { source: 'skipped', costs: [] };
  }
  const frequency = mode === 'mail' ? 'FREQUENCY_90_DAYS' : 'FREQUENCY_30_DAYS';
  const prescriptions = ndcs.map((ndc, i) => ({
    ndc,
    frequency,
    quantity: String(fillQuantity(monthlyQuantities?.[i] ?? 30, mode)),
    alternates: alternates?.[i] ?? [],
    rxcui: rxcuis?.[i],
  }));
  const res = await fetch('/api/drug-costs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      plans,
      prescriptions,
      retail_only: mode === 'retail',
      lis: LIS_ENUM_MAP[lisTier ?? 'none'],
      npis: [],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`drug-costs ${res.status} — ${text.slice(0, 200)}`);
  }
  return (await res.json()) as DrugCostResponse;
}
