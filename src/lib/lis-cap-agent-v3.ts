// LIS (Extra Help) cap adjustment for the agent-v3 library-ranked flow.
//
// The library rank-plans endpoint returns per-plan total_annual_drug_cost
// AT full plan copays — it doesn't yet know about the client's LIS tier.
// The consumer repo will eventually apply caps server-side; until then
// this helper runs the same math client-side over LibraryRankPlan
// medications so CompareScreen displays what the client actually pays.
//
// Uses a tier heuristic for generic-vs-brand classification because
// LibraryRankMedication doesn't carry drug_type yet (see migration 017 —
// pm_formulary_v2.drug_type is populated but the library response
// hasn't been extended to surface it). Tier 1–2 → generic; tier 3+ →
// brand. Specialty drugs are capped at the brand rate per CMS (LIS has
// no separate specialty cap). This heuristic misses plans that put
// generics on tier 3 or brand-name drugs on tier 2 — acceptable for
// MVP, will be tightened when the library response carries drug_type
// per-medication.

import {
  getLisCopays,
  type DualEligibleAdjustment,
  type LisTier,
  type LivingSetting,
  type MedicaidLevel,
} from './dual-eligible';
import { PART_D_OOP_CAP_2026 } from './plan-brain-utils';
import type { LibraryRankPlan, LibraryRankResult } from './library-client';
import type { Plan } from '../types/plans';

export interface LisCappableDrug {
  covered: boolean;
  /** Full plan-copay yearly cost. */
  annualCost: number;
  /** Formulary tier (1..N) when covered; null when not on formulary. */
  tier: number | null;
}

export interface LisCapResult {
  /** Sum after applying per-fill LIS caps + TrOOP backstop. */
  adjustedTotal: number;
  /** The caps that were applied, or null when lisTier === 'none'. */
  lisCopaysApplied: { generic: number; brand: number } | null;
}

/** Given a plan's medications and the client's LIS tier, return the
 *  yearly drug-cost total after per-fill LIS caps + TrOOP backstop.
 *
 *  Mirrors the LIS branch of applyDualEligibleCostAdjustment() in
 *  ./dual-eligible.ts. Only the LIS path — this helper does NOT zero
 *  QMB medical cost-sharing or apply the D-SNP premium override. Those
 *  are handled at a different layer.
 *
 *  When lisTier is 'none', returns the input sum unchanged. */
export function applyLisCapsToLibraryPlan(
  medications: ReadonlyArray<LisCappableDrug>,
  lisTier: LisTier,
): LisCapResult {
  const lisCopays = getLisCopays(lisTier);
  if (!lisCopays) {
    return {
      adjustedTotal: medications.reduce((sum, m) => sum + m.annualCost, 0),
      lisCopaysApplied: null,
    };
  }
  let running = 0;
  for (const m of medications) {
    if (!m.covered) {
      running += m.annualCost;
      continue;
    }
    // Brain assumes 12 fills/year. Matches dual-eligible.ts:212.
    const planPerFill = m.annualCost > 0 ? m.annualCost / 12 : 0;
    const isBrand = m.tier != null && m.tier >= 3;
    const lisCap = isBrand ? lisCopays.brand : lisCopays.generic;
    const perFill = Math.min(planPerFill, lisCap);
    running += Math.round(perFill * 12);
  }
  return {
    adjustedTotal: Math.min(running, PART_D_OOP_CAP_2026),
    lisCopaysApplied: lisCopays,
  };
}

/** Build the by-plan-id maps CompareScreen needs when the client has
 *  Medicaid or LIS on file. Replaces the legacy `usePlanBrain`-fed
 *  `dualEligibleByPlanId` for the agent-v3 library-ranked flow.
 *
 *  Returns two maps:
 *   • `annualDrugByPlanId` — total_annual_drug_cost per plan, LIS-
 *     adjusted when lisTier !== 'none' (used by the Drug cost / yr
 *     column + MetricMini per-plan card).
 *   • `dualEligibleByPlanId` — a DualEligibleAdjustment per plan, so
 *     the existing MetricMini strike + DualEligibleBadges render
 *     without a code change. `original.totalAnnualDrugCost` carries
 *     the pre-adjustment plan cost for the strikethrough; other
 *     `original.*` fields the Compare surface doesn't read are stubbed
 *     — the agent-v3 flow doesn't produce a full BrainScore. */
export function buildAgentV3LisMaps(args: {
  ranked: LibraryRankResult | null;
  planById: ReadonlyMap<string, Plan>;
  normalizePlanId: (id: string) => string;
  client: {
    lisTier?: LisTier;
    medicaidLevel?: MedicaidLevel;
    livingSetting?: LivingSetting;
  };
}): {
  annualDrugByPlanId: Record<string, number | null>;
  dualEligibleByPlanId: Record<string, DualEligibleAdjustment | undefined>;
} {
  const { ranked, planById, normalizePlanId, client } = args;
  const annualDrugByPlanId: Record<string, number | null> = {};
  const dualEligibleByPlanId: Record<string, DualEligibleAdjustment | undefined> = {};
  if (!ranked) return { annualDrugByPlanId, dualEligibleByPlanId };

  const lisTier = client.lisTier ?? 'none';
  const medicaidLevel = client.medicaidLevel ?? 'none';
  const livingSetting = client.livingSetting ?? 'community';
  const isQmbOrHigher = medicaidLevel === 'qmb' || medicaidLevel === 'fbde';
  const noAdjustment = lisTier === 'none' && medicaidLevel === 'none';

  const processPlan = (lp: LibraryRankPlan) => {
    const p = planById.get(normalizePlanId(lp.plan_id));
    if (!p) return;

    // Always publish something to the drug-cost map — CompareScreen
    // reads it for every plan regardless of adjustment status.
    if (noAdjustment) {
      annualDrugByPlanId[p.id] = lp.total_annual_drug_cost;
      return;
    }

    const drugs = lp.medications.map((m) => ({
      covered: m.covered,
      annualCost: m.annual_cost,
      tier: m.tier,
    }));
    const { adjustedTotal, lisCopaysApplied } = applyLisCapsToLibraryPlan(
      drugs,
      lisTier,
    );
    annualDrugByPlanId[p.id] = adjustedTotal;

    // D-SNP detection — premium override applies only when Medicaid
    // pays Part C (QMB+ on a D-SNP). Both plan_type and snp_type are
    // checked because CMS files the marker inconsistently.
    const planTypeStr = p.plan_type ?? '';
    const snpTypeStr =
      (p as unknown as { snp_type?: string | null }).snp_type ?? '';
    const isDsnp = /D-?SNP/i.test(planTypeStr) || /D-?SNP/i.test(snpTypeStr);
    const premiumPaidByMedicaid = isQmbOrHigher && isDsnp;

    // CompareScreen consumes only these fields off DualEligibleAdjustment:
    //   context.medicaidLevel, premiumPaidByMedicaid,
    //   medicalCostSharingZeroed, lisCopaysApplied.{generic,brand},
    //   original.totalAnnualDrugCost
    // The full BrainScore-shaped `original.realAnnualCost` /
    // `annualMedicalCost` / `drugBreakdown` fields are unused here.
    // Cast at the boundary rather than stubbing 20+ zero-fields —
    // Phase 5 rebuild narrows the CompareScreen prop type.
    dualEligibleByPlanId[p.id] = {
      context: { medicaidLevel, livingSetting, lisTier },
      premiumPaidByMedicaid,
      medicalCostSharingZeroed: isQmbOrHigher,
      lisCopaysApplied,
      original: {
        totalAnnualDrugCost: lp.total_annual_drug_cost,
      },
    } as unknown as DualEligibleAdjustment;
  };

  for (const lp of ranked.top_plans) processPlan(lp);
  for (const lp of ranked.bench_plans) processPlan(lp);

  return { annualDrugByPlanId, dualEligibleByPlanId };
}
