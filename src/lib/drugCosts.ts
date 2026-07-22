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
// Confirmed via scripts/_lis-probe-pdp.mjs 2026-07-22 against Humana
// Basic Rx S5884-133-0: partd premium $6.80 → calculated_monthly_premium
// $0 for LIS_LEVEL_1A/2/3/4_100 (subsidy recognized), $6.80 for
// LIS_NO_HELP. The tier→level mapping follows CMS convention:
//   Level 1(A) → institutional FBDE ($0/$0 copay tier)
//   Level 2    → full LIS community, ≤100% FPL ($1.60/$4.90)
//   Level 3    → full LIS community, higher FPL / MSP recipient
//                ($5.10/$12.65)
// LIS_LEVEL_4_100 is the pre-IRA partial-subsidy tier — post-IRA §11404
// (2024) all partials migrated to full LIS, so this repo's LisTier has
// no entry that maps to it.
const LIS_ENUM_MAP: Record<LisTier, string> = {
  none: 'LIS_NO_HELP',
  full_institutional: 'LIS_LEVEL_1A',
  full_low: 'LIS_LEVEL_2',
  full_high: 'LIS_LEVEL_3',
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

export async function fetchDrugCosts(params: {
  plans: DrugCostPlanInput[];
  ndcs: string[];               // one representative NDC per prescription
  mode: PharmacyMode;
  /** Client's LIS tier. Omitted / undefined is treated as 'none' — the
   *  API receives LIS_NO_HELP and cache buckets remain separate from
   *  subsidized-client requests (api/drug-costs.ts:201 keys on lis). */
  lisTier?: LisTier;
}): Promise<DrugCostResponse> {
  const { plans, ndcs, mode, lisTier } = params;
  if (plans.length === 0 || ndcs.length === 0) {
    return { source: 'skipped', costs: [] };
  }
  const frequency = mode === 'mail' ? 'FREQUENCY_90_DAYS' : 'FREQUENCY_30_DAYS';
  const quantity = mode === 'mail' ? '90' : '30';
  const prescriptions = ndcs.map((ndc) => ({ ndc, frequency, quantity }));
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
