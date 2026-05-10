// Broker Playbook — client archetypes, medication patterns, and
// red-flag engine. The pieces a 25-year Medicare broker reaches for
// before they look at any plan numbers.
//
// What this module owns:
//   1. ClientArchetype — the single label that summarizes WHO this
//      person is (healthy newly-eligible / single-chronic diabetic /
//      multi-chronic / insulin-dependent / specialty-drug / …).
//      Drives weight selection + plan-type preference + red-flag
//      family activation. Picked by classifyArchetype with a strict
//      priority order so two archetypes never both fire.
//   2. ARCHETYPE_RULES — the table mapping each archetype to its
//      drug/OOP/extras weights, preferred plan types, critical
//      decision factors, and which red-flag families apply.
//   3. MEDICATION_PATTERNS — combinations a broker spots instantly:
//      Metformin + Ozempic = "diabetes escalation, not stable";
//      Entresto = "confirmed CHF, hospital-readmission risk dominant".
//      Each pattern has plain-English broker copy.
//   4. RED_FLAGS — explicit overrides on top of the composite score.
//      A flag can disqualify a plan, penalize its score, or just
//      attach a warning surfaced to the user.
//
// What this module does NOT own:
//   - The composite scoring math (still in plan-brain.ts).
//   - The condition-detection from meds (still in condition-detector.ts).
//     We CONSUME its output here.
//   - UI copy templates (focusCopyFor in reportCard.ts).
//
// Detection priority is intentional: insulin_dependent is technically
// also single_chronic (diabetes), but the insulin signal dominates the
// plan choice (the $35/mo IRA cap matters more than the diabetes
// label). Same for specialty_drug — a Humira patient might also be
// multi_chronic, but the specialty drug economics drive everything.

import type { BrainScoredPlan, BrainWeights } from './plan-brain-types';
import type { DetectedCondition } from './condition-detector';

// ─── Archetype types ──────────────────────────────────────────────────

export type ClientArchetype =
  | 'specialty_drug'
  | 'dual_eligible'
  | 'insulin_dependent'
  | 'complex_polypharmacy'
  | 'multi_chronic'
  | 'single_chronic'
  | 'provider_locked'
  | 'healthy_newly_eligible'
  | 'healthy_established'
  | 'general';

export interface ArchetypeProfile {
  age: number | null;
  /** Union of self-reported csnpConditions and med-detected conditions
   *  with confidence >= likely. Lowercased canonical names like
   *  'diabetes' / 'chf' / 'copd' / 'ckd' / 'hypertension'. */
  conditions: ReadonlyArray<string>;
  detectedConditions: ReadonlyArray<DetectedCondition>;
  medications: ReadonlyArray<{ name: string; rxcui?: string }>;
  providerCount: number;
  /** True when the user self-reports Medicaid on About-You (which
   *  derives FlowState.dsnpEligible === true). 'unsure' is treated as
   *  false here — we only flip the archetype when the user is
   *  confirmed dual-eligible. */
  dualEligible: boolean;
}

export interface ArchetypeRule {
  /** 50/30/20 → 0.50/0.30/0.20 — sums to 1.0, matches BrainWeights. */
  weights: BrainWeights;
  /** Preferred plan types in order. The brain uses these as soft
   *  guidance for ranking + suggestion copy; not as hard filters. */
  planTypes: ReadonlyArray<string>;
  /** What a broker would check first for this archetype — surfaced
   *  in the agent dashboard and in console diagnostics. */
  criticalFactors: ReadonlyArray<string>;
  /** Which red-flag families fire for this archetype. Lets us skip
   *  flags that don't apply (e.g., insulin_no_cap on a patient who
   *  isn't on insulin). */
  redFlagFamilies: ReadonlyArray<RedFlagFamily>;
}

// ─── Detection priority + predicates ─────────────────────────────────
//
// Most-specific first. Once one fires, the rest are skipped — a
// Humira patient with diabetes + hypertension is 'specialty_drug'
// (the Tier 5 economics dominate) regardless of how many other
// archetypes they could also satisfy.

// Excludes 'general' — that's the fallback when nothing else fires.
//
// dual_eligible sits second only to specialty_drug because the D-SNP
// economics (typically $0 premium, $0 drug copays, transportation /
// meals built in) dominate plan choice for any dual beneficiary EXCEPT
// when they're also on a Tier-5 specialty drug — where the specialty
// economics still dictate the plan even though they're dual.
const ARCHETYPE_PRIORITY: ReadonlyArray<Exclude<ClientArchetype, 'general'>> = [
  'specialty_drug',
  'dual_eligible',
  'insulin_dependent',
  'complex_polypharmacy',
  'multi_chronic',
  'single_chronic',
  'provider_locked',
  'healthy_established',
  'healthy_newly_eligible',
];

// Common chronic conditions that count toward single/multi_chronic
// classification. We exclude 'hypertension' from the chronic count
// because most BP patients are stable on Tier-1 generics and don't
// drive the chronic-care decision. Exported so plan-brain's profile
// detector applies the same definition — without this, a healthy
// 65-year-old on Lisinopril alone classified as "sick" (Profile A)
// and skipped the premium penalty path.
export const CHRONIC_CONDITION_KEYS: ReadonlySet<string> = new Set([
  'diabetes', 'chf', 'copd', 'ckd', 'cardio', 'esrd', 'cancer',
]);

const INSULIN_NAMES: ReadonlyArray<string> = [
  'lantus', 'basaglar', 'tresiba', 'levemir', 'humalog', 'novolog',
  'insulin glargine', 'insulin lispro', 'insulin aspart', 'insulin detemir',
  'humulin', 'novolin', 'admelog', 'fiasp', 'lyumjev', 'toujeo',
  'apidra', 'afrezza', 'semglee', 'rezvoglar',
];

const SPECIALTY_DRUG_NAMES: ReadonlyArray<string> = [
  'humira', 'stelara', 'enbrel', 'otezla', 'xeljanz', 'rinvoq',
  'dupixent', 'cosentyx', 'skyrizi', 'tremfya', 'kevzara',
  'ocrevus', 'tysabri', 'tecfidera', 'revlimid', 'imbruvica',
  'keytruda', 'opdivo', 'ibrance', 'pomalyst', 'jakafi',
  'venclexta', 'kalydeco', 'orkambi', 'trikafta', 'spinraza',
];

const includesAny = (haystack: string, needles: ReadonlyArray<string>): boolean => {
  const h = haystack.toLowerCase();
  return needles.some((n) => h.includes(n));
};

const DETECT: Record<Exclude<ClientArchetype, 'general'>, (p: ArchetypeProfile) => boolean> = {
  specialty_drug: (p) =>
    p.medications.some((m) => includesAny(m.name, SPECIALTY_DRUG_NAMES)),

  dual_eligible: (p) => p.dualEligible === true,

  insulin_dependent: (p) =>
    p.medications.some((m) => includesAny(m.name, INSULIN_NAMES)),

  complex_polypharmacy: (p) => p.medications.length >= 5,

  multi_chronic: (p) => {
    const chronic = p.conditions.filter((c) => CHRONIC_CONDITION_KEYS.has(c));
    return chronic.length >= 2;
  },

  single_chronic: (p) => {
    const chronic = p.conditions.filter((c) => CHRONIC_CONDITION_KEYS.has(c));
    return chronic.length === 1;
  },

  provider_locked: (p) => p.providerCount >= 2,

  // Strict: 65 exactly, ≤1 med, no chronic conditions. The "newly
  // eligible" framing assumes you're on the cusp of Medicare and
  // optimizing for first-year benefits. Conditions are filtered
  // through CHRONIC_CONDITION_KEYS so a single BP med (hypertension
  // likely) doesn't kick the user out of healthy.
  healthy_newly_eligible: (p) =>
    p.age === 65 &&
    p.medications.length <= 1 &&
    p.conditions.filter((c) => CHRONIC_CONDITION_KEYS.has(c)).length === 0,

  // Stable established beneficiary: 66–74, ≤2 meds, no chronic
  // conditions. Past the newly-eligible window but not yet at the
  // age where utilization spikes.
  healthy_established: (p) =>
    p.age != null &&
    p.age >= 66 &&
    p.age <= 74 &&
    p.medications.length <= 2 &&
    p.conditions.filter((c) => CHRONIC_CONDITION_KEYS.has(c)).length === 0,
};

export function classifyArchetype(p: ArchetypeProfile): ClientArchetype {
  for (const a of ARCHETYPE_PRIORITY) {
    if (DETECT[a](p)) return a;
  }
  return 'general';
}

// ─── Archetype rule table ────────────────────────────────────────────

export const ARCHETYPE_RULES: Record<ClientArchetype, ArchetypeRule> = {
  // Specialty drug economics dominate — the Tier 5 coinsurance % is
  // the single biggest cost lever; OOP is secondary because they'll
  // hit Rx MOOP either way.
  specialty_drug: {
    weights: { drug: 0.70, oop: 0.20, extras: 0.10 },
    planTypes: ['MAPD'],
    criticalFactors: [
      'Tier 5 coinsurance % (varies 25–33%)',
      'Specialty drug copay cap if any',
      'Rx out-of-pocket maximum (will be reached)',
      'Step-therapy / prior-auth requirements',
      'Manufacturer assistance program eligibility',
    ],
    redFlagFamilies: ['critical_drug', 'star_rating'],
  },

  // Dual-eligible (Medicare + Medicaid): D-SNP plans typically have
  // $0 premium, $0 drug copays, and lifeline extras (transportation,
  // meals, OTC card). Drug + OOP weights drop to near-zero; extras
  // dominate because that's the differentiator across D-SNPs.
  dual_eligible: {
    weights: { drug: 0.10, oop: 0.20, extras: 0.70 },
    planTypes: ['D-SNP', 'MAPD'],
    criticalFactors: [
      'D-SNP availability with provider in-network',
      'Transportation benefit (covered rides to appointments)',
      'OTC / grocery card monthly value',
      'Meal benefit (post-discharge or chronic)',
      'Dental + vision + hearing depth (Medicaid covers little of these)',
      'Care coordination (built into D-SNP)',
    ],
    redFlagFamilies: ['dual_dsnp_match', 'dual_on_mapd', 'all_providers_out', 'star_rating'],
  },

  // Insulin-dependent: $35/mo IRA cap is mandatory; supplies
  // coverage is the next biggest lever. Drugs and OOP roughly
  // co-equal because endocrinology + lab utilization is high.
  insulin_dependent: {
    weights: { drug: 0.55, oop: 0.30, extras: 0.15 },
    planTypes: ['C-SNP', 'MAPD'],
    criticalFactors: [
      '$35/month insulin cap (IRA — mandatory)',
      'Insulin tier placement (some plans Tier 2 $0, others Tier 3 $47)',
      'Diabetic supplies coverage ($0 strips/lancets/CGM)',
      'Endocrinologist copay × 4 visits/yr',
      'A1C lab frequency coverage',
    ],
    redFlagFamilies: ['insulin_cap', 'diabetic_supplies', 'all_providers_out', 'star_rating'],
  },

  // Polypharmacy: 5+ drugs means even a $0 plan with one missing
  // drug becomes the most expensive plan. Drug coverage trumps
  // everything else.
  complex_polypharmacy: {
    weights: { drug: 0.60, oop: 0.30, extras: 0.10 },
    planTypes: ['MAPD', 'C-SNP'],
    criticalFactors: [
      'Total monthly drug cost across ALL meds',
      'Number of drugs NOT on formulary (any miss is critical)',
      'Rx deductible (hit fast with 5+ drugs)',
      'Tier-3/4 coinsurance vs. flat copay',
      'Coverage gap implications',
    ],
    redFlagFamilies: ['critical_drug', 'all_providers_out', 'star_rating'],
  },

  // Multi-chronic: MOOP is king — these patients WILL hit MOOP
  // through a hospitalization. Inpatient + ER copays drive the
  // worst-case dollars more than monthly drug costs.
  multi_chronic: {
    weights: { drug: 0.35, oop: 0.50, extras: 0.15 },
    planTypes: ['C-SNP', 'MAPD'],
    criticalFactors: [
      'MOOP — they WILL hit it',
      'Inpatient copay per day (will be admitted)',
      'ER copay (will use it)',
      'Specialist copay × multiple specialists',
      'Care coordination (managing 2+ conditions)',
      'All-drugs-on-formulary check',
      'Telehealth + ambulance coverage',
    ],
    redFlagFamilies: [
      'chronic_maxmoop',
      'critical_drug',
      'all_providers_out',
      'chf_high_inpatient',
      'star_rating',
      'narrow_network_multi_specialist',
    ],
  },

  // Single-chronic: drug + OOP equally important. C-SNP if
  // available — purpose-built for the condition and usually $0
  // copays on condition meds.
  single_chronic: {
    weights: { drug: 0.40, oop: 0.40, extras: 0.20 },
    planTypes: ['C-SNP', 'MAPD'],
    criticalFactors: [
      'C-SNP availability with provider in-network',
      'Cost of the condition-driver drug',
      'MOOP — they WILL use healthcare',
      'Condition-specific supplies coverage',
      'Specialist copay × ~4 visits/yr',
      'Lab copay × ~6 draws/yr',
      'Care coordination (built into C-SNP)',
    ],
    redFlagFamilies: [
      'chronic_maxmoop',
      'critical_drug',
      'all_providers_out',
      'diabetic_supplies',
      'chf_high_inpatient',
      'copd_inhaler_tier4',
      'star_rating',
    ],
  },

  // Provider-locked: 2+ providers they want to keep. Drug + OOP
  // moderate; the implicit "plan must keep all providers" lives in
  // the brain's allProvidersOutOfNetwork disqualifier, not as an
  // explicit weight.
  provider_locked: {
    weights: { drug: 0.30, oop: 0.30, extras: 0.40 },
    planTypes: ['PPO', 'HMO-POS', 'MAPD'],
    criticalFactors: [
      'ALL providers must be in-network',
      'PPO vs. HMO — referral requirements',
      'Out-of-network coverage as safety net (PPO)',
    ],
    redFlagFamilies: ['all_providers_out', 'narrow_network_multi_specialist', 'star_rating'],
  },

  // Healthy newly-eligible (65, ≤1 med): extras dominate. Giveback,
  // OTC, dental, vision, fitness — the year-one benefits beat
  // everything else when drug costs are pennies.
  healthy_newly_eligible: {
    weights: { drug: 0.15, oop: 0.25, extras: 0.60 },
    planTypes: ['giveback', 'MAPD'],
    criticalFactors: [
      'Part B giveback amount',
      'OTC card monthly value',
      'Dental coverage tier',
      'Vision allowance',
      'Fitness benefit',
    ],
    redFlagFamilies: ['giveback_trap', 'star_rating'],
  },

  // Healthy established (66–74, ≤2 meds): same shape as newly
  // eligible but slightly more weight on OOP — they're aging into
  // higher utilization probability.
  healthy_established: {
    weights: { drug: 0.20, oop: 0.30, extras: 0.50 },
    planTypes: ['giveback', 'MAPD'],
    criticalFactors: [
      'Part B giveback amount',
      'Low MOOP (peace of mind)',
      'OTC card',
      'Dental + vision',
    ],
    redFlagFamilies: ['giveback_trap', 'star_rating'],
  },

  // General: catch-all for users that don't fit a specific story.
  // Falls back to standard 50/30/20 — same as the legacy default.
  general: {
    weights: { drug: 0.50, oop: 0.30, extras: 0.20 },
    planTypes: ['MAPD'],
    criticalFactors: [
      'Drug coverage + total cost',
      'MOOP exposure',
      'Provider network',
      'Extras value',
    ],
    redFlagFamilies: ['critical_drug', 'all_providers_out', 'star_rating'],
  },
};

// ─── Medication patterns ─────────────────────────────────────────────
//
// What a broker spots in the first 5 seconds of looking at a med list.
// Each pattern has a `variant` slot so a single pattern (e.g.
// 'diabetes_escalation') can resolve to one of several variants
// ('moderate' / 'aggressive' / 'insulin_dependent') with different
// implication copy. Variants are mutually exclusive within a pattern.

export interface MedicationPattern {
  /** Pattern family id — stable for analytics. */
  id: string;
  /** Variant within the family. */
  variant: string;
  /** Sentence-ready broker copy for surface in the Report Card or
   *  agent dashboard. */
  implication: string;
}

interface PatternFamily {
  id: string;
  detect: (meds: ReadonlyArray<{ name: string }>) => string | null;
  variants: Record<string, string>;
}

const PATTERN_FAMILIES: ReadonlyArray<PatternFamily> = [
  {
    id: 'diabetes_escalation',
    detect: (meds) => {
      const has = (names: ReadonlyArray<string>) => meds.some((m) => includesAny(m.name, names));
      const biguanide = has(['metformin']);
      const glp1 = has(['ozempic', 'semaglutide', 'trulicity', 'mounjaro', 'rybelsus', 'zepbound']);
      const sglt2 = has(['jardiance', 'farxiga', 'invokana', 'empagliflozin', 'dapagliflozin']);
      const insulin = has(INSULIN_NAMES);
      if (insulin) return 'insulin_dependent';
      if (biguanide && glp1 && sglt2) return 'aggressive';
      if (biguanide && glp1) return 'moderate';
      return null;
    },
    variants: {
      moderate:
        'Diabetes not controlled on Metformin alone — doctor added an injectable. Expect endocrinology visits, A1C every 3 months, possible insulin within 1–2 years.',
      aggressive:
        'Triple therapy — diabetes is being managed aggressively. High utilization expected. MOOP and supplies coverage are load-bearing. C-SNP is ideal if available.',
      insulin_dependent:
        'Insulin-dependent — highest diabetes utilization. $35/mo IRA cap is mandatory; supplies coverage critical. C-SNP if available.',
    },
  },

  {
    id: 'cardiac_cascade',
    detect: (meds) => {
      const has = (names: ReadonlyArray<string>) => meds.some((m) => includesAny(m.name, names));
      const beta = has(['metoprolol', 'carvedilol', 'atenolol', 'bisoprolol']);
      const aceArb = has(['lisinopril', 'losartan', 'valsartan', 'enalapril', 'ramipril', 'olmesartan']);
      const anticoag = has(['eliquis', 'xarelto', 'warfarin', 'coumadin', 'apixaban', 'rivaroxaban']);
      const entresto = has(['entresto', 'sacubitril/valsartan']);
      const diuretic = has(['furosemide', 'bumetanide', 'spironolactone', 'torsemide']);
      if (entresto) return 'chf_confirmed';
      if (beta && aceArb && diuretic) return 'chf_likely';
      if (anticoag && beta) return 'afib_cardiac';
      if (beta && aceArb) return 'hypertension_managed';
      return null;
    },
    variants: {
      chf_confirmed:
        'Entresto = confirmed heart failure. Hospital readmission risk dominates plan choice. C-SNP for heart conditions if available.',
      chf_likely:
        'Beta blocker + ACE/ARB + diuretic = likely heart failure. Expect cardiology visits, echo, BNP labs. MOOP matters more than drug cost.',
      afib_cardiac:
        'Anticoagulant + beta blocker = atrial fibrillation. INR monitoring if on warfarin. Cardiology 2–4×/year.',
      hypertension_managed:
        'Blood pressure managed with two drugs. Stable. Don\'t overweight cardiac risk in scoring.',
    },
  },

  {
    id: 'respiratory_burden',
    detect: (meds) => {
      const has = (names: ReadonlyArray<string>) => meds.some((m) => includesAny(m.name, names));
      const icsLaba = has(['symbicort', 'breo', 'advair', 'trelegy', 'wixela', 'dulera']);
      const lama = has(['spiriva', 'tiotropium', 'incruse', 'tudorza']);
      const rescue = has(['albuterol', 'proair', 'ventolin', 'proventil', 'levalbuterol']);
      if (icsLaba && lama) return 'copd_severe';
      if (icsLaba) return 'copd_moderate';
      if (rescue && !icsLaba) return 'asthma_mild';
      return null;
    },
    variants: {
      copd_severe:
        'ICS/LABA + LAMA = severe COPD. High ER risk. Pulmonary rehab + inhaler costs drive plan choice.',
      copd_moderate:
        'Maintenance inhaler = moderate COPD. Inhaler tier (3 vs 4) is the key cost differentiator.',
      asthma_mild:
        'Rescue inhaler only = mild asthma. Not a major plan driver.',
    },
  },

  {
    id: 'cv_prevention',
    detect: (meds) => {
      const has = (names: ReadonlyArray<string>) => meds.some((m) => includesAny(m.name, names));
      const statin = has(['atorvastatin', 'rosuvastatin', 'simvastatin', 'pravastatin', 'lovastatin']);
      const bp = has([
        'lisinopril', 'losartan', 'amlodipine', 'metoprolol', 'hydrochlorothiazide',
        'valsartan', 'enalapril', 'olmesartan',
      ]);
      if (statin && bp) return 'standard_prevention';
      return null;
    },
    variants: {
      standard_prevention:
        'Statin + BP med = doctor protecting against cardiovascular events. All Tier-1 generics — drug cost is NOT the differentiator. Focus on MOOP, extras, provider network.',
    },
  },

  {
    id: 'pain_complexity',
    detect: (meds) => {
      const has = (names: ReadonlyArray<string>) => meds.some((m) => includesAny(m.name, names));
      const gaba = has(['gabapentin', 'pregabalin', 'lyrica']);
      const dulox = has(['duloxetine', 'cymbalta']);
      if (gaba && dulox) return 'neuropathic_pain';
      if (gaba) return 'nerve_pain';
      return null;
    },
    variants: {
      neuropathic_pain:
        'Two pain medications = chronic pain management. May need pain specialist. All generics — focus on specialist copay and provider network.',
      nerve_pain:
        'Single nerve-pain medication — common and not a major plan driver.',
    },
  },
];

export function detectMedicationPatterns(
  meds: ReadonlyArray<{ name: string }>,
): MedicationPattern[] {
  if (meds.length === 0) return [];
  const out: MedicationPattern[] = [];
  for (const fam of PATTERN_FAMILIES) {
    const variant = fam.detect(meds);
    if (variant && fam.variants[variant]) {
      out.push({ id: fam.id, variant, implication: fam.variants[variant] });
    }
  }
  return out;
}

// ─── Red flags ───────────────────────────────────────────────────────
//
// Scored AFTER broker rules. Each flag declares its action:
//   disqualify → plan is removed from Top 3 selection.
//   penalize  → composite score gets `points` added (negative penalty).
//   warn      → no score change; flag attaches for UI.
//   flag      → no score change; flag attaches for UI (lower-severity
//               warn synonym, kept distinct so analytics can split).
//
// Severity is independent of action — a 'medium' severity flag with
// 'penalize' costs less than a 'high' one.

export type RedFlagSeverity = 'critical' | 'high' | 'medium' | 'low';
export type RedFlagAction = 'disqualify' | 'penalize' | 'warn' | 'flag';

export type RedFlagFamily =
  | 'chronic_maxmoop'
  | 'insulin_cap'
  | 'all_providers_out'
  | 'critical_drug'
  | 'diabetic_supplies'
  | 'chf_high_inpatient'
  | 'copd_inhaler_tier4'
  | 'giveback_trap'
  | 'star_rating'
  | 'narrow_network_multi_specialist'
  | 'dual_dsnp_match'
  | 'dual_on_mapd';

export interface RedFlagInstance {
  id: RedFlagFamily;
  severity: RedFlagSeverity;
  action: RedFlagAction;
  message: string;
  points?: number;
}

const MAINT_INHALER_NAMES: ReadonlyArray<string> = [
  'symbicort', 'breo', 'advair', 'trelegy', 'spiriva',
  'incruse', 'tudorza', 'wixela', 'dulera', 'anoro',
];

interface RedFlagDef {
  family: RedFlagFamily;
  severity: RedFlagSeverity;
  action: RedFlagAction;
  /** Negative — added to composite when action === 'penalize'. */
  points?: number;
  check: (profile: ArchetypeProfile, plan: BrainScoredPlan) => boolean;
  message: (profile: ArchetypeProfile, plan: BrainScoredPlan) => string;
}

const RED_FLAG_DEFS: ReadonlyArray<RedFlagDef> = [
  {
    family: 'chronic_maxmoop',
    severity: 'critical',
    action: 'warn',
    check: (p, plan) => {
      const hasChronic = p.conditions.some((c) => CHRONIC_CONDITION_KEYS.has(c));
      return hasChronic && (plan.row.moop ?? 0) >= 7500;
    },
    message: (_p, plan) =>
      `MOOP $${(plan.row.moop ?? 0).toLocaleString()} — at the CMS ceiling. With your conditions, one bad year hits the maximum.`,
  },

  {
    family: 'insulin_cap',
    severity: 'critical',
    action: 'penalize',
    points: -30,
    check: (p, plan) => {
      // Only fires for insulin-dependent users. Approximation: if
      // any insulin in the user's list has a formulary copay > 35
      // on this plan, the plan isn't honoring the IRA cap (or has
      // it filed in a way we can't see).
      const userInsulins = p.medications.filter((m) => includesAny(m.name, INSULIN_NAMES));
      if (userInsulins.length === 0) return false;
      for (const ins of userInsulins) {
        if (!ins.rxcui) continue;
        const cov = plan.formulary.get(ins.rxcui);
        if (!cov || cov.tier == null) continue;
        const tierBenefit = plan.benefits.find((b) => b.benefit_category === `rx_tier_${cov.tier}`);
        const copay = tierBenefit?.copay ?? null;
        if (copay != null && copay > 35) return true;
      }
      return false;
    },
    message: () =>
      'Insulin tier copay above the $35/month IRA cap on this plan — could cost hundreds more per month than a compliant plan.',
  },

  {
    family: 'all_providers_out',
    severity: 'critical',
    action: 'disqualify',
    check: (_p, plan) => plan.score.allProvidersOutOfNetwork,
    message: () => 'None of your providers accept this plan.',
  },

  {
    family: 'critical_drug',
    severity: 'high',
    action: 'penalize',
    points: -25,
    check: (p, plan) => {
      // Cost-driver drug = highest-tier drug on the user's list.
      // If it's tier 3+ AND not covered on this plan, the plan is
      // structurally wrong for this user.
      let driver: { rxcui?: string; name: string; tier: number } | null = null;
      for (const m of p.medications) {
        if (!m.rxcui) continue;
        const cov = plan.formulary.get(m.rxcui);
        const tier = cov?.tier ?? 0;
        if (driver == null || tier > driver.tier) {
          driver = { rxcui: m.rxcui, name: m.name, tier };
        }
      }
      if (!driver || driver.tier < 3) return false;
      const cov = driver.rxcui ? plan.formulary.get(driver.rxcui) : undefined;
      return !cov;
    },
    message: (p) => {
      // Re-derive the driver name for the message — keeps the
      // function pure (no shared state with check).
      let driverName = 'your most expensive medication';
      for (const m of p.medications) {
        if (m.name) driverName = m.name;
      }
      return `${driverName} is not on this plan's formulary.`;
    },
  },

  {
    family: 'diabetic_supplies',
    severity: 'medium',
    action: 'penalize',
    points: -15,
    check: (p, plan) => {
      const isDiabetic = p.conditions.includes('diabetes');
      if (!isDiabetic) return false;
      // Insulin/supplies category in pbp_benefits is keyed 'insulin'
      // by the medicare_gov mapper. Absent = not covered.
      return !plan.benefits.some((b) => b.benefit_category === 'insulin');
    },
    message: () => 'Diabetic supplies (test strips, lancets, glucose monitor) not covered.',
  },

  {
    family: 'chf_high_inpatient',
    severity: 'medium',
    action: 'penalize',
    points: -10,
    check: (p, plan) => {
      const isChf = p.conditions.includes('chf') || p.conditions.includes('cardio');
      if (!isChf) return false;
      const ip = plan.benefits.find((b) => b.benefit_category === 'inpatient');
      const perDay = ip?.copay ?? 0;
      return perDay > 300;
    },
    message: (_p, plan) => {
      const ip = plan.benefits.find((b) => b.benefit_category === 'inpatient');
      const perDay = ip?.copay ?? 0;
      return `$${perDay}/day inpatient copay — risky for heart failure (high readmission rate).`;
    },
  },

  {
    family: 'copd_inhaler_tier4',
    severity: 'medium',
    action: 'penalize',
    points: -10,
    check: (p, plan) => {
      const isCopd = p.conditions.includes('copd');
      if (!isCopd) return false;
      const userInhalers = p.medications.filter((m) => includesAny(m.name, MAINT_INHALER_NAMES));
      if (userInhalers.length === 0) return false;
      return userInhalers.some((m) => {
        if (!m.rxcui) return false;
        const cov = plan.formulary.get(m.rxcui);
        return cov?.tier != null && cov.tier >= 4;
      });
    },
    message: () =>
      'Maintenance inhaler is Tier 4 on this plan — expect higher copays than tier-3 alternatives.',
  },

  {
    family: 'giveback_trap',
    severity: 'high',
    action: 'flag',
    check: (_p, plan) => {
      // True if the giveback's annual value is less than the plan's
      // annual drug cost relative to the cheapest plan's drug cost.
      // We don't have cross-plan context here, so approximate: a
      // plan with a giveback AND a totalAnnualDrugCost > $1,000
      // is a candidate. The message phrases it as a question —
      // surface, don't disqualify.
      const giveback = plan.score.partBGivebackAnnual ?? 0;
      const drugCost = plan.score.totalAnnualDrugCost ?? 0;
      return giveback > 0 && drugCost > giveback;
    },
    message: (_p, plan) => {
      const monthly = Math.round((plan.score.partBGivebackAnnual ?? 0) / 12);
      return `Plan gives back $${monthly}/mo but your drugs cost $${(plan.score.totalAnnualDrugCost ?? 0).toLocaleString()}/yr on it — check the math vs. cheaper-drug alternatives.`;
    },
  },

  {
    family: 'star_rating',
    severity: 'medium',
    action: 'penalize',
    points: -10,
    check: (_p, plan) => {
      // PmPlanRow doesn't currently expose star_rating uniformly.
      // Until we expose it, this flag is dormant — kept as a stub
      // so the wiring is in place when the data lands. Returns
      // false so it never fires; check is here for shape-stability.
      const rating = (plan.row as { star_rating?: number | null }).star_rating ?? null;
      return rating != null && rating < 3.0;
    },
    message: (_p, plan) => {
      const rating = (plan.row as { star_rating?: number | null }).star_rating ?? null;
      return `Below-average CMS star rating (${rating?.toFixed(1) ?? '?'}/5).`;
    },
  },

  {
    family: 'narrow_network_multi_specialist',
    severity: 'low',
    action: 'penalize',
    points: -5,
    check: (p, plan) => {
      if (p.providerCount < 2) return false;
      const planType = (plan.row.plan_type ?? '').toUpperCase();
      // Strict HMO (without -POS) means no out-of-network fallback.
      return planType.includes('HMO') && !planType.includes('POS') && !planType.includes('PPO');
    },
    message: () =>
      'Strict HMO with multiple specialists — referrals required for each specialist visit.',
  },

  // ── Dual-eligibility red flags ──────────────────────────────────────
  // These two pair up: a dual user gets a positive boost for D-SNP
  // plans and a warn (no points) for standard MAPD. The boost +
  // warn together steer the dual toward the D-SNP without disqualifying
  // the MAPD outright (some duals deliberately stay on MAPD for
  // network reasons — broker call, not a hard exclusion).

  {
    family: 'dual_dsnp_match',
    severity: 'high',
    action: 'penalize',  // negative-conventioned action, positive points = boost
    points: 20,
    check: (p, plan) => {
      if (!p.dualEligible) return false;
      const t = (plan.row.snp_type ?? '').toLowerCase();
      return t.includes('d-snp') || t.includes('dsnp') || t.includes('dual');
    },
    message: () =>
      'Built for dual-eligible beneficiaries — typically $0 premium, $0 drug copays, and lifeline extras (transportation, meals, OTC).',
  },

  {
    family: 'dual_on_mapd',
    severity: 'high',
    action: 'warn',
    check: (p, plan) => {
      if (!p.dualEligible) return false;
      const t = (plan.row.snp_type ?? '').toLowerCase();
      // Fires only on plain MAPD (not D-SNP, not C-SNP). C-SNP can
      // be a reasonable alternative for a dual with a chronic
      // condition and the broker may steer there instead.
      return !t.includes('d-snp') && !t.includes('dsnp') && !t.includes('dual')
        && !t.includes('c-snp') && !t.includes('csnp') && !t.includes('chronic');
    },
    message: () =>
      'You qualify for a Dual Special Needs Plan — a plain MAPD typically costs you premium and copays a D-SNP would waive.',
  },
];

export function evaluateRedFlags(
  profile: ArchetypeProfile,
  archetype: ClientArchetype,
  plan: BrainScoredPlan,
): RedFlagInstance[] {
  const families = new Set(ARCHETYPE_RULES[archetype].redFlagFamilies);
  const out: RedFlagInstance[] = [];
  for (const def of RED_FLAG_DEFS) {
    // Only run flags that this archetype subscribes to. Keeps the
    // diabetic_supplies flag from firing on a healthy newly-eligible
    // user, etc.
    if (!families.has(def.family)) continue;
    if (!def.check(profile, plan)) continue;
    out.push({
      id: def.family,
      severity: def.severity,
      action: def.action,
      message: def.message(profile, plan),
      points: def.points,
    });
  }
  return out;
}
