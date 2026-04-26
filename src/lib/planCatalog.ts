// planCatalog — plan lookup backed by pm_plans + pm_plan_benefits via
// the /api/plans serverless route. Replaces the 12-plan static array
// in cmsPlans.ts for Step 5 Benefit Filters and Step 6 Quote &
// Delivery renders.
//
// The shape returned matches the Plan interface in src/types/plans.ts
// so downstream consumers (computeFunnel, SideBySideTable, benefit
// cards) don't need to change. Graceful-degradation fallback: if the
// server route errors, callers can fall back to the static cmsPlans
// array so the UI still renders during a Supabase outage.

import type { Plan, PlanBenefits } from '@/types/plans';
import type { PlanType, StateCode } from '@/types/session';

interface ApiPlan {
  id: string;
  contract_id: string;
  plan_number: string;
  segment_id: string;
  carrier: string;
  plan_name: string;
  state: string;
  counties: string[];
  plan_type: PlanType;
  premium: number;
  annual_deductible: number | null;
  moop_in_network: number;
  moop_out_of_network: number | null;
  drug_deductible: number | null;
  part_b_giveback: number;
  star_rating: number;
  benefits: Partial<PlanBenefits>;
  formulary?: Record<string, never>;
  in_network_npis?: string[];
}

interface ApiPlansResponse {
  plans: ApiPlan[];
  source: 'pm_plans' | 'static_fallback';
}

export interface FetchPlansParams {
  state: StateCode | null;
  county: string;
  planType: PlanType | null;
  /** Pass explicit ids to refetch a known finalist set (Step 6). */
  ids?: string[];
}

// Filled in on every fetch so callers can cheaply ask "did the last
// lookup actually hit the database?" without wiring a separate status
// channel through React Query. `'static_fallback'` means the server
// errored and we returned the 12-plan const below.
let lastSource: ApiPlansResponse['source'] = 'pm_plans';

export function lastPlanSource(): ApiPlansResponse['source'] {
  return lastSource;
}

export async function fetchPlansForClient(params: FetchPlansParams): Promise<Plan[]> {
  const qs = new URLSearchParams();
  if (params.ids && params.ids.length > 0) {
    qs.set('ids', params.ids.join(','));
  } else {
    if (params.state) qs.set('state', params.state);
    if (params.county) qs.set('county', params.county);
    if (params.planType) qs.set('planType', params.planType);
  }
  qs.set('limit', '2000');

  try {
    const res = await fetch(`/api/plans?${qs.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`plans ${res.status} — ${text.slice(0, 200)}`);
    }
    const body = (await res.json()) as ApiPlansResponse;
    lastSource = body.source ?? 'pm_plans';
    return body.plans.map(toPlan);
  } catch (err) {
    console.warn('[planCatalog] fetch failed, falling back to static seed:', err);
    lastSource = 'static_fallback';
    const { fallbackPlansForClient } = await import('./cmsPlans');
    return fallbackPlansForClient(params);
  }
}

/** Convenience for Step 6: fetch a specific set of finalist ids. */
export async function fetchPlansByIds(ids: string[]): Promise<Plan[]> {
  if (ids.length === 0) return [];
  return fetchPlansForClient({ state: null, county: '', planType: null, ids });
}

function toPlan(p: ApiPlan): Plan {
  return {
    id: p.id,
    contract_id: p.contract_id,
    plan_number: p.plan_number,
    carrier: p.carrier,
    plan_name: p.plan_name,
    state: p.state as StateCode,
    counties: p.counties ?? [],
    plan_type: p.plan_type,
    premium: p.premium ?? 0,
    annual_deductible: p.annual_deductible ?? null,
    moop_in_network: p.moop_in_network ?? 0,
    moop_out_of_network: p.moop_out_of_network ?? null,
    drug_deductible: p.drug_deductible ?? null,
    part_b_giveback: p.part_b_giveback ?? 0,
    star_rating: p.star_rating ?? 0,
    benefits: fillBenefits(p.benefits ?? {}),
    // Formulary is queried per-(plan, rxcui) via /api/formulary — the
    // Plan type still carries a formulary dict for back-compat; we
    // leave it empty so any direct lookup misses and the code falls
    // through to the proper formularyLookup path.
    formulary: {},
    // Network status flows through networkCheck.ts now. Leave empty
    // so the in-memory hash fallback stays unreachable.
    in_network_npis: [],
  };
}

function fillBenefits(partial: Partial<PlanBenefits>): PlanBenefits {
  return {
    dental: {
      preventive: partial.dental?.preventive ?? false,
      comprehensive: partial.dental?.comprehensive ?? false,
      annual_max: partial.dental?.annual_max ?? 0,
      description: partial.dental?.description ?? null,
    },
    vision: {
      exam: partial.vision?.exam ?? false,
      eyewear_allowance_year: partial.vision?.eyewear_allowance_year ?? 0,
      description: partial.vision?.description ?? null,
    },
    hearing: {
      aid_allowance_year: partial.hearing?.aid_allowance_year ?? 0,
      exam: partial.hearing?.exam ?? false,
      description: partial.hearing?.description ?? null,
    },
    transportation: {
      rides_per_year: partial.transportation?.rides_per_year ?? 0,
      distance_miles: partial.transportation?.distance_miles ?? 0,
      description: partial.transportation?.description ?? null,
    },
    otc: {
      allowance_per_quarter: partial.otc?.allowance_per_quarter ?? 0,
      description: partial.otc?.description ?? null,
    },
    food_card: {
      allowance_per_month: partial.food_card?.allowance_per_month ?? 0,
      restricted_to_medicaid_eligible:
        partial.food_card?.restricted_to_medicaid_eligible ?? false,
      description: partial.food_card?.description ?? null,
    },
    diabetic: {
      covered: partial.diabetic?.covered ?? false,
      preferred_brands: partial.diabetic?.preferred_brands ?? [],
    },
    fitness: {
      enabled: partial.fitness?.enabled ?? false,
      program: partial.fitness?.program ?? null,
    },
    medical: {
      primary_care: cs(partial.medical?.primary_care),
      specialist: cs(partial.medical?.specialist),
      urgent_care: cs(partial.medical?.urgent_care),
      emergency: cs(partial.medical?.emergency),
      inpatient: cs(partial.medical?.inpatient),
      outpatient_surgery_hospital: cs(partial.medical?.outpatient_surgery_hospital),
      outpatient_surgery_asc: cs(partial.medical?.outpatient_surgery_asc),
      outpatient_observation: cs(partial.medical?.outpatient_observation),
      lab_services: cs(partial.medical?.lab_services),
      diagnostic_tests: cs(partial.medical?.diagnostic_tests),
      xray: cs(partial.medical?.xray),
      diagnostic_radiology: cs(partial.medical?.diagnostic_radiology),
      therapeutic_radiology: cs(partial.medical?.therapeutic_radiology),
      mental_health_individual: cs(partial.medical?.mental_health_individual),
      mental_health_group: cs(partial.medical?.mental_health_group),
      physical_therapy: cs(partial.medical?.physical_therapy),
      telehealth: cs(partial.medical?.telehealth),
    },
    rx_tiers: {
      tier_1: cs(partial.rx_tiers?.tier_1),
      tier_2: cs(partial.rx_tiers?.tier_2),
      tier_3: cs(partial.rx_tiers?.tier_3),
      tier_4: cs(partial.rx_tiers?.tier_4),
      tier_5: cs(partial.rx_tiers?.tier_5),
    },
  };
}

function cs(v: { copay?: number | null; coinsurance?: number | null; description?: string | null } | undefined) {
  return {
    copay: v?.copay ?? null,
    coinsurance: v?.coinsurance ?? null,
    description: v?.description ?? null,
  };
}
