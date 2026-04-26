import type {
  BenefitFilterState,
  BenefitKey,
  CutTag,
  FunnelSnapshot,
  Plan,
} from '@/types/plans';
import type { Medication, Provider } from '@/types/session';
import { getCachedFormulary } from './formularyLookup';

interface FilterInput {
  plans: Plan[];
  medications: Medication[];
  providers: Provider[];
  benefitFilters: BenefitFilterState;
}

export function computeFunnel(input: FilterInput): FunnelSnapshot {
  const { plans, medications, providers, benefitFilters } = input;
  const cuts: CutTag[] = [];
  const alive = new Set(plans.map((p) => p.id));

  // --- Provider elimination (in-network required if provider was confirmed in) ---
  for (const provider of providers) {
    if (!provider.npi) continue;
    if (provider.manuallyConfirmed) continue;
    if (!provider.networkStatus) continue;
    for (const plan of plans) {
      if (!alive.has(plan.id)) continue;
      const status = provider.networkStatus[plan.id];
      if (status === 'out') {
        cuts.push({
          plan_id: plan.id,
          reason: 'provider_out_of_network',
          detail: `${provider.name} out of network`,
        });
        alive.delete(plan.id);
      }
    }
  }

  const afterProviders = alive.size;

  // --- Formulary elimination (pm_formulary-backed) ---
  // Reads the cache primed by bulkLookupFormulary. A missing cache entry
  // means the server hasn't responded yet — treat as neutral and don't
  // cut (the caller re-runs once the cache fills, see Step5's tick).
  // A med with no rxcui is also neutral — can't authoritatively call it
  // uncovered without an RxNorm match, so keep the plan.
  for (const med of medications) {
    if (!med.rxcui) continue;
    for (const plan of plans) {
      if (!alive.has(plan.id)) continue;
      const contractPlanId = `${plan.contract_id}_${plan.plan_number}`;
      const hit = getCachedFormulary(contractPlanId, med.rxcui);
      if (!hit) continue;
      if (hit.tier === 'not_covered' || hit.tier === 'excluded') {
        cuts.push({
          plan_id: plan.id,
          reason: 'formulary_gap',
          detail: `${med.name} not on formulary`,
        });
        alive.delete(plan.id);
      }
    }
  }

  const afterFormulary = alive.size;

  // --- Benefit filter elimination ---
  for (const plan of plans) {
    if (!alive.has(plan.id)) continue;
    for (const key of Object.keys(benefitFilters) as BenefitKey[]) {
      const f = benefitFilters[key];
      if (!f.enabled) continue;
      if (!passesBenefit(plan, key, f)) {
        cuts.push({
          plan_id: plan.id,
          reason: 'benefit_filter',
          detail: benefitLabel(key) + ' requirement not met',
        });
        alive.delete(plan.id);
        break;
      }
    }
  }

  return {
    total: plans.length,
    after_providers: afterProviders,
    after_formulary: afterFormulary,
    finalists: alive.size,
    cuts,
  };
}

export function finalistIdsFromSnapshot(plans: Plan[], snapshot: FunnelSnapshot): string[] {
  const dead = new Set(snapshot.cuts.map((c) => c.plan_id));
  return plans.filter((p) => !dead.has(p.id)).map((p) => p.id);
}

// Pass-by-default semantics. The principle: missing benefit data
// should never eliminate a plan. api/plans.ts coerces null/missing
// max_coverage and coverage_amount values to 0 (planCatalog.ts does
// the same), so 0 is indistinguishable from "no row in
// pm_plan_benefits for this category". Treating 0 as failure was the
// previous bug — Hearing toggle on "Any" returned 1/33 because most
// plans land at 0 (the file's max_coverage is often blank for
// hearing/dental/vision when the SoB carries the dollar amount).
//
// Rules per the V4 spec:
//   • tier === 'any' (or undefined / 'basic') → no value threshold;
//     plan passes regardless of dollar amount. Sub-toggle
//     requirements (e.g. comprehensive dental, OneTouch diabetic)
//     still apply because those are categorical not numeric.
//   • tier === 'enhanced' or 'premium' → enforce the minimum dollar
//     value, but ONLY when the value is > 0. A 0 value is treated as
//     missing data and passes. Only an explicit value below the tier
//     threshold (e.g. $1,200 dental when the user picked $1,500+)
//     fails the filter.
//   • Categorical flags (dental.preventive, vision.exam,
//     diabetic.covered, fitness.enabled) used to be hard
//     requirements. They're now treated as informational only — MAPD
//     plans almost universally include preventive dental + a vision
//     exam + a fitness program, so the data layer's failure to
//     populate the flag shouldn't cascade into a filter cut.
function passesBenefit(plan: Plan, key: BenefitKey, f: import('@/types/plans').BenefitFilter): boolean {
  const b = plan.benefits;
  const noThreshold = f.tier === 'any' || !f.tier;

  switch (key) {
    case 'dental': {
      if (!noThreshold && b.dental.annual_max > 0) {
        if (f.tier === 'premium' && b.dental.annual_max < 2500) return false;
        if (f.tier === 'enhanced' && b.dental.annual_max < 1500) return false;
      }
      if (f.subToggles?.comprehensive && !b.dental.comprehensive) return false;
      return true;
    }
    case 'vision': {
      if (!noThreshold && b.vision.eyewear_allowance_year > 0) {
        if (f.tier === 'premium' && b.vision.eyewear_allowance_year < 350) return false;
        if (f.tier === 'enhanced' && b.vision.eyewear_allowance_year < 250) return false;
      }
      return true;
    }
    case 'hearing': {
      if (!noThreshold && b.hearing.aid_allowance_year > 0) {
        if (f.tier === 'premium' && b.hearing.aid_allowance_year < 2000) return false;
        if (f.tier === 'enhanced' && b.hearing.aid_allowance_year < 1500) return false;
      }
      return true;
    }
    case 'transportation': {
      if (!noThreshold && b.transportation.rides_per_year > 0) {
        if (f.tier === 'premium' && b.transportation.rides_per_year < 36) return false;
        if (f.tier === 'enhanced' && b.transportation.rides_per_year < 24) return false;
      }
      return true;
    }
    case 'otc': {
      if (!noThreshold && b.otc.allowance_per_quarter > 0) {
        if (f.tier === 'premium' && b.otc.allowance_per_quarter < 200) return false;
        if (f.tier === 'enhanced' && b.otc.allowance_per_quarter < 150) return false;
      }
      return true;
    }
    case 'food_card': {
      if (!noThreshold && b.food_card.allowance_per_month > 0) {
        if (f.tier === 'premium' && b.food_card.allowance_per_month < 150) return false;
        if (f.tier === 'enhanced' && b.food_card.allowance_per_month < 100) return false;
      }
      return true;
    }
    case 'diabetic': {
      // Sub-toggle preferred-brand checks fire on every tier, but only
      // when the brand list is non-empty. An empty list is missing
      // data, not "no preferred brands."
      const brands = b.diabetic.preferred_brands;
      if (f.subToggles?.onetouch && brands.length > 0 && !brands.includes('OneTouch')) return false;
      if (f.subToggles?.accuchek && brands.length > 0 && !brands.includes('Accu-Chek')) return false;
      return true;
    }
    case 'fitness': {
      // Program sub-toggle only matters when fitness.program is set.
      // Missing program string = pass (don't punish unfileded data).
      if (f.subToggles?.silversneakers && b.fitness.program && b.fitness.program !== 'SilverSneakers') return false;
      if (f.subToggles?.renew_active && b.fitness.program && b.fitness.program !== 'Renew Active') return false;
      return true;
    }
  }
}

export function benefitLabel(key: BenefitKey): string {
  const map: Record<BenefitKey, string> = {
    dental: 'Dental',
    vision: 'Vision',
    hearing: 'Hearing',
    transportation: 'Transportation',
    otc: 'OTC',
    food_card: 'Food card',
    diabetic: 'Diabetic supplies',
    fitness: 'Fitness',
  };
  return map[key];
}
