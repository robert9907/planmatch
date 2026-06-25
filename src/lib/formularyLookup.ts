// formularyLookup — per-(plan, rxcui) pm_formulary tier query.
//
// Reads from the consumer's /api/formulary endpoint (cross-origin via
// planmatch.generationhealth.me, configurable through
// VITE_PLANMATCH_LIBRARY_URL) so the agent and consumer give
// identical answers for the same drug + plan combination. Replaces
// the agent's own /api/formulary route (still live under deprecation
// until traffic drains) which did RxNorm /related.json expansion
// instead of the consumer's brand→generic + ingredient-stem fallback.
//
// BEHAVIOR CHANGE — flagged on cutover:
//   • Direct rxcui match: identical answers.
//   • Ingredient fallback: shifts from RxNorm-graph expansion (sibling
//     SCDs/SBDs via /related.json) to name-stem ILIKE expansion
//     (brand→generic substitution + first-word stems of the user's
//     drug name against pm_drug_ndc + pm_drugs). For autocomplete-
//     sourced rxcuis the answers should converge; edge cases like
//     rxcuis whose ingredient doesn't appear in pm_drug_ndc/pm_drugs
//     by name may resolve differently. The consumer endpoint surfaces
//     these as match_type='ingredient' with a "confirm with your
//     doctor" UI disclaimer.
//   • Combo suppression: the agent's old endpoint suppressed combo-
//     sibling hits (e.g. HCTZ/lisinopril matching a query for plain
//     lisinopril). The consumer endpoint does not; it relies on the
//     extractStems combo-split to match the right side of a query
//     instead. Combo-only matches will surface; UI should treat
//     match_type='ingredient' as advisory.
//
// Returned to the UI: the same FormularyHit shape it has always
// consumed — tier/copay/coinsurance/PA/ST/QL/drug_name. The
// in-memory cache + getCachedFormulary sync read still work.
//
// coinsurance is a fraction 0..1 in the agent's existing convention;
// the consumer endpoint returns percent (0..100). We divide by 100 on
// receive so the existing UI math (which expects fraction) still
// works.

import type { FormularyTier } from '@/types/plans';

const LIBRARY_URL: string =
  ((import.meta.env as { VITE_PLANMATCH_LIBRARY_URL?: string })
    .VITE_PLANMATCH_LIBRARY_URL ??
    'https://planmatch.generationhealth.me') as string;

export interface FormularyHit {
  tier: FormularyTier | 'not_covered';
  copay: number | null;
  // Fraction (0.25 = 25%). UI that mixes formulary coinsurance with
  // pm_plan_benefits.rx_tier coinsurance (percent integer) must
  // convert — see Step6QuoteDelivery's medication cell.
  coinsurance: number | null;
  drug_name: string | null;
  prior_auth: boolean;
  step_therapy: boolean;
  quantity_limit: boolean;
}

interface LibraryGetResponse {
  coverage?: Array<{
    rxcui: string;
    drug_name: string | null;
    tier: number | null;
    copay: number | null;
    /** Percent 0..100 (consumer endpoint convention). */
    coinsurance: number | null;
    prior_auth: boolean;
    step_therapy: boolean;
    quantity_limit: boolean;
    match_type?: 'rxcui' | 'ingredient';
  }>;
  missing?: string[];
}

interface LibraryPostResponse {
  matches?: Array<{
    rxcui: string;
    contract_id: string;
    plan_id: string;
    contract_plan_id: string;
    drug_name: string | null;
    tier: number | null;
    copay: number | null;
    /** Percent 0..100 (consumer endpoint convention). */
    coinsurance: number | null;
    prior_auth: boolean;
    step_therapy: boolean;
    quantity_limit: boolean;
    match_type: 'rxcui' | 'ingredient';
  }>;
}

const cache = new Map<string, FormularyHit>();

function cacheKey(contractPlanId: string, rxcui: string): string {
  return `${contractPlanId}::${rxcui}`;
}

function normalizeTier(raw: unknown): FormularyTier | 'not_covered' {
  if (raw === 'not_covered') return 'not_covered';
  if (raw === 'excluded') return 'excluded';
  // CMS SPUF caps tier at 6 but some carriers (notably Humana H1036 on
  // preferred generics) file at 6 and a few plans use 7-tier
  // structures. Only a null/undefined/0 tier means the drug isn't on
  // this plan's formulary — anything from 1 through 8 is a valid
  // placement and should render as "covered" in the UI.
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 8) {
    return n as FormularyTier;
  }
  return 'not_covered';
}

function emptyHit(): FormularyHit {
  return {
    tier: 'not_covered',
    copay: null,
    coinsurance: null,
    drug_name: null,
    prior_auth: false,
    step_therapy: false,
    quantity_limit: false,
  };
}

// The consumer endpoint returns coinsurance as percent (0..100). The
// agent's UI expects fraction (0..1). Convert here so callers keep
// working.
function rowToHit(row: {
  drug_name: string | null;
  tier: number | null;
  copay: number | null;
  coinsurance: number | null;
  prior_auth: boolean;
  step_therapy: boolean;
  quantity_limit: boolean;
}): FormularyHit {
  return {
    tier: normalizeTier(row.tier),
    copay: typeof row.copay === 'number' ? row.copay : null,
    coinsurance:
      typeof row.coinsurance === 'number' ? row.coinsurance / 100 : null,
    drug_name: row.drug_name,
    prior_auth: row.prior_auth === true,
    step_therapy: row.step_therapy === true,
    quantity_limit: row.quantity_limit === true,
  };
}

/** Look up one (contract_plan_id, rxcui) pair. */
export async function lookupFormulary(
  contractPlanId: string,
  rxcui: string | null | undefined,
): Promise<FormularyHit> {
  if (!rxcui) return emptyHit();
  const key = cacheKey(contractPlanId, rxcui);
  const cached = cache.get(key);
  if (cached) return cached;

  // contractPlanId historically comes in either "H1234_005" or
  // "H1234-005" form depending on caller. Library GET expects
  // contract_id + plan_id as separate params; split on either.
  const sep = contractPlanId.includes('_') ? '_' : '-';
  const [contractId, planId] = contractPlanId.split(sep);
  if (!contractId || !planId) return emptyHit();

  const qs = new URLSearchParams({
    contract_id: contractId,
    plan_id: planId,
    rxcui,
  });
  try {
    const res = await fetch(`${LIBRARY_URL}/api/formulary?${qs.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`formulary ${res.status}`);
    const body = (await res.json()) as LibraryGetResponse;
    const row = body.coverage?.[0];
    const hit: FormularyHit = row ? rowToHit(row) : emptyHit();
    cache.set(key, hit);
    return hit;
  } catch (err) {
    console.warn('[formularyLookup] fetch failed:', err);
    return emptyHit();
  }
}

/**
 * Bulk lookup — one POST per Step 5 funnel pass spanning N contracts
 * × M rxcuis. Returns a Map keyed identically to cacheKey() and
 * populates the module-level cache so subsequent single lookups hit
 * memory.
 */
export async function bulkLookupFormulary(
  contractIds: string[],
  rxcuis: string[],
): Promise<Map<string, FormularyHit>> {
  const out = new Map<string, FormularyHit>();
  const realRxcuis = rxcuis.filter(Boolean);
  const realContracts = contractIds.filter(Boolean);
  if (realRxcuis.length === 0 || realContracts.length === 0) return out;

  try {
    const res = await fetch(`${LIBRARY_URL}/api/formulary`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contractIds: realContracts,
        rxcuis: realRxcuis,
      }),
    });
    if (!res.ok) throw new Error(`formulary bulk ${res.status}`);
    const body = (await res.json()) as LibraryPostResponse;
    for (const m of body.matches ?? []) {
      const hit = rowToHit(m);
      // Agent has historically keyed the cache on `contractId_planId`
      // (underscore). The endpoint returns `contractId_planId` in
      // contract_plan_id, so this is a 1:1 mapping.
      const key = cacheKey(m.contract_plan_id, m.rxcui);
      out.set(key, hit);
      cache.set(key, hit);
    }
    return out;
  } catch (err) {
    console.warn('[formularyLookup] bulk fetch failed:', err);
    return out;
  }
}

/** Flush the cache — call from a "retry all network checks" button. */
export function clearFormularyCache(): void {
  cache.clear();
}

/**
 * Synchronous read from the cache. Returns null if the pair hasn't
 * been primed by bulkLookupFormulary or hit by lookupFormulary yet —
 * callers should treat that as "still loading" rather than
 * "not covered" so a race condition doesn't falsely eliminate a plan.
 */
export function getCachedFormulary(
  contractPlanId: string,
  rxcui: string | null | undefined,
): FormularyHit | null {
  if (!rxcui) return null;
  return cache.get(cacheKey(contractPlanId, rxcui)) ?? null;
}
