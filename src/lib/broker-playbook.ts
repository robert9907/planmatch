// broker-playbook — the broker's mental model expressed as code:
//
//   1. Medication-pattern detection — escalation/combination signatures
//      that go beyond "client has condition X". A diabetic on metformin
//      alone is a different broker quote than the same diabetic three
//      escalations deep on insulin.
//
//   2. Client archetype classification — categorical labels (healthy
//      newly eligible, single chronic, multi chronic, complex
//      polypharmacy, insulin-dependent, specialty drug, provider-locked)
//      that drive the weight profile. Replaces the old hardcoded
//      50/30/20 weights from plan-brain-weights.
//
//   3. Red-flag engine — severe per-plan signals that can DISQUALIFY a
//      plan outright (all-providers-out, cost-driver-not-on-formulary)
//      or surface a CRITICAL warning the broker cannot ignore. Distinct
//      from the +/− broker-rules layer (those are score adjustments
//      with reasons; red flags can outright remove plans from the pool
//      or override the ranking).

import type { Plan } from '@/types/plans';
import type { Medication, Provider } from '@/types/session';
import type { Condition, DetectedCondition } from './condition-detector';
import type { ScoredPlan, WeightProfile } from './plan-brain-types';

// ─── Medication patterns ──────────────────────────────────────────────

export type MedicationPatternId =
  | 'diabetes_escalation'
  | 'cardiac_cascade'
  | 'respiratory_burden'
  | 'statin_bp_combo'
  | 'pain_complexity';

export interface MedicationPattern {
  id: MedicationPatternId;
  /** Severity tag. Each pattern has its own severity vocabulary; the
   *  UI just renders the string. */
  severity: string;
  /** Drugs that triggered the pattern, in input order. */
  meds: string[];
  /** Broker-voice one-liner summarizing the pattern + severity. */
  summary: string;
}

const MED_RX = {
  metformin: /\bmetformin\b|\bglucophage\b/i,
  glp1: /\bozempic\b|\bsemaglutide\b|\brybelsus\b|\bmounjaro\b|\btirzepatide\b|\btrulicity\b|\bdulaglutide\b|\bvictoza\b|\bliraglutide\b|\bwegovy\b|\bzepbound\b/i,
  sglt2: /\bjardiance\b|\bempagliflozin\b|\bfarxiga\b|\bdapagliflozin\b|\binvokana\b|\bcanagliflozin\b|\bsteglatro\b|\bertugliflozin\b/i,
  insulin: /\binsulin\b|\bhumalog\b|\bnovolog\b|\blantus\b|\blevemir\b|\btresiba\b|\btoujeo\b|\bbasaglar\b|\bhumulin\b|\bnovolin\b|\bfiasp\b|\blyumjev\b/i,
  entresto: /\bentresto\b|\bsacubitril\b/i,
  betaBlocker: /\bcarvedilol\b|\bmetoprolol\b|\batenolol\b|\bbisoprolol\b|\bnebivolol\b|\bcoreg\b|\btoprol\b/i,
  aceArb: /\blisinopril\b|\benalapril\b|\bramipril\b|\blosartan\b|\bvalsartan\b|\birbesartan\b|\bolmesartan\b|\btelmisartan\b|\bcandesartan\b/i,
  diuretic: /\bfurosemide\b|\blasix\b|\btorsemide\b|\bbumetanide\b|\bspironolactone\b|\beplerenone\b|\bhydrochlorothiazide\b|\bhctz\b/i,
  icsLaba: /\btrelegy\b|\bbreo\b|\bsymbicort\b|\badvair\b|\bdulera\b|\bwixela\b|\bairsupra\b|\bbreyna\b/i,
  lama: /\bspiriva\b|\btiotropium\b|\bincruse\b|\bumeclidinium\b|\btudorza\b|\baclidinium\b/i,
  statin: /\batorvastatin\b|\bsimvastatin\b|\brosuvastatin\b|\bpravastatin\b|\blovastatin\b|\bpitavastatin\b|\blipitor\b|\bcrestor\b|\bzocor\b/i,
  bpCombo: /\blisinopril\b|\blosartan\b|\bvalsartan\b|\bamlodipine\b|\bhydrochlorothiazide\b|\bhctz\b|\benalapril\b|\bramipril\b|\bolmesartan\b|\btelmisartan\b|\bnorvasc\b/i,
  gabapentinoid: /\bgabapentin\b|\bneurontin\b|\bpregabalin\b|\blyrica\b/i,
  duloxetineSnri: /\bduloxetine\b|\bcymbalta\b|\bvenlafaxine\b|\beffexor\b|\bmilnacipran\b|\bsavella\b/i,
};

function matchedMeds(meds: { name: string }[], rx: RegExp): string[] {
  return meds.filter((m) => rx.test(m.name)).map((m) => m.name);
}

export function detectMedicationPatterns(meds: { name: string }[]): MedicationPattern[] {
  const out: MedicationPattern[] = [];

  // ── Diabetes escalation ladder ──
  const dmHits = {
    metformin: matchedMeds(meds, MED_RX.metformin),
    glp1: matchedMeds(meds, MED_RX.glp1),
    sglt2: matchedMeds(meds, MED_RX.sglt2),
    insulin: matchedMeds(meds, MED_RX.insulin),
  };
  const ladderRungs =
    (dmHits.metformin.length > 0 ? 1 : 0) +
    (dmHits.glp1.length > 0 ? 1 : 0) +
    (dmHits.sglt2.length > 0 ? 1 : 0) +
    (dmHits.insulin.length > 0 ? 1 : 0);
  if (ladderRungs >= 1 && (dmHits.glp1.length > 0 || dmHits.sglt2.length > 0 || dmHits.insulin.length > 0 || dmHits.metformin.length > 0)) {
    let severity: 'moderate' | 'aggressive' | 'insulin_dependent' = 'moderate';
    if (dmHits.insulin.length > 0) severity = 'insulin_dependent';
    else if (ladderRungs >= 3) severity = 'aggressive';
    else if (ladderRungs === 2) severity = 'moderate';
    else severity = 'moderate';
    const allMeds = [...dmHits.metformin, ...dmHits.glp1, ...dmHits.sglt2, ...dmHits.insulin];
    out.push({
      id: 'diabetes_escalation',
      severity,
      meds: allMeds,
      summary:
        severity === 'insulin_dependent'
          ? `Diabetes escalation: insulin-dependent — IRA $35/mo cap is the headline savings`
          : severity === 'aggressive'
            ? `Diabetes escalation: aggressive (${ladderRungs} drug classes) — A1c likely uncontrolled`
            : `Diabetes escalation: moderate (${allMeds.join(' + ')})`,
    });
  }

  // ── Cardiac cascade ──
  const entresto = matchedMeds(meds, MED_RX.entresto);
  const beta = matchedMeds(meds, MED_RX.betaBlocker);
  const ace = matchedMeds(meds, MED_RX.aceArb);
  const diur = matchedMeds(meds, MED_RX.diuretic);
  if (entresto.length > 0) {
    out.push({
      id: 'cardiac_cascade',
      severity: 'confirmed',
      meds: [...entresto, ...beta, ...ace, ...diur],
      summary: 'Cardiac cascade: CHF confirmed (Entresto) — MOOP and inpatient day-1 are decision-critical',
    });
  } else if (beta.length > 0 && ace.length > 0 && diur.length > 0) {
    out.push({
      id: 'cardiac_cascade',
      severity: 'likely',
      meds: [...beta, ...ace, ...diur],
      summary: 'Cardiac cascade: CHF likely (β-blocker + ACE/ARB + diuretic) — verify with the client',
    });
  }

  // ── Respiratory burden ──
  const icsLaba = matchedMeds(meds, MED_RX.icsLaba);
  const lama = matchedMeds(meds, MED_RX.lama);
  if (icsLaba.length > 0 && lama.length > 0) {
    out.push({
      id: 'respiratory_burden',
      severity: 'severe',
      meds: [...icsLaba, ...lama],
      summary: 'Respiratory burden: severe COPD (ICS/LABA + LAMA) — inhaler tier placement decides the plan',
    });
  }

  // ── Statin + BP combo (CV prevention, no chronic disease implied) ──
  const statin = matchedMeds(meds, MED_RX.statin);
  const bp = matchedMeds(meds, MED_RX.bpCombo);
  // Only fire when the meds list is small (≤4) — large polypharmacy
  // overrides this signal because it's no longer "just CV prevention".
  if (statin.length > 0 && bp.length > 0 && meds.length <= 4) {
    out.push({
      id: 'statin_bp_combo',
      severity: 'cv_prevention',
      meds: [...statin, ...bp],
      summary: 'Statin + BP: CV prevention regimen — tier-1 generics, focus on MOOP and extras, not Rx',
    });
  }

  // ── Pain complexity ──
  const gaba = matchedMeds(meds, MED_RX.gabapentinoid);
  const dlx = matchedMeds(meds, MED_RX.duloxetineSnri);
  if (gaba.length > 0 && dlx.length > 0) {
    out.push({
      id: 'pain_complexity',
      severity: 'chronic_pain',
      meds: [...gaba, ...dlx],
      summary: 'Pain complexity: chronic pain (gabapentinoid + SNRI) — specialist + PT visits are the cost driver',
    });
  }

  return out;
}

// ─── Archetypes ───────────────────────────────────────────────────────

export type Archetype =
  | 'healthy_newly_eligible'
  | 'healthy_established'
  | 'single_chronic'
  | 'multi_chronic'
  | 'complex_polypharmacy'
  | 'insulin_dependent'
  | 'specialty_drug'
  | 'provider_locked';

export interface ArchetypeMatch {
  archetype: Archetype;
  weights: WeightProfile;
  preferences: { preferCsnp: boolean; preferPpo: boolean };
  /** Two-word UI label (e.g. "Single Chronic"). */
  label: string;
  /** One-line broker-voice description for the badge tooltip. */
  description: string;
}

interface ClassifyArgs {
  age: number | null;
  conditions: DetectedCondition[];
  conditionSet: Set<Condition>;
  medications: Medication[];
  providers: Provider[];
  /** True when any med matches the insulin pattern. */
  isInsulinUser: boolean;
  /** True when any med has a tier 5 row in pm_formulary for the
   *  client's contracted plan list. Caller computes this — the
   *  playbook doesn't have access to formulary rows. */
  hasSpecialtyDrug: boolean;
}

const HEALTHY_NEWLY_ELIGIBLE: Omit<ArchetypeMatch, 'archetype'> = {
  weights: { drug: 0.15, oop: 0.25, extras: 0.60 },
  preferences: { preferCsnp: false, preferPpo: false },
  label: 'Healthy · Newly Eligible',
  description: 'Age 65, low Rx burden — extras (dental/OTC/fitness) drive the value calculation',
};
const HEALTHY_ESTABLISHED: Omit<ArchetypeMatch, 'archetype'> = {
  weights: { drug: 0.20, oop: 0.30, extras: 0.50 },
  preferences: { preferCsnp: false, preferPpo: false },
  label: 'Healthy · Established',
  description: 'Older but still low-utilization — extras still dominate, MOOP secondary',
};
const SINGLE_CHRONIC: Omit<ArchetypeMatch, 'archetype'> = {
  weights: { drug: 0.40, oop: 0.40, extras: 0.20 },
  preferences: { preferCsnp: true, preferPpo: false },
  label: 'Single Chronic',
  description: 'One chronic condition — balanced Rx + OOP, C-SNP preferred when in-network',
};
const MULTI_CHRONIC: Omit<ArchetypeMatch, 'archetype'> = {
  weights: { drug: 0.35, oop: 0.50, extras: 0.15 },
  preferences: { preferCsnp: false, preferPpo: false },
  label: 'Multi-Chronic',
  description: 'Two+ chronic conditions — MOOP is king, hospital risk doubles the math',
};
const COMPLEX_POLYPHARMACY: Omit<ArchetypeMatch, 'archetype'> = {
  weights: { drug: 0.60, oop: 0.30, extras: 0.10 },
  preferences: { preferCsnp: false, preferPpo: false },
  label: 'Complex Polypharmacy',
  description: '5+ medications — Rx tiering and donut-hole math dominate; verify formulary on every drug',
};
const INSULIN_DEPENDENT: Omit<ArchetypeMatch, 'archetype'> = {
  weights: { drug: 0.55, oop: 0.30, extras: 0.15 },
  preferences: { preferCsnp: true, preferPpo: false },
  label: 'Insulin-Dependent',
  description: 'On insulin — IRA $35/mo cap is mandatory, all Part D plans must comply',
};
const SPECIALTY_DRUG: Omit<ArchetypeMatch, 'archetype'> = {
  weights: { drug: 0.70, oop: 0.20, extras: 0.10 },
  preferences: { preferCsnp: false, preferPpo: false },
  label: 'Specialty Drug',
  description: 'Tier 5 specialty — drug coverage is the only axis that matters; verify PA/ST/quantity limits',
};
const PROVIDER_LOCKED: Omit<ArchetypeMatch, 'archetype'> = {
  weights: { drug: 0.30, oop: 0.40, extras: 0.30 },
  preferences: { preferCsnp: false, preferPpo: true },
  label: 'Provider-Locked',
  description: '2+ specific providers — PPO flexibility is worth the premium bump; verify network on every plan',
};

/**
 * Classify the client into ONE primary archetype. Priority order
 * (most-specific first):
 *   specialty_drug → insulin_dependent → complex_polypharmacy →
 *   provider_locked → multi_chronic → single_chronic →
 *   healthy_newly_eligible (age 65) → healthy_established (66-74).
 *
 * Provider-locked sits in the middle because two providers + complex
 * meds means the polypharmacy classification is more decision-relevant
 * than the network preference (which is a soft +5 in broker-rules).
 */
export function classifyArchetype(args: ClassifyArgs): ArchetypeMatch {
  const { age, conditionSet, medications, providers, isInsulinUser, hasSpecialtyDrug } = args;
  const certainOrLikely = args.conditions.filter((d) => d.confidence !== 'possible').length;

  if (hasSpecialtyDrug) return { archetype: 'specialty_drug', ...SPECIALTY_DRUG };
  if (isInsulinUser) return { archetype: 'insulin_dependent', ...INSULIN_DEPENDENT };
  if (medications.length >= 5) return { archetype: 'complex_polypharmacy', ...COMPLEX_POLYPHARMACY };
  if (providers.length >= 2 && conditionSet.size <= 1) {
    return { archetype: 'provider_locked', ...PROVIDER_LOCKED };
  }
  if (certainOrLikely >= 2) return { archetype: 'multi_chronic', ...MULTI_CHRONIC };
  if (certainOrLikely >= 1) return { archetype: 'single_chronic', ...SINGLE_CHRONIC };
  if (age != null && age <= 65) return { archetype: 'healthy_newly_eligible', ...HEALTHY_NEWLY_ELIGIBLE };
  return { archetype: 'healthy_established', ...HEALTHY_ESTABLISHED };
}

// ─── Red-flag engine ──────────────────────────────────────────────────

export type RedFlagSeverity = 'critical' | 'penalty' | 'flag' | 'disqualify';

export interface RedFlag {
  id: string;
  severity: RedFlagSeverity;
  message: string;
  /** Composite-score adjustment (negative for penalty, 0 otherwise).
   *  Disqualify rules don't move the score — they remove the plan
   *  from the eligible pool entirely. */
  pointsAdjustment: number;
  /** True when this flag should remove the plan from the final
   *  ranking (e.g. all providers out-of-network). */
  disqualify: boolean;
}

interface RedFlagContext {
  hasChronicCondition: boolean;
  isInsulinUser: boolean;
  /** Names of medications whose annual cost is ≥80% of total Rx cost.
   *  Caller derives this from the per-rxcui drug-cost map. */
  costDriverRxcuis: string[];
  /** True when the cost-driver drug has NO formulary row on this
   *  plan. Caller threads this in. */
  costDriverNotOnFormulary: boolean;
  /** Net giveback delta — positive when this plan's giveback exceeds
   *  the cheapest non-giveback alternative's drug-cost differential.
   *  Negative means the giveback is a "trap" (saving $30/mo on premium
   *  costs the client $50/mo more in drugs). */
  givebackTrapDelta: number;
}

/**
 * Detect red flags for one (plan, scoredPlan) pair. Severity drives UI:
 *   critical    — show ⚠ banner, broker should think twice
 *   penalty     — score adjustment, surfaced in tooltip
 *   flag        — informational, no score change
 *   disqualify  — remove from ranking
 */
export function detectRedFlags(
  plan: Plan,
  scored: ScoredPlan,
  ctx: RedFlagContext,
): RedFlag[] {
  const out: RedFlag[] = [];

  // 1. Chronic condition + MOOP at CMS regulatory ceiling. The
  // broker-rules layer already penalizes -25; the red-flag engine
  // surfaces the same signal as a CRITICAL warning so the UI shows a
  // banner the broker can't miss. Both can fire — they live in
  // different layers (rules adjust composite, flags drive UI).
  if (ctx.hasChronicCondition && (plan.moop_in_network ?? 0) >= 7550) {
    out.push({
      id: 'chronic_at_moop_ceiling',
      severity: 'critical',
      message: `MOOP $${(plan.moop_in_network ?? 0).toLocaleString()} is at the CMS regulatory ceiling — chronic-condition clients hit MOOP fast`,
      pointsAdjustment: 0, // already penalized in broker-rules
      disqualify: false,
    });
  }

  // 2. Insulin user without $35 cap. After the IRA, every Part D plan
  // is required to honor $35/mo for insulin — but if our drug-cost
  // engine sees a higher figure (data lag, preferred/non-preferred
  // mismatch), penalize so the broker investigates.
  if (ctx.isInsulinUser) {
    // Caller-side note: scored.totalAnnualDrugCost / 12 / numInsulins
    // > 35 would indicate a violation. We rely on the broker-rules
    // "insulin_with_cap" boost firing as an "OK signal"; absence isn't
    // a red flag by itself, so we DON'T fire here unless we have
    // explicit evidence of a violation. Keeps false positives down.
  }

  // 3. All providers out of network → DISQUALIFY. The plan is
  // unusable for this client; remove it entirely so the broker
  // doesn't waste airtime explaining why "this $0 premium plan"
  // isn't viable.
  if (scored.providerNetworkStatus === 'all_out') {
    out.push({
      id: 'all_providers_out',
      severity: 'disqualify',
      message: 'Every listed provider is out-of-network on this plan',
      pointsAdjustment: 0,
      disqualify: true,
    });
  }

  // 4. Cost-driver drug not on formulary. If the drug that accounts
  // for ≥80% of the client's annual Rx cost has no formulary row,
  // every other consideration is moot — this plan won't cover the
  // drug at all, the client will pay full cash.
  if (ctx.costDriverRxcuis.length > 0 && ctx.costDriverNotOnFormulary) {
    out.push({
      id: 'cost_driver_off_formulary',
      severity: 'penalty',
      message: `Cost-driver drug not on this plan's formulary — client pays full cash for ≥80% of Rx spend`,
      pointsAdjustment: -25,
      disqualify: false,
    });
  }

  // 5. Giveback trap. Plan offers a Part B giveback but the cheaper
  // premium is offset by higher drug costs vs alternatives. Surface
  // as FLAG (no score change) because the broker should explain the
  // tradeoff rather than the engine silently demoting it.
  if ((plan.part_b_giveback ?? 0) > 0 && ctx.givebackTrapDelta < 0) {
    out.push({
      id: 'giveback_trap',
      severity: 'flag',
      message: `Part B giveback (-$${plan.part_b_giveback}/mo) is offset by $${Math.abs(ctx.givebackTrapDelta)}/yr higher drug costs vs alternatives`,
      pointsAdjustment: 0,
      disqualify: false,
    });
  }

  return out;
}

// ─── Why-switch copy generation ───────────────────────────────────────

export interface WhySwitchInputs {
  archetype: Archetype;
  /** Annual savings vs the baseline column ($/yr; positive = saves). */
  savings: number | null;
  /** Plan being described (the alternative, not the baseline). */
  plan: Plan;
  scored: ScoredPlan;
}

/**
 * Archetype-specific copy for the "Why switch?" row. Falls back to a
 * generic savings line when nothing archetype-specific applies.
 *
 * The broker's voice changes by archetype:
 *   healthy_*           — lead with extras dollar value
 *   single_chronic      — lead with MOOP + provider fit
 *   multi_chronic       — lead with MOOP, then provider
 *   complex_polypharmacy — lead with Rx coverage breadth
 *   insulin_dependent   — confirm $35 cap, then savings
 *   specialty_drug      — confirm formulary tier, then PA/ST status
 *   provider_locked     — lead with network fit
 */
export function whySwitchCopy(input: WhySwitchInputs): string {
  const { archetype, savings, plan, scored } = input;

  const savingsBit = savings != null && savings > 50
    ? `Saves $${Math.round(savings).toLocaleString()}/yr`
    : savings != null && savings < -50
      ? `Costs $${Math.round(-savings).toLocaleString()} more/yr`
      : null;

  const networkBit = scored.providerNetworkStatus === 'all_in' ? 'all docs in-network' : null;
  const moopBit = `$${plan.moop_in_network.toLocaleString()} MOOP`;

  switch (archetype) {
    case 'healthy_newly_eligible':
    case 'healthy_established': {
      const extras: string[] = [];
      if (plan.benefits.dental.annual_max > 1000) extras.push(`$${plan.benefits.dental.annual_max} dental`);
      if (plan.benefits.otc.allowance_per_quarter > 0) extras.push(`$${plan.benefits.otc.allowance_per_quarter * 4}/yr OTC`);
      if (plan.benefits.food_card.allowance_per_month > 0) extras.push(`$${plan.benefits.food_card.allowance_per_month * 12}/yr food`);
      if ((plan.part_b_giveback ?? 0) > 0) extras.push(`$${plan.part_b_giveback}/mo giveback`);
      const lead = extras.slice(0, 2).join(' · ') || 'standard extras';
      return [savingsBit, lead].filter(Boolean).join(' · ');
    }
    case 'single_chronic':
    case 'multi_chronic': {
      return [savingsBit, moopBit, networkBit].filter(Boolean).join(' · ');
    }
    case 'complex_polypharmacy': {
      const uncov = scored.uncoveredDrugRxcuis.length;
      const rxBit = uncov > 0 ? `${uncov} uncovered drug${uncov > 1 ? 's' : ''}` : 'all meds covered';
      return [savingsBit, rxBit, moopBit].filter(Boolean).join(' · ');
    }
    case 'insulin_dependent': {
      return [savingsBit, '$35/mo insulin cap', networkBit].filter(Boolean).join(' · ');
    }
    case 'specialty_drug': {
      return [savingsBit, 'verify Tier 5 PA/ST', moopBit].filter(Boolean).join(' · ');
    }
    case 'provider_locked': {
      const ppoBit = /\bPPO\b/i.test(plan.plan_name) ? 'PPO flexibility' : null;
      return [networkBit, ppoBit, savingsBit].filter(Boolean).join(' · ');
    }
  }
}
