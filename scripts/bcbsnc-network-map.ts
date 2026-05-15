// scripts/bcbsnc-network-map.ts
//
// Translates BCBS NC FHIR network display names into pm_plans rows.
// Their public FHIR endpoint
// (apiservices-ext.bcbsnc.com/fhir/prod/R4/providerdirectory) exposes
// PractitionerRole.network references, but their InsurancePlan
// resource is empty (0 results on any filter) and the network
// Organizations carry no H-contract identifiers — so there is no
// FHIR-only path from network → CMS contract.
//
// Unlike the broad-tier Wellcare mapping, BCBS NC's networks line up
// 1:1 with specific CMS contracts in NC, so each rule pins exactly
// one contract_id:
//
//   FHIR network display                          → pm_plans contract
//   ─────────────────────────────────────────────  ──────────────────
//   "Medicare Advantage HMO"                       H3449  (HMO/HMO-POS)
//   "Medicare Advantage PPO"                       H3404  (PPO)
//   "Healthy Blue + Medicare"                      H9147  (HMO-POS D-SNP)
//   "Experience Health Medicare Advantage HMO"     H3777  (HMO)
//
// Order in NETWORK_RULES matters — the more specific patterns
// ("Experience Health …", "Healthy Blue …") must come before the
// generic "Medicare Advantage HMO" so the latter doesn't shadow them.
//
// PDP (S5540) is intentionally excluded — drug-only contracts have no
// provider network linkage.

import type { SupabaseClient } from '@supabase/supabase-js';

export interface BcbsncPlanRow {
  contract_id: string;
  plan_id: string;
  plan_name: string | null;
  plan_type: string;
  state: string;
  segment_id: string | null;
}

interface NetworkRule {
  // Matched against Organization.display, case-insensitive.
  pattern: RegExp;
  // The CMS contract this network represents.
  contractId: string;
  // Optional: only include plans whose plan_type matches one of these
  // substrings (case-insensitive). Lets us exclude e.g. D-SNP plans
  // from the generic HMO network if BCBS ever splits them onto the
  // same contract.
  planTypeContains?: string[];
  reason?: string;
}

export const NETWORK_RULES: NetworkRule[] = [
  // Specific brands first so they don't fall into the generic HMO rule.
  {
    pattern: /Experience\s+Health.*Medicare\s+Advantage\s+HMO/i,
    contractId: 'H3777',
    reason: 'Experience Health (BCBS NC NC State Health Plan brand)',
  },
  {
    pattern: /Healthy\s+Blue.*Medicare/i,
    contractId: 'H9147',
    reason: 'Healthy Blue + Medicare D-SNP',
  },
  {
    pattern: /^Medicare\s+Advantage\s+PPO$/i,
    contractId: 'H3404',
    reason: 'BCBS NC Medicare Advantage PPO',
  },
  {
    pattern: /^Medicare\s+Advantage\s+HMO$/i,
    contractId: 'H3449',
    reason: 'BCBS NC Medicare Advantage HMO/HMO-POS',
  },
];

function findRule(display: string): NetworkRule | null {
  const norm = (display ?? '').trim();
  if (!norm) return null;
  for (const rule of NETWORK_RULES) {
    if (rule.pattern.test(norm)) return rule;
  }
  return null;
}

// Postgrest paginated load of every BCBS NC + Experience Health plan
// in pm_plans (NC only; this carrier is state-licensed). Cached
// per-process — this module is imported once by the CLI script.
let CACHE: Promise<BcbsncPlanRow[]> | null = null;

export async function loadBcbsncPlans(sb: SupabaseClient): Promise<BcbsncPlanRow[]> {
  if (CACHE) return CACHE;
  CACHE = (async () => {
    const out: BcbsncPlanRow[] = [];
    for (let offset = 0; offset < 50_000; offset += 1000) {
      const { data, error } = await sb
        .from('pm_plans')
        .select('contract_id, plan_id, plan_name, plan_type, state, segment_id')
        .or('carrier.ilike.%Blue Cross%North Carolina%,carrier.ilike.%Experience Health%')
        .eq('state', 'NC')
        .eq('sanctioned', false)
        .range(offset, offset + 999);
      if (error) throw error;
      const rows = (data ?? []) as BcbsncPlanRow[];
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    // Deduplicate on (contract_id, plan_id) — pm_plans has one row per
    // county, but the cache key is contract+plan only.
    const seen = new Set<string>();
    const unique: BcbsncPlanRow[] = [];
    for (const r of out) {
      const k = `${r.contract_id}-${r.plan_id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(r);
    }
    return unique;
  })();
  return CACHE;
}

export interface ResolvedHit {
  plan_contract_id: string; // "H3449-027" — matches pm_provider_network_cache.plan_id
  plan_full_id: string;     // same form; BCBS NC has no separate "full" id
  plan_name?: string;
  network_org_id: string;
  network_display?: string;
  reason: string;
}

export async function resolveBcbsncNetworks(
  sb: SupabaseClient,
  networks: Array<{ org_id: string; display?: string }>,
): Promise<{ hits: ResolvedHit[]; rulesFired: Map<string, number>; unmatched: string[] }> {
  const plans = await loadBcbsncPlans(sb);
  const byContract = new Map<string, BcbsncPlanRow[]>();
  for (const p of plans) {
    const arr = byContract.get(p.contract_id) ?? [];
    arr.push(p);
    byContract.set(p.contract_id, arr);
  }

  const hits: ResolvedHit[] = [];
  const rulesFired = new Map<string, number>();
  const unmatched: string[] = [];
  const seen = new Set<string>(); // (contract-plan|orgId)

  for (const net of networks) {
    const display = net.display ?? '';
    const rule = findRule(display);
    if (!rule) {
      unmatched.push(display || `<no display, id=${net.org_id}>`);
      continue;
    }
    const ruleKey = `${rule.contractId}:${rule.pattern}`;
    const matchingPlans = byContract.get(rule.contractId) ?? [];
    for (const plan of matchingPlans) {
      if (rule.planTypeContains && rule.planTypeContains.length > 0) {
        const hay = (plan.plan_type ?? '').toUpperCase();
        if (!rule.planTypeContains.some((t) => hay.includes(t.toUpperCase()))) continue;
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
