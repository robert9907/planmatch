// planDisplay — derive the short display strings the swipe / pinned /
// compare cards expect from the real Plan shape.
//
// The reference mockup hand-types fields like dentalMax: "$2,500/yr",
// otcAllowance: 50, hearing: "Routine + aids". Real plans expose nested
// objects in `Plan.benefits.*`. This module is the single place that
// maps one to the other so every card renders consistently.

import type { Plan } from '@/types/plans';

export interface PlanDisplay {
  dental: string;
  dentalMax: string;
  vision: string;
  visionAllowance: string;
  hearing: string;
  otcText: string;          // formatted "$N/mo"
  otcMonthly: number;       // raw monthly $ for goodness comparisons
  meals: string;
  transport: string;
  fitness: string;
  ozempicMonthlyHint: string | null;  // optional rx hint for headers
}

function fmtMoney(n: number): string {
  return '$' + n.toLocaleString();
}

export function planDisplay(plan: Plan): PlanDisplay {
  const b = plan.benefits;
  // Dental: prefer the structured annual_max; fall back to a coverage
  // descriptor when the plan only filed a description string.
  const dental = b.dental.comprehensive
    ? 'Comprehensive'
    : b.dental.preventive
      ? 'Preventive only'
      : b.dental.description
        ? 'Per description'
        : 'None';
  const dentalMax = b.dental.annual_max > 0
    ? `${fmtMoney(b.dental.annual_max)}/yr`
    : b.dental.preventive || b.dental.comprehensive
      ? 'No annual cap filed'
      : 'None';

  const vision = b.vision.exam
    ? b.vision.eyewear_allowance_year > 0
      ? 'Routine + eyewear'
      : 'Exam only'
    : 'None';
  const visionAllowance = b.vision.eyewear_allowance_year > 0
    ? `${fmtMoney(b.vision.eyewear_allowance_year)}`
    : '$0';

  const hearing = b.hearing.aid_allowance_year > 0
    ? b.hearing.exam
      ? `Routine + ${fmtMoney(b.hearing.aid_allowance_year)}/yr aids`
      : `${fmtMoney(b.hearing.aid_allowance_year)}/yr aids`
    : b.hearing.exam
      ? 'Routine only'
      : 'None';

  // OTC pm_plan_benefits files quarterly; spec headers in $/mo.
  const otcMonthly = Math.round(b.otc.allowance_per_quarter / 3);
  const otcText = otcMonthly > 0 ? `$${otcMonthly}/mo` : '$0/mo';

  const meals = b.food_card.allowance_per_month > 0
    ? `$${b.food_card.allowance_per_month}/mo`
    : 'None';

  const transport = b.transportation.rides_per_year > 0
    ? `${b.transportation.rides_per_year} trips/yr`
    : 'None';

  const fitness = b.fitness.enabled
    ? b.fitness.program ?? 'Yes'
    : 'None';

  return {
    dental,
    dentalMax,
    vision,
    visionAllowance,
    hearing,
    otcText,
    otcMonthly,
    meals,
    transport,
    fitness,
    ozempicMonthlyHint: null,
  };
}

// Annual = monthly premium × 12 + estimated annual drug cost. Drug
// cost is supplied by the caller (resolved upstream from useDrugCosts /
// usePlanBrain) so this function stays a pure formatter.
export function annualEstimate(plan: Plan, annualDrugCost: number | null): {
  total: number | null;
  premiumComponent: number;
  drugComponent: number | null;
} {
  const premiumComponent = plan.premium * 12;
  if (annualDrugCost == null) {
    return { total: null, premiumComponent, drugComponent: null };
  }
  return {
    total: premiumComponent + annualDrugCost,
    premiumComponent,
    drugComponent: annualDrugCost,
  };
}

export function formatPremium(plan: Plan): string {
  return plan.premium === 0 ? '$0' : `$${plan.premium}`;
}

export function formatPcp(plan: Plan): string {
  const c = plan.benefits.medical.primary_care.copay;
  return c == null ? '—' : `$${c}`;
}

export function formatSpecialist(plan: Plan): string {
  const c = plan.benefits.medical.specialist.copay;
  return c == null ? '—' : `$${c}`;
}

// Generic CostShare formatter — copay wins when present, otherwise
// coinsurance %, otherwise em-dash. Used by the CompareScreen expanded
// rows for medical-benefit categories and Part D tier copays.
export function formatCostShare(
  cs: { copay: number | null; coinsurance: number | null } | undefined | null,
): string {
  if (!cs) return '—';
  if (cs.copay != null) return `$${cs.copay}`;
  if (cs.coinsurance != null) return `${cs.coinsurance}%`;
  return '—';
}

export function costShareNumeric(
  cs: { copay: number | null; coinsurance: number | null } | undefined | null,
): number | null {
  if (!cs) return null;
  if (cs.copay != null) return cs.copay;
  if (cs.coinsurance != null) return cs.coinsurance;
  return null;
}
