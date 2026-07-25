// Compares two PlanSnapshots (MPF vs PM) field-by-field.
// Applies post-IRA spec corrections (spec-corrections.md): ICL/gap skipped,
// inpatient/psych day limits N/A, insulin $35 cap as validation rule,
// Part B-or-D drugs allowed to be "not on Part D formulary" for provider-
// administered products.

import type {
  BeneficiaryProfile,
  Drug,
  DrugCoverage,
  FailCode,
  FieldComparison,
  FieldSeverity,
  FieldStatus,
  PlanComparison,
  PlanSnapshot,
} from '../types.js';

const SEVERITY_WEIGHT: Record<FieldSeverity, number> = {
  critical: 3,
  major: 2,
  minor: 1,
  display: 0.5,
};

// Regex identifies insulin products — insulin $35/mo cap applies to any
// covered insulin per IRA §11406 (see spec-corrections C3).
const INSULIN_RX =
  /^(Insulin|Basaglar|Lantus|Toujeo|Tresiba|Humalog|NovoLog|Levemir|Apidra|Fiasp|Lyumjev|Semglee|Rezvoglar)/i;

// Category labels per SPEC §3.1–3.13.
const CATEGORY = {
  ident: '3.1 Plan Identification',
  premium: '3.2 Premium & Deductible',
  inpatient: '3.3 Inpatient / SNF',
  outpatient: '3.4 Outpatient',
  therapy: '3.5 Therapy & DME',
  otherMedical: '3.6 Other Medical',
  rxStructure: '3.7 Rx Tier Structure',
  rxPhases: '3.8 Rx Phases (Post-IRA)',
  drugCoverage: '3.9 Per-Drug Coverage',
  dental: '3.10 Dental',
  vision: '3.11 Vision',
  hearing: '3.12 Hearing',
  supplemental: '3.13 Supplemental',
  ira: '5.1 IRA Provisions',
} as const;

// Fields marked N/A per C5 (day-limit not extracted from MPF API).
const NA_FIELDS = new Set<string>([
  'inpatient.dayLimit',
  'inpatient.psychDayLimit',
]);

const NA_NOTE = 'day_limit not extracted from MPF API — requires manual PBP review';

// Drugs where "not on Part D formulary" is PASS if the profile marks them as
// provider-administered (Part B or Part-B-or-D). See spec-corrections C4.
// Crizanlizumab (Adakveo) is always Part B (IV infusion only, no self-
// administered form) — added 2026-07-24 for Rosa/Shirley SCD profiles.
const PART_B_OR_D_DRUGS = new Set<string>([
  'Prolia',
  'Zoledronic',
  'Zoledronic Acid',
  'Xgeva',
  'Benlysta',
  'Radicava',
  'Filgrastim',
  'Crizanlizumab',
  'Adakveo',
]);

// F9 misclassification should only fire when we're CERTAIN a drug is
// provider-administered. Prolia/Benlysta/Radicava/Filgrastim are setting-
// dependent — legitimately Part D when self-administered at home. Fire F9
// only when profile explicitly pins the setting to office or provider-
// administered. Absent setting → assume self-admin → Part D formulary
// presence is valid.
function isDefinitelyPartB(drug: Drug): boolean {
  if (drug.part === 'part-b') return true;
  if (drug.part === 'part-b-or-d') {
    return drug.setting === 'office' || drug.setting === 'provider-administered';
  }
  return false;
}

function isSameDrug(a: Drug, b: Drug): boolean {
  return (
    a.name.trim().toLowerCase() === b.name.trim().toLowerCase() &&
    a.strength.trim().toLowerCase() === b.strength.trim().toLowerCase()
  );
}

function findCoverage(cov: DrugCoverage[], drug: Drug): DrugCoverage | undefined {
  return cov.find((c) => isSameDrug(c.drug, drug));
}

// ─── Value normalization ─────────────────────────────────────────────

function stripMoney(s: string): number | null {
  const m = s.replace(/,/g, '').match(/-?\$?\s*(-?\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function stripPercent(s: string): number | null {
  const m = s.replace(/,/g, '').match(/(-?\d+(?:\.\d+)?)\s*%?/);
  return m ? Number(m[1]) : null;
}

function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (!trimmed) return '';
    const lower = trimmed.toLowerCase();
    if (
      lower === 'no charge' ||
      lower === 'no cost' ||
      lower === '$0' ||
      lower === '$0.00' ||
      lower === 'free'
    ) {
      return 0;
    }
    if (/^\$?\-?\d+(\.\d+)?%?$/.test(trimmed.replace(/,/g, ''))) {
      if (trimmed.endsWith('%')) return stripPercent(trimmed);
      return stripMoney(trimmed);
    }
    return trimmed;
  }
  return v;
}

function valuesSemanticallyEqual(a: unknown, b: unknown): boolean {
  const na = normalizeValue(a);
  const nb = normalizeValue(b);
  if (na === nb) return true;
  if (typeof na === 'number' && typeof nb === 'number') {
    return Math.abs(na - nb) < 0.005;
  }
  return false;
}

function displayEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'string' && typeof b === 'string') {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  return false;
}

// ─── Severity heuristics ─────────────────────────────────────────────

function severityForMoneyGap(a: unknown, b: unknown): FieldSeverity {
  if (typeof a === 'number' && typeof b === 'number') {
    const gap = Math.abs(a - b);
    if (gap >= 10) return 'major';
    return 'minor';
  }
  return 'minor';
}

// ─── Field comparison builders ───────────────────────────────────────

interface CompareOptions {
  severity?: FieldSeverity;
  failCode?: FailCode;
  isFormulary?: boolean;
}

function compareField(
  fieldPath: string,
  category: string,
  mpfValue: unknown,
  pmValue: unknown,
  opts: CompareOptions = {},
): FieldComparison {
  if (NA_FIELDS.has(fieldPath)) {
    return {
      fieldPath,
      category,
      mpfValue,
      pmValue,
      status: 'N/A',
      severity: 'display',
      note: NA_NOTE,
    };
  }

  const mpfNull = mpfValue === null || mpfValue === undefined;
  const pmNull = pmValue === null || pmValue === undefined;

  if (mpfNull && pmNull) {
    return {
      fieldPath,
      category,
      mpfValue,
      pmValue,
      status: 'N/A',
      severity: 'display',
      note: 'both sources null — treated as N/A',
    };
  }

  if (!mpfNull && pmNull) {
    return {
      fieldPath,
      category,
      mpfValue,
      pmValue,
      status: 'FAIL',
      failCode: 'F2',
      severity: opts.severity ?? 'minor',
      note: 'PM missing value MPF provided',
    };
  }

  if (mpfNull && !pmNull) {
    return {
      fieldPath,
      category,
      mpfValue,
      pmValue,
      status: 'CONDITIONAL',
      severity: 'display',
      note: 'PM has value; MPF null',
    };
  }

  if (displayEqual(mpfValue, pmValue)) {
    return {
      fieldPath,
      category,
      mpfValue,
      pmValue,
      status: 'PASS',
      severity: opts.severity ?? 'minor',
    };
  }

  if (valuesSemanticallyEqual(mpfValue, pmValue)) {
    return {
      fieldPath,
      category,
      mpfValue,
      pmValue,
      status: 'CONDITIONAL',
      severity: 'display',
      note: 'semantically equal, display differs',
    };
  }

  const failCode: FailCode = opts.failCode ?? (opts.isFormulary ? 'F4' : 'F1');
  const severity: FieldSeverity =
    opts.severity ??
    (opts.isFormulary ? 'major' : severityForMoneyGap(mpfValue, pmValue));
  return {
    fieldPath,
    category,
    mpfValue,
    pmValue,
    status: 'FAIL',
    failCode,
    severity,
  };
}

// ─── Walkers per section ─────────────────────────────────────────────

// planType axes:
//   MPF: CMS enrollment category  — PLAN_TYPE_MA / PLAN_TYPE_MAPD / PLAN_TYPE_PDP
//   PM:  network type             — PPO / HMO / HMO-POS / PFFS / PDP / Cost / MSA
// Both are correct, they answer different questions. Canonicalize each side
// separately: MPF returns a definitive enrollment category; PM's network
// type is compatible with either MA or MAPD (MA-family), and only PDP is
// unambiguous. Downstream: MA-family on PM side + MA or MAPD on MPF side →
// CONDITIONAL. PDP on both → CONDITIONAL. Mismatched category → FAIL.
type PlanTypeCanon = 'MA' | 'MAPD' | 'MA_FAMILY' | 'PDP' | 'OTHER';

function canonicalPlanType(raw: string): PlanTypeCanon {
  const s = (raw ?? '').toUpperCase();
  if (s.includes('PDP')) return 'PDP';
  if (s.includes('MAPD')) return 'MAPD';
  if (s.includes('PLAN_TYPE_MA') && !s.includes('MAPD')) return 'MA';
  // PM stores network type without Part D indicator. PPO/HMO/HMO-POS/PFFS/
  // Cost/MSA can be either MA-only or MAPD depending on Part D coverage,
  // which PM's pm_plans row doesn't file separately.
  if (/PPO|HMO|PFFS|COST|MSA/.test(s)) return 'MA_FAMILY';
  return 'OTHER';
}

function planTypesCompatible(mpf: PlanTypeCanon, pm: PlanTypeCanon): boolean {
  if (mpf === pm) return mpf !== 'OTHER';
  // MA-family on PM side matches either MA or MAPD on MPF side.
  if (pm === 'MA_FAMILY' && (mpf === 'MA' || mpf === 'MAPD')) return true;
  if (mpf === 'MA_FAMILY' && (pm === 'MA' || pm === 'MAPD')) return true;
  return false;
}

// orgName axes:
//   MPF: marketing brand    — "Humana", "Aetna Medicare", "HealthTeam Advantage"
//   PM:  legal parent entity — "Humana Inc.", "CVS Health Corporation", "Risant Health, Inc."
// Both are valid names at different levels of the org hierarchy. In practice
// only Humana-family lines up textually (brand IS parent short-name). Substring
// match handles that case; for the rest (Aetna→CVS, HealthTeam→Risant, BCBSNC
// →CuraCor, Wellcare→Centene) there is no textual link. Rob's Fix 1 gives us
// three options; combining: substring match → CONDITIONAL, otherwise still
// CONDITIONAL with a note flagging the brand-vs-parent gap. Not beneficiary-
// facing data accuracy — plan name + carrier logo drive UX, orgName is a
// back-office reference field.
function orgNamesCompatible(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/[.,]/g, '').replace(/\s+(inc|corp|corporation|llc)$/, '').trim();
  const nb = b.toLowerCase().replace(/[.,]/g, '').replace(/\s+(inc|corp|corporation|llc)$/, '').trim();
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

function walkIdent(mpf: PlanSnapshot, pm: PlanSnapshot): FieldComparison[] {
  const out: FieldComparison[] = [];
  const scalarKeys: Array<keyof PlanSnapshot['ident']> = [
    'planName',
    'contractId',
    'planId',
    'segmentId',
  ];
  for (const k of scalarKeys) {
    out.push(
      compareField(
        `ident.${k}`,
        CATEGORY.ident,
        mpf.ident[k],
        pm.ident[k],
        { severity: 'minor' },
      ),
    );
  }

  // starRating — CMS files half-stars (4.5); pm_plans.star_rating is a
  // smallint that rounds to 4. Treat within-0.5 as CONDITIONAL (same
  // half-star tier). Only genuinely-off ratings (≥ 1.0 gap) fail.
  const mStar = typeof mpf.ident.starRating === 'number' ? mpf.ident.starRating : null;
  const pStar = typeof pm.ident.starRating === 'number' ? pm.ident.starRating : null;
  if (mStar != null && pStar != null && Math.abs(mStar - pStar) <= 0.5) {
    out.push({
      fieldPath: 'ident.starRating',
      category: CATEGORY.ident,
      mpfValue: mStar,
      pmValue: pStar,
      status: mStar === pStar ? 'PASS' : 'CONDITIONAL',
      severity: 'minor',
      note: mStar === pStar ? undefined : 'within half-star tolerance (pm_plans.star_rating is smallint; CMS files half-star)',
    });
  } else {
    out.push(compareField('ident.starRating', CATEGORY.ident, mStar, pStar, { severity: 'minor' }));
  }

  // planType — canonicalize both sides; MA-family (PM network type without
  // Part D signal) is compatible with either MA or MAPD (MPF enrollment
  // category).
  const mpfCanon = canonicalPlanType(String(mpf.ident.planType ?? ''));
  const pmCanon = canonicalPlanType(String(pm.ident.planType ?? ''));
  if (planTypesCompatible(mpfCanon, pmCanon)) {
    const label = pmCanon === 'MA_FAMILY' ? `${mpfCanon}/MA-family` : mpfCanon;
    out.push({
      fieldPath: 'ident.planType',
      category: CATEGORY.ident,
      mpfValue: mpf.ident.planType,
      pmValue: pm.ident.planType,
      status: 'CONDITIONAL',
      severity: 'display',
      note: `enrollment category '${label}' — MPF sends CMS enum, PM stores network type`,
    });
  } else {
    out.push(compareField('ident.planType', CATEGORY.ident, mpf.ident.planType, pm.ident.planType, { severity: 'minor' }));
  }

  // orgName — brand vs parent-entity. When both non-null, mark CONDITIONAL
  // with a note; substring match adds specificity to the note.
  const mpfOrg = String(mpf.ident.orgName ?? '');
  const pmOrg = String(pm.ident.orgName ?? '');
  if (mpfOrg && pmOrg) {
    const substringMatch = orgNamesCompatible(mpfOrg, pmOrg);
    out.push({
      fieldPath: 'ident.orgName',
      category: CATEGORY.ident,
      mpfValue: mpfOrg,
      pmValue: pmOrg,
      status: 'CONDITIONAL',
      severity: 'display',
      note: substringMatch
        ? 'brand vs parent-entity — substring compatible'
        : 'brand (MPF) vs corporate parent (PM) — different levels of org hierarchy, not a data error',
    });
  } else {
    out.push(
      compareField('ident.orgName', CATEGORY.ident, mpfOrg, pmOrg, {
        severity: 'display',
      }),
    );
  }

  return out;
}

function walkPremium(mpf: PlanSnapshot, pm: PlanSnapshot): FieldComparison[] {
  const out: FieldComparison[] = [];
  const keys: Array<keyof PlanSnapshot['premium']> = [
    'monthlyPremium',
    'partBPremiumReduction',
    'partDPremium',
    'medicalDeductibleIN',
    'medicalDeductibleOON',
    'partDDrugDeductible',
    'drugDeductibleTierExceptions',
    'annualMoopIN',
  ];
  for (const k of keys) {
    out.push(
      compareField(
        `premium.${k}`,
        CATEGORY.premium,
        mpf.premium[k],
        pm.premium[k],
      ),
    );
  }
  return out;
}

function walkInpatient(mpf: PlanSnapshot, pm: PlanSnapshot): FieldComparison[] {
  const out: FieldComparison[] = [];
  out.push(
    compareField(
      'inpatient.perAdmissionCopay',
      CATEGORY.inpatient,
      mpf.inpatient.perAdmissionCopay,
      pm.inpatient.perAdmissionCopay,
    ),
  );
  out.push(
    compareField(
      'inpatient.perDayTiered',
      CATEGORY.inpatient,
      mpf.inpatient.perDayTiered
        ? JSON.stringify(mpf.inpatient.perDayTiered)
        : null,
      pm.inpatient.perDayTiered
        ? JSON.stringify(pm.inpatient.perDayTiered)
        : null,
      { severity: 'major' },
    ),
  );
  out.push(
    compareField(
      'inpatient.coinsurance',
      CATEGORY.inpatient,
      mpf.inpatient.coinsurance,
      pm.inpatient.coinsurance,
    ),
  );
  out.push(
    compareField(
      'inpatient.psychInpatientCopay',
      CATEGORY.inpatient,
      mpf.inpatient.psychInpatientCopay,
      pm.inpatient.psychInpatientCopay,
    ),
  );
  out.push(
    compareField(
      'inpatient.snfDays1to20',
      CATEGORY.inpatient,
      mpf.inpatient.snfDays1to20,
      pm.inpatient.snfDays1to20,
    ),
  );
  out.push(
    compareField(
      'inpatient.snfDays21to100',
      CATEGORY.inpatient,
      mpf.inpatient.snfDays21to100,
      pm.inpatient.snfDays21to100,
    ),
  );

  // C5-designated N/A fields — emit explicit entries so denominator excludes.
  out.push(
    compareField('inpatient.dayLimit', CATEGORY.inpatient, null, null),
  );
  out.push(
    compareField('inpatient.psychDayLimit', CATEGORY.inpatient, null, null),
  );
  return out;
}

function walkOutpatient(mpf: PlanSnapshot, pm: PlanSnapshot, profile: BeneficiaryProfile): FieldComparison[] {
  const keys: Array<keyof PlanSnapshot['outpatient']> = [
    'pcpCopay',
    'specialistCopay',
    'preventiveCopay',
    'urgentCareCopay',
    'erCopay',
    'ambulanceGroundCopay',
    'ambulanceAirCopay',
    'outpatientSurgeryAsc',
    'outpatientSurgeryHospital',
    'diagnosticLabsCopay',
    // diagnosticRadiologyCopay handled specially below (MPF bundles x-ray
    // and advanced imaging under one "radiology" service; PM splits them).
    'mhOutpatientIndividual',
    'mhOutpatientGroup',
    'substanceAbuseCopay',
  ];
  // QMB / full-dual: PM correctly zeros beneficiary cost-share (Medicaid
  // pays the plan's copay). MPF displays the plan's filed copay as-is.
  // Divergence is expected + correct — treat PM=$0 vs MPF>0 as CONDITIONAL
  // ("QMB override applied by PM; MPF shows raw plan copay").
  const qmbLike = profile.medicaid === 'qmb' || profile.medicaid === 'full-dual';
  const out: FieldComparison[] = keys.map((k) => {
    const mv = mpf.outpatient[k];
    const pv = pm.outpatient[k];
    if (qmbLike && pv === 0 && typeof mv === 'number' && mv > 0) {
      return {
        fieldPath: `outpatient.${k}`,
        category: CATEGORY.outpatient,
        mpfValue: mv,
        pmValue: pv,
        status: 'CONDITIONAL',
        severity: 'display',
        note: `QMB/full-dual override applied by PM ($0 to beneficiary); MPF shows raw plan copay $${mv}`,
      };
    }
    return compareField(
      `outpatient.${k}`,
      CATEGORY.outpatient,
      mv,
      pv,
    );
  });

  // Radiology field bundling: MPF's ma_benefit for "diagnostic_radiology"
  // often carries the CT/MRI/PET copay (higher, more visible); PM stores
  // x-ray (diagnosticRadiologyCopay) and CT/MRI/PET (advancedImagingCopay)
  // separately. Compare MPF's radiology value against whichever PM field
  // matches — usually advancedImaging for the $300+ values we see, or
  // diagnosticRadiology for X-ray-only plans.
  const mRad = mpf.outpatient.diagnosticRadiologyCopay;
  const pXray = pm.outpatient.diagnosticRadiologyCopay;
  const pAdv = pm.outpatient.advancedImagingCopay;
  if (typeof mRad === 'number' && (typeof pXray === 'number' || typeof pAdv === 'number')) {
    const matchesXray = typeof pXray === 'number' && Math.abs(mRad - pXray) < 0.5;
    const matchesAdv = typeof pAdv === 'number' && Math.abs(mRad - pAdv) < 0.5;
    // QMB/full-dual: PM zeros both imaging copays for the beneficiary
    // (Medicaid pays). Mirror the CONDITIONAL treatment applied to the
    // regular outpatient keys above so the bundled-radiology path doesn't
    // false-flag QMB profiles as F1 fails.
    if (qmbLike && pXray === 0 && pAdv === 0 && mRad > 0) {
      out.push({
        fieldPath: 'outpatient.diagnosticRadiologyCopay',
        category: CATEGORY.outpatient,
        mpfValue: mRad,
        pmValue: 0,
        status: 'CONDITIONAL',
        severity: 'display',
        note: `QMB/full-dual override applied by PM ($0 to beneficiary); MPF shows raw plan radiology copay $${mRad}`,
      });
    } else if (matchesXray || matchesAdv) {
      out.push({
        fieldPath: 'outpatient.diagnosticRadiologyCopay',
        category: CATEGORY.outpatient,
        mpfValue: mRad,
        pmValue: matchesAdv ? pAdv : pXray,
        status: 'CONDITIONAL',
        severity: 'display',
        note: `MPF radiology bundles X-ray + advanced imaging; matches PM ${matchesAdv ? 'advancedImagingCopay' : 'diagnosticRadiologyCopay'}`,
      });
    } else {
      out.push(compareField('outpatient.diagnosticRadiologyCopay', CATEGORY.outpatient, mRad, pXray));
    }
    out.push(compareField('outpatient.advancedImagingCopay', CATEGORY.outpatient, null, pAdv));
  } else {
    out.push(compareField('outpatient.diagnosticRadiologyCopay', CATEGORY.outpatient, mRad, pXray));
    out.push(compareField('outpatient.advancedImagingCopay', CATEGORY.outpatient, mpf.outpatient.advancedImagingCopay, pAdv));
  }

  return out;
}

function walkTherapy(mpf: PlanSnapshot, pm: PlanSnapshot): FieldComparison[] {
  const keys: Array<keyof PlanSnapshot['therapy']> = [
    'ptCopay',
    'otCopay',
    'stCopay',
    'cardiacRehabCopay',
    'pulmonaryRehabCopay',
    'dmeCoinsurance',
  ];
  return keys.map((k) =>
    compareField(
      `therapy.${k}`,
      CATEGORY.therapy,
      mpf.therapy[k],
      pm.therapy[k],
    ),
  );
}

function walkOtherMedical(mpf: PlanSnapshot, pm: PlanSnapshot): FieldComparison[] {
  const keys: Array<keyof PlanSnapshot['otherMedical']> = [
    'homeHealthCopay',
    'telehealthCopay',
    'partBDrugCoinsurance',
    'dialysisCopay',
    'skilledNursingHomeCopay',
    'chiropracticCopay',
    'podiatryCopay',
  ];
  return keys.map((k) =>
    compareField(
      `otherMedical.${k}`,
      CATEGORY.otherMedical,
      mpf.otherMedical[k],
      pm.otherMedical[k],
    ),
  );
}

function walkRxStructure(mpf: PlanSnapshot, pm: PlanSnapshot): FieldComparison[] {
  const out: FieldComparison[] = [];
  const tiers: Array<keyof PlanSnapshot['rxStructure']> = [
    'tier1',
    'tier2',
    'tier3',
    'tier4',
    'tier5',
    'tier6',
  ];
  const tierKeys: Array<
    keyof NonNullable<PlanSnapshot['rxStructure']['tier6']>
  > = [
    'preferredPharmacy30',
    'standardPharmacy30',
    'preferredMailOrder90',
    'standardMailOrder90',
    'isCoinsurance',
  ];
  for (const t of tiers) {
    const mTier = mpf.rxStructure[t];
    const pTier = pm.rxStructure[t];
    if (mTier === null && pTier === null) {
      out.push(
        compareField(
          `rxStructure.${t}`,
          CATEGORY.rxStructure,
          null,
          null,
        ),
      );
      continue;
    }
    for (const k of tierKeys) {
      out.push(
        compareField(
          `rxStructure.${t}.${k}`,
          CATEGORY.rxStructure,
          mTier ? mTier[k] : null,
          pTier ? pTier[k] : null,
        ),
      );
    }
  }
  return out;
}

function walkRxPhases(mpf: PlanSnapshot, pm: PlanSnapshot): FieldComparison[] {
  const keys: Array<keyof PlanSnapshot['rxPhases']> = [
    'partDOopCap',
    'catastrophicCopayGeneric',
    'catastrophicCopayBrand',
    'partDVaccinesZero',
  ];
  return keys.map((k) =>
    compareField(
      `rxPhases.${k}`,
      CATEGORY.rxPhases,
      mpf.rxPhases[k],
      pm.rxPhases[k],
    ),
  );
}

// Per-drug coverage walker. Applies:
// - F9 Part B misclassification (see PART_B_OR_D_DRUGS)
// - F4 for formulary/tier/PA/QL/ST mismatches
// - F8 insulin $35 cap validation (spec-corrections C3)
function walkDrugCoverage(
  mpf: PlanSnapshot,
  pm: PlanSnapshot,
  profile: BeneficiaryProfile,
): FieldComparison[] {
  const out: FieldComparison[] = [];

  for (let i = 0; i < profile.drugs.length; i++) {
    const drug = profile.drugs[i];
    const path = `drugCoverage[${i}:${drug.name}]`;
    const mCov = findCoverage(mpf.drugCoverage, drug);
    const pCov = findCoverage(pm.drugCoverage, drug);

    // Part B-administered drug: "not on Part D formulary" is CORRECT (PASS).
    // Fire F9 misclassification ONLY when we're certain the profile expects
    // provider-administered (Part B), not for setting-dependent drugs with
    // absent setting flag (Prolia default = self-inject, Part D valid).
    if (isDefinitelyPartB(drug) && PART_B_OR_D_DRUGS.has(drug.name.trim())) {
      const mOn = mCov?.onFormulary === true;
      const pOn = pCov?.onFormulary === true;
      if (mOn || pOn) {
        out.push({
          fieldPath: `${path}.onFormulary`,
          category: CATEGORY.drugCoverage,
          mpfValue: mCov?.onFormulary ?? null,
          pmValue: pCov?.onFormulary ?? null,
          status: 'FAIL',
          failCode: 'F9',
          severity: 'critical',
          note: `${drug.name} setting=${drug.setting ?? 'part-b'} expects Part B; on Part D formulary flags misclassification`,
        });
      } else {
        out.push({
          fieldPath: `${path}.onFormulary`,
          category: CATEGORY.drugCoverage,
          mpfValue: mCov?.onFormulary ?? false,
          pmValue: pCov?.onFormulary ?? false,
          status: 'PASS',
          severity: 'minor',
          note: `${drug.name} correctly excluded from Part D (Part B)`,
        });
      }
      continue;
    }
    // Setting-ambiguous Part-B-or-D drug (no office setting flag): Part D
    // formulary presence is expected (self-admin default). Fall through to
    // standard Part D drug comparison.

    // Standard Part D drug — expect on formulary; missing coverage is F4.
    if (!mCov || !pCov) {
      out.push({
        fieldPath: `${path}.onFormulary`,
        category: CATEGORY.drugCoverage,
        mpfValue: mCov ? mCov.onFormulary : null,
        pmValue: pCov ? pCov.onFormulary : null,
        status: 'FAIL',
        failCode: 'F2',
        severity: 'major',
        note: 'drug coverage entry missing on one side',
      });
      continue;
    }

    out.push(
      compareField(
        `${path}.onFormulary`,
        CATEGORY.drugCoverage,
        mCov.onFormulary,
        pCov.onFormulary,
        { isFormulary: true },
      ),
    );
    out.push(
      compareField(
        `${path}.tier`,
        CATEGORY.drugCoverage,
        mCov.tier,
        pCov.tier,
        { isFormulary: true },
      ),
    );
    out.push(
      compareField(
        `${path}.priorAuth`,
        CATEGORY.drugCoverage,
        mCov.priorAuth,
        pCov.priorAuth,
        { isFormulary: true },
      ),
    );
    out.push(
      compareField(
        `${path}.quantityLimit`,
        CATEGORY.drugCoverage,
        mCov.quantityLimit,
        pCov.quantityLimit,
        { isFormulary: true },
      ),
    );
    out.push(
      compareField(
        `${path}.stepTherapy`,
        CATEGORY.drugCoverage,
        mCov.stepTherapy,
        pCov.stepTherapy,
        { isFormulary: true },
      ),
    );
    out.push(
      compareField(
        `${path}.preferredCopay`,
        CATEGORY.drugCoverage,
        mCov.preferredCopay,
        pCov.preferredCopay,
      ),
    );
    out.push(
      compareField(
        `${path}.standardCopay`,
        CATEGORY.drugCoverage,
        mCov.standardCopay,
        pCov.standardCopay,
      ),
    );

    // Insulin cap validation — IRA §11406 caps copay at $35/mo. If either
    // source exceeds cap, emit F8 IRA compliance error (major).
    if (INSULIN_RX.test(drug.name)) {
      const violations: string[] = [];
      const check = (label: string, val: number | null) => {
        if (val !== null && val > 35) {
          violations.push(`${label}=$${val}`);
        }
      };
      check('mpf.preferred', mCov.preferredCopay);
      check('mpf.standard', mCov.standardCopay);
      check('pm.preferred', pCov.preferredCopay);
      check('pm.standard', pCov.standardCopay);
      if (violations.length > 0) {
        out.push({
          fieldPath: `${path}.insulinCap`,
          category: CATEGORY.ira,
          mpfValue: {
            preferred: mCov.preferredCopay,
            standard: mCov.standardCopay,
          },
          pmValue: {
            preferred: pCov.preferredCopay,
            standard: pCov.standardCopay,
          },
          status: 'FAIL',
          failCode: 'F8',
          severity: 'major',
          note: `insulin $35/mo cap violated: ${violations.join(', ')}`,
        });
      } else {
        out.push({
          fieldPath: `${path}.insulinCap`,
          category: CATEGORY.ira,
          mpfValue: mCov.preferredCopay,
          pmValue: pCov.preferredCopay,
          status: 'PASS',
          severity: 'major',
          note: 'insulin copay within $35 cap on both sides',
        });
      }
    }
  }

  return out;
}

function walkDental(mpf: PlanSnapshot, pm: PlanSnapshot): FieldComparison[] {
  const keys: Array<keyof PlanSnapshot['dental']> = [
    'preventiveCovered',
    'comprehensiveCovered',
    'annualMax',
    'copay',
  ];
  return keys.map((k) =>
    compareField(
      `dental.${k}`,
      CATEGORY.dental,
      mpf.dental[k],
      pm.dental[k],
      { failCode: 'F10', severity: 'minor' },
    ),
  );
}

function walkVision(mpf: PlanSnapshot, pm: PlanSnapshot): FieldComparison[] {
  const keys: Array<keyof PlanSnapshot['vision']> = [
    'routineExamCovered',
    'eyewearAllowance',
    'contactLensAllowance',
    'examCopay',
  ];
  return keys.map((k) => {
    // Phase 2c: many MA plans bundle contact lenses into the eyewear
    // allowance without a separate PBP filing. When PM has null contact
    // and non-zero eyewear, treat MPF's separate contact value as
    // CONDITIONAL — the benefit is present, just aggregated.
    if (k === 'contactLensAllowance') {
      const mVal = mpf.vision.contactLensAllowance;
      const pVal = pm.vision.contactLensAllowance;
      const pmEyewear = pm.vision.eyewearAllowance;
      if (pVal == null && typeof mVal === 'number' && typeof pmEyewear === 'number' && pmEyewear > 0) {
        return {
          fieldPath: 'vision.contactLensAllowance',
          category: CATEGORY.vision,
          mpfValue: mVal,
          pmValue: pVal,
          status: 'CONDITIONAL',
          severity: 'display',
          note: `contact lens allowance included in eyewear benefit ($${pmEyewear}) — no separate PBP filing`,
        };
      }
    }
    return compareField(
      `vision.${k}`,
      CATEGORY.vision,
      mpf.vision[k],
      pm.vision[k],
      { failCode: 'F10', severity: 'minor' },
    );
  });
}

function walkHearing(mpf: PlanSnapshot, pm: PlanSnapshot): FieldComparison[] {
  const keys: Array<keyof PlanSnapshot['hearing']> = [
    'routineExamCovered',
    'hearingAidBenefit',
    'examCopay',
  ];
  return keys.map((k) =>
    compareField(
      `hearing.${k}`,
      CATEGORY.hearing,
      mpf.hearing[k],
      pm.hearing[k],
      { failCode: 'F10', severity: 'minor' },
    ),
  );
}

// fitnessBenefit is a free-text description that varies across sources:
//   MPF:   "included"
//   PM:    "fitness included ($0 copay)", "SilverSneakers", "Renew Active"
// Both indicate the plan HAS the benefit; format differs. Treat as CONDITIONAL
// when both strings signal inclusion.
const FITNESS_INCLUDED_RX = /included|silversneakers|silver sneakers|renew active|fitness|gym|active&fit|onehealth/i;

function compareFitnessBenefit(mpf: PlanSnapshot, pm: PlanSnapshot): FieldComparison {
  const m = mpf.supplemental.fitnessBenefit;
  const p = pm.supplemental.fitnessBenefit;
  const mHas = typeof m === 'string' && FITNESS_INCLUDED_RX.test(m);
  const pHas = typeof p === 'string' && FITNESS_INCLUDED_RX.test(p);
  if (mHas && pHas) {
    return {
      fieldPath: 'supplemental.fitnessBenefit',
      category: CATEGORY.supplemental,
      mpfValue: m,
      pmValue: p,
      status: 'CONDITIONAL',
      severity: 'display',
      note: 'both indicate fitness benefit included; format/vendor label differs',
    };
  }
  return compareField(
    'supplemental.fitnessBenefit',
    CATEGORY.supplemental,
    m,
    p,
    { failCode: 'F10', severity: 'minor' },
  );
}

function walkSupplemental(mpf: PlanSnapshot, pm: PlanSnapshot): FieldComparison[] {
  const keys: Array<keyof PlanSnapshot['supplemental']> = [
    'otcAllowance',
    'otcAllowancePeriod',
    'transportationTripsPerYear',
    'mealsPostDischarge',
    'fitnessBenefit',
    'telehealthAccess',
    'foodCardMonthly',
    'caregiverSupport',
    'inHomeSupportHoursPerMonth',
    'acupunctureVisitsPerYear',
    'worldwideEmergency',
    'nurseHotline',
  ];
  return keys.map((k) => {
    if (k === 'fitnessBenefit') return compareFitnessBenefit(mpf, pm);
    return compareField(
      `supplemental.${k}`,
      CATEGORY.supplemental,
      mpf.supplemental[k],
      pm.supplemental[k],
      { failCode: 'F10', severity: 'minor' },
    );
  });
}

// LIS/QMB override validation (F7). Only fires when PM's snapshot itself
// violates the override — MPF's raw display of plan-filed copays doesn't
// constitute a PM bug and is expected divergence (MPF shows what the plan
// files; PM applies the override for the beneficiary).
//
// CY2026 caps per CMS Oct 2025 LIS Memo (relaxed to worst-case ceilings
// to accept both LEVEL_2 and LEVEL_3 income bands + QMB uniform):
//   Generic (Tier 1/2): ≤ $5.10 (LEVEL_3 generic ceiling)
//   Brand (Tier 3+):     ≤ $12.65 (LEVEL_3 brand ceiling)
// QMB medical: PM should zero ($0) — this is Medicaid rule, not IRA §11202.
const LIS_GENERIC_CEILING = 5.10;
const LIS_BRAND_CEILING = 12.65;

function walkLisDualOverrides(
  mpf: PlanSnapshot,
  pm: PlanSnapshot,
  profile: BeneficiaryProfile,
): FieldComparison[] {
  const out: FieldComparison[] = [];

  if (profile.lis === 'full' || profile.medicaid === 'full-dual' || profile.medicaid === 'qmb' || profile.medicaid === 'slmb' || profile.medicaid === 'qi') {
    // LIS caps apply to the beneficiary-effective copay in drugCoverage[],
    // NOT to rxStructure.tier* (which is the plan's filed tier structure —
    // MPF and PM both show these as raw plan values). Iterate drugCoverage
    // and assert each drug's PM-side preferredCopay is within the applicable
    // LIS ceiling. Generic tier (1/2) uses generic ceiling; brand tier (3+)
    // uses brand ceiling.
    for (let i = 0; i < pm.drugCoverage.length; i++) {
      const cov = pm.drugCoverage[i];
      if (!cov.onFormulary) continue; // uncovered drugs don't get LIS cap
      const tier = cov.tier ?? 0;
      const isGeneric = tier <= 2; // Tier 1 (Preferred Gen) + Tier 2 (Generic)
      const cap = isGeneric ? LIS_GENERIC_CEILING : LIS_BRAND_CEILING;
      const p = cov.preferredCopay;
      const label = `drug[${i}:${cov.drug.name}].preferredCopay`;
      const violates = typeof p === 'number' && !cov.isCoinsurance && p > cap + 0.01;
      out.push({
        fieldPath: `lisOverride.${label}`,
        category: CATEGORY.ira,
        mpfValue: null,
        pmValue: p,
        status: violates ? 'FAIL' : 'PASS',
        failCode: violates ? 'F7' : undefined,
        severity: 'critical',
        note: violates
          ? `PM copay $${p} exceeds LIS ceiling $${cap} for tier ${tier} (${isGeneric ? 'generic' : 'brand'}) — LIS override not applied`
          : `PM copay within LIS ceiling $${cap}`,
      });
    }
  }

  if (profile.medicaid === 'qmb' || profile.medicaid === 'full-dual') {
    const outFields: Array<keyof PlanSnapshot['outpatient']> = [
      'pcpCopay',
      'specialistCopay',
      'urgentCareCopay',
      'erCopay',
    ];
    for (const k of outFields) {
      const mVal = mpf.outpatient[k];
      const pVal = pm.outpatient[k];
      // QMB rule: PM must zero the beneficiary's cost-share. MPF's display
      // of the plan-filed copay is expected — it's what the plan files,
      // not what the QMB beneficiary is billed.
      const pmViolates = typeof pVal === 'number' && pVal > 0;
      if (pmViolates) {
        out.push({
          fieldPath: `dualOverride.outpatient.${k}`,
          category: CATEGORY.ira,
          mpfValue: mVal,
          pmValue: pVal,
          status: 'FAIL',
          failCode: 'F7',
          severity: 'critical',
          note: `PM ${k}=$${pVal} for QMB — must be $0 (Medicaid pays cost-share)`,
        });
      } else {
        out.push({
          fieldPath: `dualOverride.outpatient.${k}`,
          category: CATEGORY.ira,
          mpfValue: mVal,
          pmValue: pVal,
          status: 'PASS',
          severity: 'critical',
          note: `PM correctly zeroed QMB ${k}; MPF shows raw plan copay $${mVal ?? 0}`,
        });
      }
    }
  }

  return out;
}

// ─── Public API ──────────────────────────────────────────────────────

// PDP plans (standalone Part D) don't cover medical, dental, vision, hearing,
// or supplemental benefits — those fields are structurally N/A. Wrap each
// walker's output as N/A instead of comparing (spec Fix 3, 2026-07-23).
function naifyForPdp(comparisons: FieldComparison[]): FieldComparison[] {
  return comparisons.map((c) => ({
    ...c,
    status: 'N/A',
    severity: 'display',
    note: 'N/A for PDP — plan does not cover this benefit category',
  }));
}

export function diffSnapshots(
  mpf: PlanSnapshot,
  pm: PlanSnapshot,
  profile: BeneficiaryProfile,
): FieldComparison[] {
  const isPdp =
    canonicalPlanType(String(mpf.ident.planType ?? '')) === 'PDP' ||
    canonicalPlanType(String(pm.ident.planType ?? '')) === 'PDP';

  const extras = [
    ...walkDental(mpf, pm),
    ...walkVision(mpf, pm),
    ...walkHearing(mpf, pm),
    ...walkSupplemental(mpf, pm),
  ];

  return [
    ...walkIdent(mpf, pm),
    ...walkPremium(mpf, pm),
    ...(isPdp ? naifyForPdp([...walkInpatient(mpf, pm), ...walkOutpatient(mpf, pm, profile), ...walkTherapy(mpf, pm), ...walkOtherMedical(mpf, pm)]) : [...walkInpatient(mpf, pm), ...walkOutpatient(mpf, pm, profile), ...walkTherapy(mpf, pm), ...walkOtherMedical(mpf, pm)]),
    ...walkRxStructure(mpf, pm),
    ...walkRxPhases(mpf, pm),
    ...walkDrugCoverage(mpf, pm, profile),
    ...(isPdp ? naifyForPdp(extras) : extras),
    ...walkLisDualOverrides(mpf, pm, profile),
  ];
}

export function buildPlanComparison(
  mpf: PlanSnapshot,
  pm: PlanSnapshot,
  profile: BeneficiaryProfile,
): PlanComparison {
  const comparisons = diffSnapshots(mpf, pm, profile);

  const denomComparisons = comparisons.filter((c) => c.status !== 'N/A');

  let passCount = 0;
  let conditionalCount = 0;
  let failCount = 0;
  let naCount = 0;

  let weightedTotal = 0;
  let weightedFail = 0;

  for (const c of comparisons) {
    if (c.status === 'PASS') passCount++;
    else if (c.status === 'CONDITIONAL') conditionalCount++;
    else if (c.status === 'FAIL') failCount++;
    else naCount++;

    if (c.status === 'N/A') continue;
    const w = SEVERITY_WEIGHT[c.severity];
    weightedTotal += w;
    if (c.status === 'FAIL') weightedFail += w;
  }

  const unweightedParity =
    denomComparisons.length === 0
      ? 1
      : (passCount + conditionalCount) / denomComparisons.length;
  const weightedScore =
    weightedTotal === 0 ? 1 : 1 - weightedFail / weightedTotal;

  const planKey = `${pm.ident.contractId}-${pm.ident.planId}-${pm.ident.segmentId}`;

  return {
    planKey,
    planName: pm.ident.planName || mpf.ident.planName,
    comparisons,
    passCount,
    conditionalCount,
    failCount,
    naCount,
    weightedScore,
    unweightedParity,
  };
}
