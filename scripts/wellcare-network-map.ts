// scripts/wellcare-network-map.ts
//
// Translates Centene/Wellcare FHIR network display names into pm_plans
// rows. Their public FHIR endpoint
// (prod.api.centene.com/fhir/providerdirectory) exposes the practitioner
// → network linkage but the InsurancePlan resource is empty (HTTP 400 on
// any list query, 0 hits on every name filter), so there is no FHIR-only
// path from network → CMS contract.
//
// Approximation rule the user is willing to accept:
//   Wellcare networks are broad tiers (HMO national, PPO national, plus
//   state-specific overlays like "NC NCD"), not per-plan networks. So
//   "in WCG National PPO" maps to every Wellcare PPO contract+plan in
//   the practitioner's state.
//
// Known network names from the live data (plus the legacy "Do Not Use - "
// prefix that Wellcare leaves on retired-but-still-active networks):
//   - "WCG National HMO"  / "Do Not Use - WCG National HMO"
//   - "WCG National PPO"  / "Do Not Use - WCG National PPO"
//   - "NC NCD"            / "Do Not Use - NC NCD"
//   - "Exchange NC"       (Marketplace/Ambetter — no MA mapping)
//   - "Exchange Solutions"(Marketplace/Ambetter — no MA mapping)
//
// Add a new entry to NETWORK_RULES whenever a previously-unseen network
// name shows up in the FHIR results.

import type { SupabaseClient } from '@supabase/supabase-js';

export interface WellcarePlanRow {
  contract_id: string;
  plan_id: string;
  plan_name: string | null;
  plan_type: string;
  state: string;
  segment_id: string | null;
}

interface NetworkRule {
  // Matched against Organization.display after stripping a leading
  // "Do Not Use - " prefix. Case-insensitive.
  pattern: RegExp;
  // 'national' = filter pm_plans by practitionerState (or all states if no state).
  // 'state'    = ignore practitionerState; force the rule's own state.
  // 'skip'     = recognised but maps to nothing (e.g. Marketplace networks).
  scope: 'national' | 'state' | 'skip';
  forceState?: string;
  // Substring match against pm_plans.plan_type (case-insensitive).
  // Empty / undefined = any plan type.
  planTypeContains?: string[];
  reason?: string;
}

export const NETWORK_RULES: NetworkRule[] = [
  {
    pattern: /(WCG\s+)?National\s+HMO/i,
    scope: 'national',
    planTypeContains: ['HMO'], // matches "HMO", "HMO-POS", "HMO D-SNP", "HMO-POS D-SNP"
  },
  {
    pattern: /(WCG\s+)?National\s+PPO/i,
    scope: 'national',
    planTypeContains: ['PPO'], // matches "PPO", "PPO D-SNP", "LPPO"
  },
  {
    pattern: /^NC\s+NCD$/i,
    scope: 'state',
    forceState: 'NC',
    // No planType filter — NC NCD covers every Wellcare contract in NC.
  },
  {
    pattern: /^Exchange\b/i,
    scope: 'skip',
    reason: 'Marketplace/Ambetter network — pm_plans is MA-only',
  },
];

const DO_NOT_USE_PREFIX_RE = /^Do Not Use\s*-\s*/i;
function normalize(display: string | undefined): string {
  if (!display) return '';
  return display.replace(DO_NOT_USE_PREFIX_RE, '').trim();
}

function findRule(display: string): NetworkRule | null {
  const norm = normalize(display);
  if (!norm) return null;
  for (const rule of NETWORK_RULES) {
    if (rule.pattern.test(norm)) return rule;
  }
  return null;
}

// Postgrest paginated load of every Wellcare/Centene plan in pm_plans.
// Cached per-process (this module is imported once by the CLI script).
let CACHE: Promise<WellcarePlanRow[]> | null = null;

const WELLCARE_FILTER =
  'or=(carrier.ilike.%25Wellcare%25,parent_organization.ilike.%25Centene%25)';

export async function loadWellcarePlans(sb: SupabaseClient): Promise<WellcarePlanRow[]> {
  if (CACHE) return CACHE;
  CACHE = (async () => {
    const out: WellcarePlanRow[] = [];
    // Postgrest default page size is 1000; paginate explicitly.
    for (let offset = 0; offset < 50_000; offset += 1000) {
      const { data, error } = await sb
        .from('pm_plans')
        .select('contract_id, plan_id, plan_name, plan_type, state, segment_id')
        .or('carrier.ilike.%Wellcare%,parent_organization.ilike.%Centene%')
        .eq('sanctioned', false)
        .range(offset, offset + 999);
      if (error) throw error;
      const rows = (data ?? []) as WellcarePlanRow[];
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    // Deduplicate to (contract_id, plan_id) — pm_plans has one row per county,
    // but the cache key is contract+plan only (segment handled separately).
    const seen = new Set<string>();
    const unique: WellcarePlanRow[] = [];
    for (const r of out) {
      const k = `${r.contract_id}-${r.plan_id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(r);
    }
    return unique;
  })();
  // Surface filter info so the caller doesn't think the variable is dead.
  void WELLCARE_FILTER;
  return CACHE;
}

export interface ResolvedHit {
  plan_contract_id: string; // "H1914-011" — matches pm_provider_network_cache.plan_id
  plan_full_id: string;     // "H1914-011" (Wellcare has no separate "full" form)
  plan_name?: string;
  network_org_id: string;
  network_display?: string;
  reason: string;           // which rule fired — useful for debugging
}

export interface ResolveOpts {
  practitionerState?: string;
}

export async function resolveWellcareNetworks(
  sb: SupabaseClient,
  networks: Array<{ org_id: string; display?: string }>,
  opts: ResolveOpts = {},
): Promise<{ hits: ResolvedHit[]; rulesFired: Map<string, number>; unmatched: string[] }> {
  const plans = await loadWellcarePlans(sb);
  const hits: ResolvedHit[] = [];
  const rulesFired = new Map<string, number>();
  const unmatched: string[] = [];
  const seen = new Set<string>(); // (contract+plan|orgId)

  for (const net of networks) {
    const display = net.display ?? '';
    const rule = findRule(display);
    if (!rule) {
      unmatched.push(display || `<no display, id=${net.org_id}>`);
      continue;
    }
    if (rule.scope === 'skip') {
      rulesFired.set(`skip:${rule.reason ?? rule.pattern}`, (rulesFired.get(`skip:${rule.reason ?? rule.pattern}`) ?? 0) + 1);
      continue;
    }

    const targetState = rule.scope === 'state'
      ? rule.forceState
      : opts.practitionerState; // national: filter by practitioner's state if known
    const ruleKey = `${rule.scope}:${rule.pattern}${rule.planTypeContains ? `:${rule.planTypeContains.join('|')}` : ''}`;

    for (const plan of plans) {
      if (targetState && plan.state !== targetState) continue;
      if (rule.planTypeContains && rule.planTypeContains.length > 0) {
        const hay = (plan.plan_type ?? '').toUpperCase();
        const match = rule.planTypeContains.some((t) => hay.includes(t.toUpperCase()));
        if (!match) continue;
      }
      const planKey = `${plan.contract_id}-${plan.plan_id}`;
      const dedupKey = `${planKey}|${net.org_id}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      hits.push({
        plan_contract_id: planKey,
        plan_full_id: planKey,
        plan_name: plan.plan_name ?? undefined,
        network_org_id: net.org_id,
        network_display: display,
        reason: ruleKey,
      });
      rulesFired.set(ruleKey, (rulesFired.get(ruleKey) ?? 0) + 1);
    }
  }
  return { hits, rulesFired, unmatched };
}
