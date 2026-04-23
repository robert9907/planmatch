// formularyLookup — per-(plan, rxcui) formulary tier query backed by
// pm_formulary via /api/formulary. Replaces the first-word-key
// BASE_FORMULARY dict Plan.formulary[drugFirstWord] lookup in
// cmsPlans.ts that only covered ~20 drugs.
//
// The Step 3 Medications screen captures a rxcui on every RxNorm hit
// (see src/lib/rxnorm.ts → Medication.rxcui); we pass that here. A
// missing rxcui (meds added without an RxNorm match) yields
// 'not_covered' — same shape as a real exclusion so the UI path
// doesn't branch.

import type { FormularyTier } from '@/types/plans';

export interface FormularyHit {
  tier: FormularyTier | 'not_covered';
  copay: number | null;
  coinsurance: number | null;
  drug_name: string | null;
}

interface BulkRow {
  contract_plan_id: string;
  rxcui: string;
  tier: number | null;
  copay: number | null;
  coinsurance: number | null;
  drug_name: string | null;
}

// Short-lived in-memory cache keyed on the natural composite key. The
// browser-side query path calls fetch/formulary; the cache keeps
// Step 3's per-row renderer from re-firing the same request every
// scroll tick.
const cache = new Map<string, FormularyHit>();

function cacheKey(contractPlanId: string, rxcui: string): string {
  return `${contractPlanId}::${rxcui}`;
}

function normalizeTier(raw: unknown): FormularyTier | 'not_covered' {
  if (raw === 'not_covered') return 'not_covered';
  if (raw === 'excluded') return 'excluded';
  // CMS SPUF caps tier at 6 but some carriers (notably Humana H1036 on
  // preferred generics) file at 6 and a few plans use 7-tier structures.
  // Only a null/undefined/0 tier means the drug isn't on this plan's
  // formulary — anything from 1 through 8 is a valid placement and
  // should render as "covered" in the UI.
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 8) {
    return n as FormularyTier;
  }
  return 'not_covered';
}

/** Look up one (contract_plan_id, rxcui) pair. */
export async function lookupFormulary(
  contractPlanId: string,
  rxcui: string | null | undefined,
): Promise<FormularyHit> {
  if (!rxcui) {
    // No RxNorm match on the session med — we can't authoritatively
    // claim covered vs excluded, but from the UI's perspective it
    // behaves the same as "not on formulary" (same red-pill rendering).
    return { tier: 'not_covered', copay: null, coinsurance: null, drug_name: null };
  }
  const key = cacheKey(contractPlanId, rxcui);
  const cached = cache.get(key);
  if (cached) return cached;

  const qs = new URLSearchParams({ contract_plan_id: contractPlanId, rxcui });
  try {
    const res = await fetch(`/api/formulary?${qs.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`formulary ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    const hit: FormularyHit = {
      tier: normalizeTier(body.tier),
      copay: typeof body.copay === 'number' ? body.copay : null,
      coinsurance: typeof body.coinsurance === 'number' ? body.coinsurance : null,
      drug_name: typeof body.drug_name === 'string' ? body.drug_name : null,
    };
    cache.set(key, hit);
    return hit;
  } catch (err) {
    console.warn('[formularyLookup] fetch failed:', err);
    return { tier: 'not_covered', copay: null, coinsurance: null, drug_name: null };
  }
}

/**
 * Bulk lookup — one round trip for a Step 5 funnel pass that needs to
 * check every (plan × drug) pairing. Returns a Map keyed the same way
 * as cacheKey(); populates the module-level cache so subsequent single
 * lookups hit memory.
 */
export async function bulkLookupFormulary(
  contractIds: string[],
  rxcuis: string[],
): Promise<Map<string, FormularyHit>> {
  const out = new Map<string, FormularyHit>();
  const realRxcuis = rxcuis.filter(Boolean);
  if (realRxcuis.length === 0) return out;

  const qs = new URLSearchParams({
    rxcuis: realRxcuis.join(','),
    contract_ids: contractIds.join(','),
  });
  try {
    const res = await fetch(`/api/formulary?${qs.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`formulary bulk ${res.status}`);
    const body = (await res.json()) as { rows: BulkRow[] };
    for (const r of body.rows ?? []) {
      const hit: FormularyHit = {
        tier: normalizeTier(r.tier),
        copay: r.copay,
        coinsurance: r.coinsurance,
        drug_name: r.drug_name,
      };
      const key = cacheKey(r.contract_plan_id, r.rxcui);
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
