// Agent-side mirror of the consumer brain's sellability filter
// (~/Code/plan-match/packages/brain/src/sellability.ts +
// api/_lib/sellable-rules.ts). This repo can't import @plan-match/brain,
// so the logic is mirrored here — keep the two in sync.
//
// Used by /api/tpmo-counts so the (e)(41) organization/product counts are
// scoped to the SAME sellable set the brain ranks on (rules + UHC/Devoted
// flags + Wellcare allowlist), never the old is_appointed/is_certified
// gate — otherwise the disclaimed counts drift from the top four.

const UHC_CARRIER = 'UnitedHealthcare';
const DEVOTED_CARRIER = 'Devoted Health';
const WELLCARE_CARRIER = 'Wellcare';
const DEFAULT_UHC_EXCLUDED_FROM = '2026-10-14T04:00:00.000Z'; // 2026-10-14 00:00 ET (EDT)
const TTL_MS = 5 * 60 * 1000;

export interface SellableRule {
  contract_id: string;
  plan_number: string;
  segment_id: string;
  state: string;
  counties: string[] | null;
  action: 'exclude' | 'allow';
  carrier: string | null;
}
export interface SellableFlags {
  uhcExcludedFrom: string | null;
  devotedExcluded: boolean;
}
export interface SellablePlanRef {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  state: string;
  county_name: string;
  carrier: string | null;
  // Appointment + certification (pm_plan_sellability, attached to the ref by
  // the caller). can_enroll = is_appointed AND is_certified. A plan Rob isn't
  // appointed AND certified for can't be sold through this agent, for ANY
  // plan year. Absent (undefined) ⇒ sellable (State A) — the DEFAULT_SELLABILITY
  // posture. pays_commission is NEVER read here (must not affect ranking).
  is_appointed?: boolean;
  is_certified?: boolean;
}

export interface SellabilityResult {
  sellable: boolean;
  /** Short diagnostic reason when not sellable; null when sellable. */
  reason: string | null;
}

export function normalizeSegmentId(seg: string | null | undefined): string {
  const s = (seg ?? '').trim();
  if (s === '' || s === '*') return s;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? s : String(n);
}
export function normalizeCountyName(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase().replace(/\s+county$/, '').replace(/\s+/g, ' ');
}

function contractMatches(ruleContract: string, planContract: string): boolean {
  if (ruleContract === planContract) return true;
  if (ruleContract.endsWith('*')) return planContract.startsWith(ruleContract.slice(0, -1));
  return false;
}
function ruleMatchesPlan(rule: SellableRule, plan: SellablePlanRef): boolean {
  if (!contractMatches(rule.contract_id, plan.contract_id)) return false;
  if (rule.contract_id.endsWith('*') && rule.carrier && (plan.carrier ?? '') !== rule.carrier) return false;
  if (rule.plan_number !== '*' && rule.plan_number !== plan.plan_id) return false;
  if (rule.segment_id !== '*' && normalizeSegmentId(rule.segment_id) !== normalizeSegmentId(plan.segment_id)) return false;
  if (rule.state !== '*' && rule.state !== plan.state) return false;
  if (rule.counties && rule.counties.length > 0 && !rule.counties.includes(normalizeCountyName(plan.county_name))) return false;
  return true;
}

/**
 * Decide whether a single plan is sellable, returning the reason when not.
 * Mirrors the consumer brain's computeSellability
 * (packages/brain/src/sellability.ts) 1:1 so the agent local brain and the
 * consumer pick the same four. Pure — pass the ranked plan-year's rules, the
 * carrier flags, and the evaluation instant.
 */
export function computeSellability(
  plan: SellablePlanRef,
  args: { rules: readonly SellableRule[]; flags: SellableFlags; now: Date },
): SellabilityResult {
  const carrier = plan.carrier ?? '';
  const { rules, flags, now } = args;

  // ── Appointment + certification gate — EVERY plan year ────────────
  // can_enroll = is_appointed AND is_certified (pm_plan_sellability, attached
  // to the ref by the caller). Fires BEFORE the empty-ruleset (2026)
  // early-return so it applies even when `rules` is empty. Absent fields
  // (undefined) read as true → sellable (State A). pays_commission is NEVER
  // read here — commission must not affect ranking or routing.
  if (plan.is_appointed === false || plan.is_certified === false) {
    return { sellable: false, reason: 'Not available to enroll through this agent.' };
  }

  // ── Carrier flags — apply to EVERY plan year ──────────────────────
  if (carrier === UHC_CARRIER && flags.uhcExcludedFrom) {
    const cutoff = new Date(flags.uhcExcludedFrom).getTime();
    if (!Number.isNaN(cutoff) && now.getTime() >= cutoff) {
      return { sellable: false, reason: 'UnitedHealthcare plans are not offered.' };
    }
  }
  if (carrier === DEVOTED_CARRIER && flags.devotedExcluded) {
    return { sellable: false, reason: 'Devoted Health plans are not offered.' };
  }

  // ── Rules table + Wellcare allowlist — 2027 ONLY ──────────────────
  // An empty ruleset (the 2026 catalog) means the ranked year has no sellable
  // program: skip the exclude rules AND the Wellcare allowlist. (UHC/Devoted
  // and the appointment gate above already fired.)
  if (rules.length === 0) {
    return { sellable: true, reason: null };
  }

  const matchesExclude = rules.some((r) => r.action === 'exclude' && ruleMatchesPlan(r, plan));
  if (carrier === WELLCARE_CARRIER) {
    if (matchesExclude) {
      return { sellable: false, reason: 'Wellcare plan is non-commissionable for 2027.' };
    }
    const matchesAllow = rules.some((r) => r.action === 'allow' && ruleMatchesPlan(r, plan));
    if (!matchesAllow) {
      return { sellable: false, reason: 'Wellcare plan is not on the 2027 commissionable allowlist.' };
    }
    return { sellable: true, reason: null };
  }
  if (matchesExclude) {
    return { sellable: false, reason: 'This plan is not offered for 2027.' };
  }
  return { sellable: true, reason: null };
}

/** Boolean convenience over computeSellability — the shape /api/tpmo-counts
 *  consumes. Carries the appointment gate because computeSellability does. */
export function computeSellable(
  plan: SellablePlanRef,
  args: { rules: readonly SellableRule[]; flags: SellableFlags; now: Date },
): boolean {
  return computeSellability(plan, args).sellable;
}

export function getSellableFlags(): SellableFlags {
  const rawUhc = process.env.PM_UHC_EXCLUDED_FROM;
  const uhcExcludedFrom =
    rawUhc === undefined
      ? DEFAULT_UHC_EXCLUDED_FROM
      : rawUhc.trim() === '' || rawUhc.trim().toLowerCase() === 'none'
        ? null
        : rawUhc.trim();
  return { uhcExcludedFrom, devotedExcluded: process.env.PM_DEVOTED_EXCLUDED !== 'false' };
}

const cacheByYear = new Map<number, { rules: SellableRule[]; fetchedAt: number }>();

export async function getSellableRules(
  base: string,
  key: string,
  planYear: number,
): Promise<SellableRule[]> {
  const now = Date.now();
  const cached = cacheByYear.get(planYear);
  if (cached && now - cached.fetchedAt < TTL_MS) return cached.rules;
  const url =
    `${base.replace(/\/$/, '')}/rest/v1/pm_non_commissionable_rules` +
    `?select=contract_id,plan_number,segment_id,state,counties,action,carrier&plan_year=eq.${planYear}`;
  const resp = await fetch(url, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (!resp.ok) {
    if (cached) return cached.rules;
    throw new Error(`pm_non_commissionable_rules ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const rows = (await resp.json()) as Array<{
    contract_id: string; plan_number: string | null; segment_id: string | null;
    state: string | null; counties: string | null; action: string | null; carrier: string | null;
  }>;
  const rules = rows
    .filter((r) => r.contract_id && (r.action === 'exclude' || r.action === 'allow'))
    .map((r) => {
      const c = (r.counties ?? '*').trim();
      return {
        contract_id: r.contract_id,
        plan_number: (r.plan_number ?? '*').trim() || '*',
        segment_id: (r.segment_id ?? '*').trim() || '*',
        state: (r.state ?? '*').trim() || '*',
        counties: c === '*' || c === '' ? null : c.split(';').map(normalizeCountyName).filter(Boolean),
        action: r.action as 'exclude' | 'allow',
        carrier: r.carrier ?? null,
      } as SellableRule;
    });
  cacheByYear.set(planYear, { rules, fetchedAt: now });
  return rules;
}
