// Broker decision rules — declarative "if this, then that" overrides
// the brain applies on top of axis scoring.
//
// The axis math (drug + medical + extras) gets you a calculator. These
// rules turn the calculator into a broker — the kind of "I see your
// meds and I know which direction to point you" instinct that comes
// from years of selling Medicare. Each rule is a small, traceable,
// human-readable adjustment with a reason string the consumer can
// eventually read in the "why this plan" copy.
//
// Rules fire AFTER the per-axis composite is computed and BEFORE the
// final sort. Their score adjustments compound (a plan can earn
// multiple boosts or penalties). The applied list is captured on the
// BrainScore so the UI + analytics can show the broker's reasoning
// per plan.

import type { BrainScoredPlan } from './plan-brain-types';
import type { DetectedCondition } from './condition-detector';
import { extractCategoryAnnualValue } from './plan-brain-utils';

export interface ClientProfile {
  age: number | null;
  /** Union of self-reported csnpConditions + detected conditions
   *  (mapped through detectedToCsnp). String keys for matching. */
  conditions: ReadonlySet<string>;
  detectedConditions: ReadonlyArray<DetectedCondition>;
  medications: ReadonlyArray<{ rxcui?: string; name: string }>;
  providerCount: number;
  isHealthyClient: boolean;
}

export interface AppliedRule {
  ruleId: string;
  ruleName: string;
  points: number;
  reason: string;
}

interface BrokerRule {
  id: string;
  name: string;
  condition: (profile: ClientProfile, plan: BrainScoredPlan) => boolean;
  /** Composite-score adjustment. Positive = boost, negative = penalty,
   *  0 = pure flag (carry the reason without changing the score).
   *  Function form for tiered rules whose magnitude depends on plan
   *  data (e.g. moop_penalty: -50 vs -75). Evaluated only after
   *  condition() is true. */
  points: number | ((profile: ClientProfile, plan: BrainScoredPlan) => number);
  /** Human-readable reason. Template variables ({carrier}, {drug},
   *  {moop}, {giveback}) are substituted at fire time using the
   *  resolveReason helper. */
  reason: (profile: ClientProfile, plan: BrainScoredPlan) => string;
}

// ─── Helpers ────────────────────────────────────────────────────────

const INSULIN_NAME_RE =
  /\b(insulin|lantus|basaglar|toujeo|levemir|tresiba|humalog|novolog|fiasp|admelog|apidra|lyumjev|humulin|novolin|afrezza|semglee|rezvoglar)\b/i;

function isCsnp(plan: BrainScoredPlan): boolean {
  const t = (plan.row.snp_type ?? plan.row.plan_type ?? '').toLowerCase();
  return t.includes('c-snp') || t.includes('csnp') || t.includes('chronic');
}

function isPpo(plan: BrainScoredPlan): boolean {
  return /\bppo\b/i.test(plan.row.plan_type ?? '');
}

function hasDiabeticSupplies(plan: BrainScoredPlan): boolean {
  // pbp_benefits stores diabetic supplies under the 'insulin' category
  // (per the existing plan-brain-utils mapping). A row with copay <= 0
  // counts as covered.
  const row = plan.benefits.find((b) => b.benefit_category === 'insulin');
  if (!row) return false;
  return (row.copay ?? 0) === 0 || row.coverage_amount != null;
}

function carrierName(plan: BrainScoredPlan): string {
  return plan.row.carrier ?? plan.row.plan_name ?? 'this plan';
}

function fmtUSD(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

// Per-drug monthly cost using the same formulary-tier path the
// consumer UI uses. Returns 0 for uncovered or zero-cost drugs.
function monthlyCostForRxcui(
  plan: BrainScoredPlan,
  rxcui: string | undefined,
): number {
  if (!rxcui) return 0;
  const cov = plan.formulary.get(rxcui) ?? null;
  if (!cov) return 0;
  if (cov.copay != null && cov.copay > 0) return cov.copay;
  const tierBenefit =
    cov.tier != null
      ? plan.benefits.find((b) => b.benefit_category === `rx_tier_${cov.tier}`) ?? null
      : null;
  if (tierBenefit?.copay != null && tierBenefit.copay > 0) return tierBenefit.copay;
  // Coinsurance estimate via CMS-typical retail per tier.
  const NOTIONAL: Record<number, number> = { 1: 8, 2: 30, 3: 200, 4: 500, 5: 1500 };
  const notional = cov.tier != null ? NOTIONAL[cov.tier] ?? 200 : 200;
  if (cov.coinsurance != null && cov.coinsurance > 0) {
    return Math.round(notional * (cov.coinsurance / 100));
  }
  if (tierBenefit?.coinsurance != null && tierBenefit.coinsurance > 0) {
    return Math.round(notional * (tierBenefit.coinsurance / 100));
  }
  return 0;
}

// "Single cost driver" detector — returns the drug if one med is >= 80%
// of the user's total monthly drug spend on this plan, else null.
function singleCostDriver(
  plan: BrainScoredPlan,
  meds: ClientProfile['medications'],
): { name: string; share: number } | null {
  if (meds.length < 2) return null;
  const costs = meds.map((m) => ({ name: m.name, monthly: monthlyCostForRxcui(plan, m.rxcui) }));
  const total = costs.reduce((s, c) => s + c.monthly, 0);
  if (total <= 0) return null;
  const top = costs.reduce((best, c) => (c.monthly > best.monthly ? c : best), costs[0]);
  const share = top.monthly / total;
  return share >= 0.8 ? { name: top.name, share } : null;
}

// MOOP penalty — smooth sliding scale (Margaret rules R4 + R5).
//
// Anchor: $3,000 MOOP is "safe" (penalty = 0). Above $3,000, every
// $100 of additional exposure costs 1 composite point. Examples:
//   $3,500 → -5      $4,200 → -12      $5,900 → -29
//   $6,500 → -35     $7,900 → -49      $9,000 → -60
//
// Two override layers, applied in order of strength:
//   1. Full cancel — meds at lowest tier AND primary provider in-network
//      (the existing R13 override). Returns 0 outright.
//   2. Halve     — PPO/HMO-POS plan with strong dental (≥ $2k) AND
//      primary provider in-network. Halves the raw penalty.
// If neither override fires, the raw sliding-scale penalty applies.
const MOOP_PENALTY_FLOOR = 3000;
function moopPenaltyPoints(moop: number, halve: boolean): number {
  if (moop <= MOOP_PENALTY_FLOOR) return 0;
  const raw = -((moop - MOOP_PENALTY_FLOOR) / 100);
  return halve ? raw / 2 : raw;
}

function isPpoLike(plan: BrainScoredPlan): boolean {
  // True PPO carries the most flexibility (no referrals, true OON
  // benefit). HMO-POS allows out-of-network point-of-service usage but
  // is structurally HMO; we treat both as eligible for the halving
  // override. Pure HMO returns false.
  const t = plan.row.plan_type ?? '';
  return /\bppo\b/i.test(t) || /\bhmo[-\s]?pos\b/i.test(t);
}

// R5 — PPO halving qualifier. PPO/HMO-POS + dental ≥ $2k + primary
// provider in-network. Used by moopPenaltyPoints to halve (not cancel)
// the sliding penalty when a flexible plan with strong dental still
// has meaningful MOOP exposure.
function qualifiesForPpoHalving(_p: ClientProfile, plan: BrainScoredPlan): boolean {
  if (!isPpoLike(plan)) return false;
  if (!plan.score.primaryProviderInNetwork) return false;
  const dentalAnnual = extractCategoryAnnualValue(plan.benefits, 'dental');
  return dentalAnnual >= 2000;
}

// Lowest tier the plan files in pbp_benefits — usually 1, sometimes 0
// when the plan offers a Select Care preferred-generic tier. Read by
// scanning rx_tier_N benefit categories. Falls back to 1 when the
// plan has no rx_tier rows filed.
function lowestTierOnPlan(plan: BrainScoredPlan): number {
  let lowest: number | null = null;
  for (const b of plan.benefits) {
    const m = /^rx_tier_(\d+)$/.exec(b.benefit_category ?? '');
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    if (lowest == null || n < lowest) lowest = n;
  }
  return lowest ?? 1;
}

// MOOP penalty override: cancels the penalty when BOTH conditions
// hold — every priced med (rxcui-bearing) is on the plan's lowest
// available tier AND the primary provider is in-network. Either
// alone is not enough. With no priced meds, the override does NOT
// apply (nothing to verify against).
function moopPenaltyOverridden(profile: ClientProfile, plan: BrainScoredPlan): boolean {
  if (!plan.score.primaryProviderInNetwork) return false;
  const rxcuis = profile.medications
    .map((m) => m.rxcui)
    .filter((x): x is string => typeof x === 'string' && x.length > 0);
  if (rxcuis.length === 0) return false;
  const lowest = lowestTierOnPlan(plan);
  return rxcuis.every((id) => (plan.formulary.get(id)?.tier ?? null) === lowest);
}

// ─── Rules ──────────────────────────────────────────────────────────

const RULES: BrokerRule[] = [
  // R1 — Diabetic + C-SNP + provider in-network → massive boost
  {
    id: 'diabetic_csnp_match',
    name: 'C-SNP for diagnosed diabetic',
    points: 25,
    condition: (p, plan) =>
      p.conditions.has('diabetes') && isCsnp(plan) && plan.score.allProvidersInNetwork,
    reason: () =>
      'Chronic Special Needs Plan designed for diabetes — typically $0 copays on diabetes meds and built-in care coordination.',
  },

  // R2 — Diabetic with no diabetic-supplies coverage → penalty
  {
    id: 'diabetic_needs_supplies',
    name: 'Diabetic needs supplies coverage',
    points: -15,
    condition: (p, plan) => p.conditions.has('diabetes') && !hasDiabeticSupplies(plan),
    reason: (_p, plan) =>
      `${carrierName(plan)} doesn't cover diabetic supplies (test strips, lancets, monitors) — important if you check your sugar at home.`,
  },

  // R4 — CHF + C-SNP + provider in-network → massive boost
  {
    id: 'chf_csnp_match',
    name: 'C-SNP for CHF patient',
    points: 25,
    condition: (p, plan) =>
      p.conditions.has('cardio') && isCsnp(plan) && plan.score.allProvidersInNetwork,
    reason: () =>
      'Chronic Special Needs Plan designed for heart conditions — care coordination and lower cost-sharing on cardiac meds.',
  },

  // R5 — Single cost driver → flag (no score change, but capture
  // the dominant drug so the UI can mention it). The reason is
  // dynamic per plan because the dominant drug can shift.
  {
    id: 'single_cost_driver',
    name: 'One drug dominates cost',
    points: 0,
    condition: (p, plan) => singleCostDriver(plan, p.medications) != null,
    reason: (p, plan) => {
      const driver = singleCostDriver(plan, p.medications);
      if (!driver) return 'One medication drives most of your drug cost.';
      return `Your ${driver.name} prescription drives most of your drug cost — we optimized for the plan with the best price on it.`;
    },
  },

  // R6 — Healthy client + Part B giveback → boost
  {
    id: 'healthy_giveback',
    name: 'Healthy client gets Part B giveback',
    points: 15,
    condition: (p, plan) => p.isHealthyClient && (plan.score.partBGivebackAnnual ?? 0) > 0,
    reason: (_p, plan) => {
      const monthly = Math.round((plan.score.partBGivebackAnnual ?? 0) / 12);
      return `With minimal medication needs, this plan gives you ${fmtUSD(monthly)}/month back on your Medicare Part B premium.`;
    },
  },

  // R7 — Multiple providers + PPO → small boost
  {
    id: 'multi_specialist_ppo',
    name: 'Multiple providers favor PPO',
    points: 5,
    condition: (p, plan) => p.providerCount >= 2 && isPpo(plan),
    reason: () =>
      'PPO gives you flexibility to see multiple specialists across systems without referrals.',
  },

  // R8 — Newly eligible (65) + strong extras → boost
  {
    id: 'newly_eligible_extras',
    name: 'New to Medicare — extras matter',
    points: 5,
    condition: (p, plan) => p.age === 65 && plan.score.extraBenefitsScore > 80,
    reason: () =>
      "New to Medicare — this plan's extras (OTC card, dental, gym) are the strongest match for what new beneficiaries actually use.",
  },

  // R10 — Insulin user note (informational; no score change since the
  // 2026 IRA $35 cap is universal across Part D plans).
  {
    id: 'insulin_cap_note',
    name: 'Insulin cap reminder',
    points: 0,
    condition: (p) =>
      p.medications.some((m) => INSULIN_NAME_RE.test(m.name ?? '')),
    reason: () =>
      'Your insulin is capped at $35/month under the 2026 IRA cap — same on every Part D plan.',
  },

  // R11 — COPD patient → flag (inhaler costs decide; surface to UI)
  {
    id: 'copd_inhaler_cost',
    name: 'COPD — inhalers drive plan choice',
    points: 0,
    condition: (p) => p.conditions.has('copd'),
    reason: () =>
      'Inhaler costs vary plan to plan — we prioritized plans with the best inhaler tier coverage.',
  },

  // R12 — Low star rating → penalty
  {
    id: 'low_star_warning',
    name: 'Low star rating warning',
    points: -10,
    condition: (_p, plan) => (plan.row.star_rating ?? 5) < 3.0,
    reason: (_p, plan) =>
      `Below-average CMS star rating (${(plan.row.star_rating ?? 0).toFixed(1)}★) — flagged for member-satisfaction concerns.`,
  },

  // R13 — Sliding-scale MOOP penalty (Margaret R4 + R5). Every plan
  // with MOOP above $3,000 gets penalized at 1 composite point per $100
  // of exposure, smooth across the range. Two override layers above
  // that:
  //   * Full cancel — meds on the plan's lowest tier AND primary
  //     provider in-network (legacy R13 override; preserved verbatim).
  //   * Halve      — PPO/HMO-POS plan with dental ≥ $2k AND primary
  //     provider in-network. PPO flexibility + strong dental balances
  //     out a moderate MOOP without zeroing it.
  // The full-cancel path takes precedence over the halve path; if
  // neither fires, the raw sliding penalty applies.
  {
    id: 'moop_penalty',
    name: 'High MOOP exposure',
    points: (p, plan) =>
      moopPenaltyPoints(plan.row.moop ?? 0, qualifiesForPpoHalving(p, plan)),
    condition: (p, plan) => {
      const moop = plan.row.moop ?? 0;
      if (moop <= MOOP_PENALTY_FLOOR) return false;
      // Full-cancel override — when both meds and provider line up,
      // the mid-range MOOP is unlikely to bite. Skip the rule entirely
      // so no penalty AND no reason text appears on the plan.
      if (moopPenaltyOverridden(p, plan)) return false;
      return true;
    },
    reason: (p, plan) => {
      const moop = plan.row.moop ?? 0;
      const halved = qualifiesForPpoHalving(p, plan);
      const raw = -((moop - MOOP_PENALTY_FLOOR) / 100);
      const finalPts = halved ? raw / 2 : raw;
      const exposure = moop - MOOP_PENALTY_FLOOR;
      const base = `Max out-of-pocket of ${fmtUSD(moop)} sits ${fmtUSD(
        exposure,
      )} above the $3,000 floor (${finalPts.toFixed(1)} composite points)`;
      if (halved) {
        return `${base}. PPO flexibility + dental ≥ $2,000 + your doctor in-network halves the penalty — still meaningful, but offset by what the plan gives back.`;
      }
      return `${base}. Manageable in a calm year, painful if utilization spikes.`;
    },
  },
];

export function applyBrokerRules(
  profile: ClientProfile,
  plan: BrainScoredPlan,
): { adjustment: number; applied: AppliedRule[] } {
  let adjustment = 0;
  const applied: AppliedRule[] = [];
  for (const rule of RULES) {
    let fired = false;
    try {
      fired = rule.condition(profile, plan);
    } catch {
      // Defensive: a rule should never crash the brain. Skip on error.
      continue;
    }
    if (!fired) continue;
    let reasonText: string;
    try {
      reasonText = rule.reason(profile, plan);
    } catch {
      reasonText = rule.name;
    }
    let resolvedPoints: number;
    try {
      resolvedPoints =
        typeof rule.points === 'function' ? rule.points(profile, plan) : rule.points;
    } catch {
      // Defensive: a tiered-rule points fn that throws falls back to 0
      // (pure flag) rather than poisoning the composite.
      resolvedPoints = 0;
    }
    adjustment += resolvedPoints;
    applied.push({
      ruleId: rule.id,
      ruleName: rule.name,
      points: resolvedPoints,
      reason: reasonText,
    });
  }
  return { adjustment, applied };
}

// Pick the strongest applied rule by absolute score impact, ties
// broken by negative-first (warnings beat boosts when surfacing one
// reason — the consumer should see the red flag, not a lukewarm boost).
export function strongestRule(applied: ReadonlyArray<AppliedRule>): AppliedRule | null {
  if (applied.length === 0) return null;
  return [...applied].sort((a, b) => {
    const absDiff = Math.abs(b.points) - Math.abs(a.points);
    if (absDiff !== 0) return absDiff;
    return a.points - b.points; // negative first on tie
  })[0];
}

// Total list of rule ids (for telemetry / analytics).
export function ruleIds(applied: ReadonlyArray<AppliedRule>): string[] {
  return applied.map((r) => r.ruleId);
}
