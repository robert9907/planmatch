// Per-gate, customer-facing micro-explainer string builders for the
// agent brain. Mirrors packages/brain/src/plan-brain.ts in the consumer
// repo (buildGate1Explanations / buildGate2Explanations /
// buildGate3Explanations + evaluatePriorityChecks). Kept in its own
// module so the funnel in plan-brain.ts doesn't get longer than it
// already is, and so a future drift between the two brains is
// localized to one file.
//
// IMPORTANT — if the strings emitted here change, the matching
// pattern-recognizer at src/lib/classify-explanation.ts (the ✓ / ✗ / ⚠
// icon picker) must change too. The contract is "phrasing" not "shape".

import type {
  GateExplanations,
  ProviderNetworkCacheEntry,
} from './plan-brain-types';
import type { FormularyCoverage } from './brain-foreign-types';
import {
  extractCategoryAnnualValue,
  extractOtcQuarterly,
} from './plan-brain-utils';

// ─── Local helpers ──────────────────────────────────────────────────

function fmtUSD(n: number): string {
  return `$${Math.max(0, Math.round(n)).toLocaleString()}`;
}

// Last-name extraction. Strips honorifics ("Dr.", "Doctor") and
// post-nominal credentials (MD, DO, NP, PA-C, etc.) so "Dr. Klein, DO"
// renders as "Klein" in the explanation pill.
const CREDENTIAL_SUFFIX_RE =
  /,?\s+(?:M\.?D\.?|D\.?O\.?|N\.?P\.?|P\.?A\.?-?C?|D\.?D\.?S\.?|D\.?M\.?D\.?|D\.?P\.?M\.?|D\.?C\.?|O\.?D\.?|Ph\.?D\.?|Psy\.?D\.?|R\.?N\.?|F\.?N\.?P\.?|A\.?P\.?R\.?N\.?|C\.?N\.?M\.?|MBBS|MBChB)\.?$/i;

function providerLastName(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  const noPrefix = trimmed.replace(/^\s*(?:Dr\.?|Doctor)\s+/i, '');
  const noCredential = noPrefix.replace(CREDENTIAL_SUFFIX_RE, '').trim();
  const tokens = noCredential.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  const last = tokens[tokens.length - 1];
  return last.charAt(0).toUpperCase() + last.slice(1).toLowerCase();
}

// Trim trailing "(generic name)" suffix some drug names carry from
// NDC normalization so the pill reads as the brand the user typed.
function displayDrugName(raw: string): string {
  return raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function extractGivebackMonthly(
  benefits: ReadonlyArray<{
    benefit_category: string;
    coverage_amount: number | null;
    max_coverage: number | null;
  }>,
): number {
  const row = benefits.find((b) => b.benefit_category === 'partb_giveback');
  if (!row) return 0;
  const filed = row.coverage_amount ?? row.max_coverage ?? null;
  if (filed == null) return 0;
  return filed;
}

// Priority labels — keep parity with the consumer's TIER_LABEL_BY_KEY
// and TOGGLE_LABEL_BY_KEY so a user comparing the consumer Results
// screen to an agent CompareScreen reads the same pill copy on both.
const TIER_LABEL_BY_KEY: Readonly<Record<string, string>> = {
  dental: 'Dental',
  vision: 'Vision',
  otc: 'OTC',
  partb_giveback: 'Part B giveback',
};

const TOGGLE_LABEL_BY_KEY: Readonly<Record<string, string>> = {
  hearing: 'Hearing',
  fitness: 'Fitness',
  low_moop: 'Low max out-of-pocket',
  telehealth: 'Telehealth',
  low_drug_costs: 'Low drug costs',
  transportation: 'Transportation',
  healthy_foods: 'Healthy foods / grocery',
};

interface PriorityCheckInternal {
  priority: string;
  label: string;
  meets: boolean;
  partial: boolean;
  score: number;
}

// Per-priority threshold evaluator. The agent BrainScore carries
// priorityChecks: [] (the agent funnel doesn't fill it from the broker
// pipeline), so we run this here independently to produce labels for
// gate 3 explanations. Direct port of consumer's evaluatePriorityChecks
// so the two surfaces stay phrasing-identical.
function evaluatePriorityChecks(args: {
  benefits: ReadonlyArray<{
    benefit_category: string;
    coverage_amount: number | null;
    max_coverage: number | null;
  }>;
  moop: number | null;
  partBGivebackAnnual: number;
  drugCostScore: number;
  priorities: ReadonlySet<string>;
  thresholds: Partial<
    Record<'dental' | 'vision' | 'otc' | 'partb_giveback', number>
  >;
}): PriorityCheckInternal[] {
  const out: PriorityCheckInternal[] = [];
  for (const pri of args.priorities) {
    if (pri === 'dental' || pri === 'vision') {
      const annual = extractCategoryAnnualValue(args.benefits, pri);
      const threshold = args.thresholds[pri] ?? 0;
      const score =
        threshold > 0
          ? Math.min(annual / threshold, 1.0)
          : annual > 0
            ? 1
            : 0;
      const meets = score >= 1;
      const partial = !meets && score > 0;
      out.push({
        priority: pri,
        label:
          annual > 0
            ? `${TIER_LABEL_BY_KEY[pri]} ${fmtUSD(annual)}` +
              (threshold > 0 ? ` (your pick: ${fmtUSD(threshold)}+)` : '')
            : `${TIER_LABEL_BY_KEY[pri]} not filed` +
              (threshold > 0 ? ` (your pick: ${fmtUSD(threshold)}+)` : ''),
        meets,
        partial,
        score,
      });
    } else if (pri === 'otc') {
      const { quarterly, period } = extractOtcQuarterly(args.benefits);
      const threshold = args.thresholds.otc ?? 0;
      const score =
        threshold > 0
          ? Math.min(quarterly / threshold, 1.0)
          : quarterly > 0
            ? 1
            : 0;
      const meets = score >= 1;
      const partial = !meets && score > 0;
      const displayValue =
        period === 'month' ? Math.round(quarterly / 3) : quarterly;
      const displayUnit = period === 'month' ? '/mo' : '/qtr';
      out.push({
        priority: 'otc',
        label:
          quarterly > 0
            ? `${TIER_LABEL_BY_KEY.otc} ${fmtUSD(displayValue)}${displayUnit}` +
              (threshold > 0 ? ` (your pick: ${fmtUSD(threshold)}+/qtr)` : '')
            : `${TIER_LABEL_BY_KEY.otc} not offered` +
              (threshold > 0 ? ` (your pick: ${fmtUSD(threshold)}+/qtr)` : ''),
        meets,
        partial,
        score,
      });
    } else if (pri === 'partb_giveback') {
      const monthly = extractGivebackMonthly(args.benefits);
      const threshold = args.thresholds.partb_giveback ?? 0;
      const score =
        threshold > 0
          ? Math.min(monthly / threshold, 1.0)
          : monthly > 0
            ? 1
            : 0;
      const meets = score >= 1;
      const partial = !meets && score > 0;
      out.push({
        priority: 'partb_giveback',
        label:
          monthly > 0
            ? `${TIER_LABEL_BY_KEY.partb_giveback} ${fmtUSD(monthly)}/mo` +
              (threshold > 0 ? ` (your pick: ${fmtUSD(threshold)}+/mo)` : '')
            : `${TIER_LABEL_BY_KEY.partb_giveback} not offered` +
              (threshold > 0 ? ` (your pick: ${fmtUSD(threshold)}+/mo)` : ''),
        meets,
        partial,
        score,
      });
    } else if (pri === 'low_moop') {
      const moop = args.moop ?? null;
      const meets = moop != null && moop > 0 && moop <= 5500;
      out.push({
        priority: pri,
        label:
          moop != null && moop > 0
            ? `Max out-of-pocket ${fmtUSD(moop)}` +
              (meets ? ' (strong protection)' : '')
            : 'Max out-of-pocket not filed',
        meets,
        partial: false,
        score: meets ? 1 : 0,
      });
    } else if (pri === 'low_drug_costs') {
      const meets = args.drugCostScore >= 66;
      out.push({
        priority: pri,
        label: meets
          ? 'Low drug costs (top third of plans)'
          : 'Drug costs middle/lower third',
        meets,
        partial: false,
        score: meets ? 1 : 0,
      });
    } else {
      const cat: 'hearing' | 'fitness' | 'transportation' | 'telehealth' | null =
        pri === 'hearing'
          ? 'hearing'
          : pri === 'fitness'
            ? 'fitness'
            : pri === 'transportation'
              ? 'transportation'
              : pri === 'telehealth'
                ? 'telehealth'
                : null;
      const filed = cat ? extractCategoryAnnualValue(args.benefits, cat) : 0;
      const fallback =
        pri === 'healthy_foods'
          ? args.benefits.some((b) => b.benefit_category === 'meals')
          : false;
      const meets = filed > 0 || fallback;
      const label = TOGGLE_LABEL_BY_KEY[pri] ?? pri;
      out.push({
        priority: pri,
        label: meets ? `${label} included` : `${label} not offered`,
        meets,
        partial: false,
        score: meets ? 1 : 0,
      });
    }
  }
  return out;
}

// ─── Public builders ────────────────────────────────────────────────

/**
 * Gate 1 — providers. One string per user-supplied provider.
 *
 *   "Dr. Klein is in-network"
 *   "Dr. Smith is out-of-network on this plan"
 *   "Dr. Doe — network status unverified"
 *   "Dr. Doe — no NPI on file, network status unverified"
 *
 * Falls back to the contract-level `verifiedInNetworkContracts` set
 * when the per-NPI cache isn't available (mirrors the consumer brain).
 */
export function buildGate1Explanations(
  providers: ReadonlyArray<{ npi?: string; name: string }>,
  providerCache: Map<string, ProviderNetworkCacheEntry> | undefined,
  verifiedInNetworkContracts: ReadonlySet<string> | undefined,
  contractId: string,
): string[] {
  if (providers.length === 0) return [];
  const verified = verifiedInNetworkContracts?.has(contractId) === true;
  return providers.map((p) => {
    const label = `Dr. ${providerLastName(p.name)}`;
    if (!p.npi) return `${label} — no NPI on file, network status unverified`;
    if (providerCache) {
      const c = providerCache.get(p.npi);
      if (c?.covered === true) return `${label} is in-network`;
      if (c && c.covered === false) return `${label} is out-of-network on this plan`;
      return `${label} — network status unverified`;
    }
    if (verified) return `${label} is in-network`;
    return `${label} — network status unverified`;
  });
}

/**
 * Gate 2 — medications. One string per user-supplied drug.
 *
 *   "Metformin — Tier 1, $4/mo"
 *   "Eliquis covered (Tier 3)"
 *   "Ozempic — coverage estimated, confirm with your pharmacist"
 *   "Synthroid is not covered on this plan"
 */
export function buildGate2Explanations(
  drugEstimates: ReadonlyArray<{
    rxcui?: string;
    name: string;
    covered: boolean;
    confirmedUncovered: boolean;
    tier: number | null;
  }>,
  formulary: Map<string, FormularyCoverage>,
): string[] {
  return drugEstimates.map((est) => {
    const name = displayDrugName(est.name);
    if (est.confirmedUncovered) return `${name} is not covered on this plan`;
    if (est.covered) {
      const tier = est.tier;
      const cov = est.rxcui ? formulary.get(est.rxcui) : undefined;
      const monthly = cov?.copay ?? null;
      if (tier != null && monthly != null) {
        return `${name} — Tier ${tier}, ${fmtUSD(monthly)}/mo`;
      }
      if (tier != null) return `${name} covered (Tier ${tier})`;
      return `${name} is covered`;
    }
    return `${name} — coverage estimated, confirm with your pharmacist`;
  });
}

/**
 * Gate 3 — extras / preferences. One string per user-selected priority.
 *
 *   "Dental $1,500 (your pick: $1,000+)"
 *   "OTC not offered"
 *   "Fitness included"
 *
 * Returns an empty array when priorities is empty (gate didn't apply).
 */
export function buildGate3Explanations(
  benefits: ReadonlyArray<{
    benefit_category: string;
    coverage_amount: number | null;
    max_coverage: number | null;
    copay: number | null;
  }>,
  moop: number | null,
  partBGivebackAnnual: number,
  drugCostScore: number,
  priorities: ReadonlySet<string>,
  thresholds: Partial<
    Record<'dental' | 'vision' | 'otc' | 'partb_giveback', number>
  >,
): string[] {
  if (priorities.size === 0) return [];
  return evaluatePriorityChecks({
    benefits,
    moop,
    partBGivebackAnnual,
    drugCostScore,
    priorities,
    thresholds,
  }).map((c) => c.label);
}

/**
 * Builds the gate-4 cost-rank summary string. Called from the cost-
 * ranking pass in plan-brain.ts after rawScored is sorted, since it
 * needs the rank position within the pool.
 *
 *   "Estimated annual cost: $2,340 (rank #1 of 38)"
 */
export function buildGate4Explanation(netAnnual: number, rankPosition: number, poolSize: number): string {
  return `Estimated annual cost: ${fmtUSD(netAnnual)} (rank #${rankPosition} of ${poolSize})`;
}

/**
 * Convenience: assemble a GateExplanations object with gate4 left blank.
 * The cost-ranking pass writes gate4 after rawScored is sorted.
 */
export function makeGateExplanations(
  gate1: ReadonlyArray<string>,
  gate2: ReadonlyArray<string>,
  gate3: ReadonlyArray<string>,
): GateExplanations {
  return { gate1, gate2, gate3, gate4: '' };
}
