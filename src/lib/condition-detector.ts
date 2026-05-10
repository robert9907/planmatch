// Condition detection from a user's medication list.
//
// A real Medicare broker reads the meds and instantly infers the
// chronic conditions. The brain needs the same instinct: someone
// taking Metformin + Ozempic is diabetic, full stop. Adding Entresto
// alone makes them a heart-failure patient. These aren't guesses —
// they're clinical certainties documented in CMS and pharmacy
// counseling literature.
//
// Detection is layered ON TOP of self-reported csnpConditions, never
// replaces them. The two streams union into the broker-rules input so
// rules fire whether a user clicked "diabetes" on About-You OR just
// listed insulin.
//
// Detection does NOT widen the SNP plan-pool filter — that still
// requires user-self-reported conditions. We don't auto-promote a
// user into a C-SNP-only pool just because their meds suggest it;
// the Welcome → About flow stays the canonical path.

export type DetectedConditionKey =
  | 'diabetes'
  | 'chf'
  | 'copd'
  | 'ckd'
  | 'hypertension'
  | 'afib'
  | 'depression'
  | 'pain_management';

export type DetectionConfidence = 'certain' | 'likely' | 'possible';

export interface DetectedCondition {
  condition: DetectedConditionKey;
  confidence: DetectionConfidence;
  /** Drug names from the user's list that triggered the match. */
  triggerMeds: string[];
}

interface DetectionRule {
  /** Lowercase substrings; matched against med name with .includes(). */
  meds: ReadonlyArray<string>;
  /** Med count threshold for "certain" verdict. */
  certain: number;
  /** Med count threshold for "likely" verdict. Anything >= this but < certain. */
  likely: number;
  /** Optional override list — ANY single match here jumps straight to certain
   *  (e.g., Entresto alone = certain CHF; oral anticoag alone could mean
   *  several things, so it's not on this list). */
  certainSingles?: ReadonlyArray<string>;
}

const RULES: Record<DetectedConditionKey, DetectionRule> = {
  diabetes: {
    meds: [
      // oral generics
      'metformin', 'glipizide', 'glyburide', 'glimepiride',
      // GLP-1 injectables
      'ozempic', 'semaglutide', 'trulicity', 'dulaglutide', 'rybelsus',
      // SGLT2 inhibitors (cross-listed for CHF/CKD too)
      'jardiance', 'empagliflozin', 'farxiga', 'dapagliflozin',
      'invokana', 'canagliflozin',
      // GLP-1/GIP dual
      'mounjaro', 'tirzepatide', 'zepbound',
      // basal insulin
      'lantus', 'basaglar', 'tresiba', 'levemir', 'insulin glargine', 'toujeo',
      // rapid insulin
      'humalog', 'novolog', 'insulin lispro', 'insulin aspart', 'fiasp',
      // DPP-4 inhibitors
      'januvia', 'sitagliptin', 'tradjenta', 'linagliptin',
      // TZDs
      'pioglitazone', 'actos',
    ],
    certain: 2,
    likely: 1,
    certainSingles: [
      // these single-drug matches are diagnostic on their own — only
      // diabetics get them
      'lantus', 'basaglar', 'tresiba', 'humalog', 'novolog', 'fiasp',
      'ozempic', 'mounjaro', 'trulicity', 'rybelsus', 'januvia',
    ],
  },
  chf: {
    meds: [
      'entresto', 'sacubitril/valsartan', 'sacubitril',
      'carvedilol', 'metoprolol succinate',
      'spironolactone', 'eplerenone',
      'furosemide', 'bumetanide', 'torsemide',
      'digoxin',
      'hydralazine', 'isosorbide dinitrate',
      // SGLT2s have CHF indication; cross-listed with diabetes
      'jardiance', 'empagliflozin', 'farxiga', 'dapagliflozin',
    ],
    certain: 2,
    likely: 1,
    certainSingles: ['entresto', 'sacubitril/valsartan', 'sacubitril'],
  },
  copd: {
    meds: [
      'symbicort', 'budesonide/formoterol',
      'breo ellipta', 'fluticasone/vilanterol',
      'trelegy ellipta', 'fluticasone/umeclidinium/vilanterol',
      'spiriva', 'tiotropium',
      'albuterol', 'proair', 'ventolin', 'proventil',
      'montelukast', 'singulair',
      'theophylline',
    ],
    certain: 2,
    likely: 1,
    certainSingles: ['trelegy ellipta', 'spiriva', 'tiotropium'],
  },
  ckd: {
    meds: [
      'kerendia', 'finerenone',
      'epoetin', 'aranesp', 'darbepoetin',
      'sevelamer', 'renvela',
      'calcitriol',
      'kayexalate', 'sodium polystyrene', 'patiromer', 'veltassa',
      // SGLT2s have CKD indication too
      'farxiga', 'dapagliflozin',
    ],
    certain: 1, // any of these is essentially diagnostic for CKD
    likely: 1,
    certainSingles: [
      'kerendia', 'finerenone', 'sevelamer', 'patiromer', 'veltassa',
      'epoetin', 'aranesp',
    ],
  },
  hypertension: {
    meds: [
      'lisinopril', 'enalapril', 'ramipril', 'benazepril', 'captopril',
      'losartan', 'valsartan', 'irbesartan', 'olmesartan', 'candesartan',
      'amlodipine', 'nifedipine', 'diltiazem', 'verapamil',
      'hydrochlorothiazide', 'chlorthalidone', 'indapamide',
      'metoprolol', 'atenolol', 'propranolol',
      'clonidine',
    ],
    certain: 2,
    likely: 1,
  },
  afib: {
    meds: [
      'eliquis', 'apixaban',
      'xarelto', 'rivaroxaban',
      'warfarin', 'coumadin',
      'amiodarone', 'flecainide', 'sotalol', 'dronedarone',
    ],
    // afib needs an anticoag + rate/rhythm control; certainSingles
    // intentionally empty — anticoagulants alone could be DVT/PE.
    certain: 2,
    likely: 1,
  },
  depression: {
    meds: [
      'sertraline', 'fluoxetine', 'citalopram', 'escitalopram',
      'paroxetine',
      'venlafaxine', 'duloxetine',
      'bupropion', 'mirtazapine', 'trazodone',
    ],
    certain: 2,
    likely: 1,
  },
  pain_management: {
    meds: [
      'gabapentin', 'pregabalin', 'lyrica',
      'tramadol', 'oxycodone', 'hydrocodone',
      'morphine', 'fentanyl',
      'cyclobenzaprine', 'methocarbamol', 'baclofen',
      'duloxetine',
      'meloxicam', 'celecoxib',
    ],
    certain: 3,
    likely: 1,
  },
};

// Broker-friendly explanation per detected condition. Surfaced in
// console diagnostics and (eventually) in the Plan Detail "why this
// plan" copy when a condition-driven rule fires.
export const BROKER_IMPLICATIONS: Record<DetectedConditionKey, ReadonlyArray<string>> = {
  diabetes: [
    'C-SNP eligibility — often \\$0 copays on diabetes meds + supplies',
    'Diabetic supplies coverage (test strips, lancets, monitors) is mandatory',
    'OTC card matters more — buys glucose tabs, bandages, supplies',
    'Lower MOOP matters — diabetics use more healthcare than average',
  ],
  chf: [
    'C-SNP eligibility (CHF qualifies)',
    'MOOP is the #1 factor — hospital admissions are the dominant cost',
    'Inpatient day-rate matters enormously',
    'Telehealth high value — frequent monitoring',
    'Post-discharge meal benefit valuable',
  ],
  copd: [
    'C-SNP eligibility',
    'Inhalers Tier 3-4 (often coinsurance) — the cost driver',
    'Pulmonary rehab coverage matters',
    'ER copay matters (exacerbations)',
  ],
  ckd: [
    'C-SNP eligibility (CKD qualifies)',
    'Specialty med costs (Kerendia, anemia therapies) drive the plan choice',
    'Lab coverage frequency matters',
  ],
  hypertension: [
    'Most BP meds Tier 1 — drug cost is rarely the differentiator',
    'Look at MOOP + extras for tiebreakers',
  ],
  afib: [
    'DOACs (Eliquis, Xarelto) Tier 3 — cost driver',
    'Cardiologist visits frequent — specialist copay matters',
  ],
  depression: [
    'Mental health visit copay matters',
    'Most antidepressants Tier 1',
  ],
  pain_management: [
    'Watch for opioid restrictions / prior auth on the formulary',
    'Specialist + PT visit copays matter',
  ],
};

// Match a user-typed med name against a rule's keyword list. Case-
// insensitive substring match; "Lisinopril 10 MG" matches "lisinopril".
function medMatches(medName: string, keyword: string): boolean {
  return medName.toLowerCase().includes(keyword);
}

export function detectConditionsFromMeds(
  meds: ReadonlyArray<{ name: string }>,
): DetectedCondition[] {
  if (!meds || meds.length === 0) return [];
  const out: DetectedCondition[] = [];
  for (const [key, rule] of Object.entries(RULES) as Array<
    [DetectedConditionKey, DetectionRule]
  >) {
    const matches = meds.filter((m) => rule.meds.some((kw) => medMatches(m.name, kw)));
    if (matches.length === 0) continue;
    let confidence: DetectionConfidence = 'possible';
    if (matches.length >= rule.certain) {
      confidence = 'certain';
    } else if (matches.length >= rule.likely) {
      confidence = 'likely';
    }
    // Single-match upgrade to certain when the matched drug is
    // diagnostic on its own.
    if (
      confidence !== 'certain' &&
      rule.certainSingles &&
      matches.some((m) => rule.certainSingles!.some((kw) => medMatches(m.name, kw)))
    ) {
      confidence = 'certain';
    }
    out.push({
      condition: key,
      confidence,
      triggerMeds: Array.from(new Set(matches.map((m) => m.name))),
    });
  }
  return out;
}

// Map a med-derived condition into the existing CsnpCondition vocabulary
// so the rest of the app (which keys off csnpConditions for utilization
// profiles + Plan Detail copy) can union the two streams.
import type { CsnpCondition } from './brain-foreign-types';

const TO_CSNP: Partial<Record<DetectedConditionKey, CsnpCondition>> = {
  diabetes: 'diabetes',
  chf: 'cardio',
  copd: 'copd',
  ckd: 'esrd',
  hypertension: 'hypertension',
  afib: 'cardio',
  // depression + pain_management have no C-SNP analogue — skip.
};

/** Map detected (med-derived) conditions onto the CsnpCondition enum
 *  used by the existing condition-profile + UI copy paths. Returns a
 *  deduped array. Use to UNION with self-reported csnpConditions. */
export function detectedToCsnp(
  detected: ReadonlyArray<DetectedCondition>,
): CsnpCondition[] {
  const out = new Set<CsnpCondition>();
  for (const d of detected) {
    const mapped = TO_CSNP[d.condition];
    if (mapped) out.add(mapped);
  }
  return Array.from(out);
}
