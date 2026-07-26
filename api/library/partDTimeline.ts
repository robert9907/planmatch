// Pure Part D phase-timeline projector — 12 monthly rows for a member's
// drug basket on one plan. Deductible → initial → catastrophic, mid-
// month straddle, per-drug insulin cap, ACIP vaccines at $0.
//
// Zero I/O. No DB, no network, no side-effects — call it from an agent
// screen, a consumer screen, a batch job, a test.
//
// ⚠ CROSS-REPO SYNC — this file exists at two locations:
//   robert9907/planmatch:  api/library/partDTimeline.ts     (agent)
//   robert9907/plan-match: packages/shared/src/partDTimeline.ts (consumer)
// Any change must be mirrored to the other until we publish this
// module as a standalone npm package that both repos depend on. Only
// the import path for planYearParams differs (agent uses `.js`
// suffix; consumer omits it to match its tsconfig). CI job
// partd-drift.yml runs scripts/check-partd-drift.mjs which enforces
// byte-identity after normalizing that suffix.

import { getPlanYearParams, type PlanYearParams } from './planYearParams.js';

// ─── Public types ─────────────────────────────────────────────────────

export type Phase = 'deductible' | 'initial' | 'catastrophic';

/** One drug + how the plan bills it. Callers translate their own
 *  formulary + drug-phase data into this shape. */
export interface DrugFill {
  rxcui: string;
  name: string;
  /** Plan formulary tier (1..5+). null when the drug is off-formulary;
   *  off-formulary drugs are excluded from timeline math (they don't
   *  count toward the deductible or TrOOP under CMS rules). */
  tier: number | null;
  /** Full retail cost of one fill (the plan's negotiated ingredient
   *  cost + dispensing fee). Used for deductible burn, coinsurance
   *  math, and grossDrugCost accounting. */
  monthlyGrossCost: number;
  /** How many fills per plan year. 12 for 30-day retail, 4 for 90-day
   *  mail-order. Any positive integer is accepted; fills are spaced
   *  evenly across the year starting at startMonth. */
  fillsPerYear: number;
  /** IRA insulin cap applies (§11406). Member cost per fill is capped
   *  at insulinMonthlyCap regardless of phase. */
  isInsulin?: boolean;
  /** ACIP-recommended Part D vaccine (§11401) — member pays
   *  vaccineMemberCost ($0) in every phase. Vaccine spend still counts
   *  toward grossDrugCost. */
  isVaccine?: boolean;
  /** Per-fill manufacturer discount amount that counts toward TrOOP
   *  (in the initial coverage phase for brand drugs, post-IRA §11201).
   *  Callers who don't have discount detail should leave this
   *  unset — TrOOP will underestimate by exactly this amount, which is
   *  the industry-standard approximation. */
  manufacturerDiscountPerFill?: number;
  // Present in the drug-phases request shape (see api/drug-phases.ts).
  // Not used by the math — accepted for API compatibility.
  ndc?: string;
  quantity?: number;
  daysSupply?: number;
}

export type CostShareType = 'copay' | 'coinsurance';

export interface PhaseCostShare {
  type: CostShareType;
  /** Dollars per fill for copay; fraction 0..1 for coinsurance. */
  amount: number;
  /** Optional lower/upper bounds (CMS files these on coinsurance rows
   *  as e.g. "25% coinsurance, min $10, max $150"). */
  min?: number;
  max?: number;
}

export interface TierCostShares {
  deductible?: PhaseCostShare;
  initial?: PhaseCostShare;
  catastrophic?: PhaseCostShare;
}

export interface PlanInput {
  /** Plan's filed Part D annual deductible ($). Zero means no
   *  deductible; capped by planYearParams.partDDeductibleMax. */
  deductible: number;
  /** Tiers subject to the deductible. CMS lets plans waive deductible
   *  on tier 1 and tier 2 (very common); some waive tiers 1..3. Fills
   *  of tiers not in this list skip the deductible phase entirely and
   *  bill at the initial-phase rate from month one. */
  deductibleAppliesToTiers: number[];
  /** Per-tier cost-share table. Missing tier or missing phase entry →
   *  treated as $0 to the member for that phase (i.e., a filing gap
   *  favors the beneficiary rather than penalizing them). */
  tierCostShares: Record<number, TierCostShares>;
}

export interface PartDTimelineArgs {
  drugs: ReadonlyArray<DrugFill>;
  plan: PlanInput;
  planYear: number;
  /** Optional override — when omitted, params are pulled from
   *  planYearParams.ts by planYear. Injectable for tests and for a
   *  future DB-backed params table without touching the function. */
  planYearParams?: PlanYearParams;
  /** Starting calendar month for the projection (1..12). Defaults to
   *  January. For mid-year enrollment quotes, callers pass the month
   *  the member's coverage begins. Months before startMonth are
   *  omitted from the returned array. */
  startMonth?: number;
}

export interface MonthlyRow {
  /** Calendar month 1..12. */
  month: number;
  /** Phase the month ENDS in. When phaseChangedMidMonth is true, this
   *  is the newer phase (the one the closing balance sits in). */
  phase: Phase;
  /** Member out-of-pocket spend attributable to this month. */
  memberCost: number;
  /** Running total of memberCost from startMonth through this month
   *  inclusive. */
  cumulativeMemberCost: number;
  /** True out-of-pocket accumulator — member cost + manufacturer
   *  discount contributions. Gates catastrophic transition. */
  troop: number;
  /** Total plan-negotiated drug cost this month (member + plan +
   *  manufacturer). Reported for transparency; does NOT gate phase. */
  grossDrugCost: number;
  /** True when at least one fill this month straddled a phase
   *  boundary (member paid at two different rates within the month). */
  phaseChangedMidMonth: boolean;
}

// ─── Internal state ───────────────────────────────────────────────────

interface RunState {
  deductibleRemaining: number;
  troop: number;
  cumulativeMemberCost: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function isFillMonth(
  drug: DrugFill,
  month: number,
  startMonth: number,
): boolean {
  if (drug.fillsPerYear <= 0) return false;
  if (month < startMonth) return false;
  const activeMonths = 12 - startMonth + 1;
  if (drug.fillsPerYear >= activeMonths) return true;
  // Space fills evenly across the remaining year, anchored to startMonth.
  //   fillsPerYear=4, startMonth=1 → months 1, 4, 7, 10
  //   fillsPerYear=4, startMonth=3 → months 3, 6, 9, 12
  const stride = Math.floor(activeMonths / drug.fillsPerYear);
  const offset = month - startMonth;
  return offset % stride === 0 && offset / stride < drug.fillsPerYear;
}

/** What the plan charges for a full fill of this drug in a given
 *  phase. `remainingGross` lets coinsurance be computed on a partial
 *  fill (mid-month straddle: the initial-phase piece is only part of
 *  the fill). For copay tiers the copay is scaled proportionally to
 *  the share of the fill in this phase, since a flat copay applied to
 *  a straddle piece would over-charge (the pharmacy bills the copay
 *  once for the whole fill, not once per phase piece). */
function memberCostForPhasePiece(args: {
  share: PhaseCostShare | undefined;
  fullFillGross: number;
  pieceGross: number;
  fallbackToRetail: boolean;
}): number {
  const { share, fullFillGross, pieceGross, fallbackToRetail } = args;
  if (pieceGross <= 0) return 0;
  if (!share) {
    // No filed cost share for this tier+phase. Deductible pieces bill
    // at retail (that's the whole point of the deductible); initial
    // pieces with a missing filing are treated as $0 (favor the
    // beneficiary — a filing gap shouldn't invent a charge).
    return fallbackToRetail ? pieceGross : 0;
  }
  if (share.type === 'coinsurance') {
    const raw = pieceGross * share.amount;
    return clampToMinMax(raw, share.min, share.max, pieceGross);
  }
  // Copay — scale proportionally to the share of the fill in this
  // phase so a straddle doesn't double-bill.
  const proportional = fullFillGross > 0
    ? share.amount * (pieceGross / fullFillGross)
    : share.amount;
  return clampToMinMax(proportional, share.min, share.max, pieceGross);
}

function clampToMinMax(
  value: number,
  min: number | undefined,
  max: number | undefined,
  cap: number,
): number {
  let v = value;
  if (min != null) v = Math.max(v, min);
  if (max != null) v = Math.min(v, max);
  // Member can never pay more than the drug actually costs.
  return Math.max(0, Math.min(v, cap));
}

function tierCanUseDeductible(tier: number | null, plan: PlanInput): boolean {
  if (tier == null) return false;
  return plan.deductibleAppliesToTiers.includes(tier);
}

// ─── Per-fill charge ──────────────────────────────────────────────────
//
// Handles a single fill event: splits across phases as needed, applies
// insulin cap and vaccine override, updates state, returns the fill's
// member cost and whether the fill straddled a boundary.

interface FillResult {
  memberCost: number;
  grossCost: number;
  straddled: boolean;
}

/** Charges one fill event and mutates state in place: draws down
 *  deductibleRemaining, adds to troop, and returns per-fill totals. */
function chargeFill(
  drug: DrugFill,
  state: RunState,
  plan: PlanInput,
  params: PlanYearParams,
): FillResult {
  const gross = Math.max(0, drug.monthlyGrossCost);
  const result: FillResult = {
    memberCost: 0,
    grossCost: gross,
    straddled: false,
  };

  // Off-formulary → member pays retail out of their own pocket, but
  // it doesn't accumulate toward the deductible or TrOOP under CMS
  // rules. Report as gross drug cost only.
  if (drug.tier == null || gross === 0) return result;

  // Vaccines: $0 to member (IRA §11401), no TrOOP contribution, gross
  // still counted.
  if (drug.isVaccine) {
    result.memberCost = params.vaccineMemberCost;
    return result;
  }

  // Already catastrophic — member cost is $0 (IRA §11201, 2025+).
  if (state.troop >= params.troopCap) return result;

  const tierShares: TierCostShares | undefined =
    plan.tierCostShares[drug.tier];
  const canUseDeductible = tierCanUseDeductible(drug.tier, plan);

  // ── Split fill across phases ────────────────────────────────────
  let deductiblePiece = 0;
  let initialPiece = 0;
  if (canUseDeductible && state.deductibleRemaining > 0) {
    deductiblePiece = Math.min(gross, state.deductibleRemaining);
    initialPiece = gross - deductiblePiece;
    state.deductibleRemaining -= deductiblePiece;
  } else {
    initialPiece = gross;
  }

  const deductibleMemberCost = memberCostForPhasePiece({
    share: tierShares?.deductible,
    fullFillGross: gross,
    pieceGross: deductiblePiece,
    fallbackToRetail: true,
  });

  const initialMemberCost = memberCostForPhasePiece({
    share: tierShares?.initial,
    fullFillGross: gross,
    pieceGross: initialPiece,
    fallbackToRetail: false,
  });

  let memberCost = deductibleMemberCost + initialMemberCost;
  let troopAdd = memberCost + (drug.manufacturerDiscountPerFill ?? 0);

  // ── Catastrophic mid-fill crossing ──────────────────────────────
  // If TrOOP would jump past the cap during this fill, refund the
  // over-cap portion of the initial piece — the pharmacy would have
  // billed the initial rate up to the crossing point, then $0. The
  // deductible piece is unaffected (deductible is fully due before
  // TrOOP counting for catastrophic even matters).
  const projectedTroop = state.troop + troopAdd;
  if (projectedTroop > params.troopCap && initialMemberCost > 0) {
    const overshoot = projectedTroop - params.troopCap;
    const refund = Math.min(overshoot, initialMemberCost);
    memberCost -= refund;
    troopAdd -= refund;
    result.straddled = true;
  }

  // ── Insulin cap ──────────────────────────────────────────────────
  if (drug.isInsulin && memberCost > params.insulinMonthlyCap) {
    const capped = params.insulinMonthlyCap;
    troopAdd -= (memberCost - capped);
    memberCost = capped;
  }

  // Straddle when both a deductible piece AND an initial piece were
  // charged in the same fill (member paid at two different rates).
  if (deductiblePiece > 0 && initialPiece > 0) result.straddled = true;

  state.troop += troopAdd;
  result.memberCost = memberCost;
  return result;
}

// ─── Public entry ─────────────────────────────────────────────────────

export function partDTimeline(args: PartDTimelineArgs): MonthlyRow[] {
  const startMonth = args.startMonth ?? 1;
  if (startMonth < 1 || startMonth > 12) {
    throw new Error(`partDTimeline: startMonth must be 1..12 (got ${startMonth})`);
  }
  const params = args.planYearParams ?? getPlanYearParams(args.planYear);

  // If no drug in the basket can burn the deductible (basket is
  // entirely on waived tiers), report the whole year as initial-phase
  // coverage rather than "we're in deductible but nobody's spending
  // toward it" — that would color the UI misleadingly.
  const anyDrugSubjectToDeductible = args.drugs.some((d) =>
    tierCanUseDeductible(d.tier, args.plan),
  );
  const effectiveDeductible = anyDrugSubjectToDeductible
    // Plan's filed deductible is capped by the year's max (a plan
    // filing above the max is a data error — clamp defensively).
    ? Math.min(Math.max(0, args.plan.deductible), params.partDDeductibleMax)
    : 0;

  const state: RunState = {
    deductibleRemaining: effectiveDeductible,
    troop: 0,
    cumulativeMemberCost: 0,
  };

  const rows: MonthlyRow[] = [];

  for (let month = startMonth; month <= 12; month += 1) {
    let monthMemberCost = 0;
    let monthGrossCost = 0;
    let anyStraddle = false;

    const phaseAtStart = currentPhase(state, params);

    // chargeFill mutates state (deductibleRemaining, troop) so
    // subsequent fills in the same month see the running balance —
    // a $600 fill followed by a $50 fill on the same day should have
    // the second fill see the deductible burn from the first.
    for (const drug of args.drugs) {
      if (!isFillMonth(drug, month, startMonth)) continue;
      const fill = chargeFill(drug, state, args.plan, params);
      monthMemberCost += fill.memberCost;
      monthGrossCost += fill.grossCost;
      if (fill.straddled) anyStraddle = true;
    }

    state.cumulativeMemberCost += monthMemberCost;

    const phaseAtEnd = currentPhase(state, params);
    const phaseChangedMidMonth =
      anyStraddle || phaseAtStart !== phaseAtEnd;

    rows.push({
      month,
      phase: phaseAtEnd,
      memberCost: round2(monthMemberCost),
      cumulativeMemberCost: round2(state.cumulativeMemberCost),
      troop: round2(state.troop),
      grossDrugCost: round2(monthGrossCost),
      phaseChangedMidMonth,
    });
  }

  return rows;
}

function currentPhase(state: RunState, params: PlanYearParams): Phase {
  if (state.troop >= params.troopCap) return 'catastrophic';
  if (state.deductibleRemaining > 0) return 'deductible';
  return 'initial';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
