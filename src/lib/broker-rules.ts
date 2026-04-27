// broker-rules — 12 rules a human Medicare broker would apply on top
// of the raw composite score. Run AFTER axis scoring + provider boost,
// BEFORE final ranking. Each rule sees one plan + one client profile
// and returns a score adjustment + a human-readable reason.
//
// The rules encode broker judgment that pure cost math misses:
//   • a C-SNP is the right answer for a diabetic if their PCP is in-
//     network, even if a cheaper MAPD scores higher on the OOP axis
//   • a CHF patient should never land on a $9k MOOP plan, period
//   • a healthy client with a Part B giveback walks away with cash
//
// Each rule has:
//   id            — stable identifier (UI uses this to format reasons)
//   action        — 'boost' (+points) | 'penalize' (-points) | 'flag'
//   points        — composite-score adjustment (flags don't move score)
//   reason        — broker-voice one-liner shown under "Why switch?"
//   match         — pure predicate; given (plan, profile, ctx) → bool
//
// flags surface in UI but don't change ranking. Rule 5 (single cost
// driver) and Rule 11 (COPD inhaler) are flags, not boosts.

import type { Plan } from '@/types/plans';
import type { Medication, Provider } from '@/types/session';
import type { BenefitRow, ScoredPlan } from './plan-brain-types';
import type { Condition, DetectedCondition } from './condition-detector';

export type RuleAction = 'boost' | 'penalize' | 'flag';

export interface ClientProfile {
  age: number | null;
  conditions: DetectedCondition[];
  conditionSet: Set<Condition>;
  hasChronicCondition: boolean;
  medications: Medication[];
  providers: Provider[];
  isHealthyClient: boolean;
  isInsulinUser: boolean;
  isNewlyEligible: boolean; // 64–66 — initial-enrollment / first-IEP window
}

// What the rules need beyond the ScoredPlan itself. Threaded through
// runPlanBrain so the rules can inspect benefit rows and per-med drug
// costs without re-fetching anything.
export interface RuleContext {
  benefits: BenefitRow[];
  // Per-plan per-medication annual drug cost in dollars, keyed by
  // rxcui. plan-brain populates this from its own drug-cost loop.
  drugCostByRxcui: Record<string, number>;
}

export interface RuleApplication {
  ruleId: string;
  action: RuleAction;
  points: number; // 0 for flags
  reason: string;
}

interface Rule {
  id: string;
  action: RuleAction;
  points: number;
  reason: string;
  match: (plan: Plan, profile: ClientProfile, ctx: RuleContext, scored: ScoredPlan) => boolean;
}

// ─── Helpers ───────────────────────────────────────────────────────

function isCSNP(plan: Plan): boolean {
  const blob = `${plan.plan_name ?? ''} ${plan.plan_type ?? ''}`.toUpperCase();
  return /\bC-?SNP\b/.test(blob);
}

function isPPO(plan: Plan): boolean {
  const blob = `${plan.plan_name ?? ''}`.toUpperCase();
  return /\bPPO\b/.test(blob);
}

function hasDiabeticSupplies(rows: BenefitRow[]): boolean {
  // pbp_benefits.benefit_type='diabetic_supplies' (or 'diabetes_supplies')
  // is what the medicare.gov scraper emits when the plan files the
  // benefit. Absence = not coverable → -15 penalty.
  return rows.some(
    (r) =>
      /diabet.*suppl/i.test(r.benefit_type) &&
      (r.copay != null || r.coinsurance != null || (r.description ?? '').length > 0),
  );
}

// ─── Rules ─────────────────────────────────────────────────────────

const RULES: Rule[] = [
  {
    id: 'diabetic_csnp_in_network',
    action: 'boost',
    points: 25,
    reason: 'Diabetes-focused C-SNP with PCP in-network — designed for this client',
    match: (plan, profile, _ctx, scored) =>
      profile.conditionSet.has('diabetes') &&
      isCSNP(plan) &&
      scored.providerNetworkStatus === 'all_in',
  },
  {
    id: 'diabetic_no_supplies',
    action: 'penalize',
    points: 15,
    reason: 'No diabetic-supplies coverage — strips, monitors, lancets billed under Part B only',
    match: (_plan, profile, ctx) =>
      profile.conditionSet.has('diabetes') && !hasDiabeticSupplies(ctx.benefits),
  },
  {
    id: 'chf_high_moop',
    action: 'penalize',
    points: 20,
    reason: 'CHF patient on a $5K+ MOOP plan — readmissions hit MOOP fast',
    match: (plan, profile) =>
      profile.conditionSet.has('chf') && (plan.moop_in_network ?? 0) > 5000,
  },
  {
    id: 'chf_csnp_in_network',
    action: 'boost',
    points: 25,
    reason: 'Cardiology C-SNP with PCP in-network — built for CHF management',
    match: (plan, profile, _ctx, scored) =>
      profile.conditionSet.has('chf') &&
      isCSNP(plan) &&
      scored.providerNetworkStatus === 'all_in',
  },
  {
    id: 'single_cost_driver',
    action: 'flag',
    points: 0,
    reason: 'One drug drives 80%+ of annual Rx cost — formulary placement is the decider',
    match: (_plan, _profile, ctx) => {
      const costs = Object.values(ctx.drugCostByRxcui).filter((v) => v > 0);
      if (costs.length < 2) return false;
      const total = costs.reduce((a, b) => a + b, 0);
      if (total <= 0) return false;
      const max = Math.max(...costs);
      return max / total >= 0.8;
    },
  },
  {
    id: 'healthy_giveback',
    action: 'boost',
    points: 15,
    reason: 'Healthy client + Part B giveback — cash back to Social Security check',
    match: (plan, profile) =>
      profile.isHealthyClient && (plan.part_b_giveback ?? 0) > 0,
  },
  {
    id: 'multi_specialist_ppo',
    action: 'boost',
    points: 5,
    reason: 'Multiple specialists + PPO — flexibility worth a small premium bump',
    match: (plan, profile) => profile.providers.length >= 2 && isPPO(plan),
  },
  {
    id: 'newly_eligible_strong_extras',
    action: 'boost',
    points: 5,
    reason: 'Newly eligible + strong extras — plan ages well as needs grow',
    match: (_plan, profile, _ctx, scored) =>
      profile.isNewlyEligible && scored.extrasScore >= 75,
  },
  {
    id: 'chronic_at_moop_ceiling',
    action: 'penalize',
    points: 25,
    reason: 'RED FLAG — chronic condition + MOOP at the CMS regulatory ceiling',
    match: (plan, profile) =>
      profile.hasChronicCondition && (plan.moop_in_network ?? 0) >= 7550,
  },
  {
    id: 'insulin_with_cap',
    action: 'boost',
    points: 10,
    reason: 'Insulin user — IRA $35/mo cap applies; predictable monthly cost',
    match: (_plan, profile) => profile.isInsulinUser,
  },
  {
    id: 'copd_inhaler_decider',
    action: 'flag',
    points: 0,
    reason: 'COPD patient — inhaler tier placement is the cost decider, verify before quoting',
    match: (_plan, profile) => profile.conditionSet.has('copd'),
  },
  {
    id: 'low_star_rating',
    action: 'penalize',
    points: 10,
    reason: 'Star rating below 3.0 — CMS underperformer, expect call-center pain',
    match: (plan) => (plan.star_rating ?? 5) < 3.0 && (plan.star_rating ?? 0) > 0,
  },
];

export function applyBrokerRules(
  plan: Plan,
  scored: ScoredPlan,
  profile: ClientProfile,
  ctx: RuleContext,
): RuleApplication[] {
  const out: RuleApplication[] = [];
  for (const rule of RULES) {
    if (rule.match(plan, profile, ctx, scored)) {
      out.push({ ruleId: rule.id, action: rule.action, points: rule.points, reason: rule.reason });
    }
  }
  return out;
}

// Net composite delta (sum of boost points minus penalize points,
// flags excluded). Useful for the UI to display a single ± number.
export function netRulePoints(applied: RuleApplication[]): number {
  let net = 0;
  for (const r of applied) {
    if (r.action === 'boost') net += r.points;
    else if (r.action === 'penalize') net -= r.points;
  }
  return net;
}

// True when at least one penalize rule of significant magnitude (>=25)
// fires. Drives the warning icon in QuoteDeliveryV4.
export function hasRedFlag(applied: RuleApplication[]): boolean {
  return applied.some((r) => r.action === 'penalize' && r.points >= 25);
}

// Convenience: pull the leading rule reason for the "Why switch?" row.
// Prefer boosts (positive framing) over penalties; among same-action
// rules, prefer higher points.
export function leadingReason(applied: RuleApplication[]): string | null {
  if (applied.length === 0) return null;
  const sorted = [...applied].sort((a, b) => {
    const order: Record<RuleAction, number> = { boost: 0, flag: 1, penalize: 2 };
    if (order[a.action] !== order[b.action]) return order[a.action] - order[b.action];
    return b.points - a.points;
  });
  return sorted[0].reason;
}
