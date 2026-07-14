// Dual-eligible / LIS (Extra Help) cost adjustment — types,
// constants, deeming table, and adjustment function.
//
// Agent-side mirror of the consumer's packages/brain/src/dual-eligible.ts.
// The consumer has @plan-match/shared for cross-package enums; the
// agent brain is self-contained, so the enums live here.
//
// Source of truth for the copay numbers: CMS memo
// "Calendar Year (CY) 2026 Resource and Cost-Sharing Limits for Low-
// Income Subsidy (LIS)", dated 2025-10-31, Table 2 (page 4).
// URL: https://www.cms.gov/files/document/cy2026-lis-resource-limits-memo.pdf
//
// Post-IRA §11404 (effective 2024) there is no partial-LIS tier —
// everyone who was on partial LIS at the $113 / 15% coinsurance rate
// is now on full LIS. Do not add a partial tier here; the CMS table
// no longer files one.

import type { BrainScore } from './plan-brain-types';
import { PART_D_OOP_CAP_2026 } from './plan-brain-utils';
import type { PmPlanRow } from './brain-foreign-types';
import type { AnnualCostEstimate } from './utilization-model';

/** Medicaid category the beneficiary qualifies for. Drives medical
 *  cost-sharing zeroing (QMB or FBDE only) and Part C premium
 *  payment (QMB+ on D-SNP plans). Distinct from DsnpEligibility —
 *  a QMB beneficiary can still enroll in a non-D-SNP MAPD.
 *
 *   none  — no Medicaid
 *   qi    — Qualifying Individual (Medicaid pays Part B premium only)
 *   slmb  — Specified Low-Income Medicare Beneficiary (Part B premium)
 *   qmb   — Qualified Medicare Beneficiary (Part B + all Medicare
 *           cost-sharing; no balance-billing allowed)
 *   fbde  — Full-Benefit Dual Eligible (QMB coverage + full Medicaid) */
export type MedicaidLevel = 'none' | 'qi' | 'slmb' | 'qmb' | 'fbde';

/** LIS (Extra Help) copay tier. Post-IRA §11404 all LIS-eligible
 *  beneficiaries fall into one of three full-subsidy tiers.
 *
 *   none                — no LIS subsidy; plan copays apply as filed
 *   full_institutional  — FBDE in institution or HCBS waiver ($0/$0)
 *   full_low            — FBDE, community, ≤100% FPL ($1.60/$4.90)
 *   full_high           — all other LIS (FBDE 100-150% FPL, MSP
 *                         applicants, LIS-only) ($5.10/$12.65) */
export type LisTier = 'none' | 'full_institutional' | 'full_low' | 'full_high';

/** Beneficiary living setting. Only affects LIS tier for FBDE. */
export type LivingSetting = 'community' | 'institutional_or_hcbs';

/** Per-fill copay caps under Part D LIS for CY 2026. LIS is a maximum
 *  — the beneficiary pays the lesser of the plan's filed copay and
 *  this cap. Above the annual TrOOP threshold ($2,100 for 2026)
 *  cost-sharing is $0 for all Part D beneficiaries (IRA §11201). */
export const LIS_COPAYS_2026: Readonly<
  Record<Exclude<LisTier, 'none'>, { generic: number; brand: number }>
> = {
  full_institutional: { generic: 0, brand: 0 },
  full_low: { generic: 1.60, brand: 4.90 },
  full_high: { generic: 5.10, brand: 12.65 },
};

/** Auto-deeming table — maps (medicaidLevel, livingSetting) to the
 *  LIS tier a beneficiary is automatically deemed for.
 *
 *  Living setting only affects FBDE. QMB, SLMB, and QI recipients get
 *  the same LIS tier regardless of setting because CMS' $0/$0
 *  institutional row applies only to Full-Benefit Dual Eligibles.
 *
 *  Known simplification: FBDE + community defaults to `full_low`
 *  (≤100% FPL). FBDE at 100-150% FPL should be `full_high` — agents
 *  can override on the intake side. Covers >95% of FBDE cases in
 *  practice (state Medicaid income caps for aged/disabled are
 *  usually ≤100% FPL). */
export const AUTO_DEEM_LIS_TIER: Readonly<
  Record<MedicaidLevel, Readonly<Record<LivingSetting, LisTier>>>
> = {
  fbde: {
    institutional_or_hcbs: 'full_institutional',
    community: 'full_low',
  },
  qmb: {
    institutional_or_hcbs: 'full_high',
    community: 'full_high',
  },
  slmb: {
    institutional_or_hcbs: 'full_high',
    community: 'full_high',
  },
  qi: {
    institutional_or_hcbs: 'full_high',
    community: 'full_high',
  },
  none: {
    institutional_or_hcbs: 'none',
    community: 'none',
  },
};

/** Given a Medicaid category and living setting, return the LIS tier
 *  the beneficiary is auto-deemed for. Non-Medicaid beneficiaries who
 *  applied for LIS directly bypass this — intake sets lisTier
 *  explicitly for them. */
export function deemLisTier(
  medicaidLevel: MedicaidLevel,
  livingSetting: LivingSetting,
): LisTier {
  return AUTO_DEEM_LIS_TIER[medicaidLevel][livingSetting];
}

/** Look up the per-fill generic/brand copay caps for an LIS tier.
 *  Returns null when the tier is 'none' (no LIS override applies). */
export function getLisCopays(
  tier: LisTier,
): { generic: number; brand: number } | null {
  if (tier === 'none') return null;
  return LIS_COPAYS_2026[tier];
}

/** Snapshot of everything the dual-eligible / LIS adjustment changed
 *  on a BrainScore. Present on `BrainScore.dualEligibleAdjustment`
 *  only when the beneficiary has Medicaid, LIS, or both. When
 *  present, `realAnnualCost`, `annualMedicalCost`,
 *  `totalAnnualDrugCost`, and `drugBreakdown` are already ADJUSTED
 *  — the `original` snapshot carries the pre-adjustment values for
 *  strikethrough rendering. */
export interface DualEligibleAdjustment {
  context: {
    medicaidLevel: MedicaidLevel;
    livingSetting: LivingSetting;
    lisTier: LisTier;
  };
  premiumPaidByMedicaid: boolean;
  medicalCostSharingZeroed: boolean;
  lisCopaysApplied: { generic: number; brand: number } | null;
  original: {
    realAnnualCost: AnnualCostEstimate;
    annualMedicalCost: number;
    totalAnnualDrugCost: number;
    drugBreakdown: BrainScore['drugBreakdown'];
  };
}

/** Post-process a BrainScore for a dual-eligible / LIS beneficiary.
 *  Called AFTER `calculateRealAnnualCost` returns and BEFORE any
 *  cost-based sort inside runPlanBrain, so every downstream sort
 *  (rankedByCost, diversified pool, C-SNP reserved slot) ranks on
 *  the adjusted realAnnualCost.netAnnual.
 *
 *  When `medicaidLevel === 'none' && lisTier === 'none'` returns the
 *  input score unchanged (reference equality). */
export function applyDualEligibleCostAdjustment(
  score: BrainScore,
  plan: PmPlanRow,
  medicaidLevel: MedicaidLevel,
  livingSetting: LivingSetting,
  lisTier: LisTier,
): BrainScore {
  if (medicaidLevel === 'none' && lisTier === 'none') return score;

  const isQmbOrHigher = medicaidLevel === 'qmb' || medicaidLevel === 'fbde';
  // D-SNP detection — check both plan_type and snp_type. CMS files
  // the SNP marker inconsistently across carriers.
  const planTypeStr = plan.plan_type ?? '';
  const snpTypeStr = plan.snp_type ?? '';
  const isDsnp = /D-?SNP/i.test(planTypeStr) || /D-?SNP/i.test(snpTypeStr);
  const premiumPaidByMedicaid = isQmbOrHigher && isDsnp;
  const lisCopays = getLisCopays(lisTier);

  // Snapshot originals BEFORE mutating.
  const original = {
    realAnnualCost: { ...score.realAnnualCost },
    annualMedicalCost: score.annualMedicalCost,
    totalAnnualDrugCost: score.totalAnnualDrugCost,
    drugBreakdown: score.drugBreakdown.map((d) => ({ ...d })),
  };

  const adjRac: AnnualCostEstimate = { ...score.realAnnualCost };
  let adjAnnualMedical = score.annualMedicalCost;

  // 1. Medical cost-sharing zeroing (QMB / FBDE). Providers enrolled
  //    with Medicaid cannot balance-bill QMB beneficiaries.
  if (isQmbOrHigher) {
    adjRac.medicalCost = 0;
    adjRac.suppliesCost = 0;
    adjRac.erExpected = 0;
    adjRac.hospitalExpected = 0;
    adjRac.snfExpected = 0;
    adjRac.ambulanceExpected = 0;
    adjRac.dmeExpected = 0;
    adjRac.deductibleCost = 0;
    adjRac.cappedMedicalBucket = 0;
    adjAnnualMedical = 0;
  }

  // 2. Premium zeroing (only when Medicaid pays Part C — QMB+ on D-SNP).
  if (premiumPaidByMedicaid) {
    adjRac.premium = 0;
  }

  // 3. Drug copay override (LIS). LIS is a MAX — plan copay wins
  //    when lower. Uncovered drugs unchanged (LIS doesn't help with
  //    non-formulary drugs).
  let adjTotalAnnualDrug = score.totalAnnualDrugCost;
  let adjDrugBreakdown: BrainScore['drugBreakdown'] = score.drugBreakdown;
  if (lisCopays) {
    let runningTotal = 0;
    adjDrugBreakdown = score.drugBreakdown.map((drug) => {
      if (!drug.covered) {
        runningTotal += drug.annualCost;
        return drug;
      }
      // Plan copay treated as per-fill; brain assumes 12 fills/year.
      const planPerFill = drug.annualCost > 0 ? drug.annualCost / 12 : 0;
      const lisCap = drug.isBrand ? lisCopays.brand : lisCopays.generic;
      const perFill = Math.min(planPerFill, lisCap);
      const yearly = Math.round(perFill * 12);
      runningTotal += yearly;
      return { ...drug, annualCost: yearly };
    });
    // TrOOP backstop — Part D free above $2,100 for everyone (IRA §11201).
    adjTotalAnnualDrug = Math.min(runningTotal, PART_D_OOP_CAP_2026);
    adjRac.drugCost = adjTotalAnnualDrug;
  }

  // 4. Recompute netAnnual — matches calculateRealAnnualCost's formula.
  adjRac.netAnnual = Math.max(
    0,
    adjRac.premium +
      adjRac.drugCost +
      adjRac.cappedMedicalBucket -
      adjRac.partBGivebackSavings,
  );

  return {
    ...score,
    realAnnualCost: adjRac,
    annualMedicalCost: adjAnnualMedical,
    totalAnnualDrugCost: adjTotalAnnualDrug,
    drugBreakdown: adjDrugBreakdown,
    dualEligibleAdjustment: {
      context: { medicaidLevel, livingSetting, lisTier },
      premiumPaidByMedicaid,
      medicalCostSharingZeroed: isQmbOrHigher,
      lisCopaysApplied: lisCopays,
      original,
    },
  };
}
