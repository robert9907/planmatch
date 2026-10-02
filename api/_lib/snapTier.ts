// Snap Link tier lookup: the drug's tier on the client's CURRENT plan.
//
// Tier isn't printed on a bottle — it depends on the plan. AgentBase
// stores the client's plan as clients.plan_id ("H5253-117" or
// "H5253-117-0"). With the RxCUI from snapRxcui we look it up in
// plan-match-prod's pm_formulary (CMS formulary file, SCD/SBD rxcuis).
// No plan ID, a plan we don't have a formulary for, or a drug that isn't
// on it → null, and the Tier cell stays blank.

import type { SupabaseClient } from '@supabase/supabase-js';

export function parsePlanId(planId: string | null | undefined): { contract: string; plan: string; segment: string | null } | null {
  // Accept "H4514-021", "H4514021", "H4514-021-0", "H4514 021" — the CRM
  // stores plan IDs however they were typed.
  const m = (planId ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '-')
    .match(/^([HRS]\d{4})-?(\d{3})(?:-?(\d{1,3}))?$/);
  if (!m) return null;
  return { contract: m[1], plan: m[2], segment: m[3] != null ? String(Number(m[3])) : null };
}

export async function lookupTier(
  formularyDb: SupabaseClient,
  planId: string | null | undefined,
  rxcui: string | null | undefined,
  planYear?: number | null,
): Promise<number | null> {
  const p = parsePlanId(planId);
  if (!p || !rxcui) return null;
  try {
    let q = formularyDb
      .from('pm_formulary')
      .select('tier, plan_year, segment_id')
      .eq('contract_id', p.contract)
      .eq('plan_id', p.plan)
      .eq('rxcui', rxcui);
    // When the caller knows the plan's year, pin to it so a later year's
    // formulary (once loaded) can't bleed its tiers onto a prior-year plan.
    if (planYear != null) q = q.eq('plan_year', planYear);
    const { data, error } = await q.limit(50);
    if (error) throw error;
    let rows = (data ?? []).filter((r) => typeof r.tier === 'number');
    if (rows.length === 0) return null;
    // No explicit year → fall back to the latest plan year on file.
    const year = planYear != null ? planYear : Math.max(...rows.map((r) => r.plan_year ?? 0));
    rows = rows.filter((r) => (r.plan_year ?? 0) === year);
    // Match the client's segment when we know it and it's on file.
    if (p.segment != null) {
      const seg = rows.filter((r) => String(Number(r.segment_id ?? 0)) === p.segment);
      if (seg.length) rows = seg;
    }
    return Math.min(...rows.map((r) => r.tier as number));
  } catch (err) {
    console.warn('[snapTier] lookup failed', {
      planId,
      rxcui,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
