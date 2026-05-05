// broker-rules — rules a human Medicare broker would apply on top of
// the raw composite score. Run AFTER axis scoring + provider boost,
// BEFORE final ranking. Each rule sees one plan + one client profile
// and returns a score adjustment + a human-readable reason.
//
// The rules encode broker judgment that pure cost math misses:
//   • a C-SNP is the right answer for a diabetic if their PCP is in-
//     network, even if a cheaper MAPD scores higher on the OOP axis
//   • any plan with a $5K+ MOOP is exposed; tiered penalty applies,
//     unless every med is on the plan's lowest tier AND the primary
//     provider is in-network
//   • a healthy client with a Part B giveback walks away with cash
//
// Each rule has:
//   id            — stable identifier (UI uses this to format reasons)
//   action        — 'boost' (+points) | 'penalize' (-points) | 'flag'
//   points        — composite-score adjustment (flags don't move score);
//                   may be a fn(plan, profile, ctx, scored) for tiered rules
//   reason        — broker-voice one-liner shown under "Why switch?";
//                   may be a fn(...) when the wording depends on the bracket
//   match         — pure predicate; given (plan, profile, ctx) → bool
//
// Flags surface in UI but don't change ranking. single_cost_driver
// and copd_inhaler_decider are flags, not boosts.

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
  // Per-plan per-medication formulary tier, keyed by rxcui. Missing
  // entry = med wasn't placed on a tier (off-formulary or unpriced).
  tierByRxcui: Record<string, number>;
  // Lowest tier number the plan files in pbp_benefits (typically 1,
  // 0 when the plan has a Select Care preferred-generic tier).
  lowestTierOnPlan: number;
  // True when the client's primary provider (first in the providers
  // array) is confirmed in-network on this plan.
  primaryProviderInNetwork: boolean;
}

export interface RuleApplication {
  ruleId: string;
  action: RuleAction;
  points: number; // 0 for flags
  reason: string;
}

type RuleArgs = [Plan, ClientProfile, RuleContext, ScoredPlan];

interface Rule {
  id: string;
  action: RuleAction;
  // Static when the magnitude is the same every time the rule fires;
  // function when a single rule covers tiered brackets (e.g. MOOP
  // penalty). The function form is evaluated only after match() is true.
  points: number | ((...args: RuleArgs) => number);
  reason: string | ((...args: RuleArgs) => string);
  match: (...args: RuleArgs) => boolean;
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

// MOOP penalty: $5,001–$6,500 → -50, $6,501+ → -75. Returns 0 below
// the threshold, including the boundary at exactly $5,000.
function moopPenaltyPoints(moop: number): number {
  if (moop <= 5000) return 0;
  if (moop <= 6500) return 50;
  return 75;
}

// Override: cancels the MOOP penalty when BOTH (a) every priced
// medication landed on the plan's lowest-cost tier AND (b) the
// client's primary provider is in-network. Either alone is not enough.
function moopPenaltyOverridden(profile: ClientProfile, ctx: RuleContext): boolean {
  if (!ctx.primaryProviderInNetwork) return false;
  const rxcuis = profile.medications.map((m) => m.rxcui).filter((x): x is string => !!x);
  if (rxcuis.length === 0) return false;
  return rxcuis.every((id) => ctx.tierByRxcui[id] === ctx.lowestTierOnPlan);
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
  {
    id: 'moop_penalty',
    action: 'penalize',
    // Tiered: -50 at $5,001–$6,500, -75 above $6,500. Static $5,000
    // boundary is intentionally inclusive (no penalty at exactly $5K).
    points: (plan) => moopPenaltyPoints(plan.moop_in_network ?? 0),
    reason: (plan) => {
      const m = plan.moop_in_network ?? 0;
      if (m > 6500) return `MOOP $${m.toLocaleString()} — high-exposure plan, large unbounded downside`;
      return `MOOP $${m.toLocaleString()} — meaningful out-of-pocket exposure if utilization spikes`;
    },
    match: (plan, profile, ctx) =>
      moopPenaltyPoints(plan.moop_in_network ?? 0) > 0 && !moopPenaltyOverridden(profile, ctx),
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
      const points =
        typeof rule.points === 'function' ? rule.points(plan, profile, ctx, scored) : rule.points;
      const reason =
        typeof rule.reason === 'function' ? rule.reason(plan, profile, ctx, scored) : rule.reason;
      out.push({ ruleId: rule.id, action: rule.action, points, reason });
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
