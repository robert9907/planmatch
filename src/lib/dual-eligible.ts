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
import type { PlanBenefitRow, PmPlanRow } from './brain-foreign-types';
import type { AnnualCostEstimate } from './utilization-model';

/** All seven CMS-defined dual-eligible categories a D-SNP can enroll,
 *  plus `none`. Drives medical cost-sharing zeroing (QMB / QMB+ /
 *  SLMB+ / FBDE — see COST_SHARING_PROTECTION below), Part C premium
 *  payment on D-SNPs, and the D-SNP eligibility filtering the Compare
 *  bench applies against pm_plans.dsnp_accepted_populations. Distinct
 *  from DsnpEligibility — a QMB beneficiary can still enroll in a
 *  non-D-SNP MAPD.
 *
 *   none      — no Medicaid
 *   qi        — Qualifying Individual (Medicaid pays Part B premium only)
 *   slmb      — Specified Low-Income Medicare Beneficiary (Part B premium)
 *   qmb       — Qualified Medicare Beneficiary — QMB-only, no full state
 *               Medicaid (Part B premium + all Medicare cost-sharing;
 *               no balance-billing allowed)
 *   qmb_plus  — QMB + full state Medicaid. Same Medicare cost-sharing
 *               protection as QMB, plus full Medicaid benefits; treated
 *               as FBDE-equivalent by the LIS deeming and cost adjustment.
 *   fbde      — Full-Benefit Dual Eligible without an MSP category
 *               (full Medicaid; QMB-level cost-sharing protection)
 *
 *  Widened 2026-08-15 from the original 5-value set (gh-audit-2026/
 *  msp-exposure finding M4 — three of the seven populations had no
 *  compile-time OR runtime path through the agent brain) to add:
 *   slmb_plus — SLMB + full state Medicaid (mirror of qmb_plus but at
 *               the SLMB tier). Same Part B premium coverage as SLMB,
 *               plus full Medicaid benefits, so Medicaid pays their
 *               Medicare cost sharing per the state plan.
 *   qdwi      — Qualified Disabled and Working Individual. Medicaid
 *               pays the Part A premium only; beneficiary pays the
 *               Part B premium + all Medicare cost-sharing. Rare
 *               category but D-SNP acceptance lists include it. */
export type MedicaidLevel =
  | 'none'
  | 'qi'
  | 'slmb'
  | 'slmb_plus'
  | 'qmb'
  | 'qmb_plus'
  | 'fbde'
  | 'qdwi';

/** LIS (Extra Help) copay tier. Post-IRA §11404 all LIS-eligible
 *  beneficiaries fall into one of three full-subsidy tiers.
 *
 *   none                — no LIS subsidy; plan copays apply as filed
 *   full_institutional  — full-benefit dual, institutionalized or on an
 *                         HCBS waiver ($0/$0) — memo Table 2 row 1
 *   full_low            — full-benefit dual with income ≤100% FPL
 *                         ($1.60/$4.90) — Table 2 row 2
 *   full_high           — full-benefit dual 100–150% FPL, OR any
 *                         non-full-benefit dual (QMB-only, SLMB-only,
 *                         QI, SSI) ($5.10/$12.65) — Table 2 rows 3-5
 *
 *  `qmb_uniform` ($4.90 flat, generic and brand) was REMOVED 2026-08-15.
 *  It was added 2026-07-23 as a "v2 spec fix" citing a "QMB + Full
 *  Medicaid" row of the CY2026 LIS memo. That row does not exist. The
 *  memo's Table 2 has five rows and none of them files the same amount
 *  for generic and brand; $4.90 appears only as the BRAND figure of the
 *  ≤100% FPL full-dual row, whose generic is $1.60. Verified against
 *  cms.gov/files/document/cy2026-lis-resource-limits-memo.pdf. The
 *  consumer brain removed the tier in 509f3bd/d97782e; this is the
 *  agent catching up, not a new judgement. */
export type LisTier = 'none' | 'full_institutional' | 'full_low' | 'full_high';

/** LIS tier values that have appeared in persisted sessions but are no
 *  longer valid. Kept as a separate type so the normalizer below is
 *  exhaustive and a future retirement has an obvious home. */
export type RetiredLisTier = 'qmb_uniform';

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

/** Re-derive a valid LIS tier for a session persisted with a retired
 *  one. Takes medicaidLevel + livingSetting rather than guessing from
 *  the stale tier alone, because `qmb_uniform` was written for BOTH
 *  full-benefit duals in the community (correct answer: full_low) and
 *  standalone QMB (correct answer: full_high) — the tier by itself
 *  cannot tell them apart, and guessing wrong understates drug cost for
 *  a QMB-only beneficiary. Returns the tier unchanged when it is valid,
 *  so this is safe to call on every hydration path. */
export function normalizeLisTier(
  tier: LisTier | RetiredLisTier | null | undefined,
  medicaidLevel: MedicaidLevel,
  livingSetting: LivingSetting,
): LisTier {
  if (tier == null) return 'none';
  if (tier === 'qmb_uniform') return deemLisTier(medicaidLevel, livingSetting);
  return tier;
}

/** Convenience wrapper for the common case: a client/session object that
 *  carries all three fields. Every read path that feeds a persisted
 *  `lisTier` into cost code should go through this rather than reading
 *  `client.lisTier` directly. */
export function normalizeLisTierForClient(client: {
  lisTier?: LisTier | RetiredLisTier | null;
  medicaidLevel?: MedicaidLevel | null;
  livingSetting?: LivingSetting | null;
}): LisTier {
  return normalizeLisTier(
    client.lisTier,
    client.medicaidLevel ?? 'none',
    client.livingSetting ?? 'community',
  );
}

/** Auto-deeming table — maps (medicaidLevel, livingSetting) to the
 *  LIS tier a beneficiary is automatically deemed for.
 *
 *  Living setting only affects the full-benefit dual categories
 *  (FBDE, QMB+, SLMB+). QMB-only, SLMB, and QI recipients get the same
 *  LIS tier regardless of setting because CMS' $0/$0 institutional row
 *  applies only to Full-Benefit Dual Eligibles.
 *
 *  Values below are taken directly from Table 2 of the CY2026 CMS LIS
 *  memo (cms.gov/files/document/cy2026-lis-resource-limits-memo.pdf):
 *
 *    row 1  full-benefit dual, institutionalized or HCBS   $0    / $0
 *    row 2  full-benefit dual, income ≤100% FPL            $1.60 / $4.90
 *    row 3  full-benefit dual, income 100–150% FPL         $5.10 / $12.65
 *    row 4  NON-full-benefit dual: "QMB-only, SLMB-only,
 *           or QI; or Supplemental Security Income"        $5.10 / $12.65
 *    row 5  non-full-benefit dual, ≤150% FPL + resources   $5.10 / $12.65
 *
 *  The full-benefit duals are FBDE, QMB+ and SLMB+ — they take rows 1-3.
 *  QMB-only, SLMB and QI are PARTIAL duals and take row 4 regardless of
 *  living setting: the $0/$0 institutional row is written for
 *  full-benefit duals only.
 *
 *  This table was briefly wrong. A 2026-07-23 change deemed FBDE
 *  community, QMB+ community and standalone QMB to a `qmb_uniform`
 *  tier of $4.90/$4.90, citing a "QMB + Full Medicaid" row. No such row
 *  exists in the memo; $4.90 is the brand figure of row 2, whose
 *  generic is $1.60. Reverted 2026-08-15 against the published table.
 *
 *  QDWI is the one Medicaid category that deems to NO LIS tier — see
 *  the POMS citation on its row below. */
export const AUTO_DEEM_LIS_TIER: Readonly<
  Record<MedicaidLevel, Readonly<Record<LivingSetting, LisTier>>>
> = {
  fbde: {
    // Full-benefit dual — memo rows 1 and 2.
    institutional_or_hcbs: 'full_institutional',
    community: 'full_low',
  },
  qmb: {
    // QMB-ONLY is a PARTIAL dual and is named explicitly in memo row 4
    // ($5.10/$12.65). The institutional $0/$0 row is for full-benefit
    // duals, so living setting does not move this one. A QMB who ALSO
    // has full Medicaid is `qmb_plus`, not this row.
    institutional_or_hcbs: 'full_high',
    community: 'full_high',
  },
  qmb_plus: {
    // QMB + full state Medicaid — a full-benefit dual, so it takes the
    // same rows as `fbde` above.
    institutional_or_hcbs: 'full_institutional',
    community: 'full_low',
  },
  slmb: {
    institutional_or_hcbs: 'full_high',
    community: 'full_high',
  },
  slmb_plus: {
    // SLMB + full state Medicaid — a full-benefit dual, so the
    // institutional $0/$0 row applies (unlike plain SLMB), and the
    // community row is `full_low` ($1.60/$4.90). FPL >100% would deem
    // full_high (memo row 3) but intake doesn't collect FPL — assumed
    // <=100% here, same assumption as `fbde`.
    institutional_or_hcbs: 'full_institutional',
    community: 'full_low',
  },
  qi: {
    institutional_or_hcbs: 'full_high',
    community: 'full_high',
  },
  qdwi: {
    // Qualified Disabled and Working Individual. Medicaid pays the
    // Part A premium only. Per SSA POMS HI 03001.005 (TN 31, effective
    // 04/09/2024): "Qualified Disabled Working Individuals (QDWI) are
    // not deemed eligible for Extra Help." A QDWI beneficiary must
    // file an SSA-1020 to apply for LIS separately. Same tier as
    // `none` here — no auto-deeming.
    // Source: https://secure.ssa.gov/poms.nsf/lnx/0603001005
    institutional_or_hcbs: 'none',
    community: 'none',
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

/** ── SINGLE SOURCE OF TRUTH: who pays Medicare cost sharing ──────
 *
 *  Ported from the consumer brain (packages/brain/src/dual-eligible.ts)
 *  on 2026-08-15. Before that the agent had exactly ONE predicate —
 *  `applyDualEligibleCostAdjustment`'s `isQmbOrHigher = qmb || fbde` —
 *  and a five-token MedicaidLevel, so three of the seven CMS
 *  dual-eligible populations (QMB+, SLMB+, QDWI) had no path through
 *  it at all. See gh-audit-2026/msp-exposure findings M4 and M5.
 *
 *  Every predicate that answers "does this beneficiary owe the plan's
 *  filed copay/coinsurance" reads the table below. Adding a population
 *  means editing one place.
 *
 *  Two DIFFERENT legal mechanisms are tracked separately, because they
 *  are not the same protection and collapsing them is what produced the
 *  consumer's original predicate split:
 *
 *  `costSharingPaid` — Medicaid pays the beneficiary's Medicare cost
 *      sharing, so the plan's filed copay/coinsurance is not what the
 *      beneficiary actually owes. True for the QMB tier (QMB, QMB+) and
 *      for full-benefit duals (SLMB+, FBDE) whose full Medicaid covers
 *      Medicare cost sharing per the state plan.
 *
 *  `balanceBillProtected` — 42 CFR § 447.15 and §1902(n)(3)(B) bar the
 *      PROVIDER from billing the beneficiary for any unpaid balance.
 *      This is a QMB-tier protection only. A SLMB+ or FBDE beneficiary
 *      has cost sharing paid to the extent of the state plan but no
 *      federal balance-billing bar, so a hard "$0, guaranteed" claim is
 *      weaker for them than for QMB. Kept as a separate flag so broker
 *      display copy can distinguish the two without reopening the split.
 */
export interface CostSharingProtection {
  costSharingPaid: boolean;
  balanceBillProtected: boolean;
}

const COST_SHARING_PROTECTION: Readonly<
  Record<MedicaidLevel, CostSharingProtection>
> = {
  none:      { costSharingPaid: false, balanceBillProtected: false },
  qi:        { costSharingPaid: false, balanceBillProtected: false },
  slmb:      { costSharingPaid: false, balanceBillProtected: false },
  qdwi:      { costSharingPaid: false, balanceBillProtected: false },
  qmb:       { costSharingPaid: true,  balanceBillProtected: true  },
  qmb_plus:  { costSharingPaid: true,  balanceBillProtected: true  },
  slmb_plus: { costSharingPaid: true,  balanceBillProtected: false },
  fbde:      { costSharingPaid: true,  balanceBillProtected: true  },
};

/** The unified predicate. True when Medicaid pays this beneficiary's
 *  Medicare cost sharing — i.e. the filed copay/coinsurance is NOT what
 *  they owe. Drives both the cost model (medical zeroing) and, by
 *  negation, the exposure classifier's applicability. */
export function isCostSharingProtected(medicaidLevel: MedicaidLevel): boolean {
  return COST_SHARING_PROTECTION[medicaidLevel].costSharingPaid;
}

/** True when 42 CFR § 447.15 bars the provider from balance-billing the
 *  beneficiary. QMB tier only — narrower than isCostSharingProtected. */
export function isBalanceBillProtected(medicaidLevel: MedicaidLevel): boolean {
  return COST_SHARING_PROTECTION[medicaidLevel].balanceBillProtected;
}

/** pm_plan_benefits categories used by the cost-sharing exposure
 *  classifier. Three high-frequency Medicare-covered services that
 *  broker experience shows drive the actual out-of-pocket differential
 *  between a $0-copay standard MA-PD and a coinsurance-filed D-SNP for
 *  a partial-dual member: primary_care, specialist, advanced_imaging.
 *  Emergency + inpatient sit above per-visit copays and rarely hit in a
 *  typical year; the three below capture the everyday exposure. */
const COST_SHARING_EXPOSURE_CATEGORIES: readonly string[] = [
  'primary_care',
  'specialist',
  'advanced_imaging',
];

/** Classify a plan's cost-sharing exposure for the populations Medicaid
 *  does not cover: SLMB, QI and QDWI. SLMB and QI have no Medicaid
 *  protection beyond the Part B premium; QDWI gets only the Part A
 *  premium and owes the Part B premium plus all Medicare cost sharing.
 *  In all three the member pays every filed copay and coinsurance out
 *  of pocket. Applicability is decided by `isCostSharingProtected` so
 *  this classifier and the cost model cannot drift apart. A plan
 *  billing coinsurance (%) on primary_care, specialist, or
 *  advanced_imaging exposes the member in a way a $0-copay MA-PD does
 *  not; the ranking tie-break in compareByCostThenTiebreakers uses this
 *  flag to prevent an exposed plan from winning the $500 cost band
 *  against a non-exposed plan.
 *
 *  Rule: `exposed` = true when Medicaid does not pay the beneficiary's
 *  cost sharing ('slmb', 'qi', 'qdwi') AND at least one of the three
 *  benefit rows files coinsurance > 0.
 *
 *  Missing-data handling: if any of the three benefit rows is absent
 *  OR has both copay AND coinsurance null, the plan is classified as
 *  exposed AND `incomplete` is set true. Defensive for the member — a
 *  hidden coinsurance behind a NULL row must not silently win the
 *  tie-break. Report layer surfaces `incomplete` so data-quality gaps
 *  are visible.
 *
 *  Returns `{exposed: false, incomplete: false}` for the protected
 *  populations — no cost-share exposure signal fires for none / qmb /
 *  qmb_plus / slmb_plus / fbde (Medicaid pays their cost sharing; none
 *  is not dual). */
export function classifyCostSharingExposure(
  medicaidLevel: MedicaidLevel,
  benefits: readonly PlanBenefitRow[],
): { exposed: boolean; incomplete: boolean } {
  // Unified with the cost model: a population is a candidate for
  // exposure exactly when Medicaid does NOT pay their cost sharing.
  // That is SLMB, QI and QDWI. 'none' is not dual and has no Medicaid
  // signal to act on.
  if (medicaidLevel === 'none' || isCostSharingProtected(medicaidLevel)) {
    return { exposed: false, incomplete: false };
  }
  let exposed = false;
  let incomplete = false;
  for (const cat of COST_SHARING_EXPOSURE_CATEGORIES) {
    const row = benefits.find((b) => b.benefit_category === cat);
    if (!row) {
      incomplete = true;
      exposed = true;
      continue;
    }
    const copayNull = row.copay == null;
    const coinsNull = row.coinsurance == null;
    if (copayNull && coinsNull) {
      incomplete = true;
      exposed = true;
      continue;
    }
    if (row.coinsurance != null && row.coinsurance > 0) {
      exposed = true;
    }
  }
  return { exposed, incomplete };
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

  // Medicaid pays this beneficiary's Medicare cost sharing — QMB, QMB+,
  // SLMB+, FBDE. Single source of truth; see COST_SHARING_PROTECTION.
  // (Named isQmbOrHigher for continuity with existing call sites; the
  // set now includes QMB+ and SLMB+, both full-benefit duals.)
  const isQmbOrHigher = isCostSharingProtected(medicaidLevel);
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

  // 1. Medical cost-sharing zeroing (QMB / QMB+ / SLMB+ / FBDE).
  //    Providers enrolled with Medicaid cannot balance-bill QMB-tier
  //    beneficiaries (42 CFR § 447.15); SLMB+ and FBDE have their cost
  //    sharing paid by full Medicaid per the state plan.
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
