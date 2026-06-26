// planDisplay — derive the short display strings the swipe / pinned /
// compare cards expect from the real Plan shape.
//
// The reference mockup hand-types fields like dentalMax: "$2,500/yr",
// otcAllowance: 50, hearing: "Routine + aids". Real plans expose nested
// objects in `Plan.benefits.*`. This module is the single place that
// maps one to the other so every card renders consistently.

import type { Plan } from '@/types/plans';
import { fitnessProgramForCarrier } from '@/lib/fitness-program';

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

  // Brand the fitness benefit using the carrier heuristic — Humana →
  // Go365, UHC/AARP → Renew Active, BCBS → Silver&Fit, default →
  // SilverSneakers. Prefer the value already filed on the plan if it's
  // a real program name; "Yes" / null fall through to the heuristic so
  // the agent never sees a generic label.
  const filedProgram = b.fitness.program;
  const fitness = b.fitness.enabled
    ? filedProgram && filedProgram !== 'OneCall' && filedProgram !== 'Active&Fit'
      ? filedProgram
      : fitnessProgramForCarrier(plan.carrier)
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

// formatPcp / formatSpecialist used to read .copay only and return "—"
// when copay was null. That hid every coinsurance-only filing — UHC
// H5453-016 specialist files coinsurance=30 with copay=null and the
// Compare screen rendered "—" instead of "30%". Delegate to
// formatCostShare so the full copay → coinsurance → description ladder
// is honored.
export function formatPcp(plan: Plan): string {
  return formatCostShare(plan.benefits.medical.primary_care);
}

export function formatSpecialist(plan: Plan): string {
  return formatCostShare(plan.benefits.medical.specialist);
}

// Generic CostShare formatter — copay wins when present, otherwise
// coinsurance %, otherwise the benefit_description (for SNP / "covered"
// rows where CMS doesn't file a structured $), otherwise em-dash.
// PDP guard: when the column is a Part D drug-only plan, medical
// categories don't apply — render "N/A — Part D only" instead of "—".
export function formatCostShare(
  cs:
    | {
        copay: number | null;
        coinsurance: number | null;
        description?: string | null;
      }
    | undefined
    | null,
  opts?: { isPdp?: boolean },
): string {
  if (opts?.isPdp) return 'N/A — Part D only';
  if (!cs) return '—';
  if (cs.copay != null) return `$${cs.copay}`;
  if (cs.coinsurance != null) return `${cs.coinsurance}%`;
  if (cs.description) return cs.description;
  return '—';
}

// Range-aware CostShare formatter. Carriers commonly file ranged
// copays for advanced imaging / outpatient surgery / diagnostic
// procedures where the actual member cost depends on the specific
// CPT code; pm_plan_benefits.copay stores only the minimum of the
// range, but the benefit_description carries the full span ("MRI /
// CT / PET · $0–$325 copay"). Surfacing just "$0" misleads the
// broker into thinking the worst case is $0 too. When a parsable
// range is in the description AND its low end matches the stored
// copay, render the full "$LOW–$HIGH" instead.
const COST_RANGE_RE = /\$(\d[\d,]*)\s*[–\-—to]+\s*\$(\d[\d,]*)/i;

export function formatCostShareWithRange(
  cs:
    | {
        copay: number | null;
        coinsurance: number | null;
        description: string | null;
      }
    | undefined
    | null,
  opts?: { isPdp?: boolean },
): string {
  if (opts?.isPdp) return 'N/A — Part D only';
  if (!cs) return '—';
  if (cs.copay != null) {
    if (cs.description) {
      const m = cs.description.match(COST_RANGE_RE);
      if (m) {
        const low = parseInt(m[1].replace(/,/g, ''), 10);
        const high = parseInt(m[2].replace(/,/g, ''), 10);
        if (
          Number.isFinite(low) &&
          Number.isFinite(high) &&
          high > low &&
          low === cs.copay
        ) {
          return `$${low}–$${high}`;
        }
      }
    }
    return `$${cs.copay}`;
  }
  if (cs.coinsurance != null) return `${cs.coinsurance}%`;
  if (cs.description) return cs.description;
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
