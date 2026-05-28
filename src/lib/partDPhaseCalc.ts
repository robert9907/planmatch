// partDPhaseCalc — Part D calendar-year cost projection.
//
// For each user drug + plan combo, walk Jan→Dec and determine which
// phase (Deductible / Initial / Gap / Catastrophic) the member is in at
// fill time, then compute the user's out-of-pocket for that fill.
//
// Inputs the calc engine expects to already be resolved by the parent:
//   • medications: useSession((s) => s.medications)
//   • plan:        a Plan (carries drug_deductible + benefits.rx_tiers)
//   • formulary:   { [rxcui]: FormularyHit } for THIS plan
//
// Retail-cost proxy: the existing TIER_NOTIONAL_RETAIL_MONTHLY constant
// in src/lib/drugCosts.ts (Tier 1=$8 / 2=$30 / 3=$200 / 4=$500 / 5=$1500
// — and the same notionals are mirrored for tiers 6-8). That same
// constant already drives the coinsurance-only monthly $ estimates on
// the Compare / Quote table, so the phase math here stays consistent
// with what the rest of the Rx UI displays.
//
// CMS 2026 constants — task spec values (the IRA-redesign $2k OOP cap +
// $5,030 ICL + $590 standard deductible). The gap phase models 25% of
// negotiated price between ICL and the $2,000 OOP cap.

import type { Medication } from '@/types/session';
import type { Plan, FormularyTier, RxTierCopays } from '@/types/plans';
import type { FormularyHit } from '@/lib/formularyLookup';

export const PART_D_2026 = {
  STANDARD_DEDUCTIBLE: 590,
  INITIAL_COVERAGE_LIMIT: 5030,
  TROOP_CAP: 2000,
  GAP_USER_COINSURANCE: 0.25,
} as const;

// Mirror of TIER_NOTIONAL_RETAIL_MONTHLY in src/lib/drugCosts.ts. Kept
// inlined rather than re-imported so this module has no behavioral
// coupling to the existing per-drug cell render path. Update both
// together if the notional table changes.
const TIER_RETAIL_MONTHLY: Record<number, number> = {
  1: 8,
  2: 30,
  3: 200,
  4: 500,
  5: 1500,
  6: 8,
  7: 30,
  8: 200,
};

// Realistic monthly retail for drugs not on the plan's formulary.
// Used only as a display placeholder; the UI marks these as "Not
// covered" so the dollar figure reads as "what you'd pay without this
// plan" rather than an in-plan cost-share.
const NOT_COVERED_RETAIL_MONTHLY = 200;

export type PartDPhase = 'deductible' | 'initial' | 'gap' | 'catastrophic';

export interface DrugMonthCost {
  rxcui: string | null;
  name: string;
  tier: FormularyTier | 'not_covered' | null;
  retail: number;
  userCost: number;
  phase: PartDPhase | 'not_covered';
  coverageNote: string | null;
}

export interface MonthCost {
  month: number;
  monthName: string;
  drugs: DrugMonthCost[];
  monthTotal: number;
  cumulativeUserOop: number;
  cumulativeGrossSpend: number;
  startPhase: PartDPhase;
  endPhase: PartDPhase;
}

export interface PartDTimeline {
  months: MonthCost[];
  totalAnnualOop: number;
  totalAnnualGross: number;
  // Month index (1-12) where each phase first starts. null if never reached.
  initialPhaseStartsMonth: number | null;
  gapPhaseStartsMonth: number | null;
  catastrophicStartsMonth: number | null;
  // True when at least one drug is not on this plan's formulary.
  hasUncoveredDrug: boolean;
  // True when the plan's drug deductible is $0/null (deductible phase skipped).
  zeroDeductible: boolean;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function tierRetail(tier: FormularyTier | 'not_covered' | null): number {
  if (tier == null || tier === 'not_covered' || tier === 'excluded') {
    return NOT_COVERED_RETAIL_MONTHLY;
  }
  return TIER_RETAIL_MONTHLY[tier as number] ?? NOT_COVERED_RETAIL_MONTHLY;
}

function tierKey(tier: number): keyof RxTierCopays | null {
  switch (tier) {
    case 1: return 'tier_1';
    case 2: return 'tier_2';
    case 3: return 'tier_3';
    case 4: return 'tier_4';
    case 5: return 'tier_5';
    case 6: return 'tier_6';
    case 7: return 'tier_7';
    case 8: return 'tier_8';
    default: return null;
  }
}

// Initial-phase user cost for one monthly fill, derived from the plan's
// filed cost-share for the drug's tier. Prefers the per-drug formulary
// row (more specific) and falls back to the plan-level rx_tiers table.
// Coinsurance is applied against the tier-notional retail so a "25%
// coinsurance" row produces a real $ estimate instead of $0.
function initialPhaseCost(
  tier: FormularyTier | 'not_covered' | null,
  formulary: FormularyHit | null,
  plan: Plan,
  retail: number,
): number {
  if (tier == null || tier === 'not_covered' || tier === 'excluded') {
    // Off-formulary fills don't have an in-plan cost share. User pays
    // retail; not credited to TrOOP.
    return retail;
  }
  // Path 1: per-drug copay filed on pm_formulary.
  if (formulary && typeof formulary.copay === 'number' && formulary.copay >= 0) {
    return formulary.copay;
  }
  // Path 2: per-drug coinsurance fraction filed on pm_formulary.
  if (
    formulary
    && typeof formulary.coinsurance === 'number'
    && formulary.coinsurance > 0
  ) {
    const frac = formulary.coinsurance > 1
      ? formulary.coinsurance / 100
      : formulary.coinsurance;
    return Math.round(retail * frac);
  }
  // Path 3: plan-level tier copay/coinsurance from pm_plan_benefits.
  const key = tierKey(tier as number);
  const tierShare = key ? plan.benefits.rx_tiers[key] : null;
  if (tierShare) {
    if (typeof tierShare.copay === 'number' && tierShare.copay >= 0) {
      return tierShare.copay;
    }
    if (typeof tierShare.coinsurance === 'number' && tierShare.coinsurance > 0) {
      // pm_plan_benefits stores coinsurance as a percent integer (25 = 25%).
      const frac = tierShare.coinsurance > 1
        ? tierShare.coinsurance / 100
        : tierShare.coinsurance;
      return Math.round(retail * frac);
    }
  }
  // Last-resort: assume $0 generic-tier or $35 brand-tier.
  return tier === 1 || tier === 2 || tier === 6 || tier === 7 ? 0 : 35;
}

function phaseFromCumulative(
  cumulativeUserOop: number,
  cumulativeGross: number,
  deductible: number,
): PartDPhase {
  if (deductible > 0 && cumulativeUserOop < deductible) return 'deductible';
  if (cumulativeGross < PART_D_2026.INITIAL_COVERAGE_LIMIT) return 'initial';
  if (cumulativeUserOop < PART_D_2026.TROOP_CAP) return 'gap';
  return 'catastrophic';
}

function resolveCoverageNote(
  hit: FormularyHit | null,
  tier: FormularyTier | 'not_covered' | null,
): string | null {
  if (tier == null || tier === 'not_covered') return 'Not on formulary';
  if (tier === 'excluded') return 'Excluded from formulary';
  if (!hit) return null;
  const notes: string[] = [];
  if (hit.prior_auth) notes.push('Prior auth');
  if (hit.step_therapy) notes.push('Step therapy');
  if (hit.quantity_limit) notes.push('Quantity limit');
  return notes.length > 0 ? notes.join(' · ') : null;
}

export function computePartDTimeline(
  medications: Medication[],
  plan: Plan,
  formulary: Record<string, FormularyHit>,
): PartDTimeline {
  const deductible = plan.drug_deductible ?? 0;
  const zeroDeductible = deductible <= 0;
  let cumulativeUserOop = 0;
  let cumulativeGross = 0;
  let hasUncoveredDrug = false;
  let initialPhaseStartsMonth: number | null = null;
  let gapPhaseStartsMonth: number | null = null;
  let catastrophicStartsMonth: number | null = null;

  // Resolve each med's tier once — stable across months.
  const drugInfos = medications.map((med) => {
    const hit = med.rxcui ? formulary[med.rxcui] ?? null : null;
    const rawTier = hit?.tier ?? 'not_covered';
    const tier: FormularyTier | 'not_covered' =
      rawTier === 'excluded' ? 'not_covered' : rawTier;
    if (tier === 'not_covered') hasUncoveredDrug = true;
    const retail = tierRetail(tier);
    const coverageNote = resolveCoverageNote(hit, tier);
    return { med, hit, tier, retail, coverageNote };
  });

  const months: MonthCost[] = [];

  for (let m = 1; m <= 12; m++) {
    const startPhase = phaseFromCumulative(cumulativeUserOop, cumulativeGross, deductible);
    const drugRows: DrugMonthCost[] = [];
    let monthTotal = 0;

    for (const { med, hit, tier, retail, coverageNote } of drugInfos) {
      // Off-formulary drugs don't accrue against the plan's TrOOP or
      // gross spend (Medicare doesn't credit excluded fills). Render
      // them at retail with a 'not_covered' phase tag.
      if (tier === 'not_covered') {
        drugRows.push({
          rxcui: med.rxcui ?? null,
          name: med.name,
          tier,
          retail,
          userCost: retail,
          phase: 'not_covered',
          coverageNote,
        });
        monthTotal += retail;
        continue;
      }

      // Atomic per-fill pricing: a single fill is charged at whatever
      // phase the user is in when that fill is processed. The phase
      // boundary is crossed AFTER the fill — so a January Ozempic in
      // deductible phase pays 100% of retail even if that fill pushes
      // cumulative-OOP past the deductible threshold. The next fill
      // sees the new phase. Matches simple CMS adjudication and keeps
      // the math interpretable for the user.
      const phase = phaseFromCumulative(cumulativeUserOop, cumulativeGross, deductible);
      let userCost = 0;
      if (phase === 'deductible') {
        userCost = retail;
      } else if (phase === 'initial') {
        userCost = initialPhaseCost(tier, hit, plan, retail);
      } else if (phase === 'gap') {
        userCost = Math.round(retail * PART_D_2026.GAP_USER_COINSURANCE);
      }
      // catastrophic = $0 (already 0 from init)

      // Don't ever charge more than retail (sanity).
      userCost = Math.min(userCost, retail);

      cumulativeUserOop += userCost;
      cumulativeGross += retail;
      monthTotal += userCost;

      drugRows.push({
        rxcui: med.rxcui ?? null,
        name: med.name,
        tier,
        retail,
        userCost,
        phase,
        coverageNote,
      });
    }

    const endPhase = phaseFromCumulative(cumulativeUserOop, cumulativeGross, deductible);

    if (initialPhaseStartsMonth == null && endPhase !== 'deductible') {
      initialPhaseStartsMonth = m;
    }
    if (gapPhaseStartsMonth == null && (endPhase === 'gap' || endPhase === 'catastrophic')) {
      gapPhaseStartsMonth = m;
    }
    if (catastrophicStartsMonth == null && endPhase === 'catastrophic') {
      catastrophicStartsMonth = m;
    }

    months.push({
      month: m,
      monthName: MONTH_NAMES[m - 1],
      drugs: drugRows,
      monthTotal,
      cumulativeUserOop,
      cumulativeGrossSpend: cumulativeGross,
      startPhase,
      endPhase,
    });
  }

  return {
    months,
    totalAnnualOop: cumulativeUserOop,
    totalAnnualGross: cumulativeGross,
    initialPhaseStartsMonth,
    gapPhaseStartsMonth,
    catastrophicStartsMonth,
    hasUncoveredDrug,
    zeroDeductible,
  };
}

// ── Brain-data adapter ──────────────────────────────────────────────
// usePlanBrain stores formulary rows as `FormularyRow` (a slightly
// different shape from FormularyHit — no drug_name / quantity_limit,
// nullable booleans). Top4Screen, PlanDetailView, and QuoteDeliveryV4
// all need to feed the CalendarYearCost component a
// Record<rxcui, FormularyHit>, so we centralize the conversion here.

interface BrainFormularyRow {
  tier: number | null;
  copay: number | null;
  coinsurance: number | null;
  prior_auth: boolean | null;
  step_therapy: boolean | null;
}

export function brainSlotToFormularyMap(
  slot: Record<string, BrainFormularyRow> | undefined,
): Record<string, FormularyHit> {
  if (!slot) return {};
  const out: Record<string, FormularyHit> = {};
  for (const [rxcui, row] of Object.entries(slot)) {
    const t = row.tier;
    const tier: FormularyHit['tier'] =
      typeof t === 'number' && t >= 1 && t <= 8
        ? (t as FormularyTier)
        : 'not_covered';
    out[rxcui] = {
      tier,
      copay: row.copay,
      coinsurance: row.coinsurance,
      drug_name: null,
      prior_auth: !!row.prior_auth,
      step_therapy: !!row.step_therapy,
      quantity_limit: false,
    };
  }
  return out;
}

export function phaseLabel(phase: PartDPhase | 'not_covered'): string {
  switch (phase) {
    case 'deductible': return 'Deductible';
    case 'initial': return 'Initial Coverage';
    case 'gap': return 'Coverage Gap';
    case 'catastrophic': return 'Catastrophic';
    case 'not_covered': return 'Not Covered';
  }
}

// Brand palette from the Calendar Year Cost mockup. Exported so the
// component (and any KPI / chart consumer) can read the same colors.
export const PHASE_COLORS: Record<PartDPhase, string> = {
  deductible: '#FF4040',
  initial: '#00CFFF',
  gap: '#FF6A00',
  catastrophic: '#00E59B',
};
