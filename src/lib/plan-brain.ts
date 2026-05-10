// Plan Brain — composite-score ranking engine.
//
// Replaces the multi-axis-pick model in rankTop3Live with:
//   1. SNP-aware filtering (D-SNP / C-SNP / standard MAPD)
//   2. Three-axis scoring (drug cost / OOP cost / extras value),
//      each normalized to 0..100 across the candidate pool
//   3. Composite = weighted sum per population's BrainWeights
//   4. Ribbon assignment — Top 3 + category leaders get distinct badges
//   5. Output mapped onto the existing LiveTop3 shape so
//      Results.tsx + Carrier Buildings consume it without changes
//
// Entry point: runPlanBrain(input) — same data shape as RankInputs +
// optional drug cost cache + provider network cache.

import type { PmPlanRow } from './brain-foreign-types';
import {
  type BrainInputs,
  type BrainOutput,
  type BrainScore,
  type BrainScoredPlan,
  type LiveTop3,
  type LiveTop3Pick,
  type RankPopulation,
  type RibbonType,
} from './plan-brain-types';
import { defaultWeightsFor, noDrugsRedistribution, WEIGHTS_HEALTHY } from './plan-brain-weights';
import {
  annualExtrasValue,
  annualMedicalCostFromUtilization,
  benefitByCategory,
  classifyPlanDentalTier,
  computeSupplyCoverage,
  copayForCategory,
  deriveUtilization,
  estimateDrugYearlyCost,
  extractCategoryAnnualValue,
  extractOtcQuarterly,
  normalizeDirect,
  normalizeInverse,
  r7ExtrasAnnualValue,
  suppliesValueAnnual,
} from './plan-brain-utils';
import { assignRibbons, ribbonDisplayText, ribbonWhyText } from './plan-brain-ribbons';
import type { ConditionProfile } from './condition-profiles';
import { detectConditionsFromMeds, detectedToCsnp, type DetectedConditionKey } from './condition-detector';
import { applyBrokerRules, strongestRule, type ClientProfile } from './broker-rules';
import {
  calculateRealAnnualCost,
  combineUtilization,
  type UtilizationCondition,
} from './utilization-model';
import type { CsnpCondition } from './brain-foreign-types';
import {
  ARCHETYPE_RULES,
  CHRONIC_CONDITION_KEYS,
  classifyArchetype,
  detectMedicationPatterns,
  evaluateRedFlags,
  type ArchetypeProfile,
} from './broker-playbook';

// Per-session debug flag. Toggle in a preview deploy by setting
// VITE_BRAIN_DEBUG=true. Off by default in production so we don't
// flood every consumer's console. Cached at module load — flip the
// env var and reload to see new output.
const BRAIN_DEBUG: boolean =
  typeof import.meta !== 'undefined' &&
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (import.meta as any).env?.VITE_BRAIN_DEBUG === 'true';
function isBrainDebugOn(): boolean {
  return BRAIN_DEBUG;
}

const PROVIDER_BOOST_ALL_IN_NET = 5;
const PROVIDER_PENALTY_ANY_OUT = 10;
// Composite-score bump for plans with a Part B giveback when the user
// is a healthy client. 8 points is enough to promote a giveback plan
// from rank ~5 into Top 3 in typical NC plan distributions, but won't
// override a meaningfully better plan on drug + extras.
const HEALTHY_GIVEBACK_BOOST = 8;
// Margaret rules R2 + R3 — non-dental priority bonus + PPO preference.
//
// R2: dental is its own bonus axis (dollar-proportional, see
//     dentalProportionalBonus below) so it's NOT bundled into the
//     legacy avg-of-checks bonus. The remaining priorities (vision,
//     OTC, fitness, hearing) keep proportional scoring at +50 max so a
//     $200-vision plan that hit 100% of the user's other asks still
//     outranks a $0-vision plan on the same draw.
const NON_DENTAL_PRIORITY_BONUS = 50;
// R3 — PPO preference. PPO/HMO-POS plans give Margaret flexibility
// (no referrals, OON fallback) that matters more when drug costs
// aren't the primary lever. Sized so that a true PPO can pull ~rank-2
// even when an HMO scores slightly higher on the bare composite.
//   PPO     = +15
//   HMO-POS = +5  (HMO chassis, but allows out-of-network POS visits)
//   HMO     =  0
// Fires only when ≥1 priced med is on the plan AND every priced med is
// on tier 1 or 2 AND the primary provider is in-network — i.e. the
// PPO's flexibility isn't being bought at the cost of drug coverage.
const PPO_BONUS = 15;
const HMO_POS_BONUS = 5;
// Tier-1 dental penalty. Fires only when the user picked dental as a
// priority (wantsDental). The dollar-threshold gate already filters
// "$0 dental" plans out, but a $1,500 *preventive-only* allowance
// passes that gate even though it doesn't cover crowns. Penalize the
// composite enough to drop those plans below comprehensive
// alternatives in the same county. -10 is sized against the typical
// in-county composite spread (~5–20 pts); paired with the +50 priority
// bonus already in place, a Tier 3 plan reliably outranks a Tier 1
// plan on the same dental dollars.
const DENTAL_TIER1_PENALTY = 10;
// R8 — priority threshold failure penalty. When a user picks a tier
// priority with a specific dollar threshold (OTC $50+/qtr, Dental
// $2,000+, etc.) and the plan falls BELOW that threshold, the plan
// takes a fixed composite penalty on top of forfeiting the
// proportional bonus. Without this, a plan that scores 0.6 on a
// failed threshold still grabs ~60% of the priority bonus, which lets
// failing plans outrank meeting plans on tight pools (the Wellcare
// Simple bug — $30/qtr OTC ranked #2 against a user picking $50+/qtr).
// Sized at 25 so one failed threshold reliably drops a plan below an
// otherwise-comparable plan that meets every threshold the user picked
// (typical in-county composite spread is ~5–20 pts).
const PRIORITY_THRESHOLD_FAIL_PENALTY = 25;

// R7 — annual-dollars-to-composite-points conversion for extras
// bonuses. $10/yr → 1 composite point so a $1,200/yr extras bundle
// lands at +120 points, comparable to the existing R-tier
// bonuses/penalties (-50 dental tier-1, +15 PPO chassis, +50
// non-dental priority).
const R7_DOLLARS_PER_POINT = 10;
// R6 — premium penalty conversion. Sized more aggressively than R7
// (premium dollars hurt more than equivalent extras dollars help)
// because the broker rule is "$0 plan beats a $53/mo plan unless the
// $53 plan is SUBSTANTIALLY superior on priorities." A plan that
// merely matches a $0 plan's extras-equivalent shouldn't be able to
// tie on composite — it has to clear the bar by a real margin.
// $6/yr → 1 composite point so a $53/mo premium ($636/yr) lands at
// -106 points (vs +64 for an equivalent $636/yr extras bundle), a
// ~42-point deficit the premium plan must overcome through superior
// priorities to outrank the $0 alternative.
const R6_DOLLARS_PER_POINT = 6;
// R6 — when the candidate pool has at least this many $0-premium
// plans, the full universal penalty applies. Below this threshold the
// pool is "premium-rich" (every plan files a premium) and R6 halves
// itself so the brain still ranks meaningfully among premium plans
// instead of collapsing every option to a uniform large penalty.
const R6_ZERO_PREMIUM_FLOOR = 4;

// ─── Broker brain v2 ─────────────────────────────────────────────────
//
// "Read the person from their inputs, then think like a broker, not a
// spreadsheet." Profile detection + weights + hard filters layered on
// top of the existing axis scoring. Drives:
//   - composite weights per profile (replaces the older healthy-vs-
//     population heuristic when a non-general profile fires)
//   - hard-eliminate-from-top-picks for provider-locked profiles
//     (still in the full ranked[] list so the consumer can scroll)
//   - personalized "why" text on each pick that names the user's
//     drugs, providers, and benefits

/**
 * One of four broker-style profiles. Detected from the user's
 * medications, providers, and self-reported chronic conditions:
 *   A — "Protect me"        (sick / chronic / many providers)
 *   B — "Save me money"     (healthy / few meds / few providers)
 *   C — "Balance"            (3-4 meds AND ~2 providers)
 *   D — "Specialty drug"    (one expensive Tier 4/5 drug dominates)
 * D wins over A when both could fire — the specialty drug is the
 * single biggest dollar lever in the plan year.
 */
export type ClientBrokerProfile = 'A' | 'B' | 'C' | 'D';

/**
 * Common Tier 4/5 specialty drugs in the NC Medicare market. Hits on
 * any of these flip the user into Profile D — the plan that covers
 * THIS drug at the lowest copay wins regardless of extras. Names are
 * lowercased + matched as substrings against the user's drug list.
 */
const SPECIALTY_DRUG_NAMES: ReadonlyArray<string> = [
  // GLP-1s
  'ozempic', 'wegovy', 'mounjaro', 'zepbound', 'rybelsus', 'trulicity', 'victoza',
  // anticoagulants (commonly Tier 3 but $400+/mo full retail)
  'eliquis', 'xarelto', 'pradaxa', 'savaysa',
  // biologics / autoimmune
  'humira', 'enbrel', 'stelara', 'cosentyx', 'taltz', 'skyrizi', 'rinvoq', 'otezla', 'dupixent',
  // oncology orals
  'ibrance', 'verzenio', 'kisqali', 'xtandi', 'erleada', 'imbruvica', 'calquence',
  // MS
  'ocrevus', 'tysabri', 'kesimpta', 'tecfidera', 'gilenya', 'aubagio',
  // pulmonary
  'trikafta', 'kalydeco', 'symdeko', 'tezepelumab', 'tezspire',
  // hep C / HIV (when present)
  'mavyret', 'epclusa', 'biktarvy', 'descovy',
  // PCSK9 + heart failure
  'repatha', 'praluent', 'entresto',
];

function detectSpecialtyDrug(drugs: ReadonlyArray<{ name: string }>): boolean {
  for (const d of drugs) {
    const n = (d.name ?? '').toLowerCase();
    if (!n) continue;
    for (const s of SPECIALTY_DRUG_NAMES) {
      if (n.includes(s)) return true;
    }
  }
  return false;
}

/**
 * Profile detector. Reads medication count, provider count, detected
 * chronic conditions, and the specialty-drug flag.
 *
 * Order matters: D > A > B > C. Specialty drug short-circuits because
 * even one $700/mo Ozempic dominates every other lever; chronic
 * conditions beat headcount because a single diabetic with 2 meds
 * still belongs in "Protect me."
 */
function detectClientProfile(args: {
  medCount: number;
  providerCount: number;
  hasSpecialtyDrug: boolean;
  hasChronicCondition: boolean;
}): ClientBrokerProfile {
  if (args.hasSpecialtyDrug) return 'D';
  if (args.medCount >= 5 || args.providerCount >= 3 || args.hasChronicCondition) return 'A';
  if (args.medCount <= 2 && args.providerCount <= 1 && !args.hasChronicCondition) return 'B';
  return 'C';
}

/**
 * Composite weight tuple per broker profile. .copay only carries
 * weight for Profile C (regular-doctor-visits user); other profiles
 * leave it at 0 so the existing 3-axis math is untouched.
 *   A : 60 / 25 / 15 / 0     (drug-led; sick user)
 *   B : 20 / 25 / 55 / 0     (extras-led; healthy user)
 *   C : 35 / 25 / 30 / 10    (balanced + per-visit copays matter)
 *   D : 75 / 15 / 10 / 0     (specialty drug dominates)
 * Sums = 1.0.
 */
interface ProfileWeights {
  drug: number;
  oop: number;
  extras: number;
  copay: number;
}
const PROFILE_WEIGHTS: Readonly<Record<ClientBrokerProfile, ProfileWeights>> = {
  A: { drug: 0.60, oop: 0.25, extras: 0.15, copay: 0.00 },
  B: { drug: 0.20, oop: 0.25, extras: 0.55, copay: 0.00 },
  C: { drug: 0.35, oop: 0.25, extras: 0.30, copay: 0.10 },
  D: { drug: 0.75, oop: 0.15, extras: 0.10, copay: 0.00 },
};

// ─── Margaret R2 + R3 helpers ────────────────────────────────────────

/**
 * R2 — proportional dental bonus.
 *   Always: dental_annual_dollars / 100  (e.g. $4,000 → +40, $0 → 0)
 *   When user picked dental as a priority: ×1.5 (so $4,000 → +60)
 *
 * Dental is universally important to seniors, so the proportional
 * portion fires regardless of the priority flag. The 1.5× multiplier
 * adds extra weight when the user explicitly asks. Pulled out as a
 * function so the breakdown logger and unit tests can hit it directly.
 */
export function dentalProportionalBonus(
  dentalAnnual: number,
  wantsDental: boolean,
): number {
  const base = dentalAnnual / 100;
  return wantsDental ? base * 1.5 : base;
}

/**
 * R3 — PPO preference bonus tier. Returns the composite-point bonus
 * for the plan's chassis:
 *   true PPO → +15
 *   HMO-POS  → +5
 *   HMO / unknown → 0
 *
 * PPO regex catches "PPO" anywhere in plan_type. HMO-POS regex matches
 * "HMO-POS", "HMO POS", "HMOPOS" with optional separators. PPO wins
 * over HMO-POS when both substrings somehow appear in the same string.
 */
export function ppoChassisBonus(planType: string | null | undefined): number {
  const t = planType ?? '';
  if (/\bppo\b/i.test(t)) return PPO_BONUS;
  if (/\bhmo[-\s]?pos\b/i.test(t)) return HMO_POS_BONUS;
  return 0;
}

/**
 * R3 — PPO preference qualifier. The bonus only fires when the plan's
 * flexibility would be a net win for this user:
 *   1. ≥ 1 priced med (rxcui present) — zero meds means PPO preference
 *      isn't a meaningful signal, plan choice is driven by other axes.
 *   2. Every priced med is on tier 1 or 2 — drugs aren't the primary
 *      cost concern, so flexibility outweighs drug-tier optimization.
 *   3. Primary provider in-network — bonus rewards real flexibility,
 *      not "PPO that doesn't cover your doctor."
 */
export function qualifiesForPpoBonus(
  formulary: ReadonlyMap<string, { tier?: number | null }>,
  meds: ReadonlyArray<{ rxcui?: string }>,
  primaryProviderInNetwork: boolean,
): boolean {
  if (!primaryProviderInNetwork) return false;
  const rxcuis = meds
    .map((m) => m.rxcui)
    .filter((x): x is string => typeof x === 'string' && x.length > 0);
  if (rxcuis.length === 0) return false;
  return rxcuis.every((id) => {
    const tier = formulary.get(id)?.tier ?? null;
    return tier != null && tier <= 2;
  });
}

/**
 * R6 — universal premium penalty. Returns the composite-point hit a
 * plan takes for filing a non-$0 premium. The penalty scales linearly
 * with annual premium at $10/yr per composite point ($420/yr → 42).
 *
 * Stacks with healthyPremiumPenalty (Profile B only, tiered) — R6 fires
 * for every profile, healthy stays as the extra emphasis on top.
 *
 * Exception: when fewer than R6_ZERO_PREMIUM_FLOOR (4) $0-premium
 * plans exist in the candidate pool, the penalty halves. This keeps
 * the brain useful in "premium-rich" pools (typically smaller-county
 * SNP-only pools) where every option carries a premium and a uniform
 * large penalty would collapse meaningful between-plan ranking.
 *
 * Pool count is the responsibility of the caller — pass the number of
 * $0-premium plans in `rawScored` before iterating.
 */
export function r6PremiumPenalty(
  annualPremium: number,
  zeroPremiumPoolCount: number,
): number {
  if (annualPremium <= 0) return 0;
  const base = annualPremium / R6_DOLLARS_PER_POINT;
  return zeroPremiumPoolCount < R6_ZERO_PREMIUM_FLOOR ? base * 0.5 : base;
}

/**
 * Top 4 selector — broker formula (v4).
 *
 *   score = annual_extras − annual_premium
 *
 * Where annual_extras is the absolute dollar value of the plan's
 * supplemental benefits over a year:
 *
 *   dental annual max
 * + vision annual allowance
 * + OTC annual (extractOtcQuarterly × 4)
 * + Part B giveback × 12
 * + hearing aid allowance
 * + food card annual (SNP-only, period-detected)
 * + transportation flat $200 if filed
 * + fitness flat $300 if filed
 *
 * Plans rank by total dollar value to the consumer minus what they
 * pay in premium — this is how a licensed broker compares plans, not
 * a rank-normalized scorecard. MOOP is a display metric and a soft
 * tiebreaker only (lower MOOP wins on a score tie); it does NOT
 * appear in the ranking formula. The high-MOOP hard exclusion
 * ($9,350, CMS 2026 cap) lives upstream in plan-brain.ts.
 *
 * Replaces the v3 5-axis rank-normalized scorecard
 *   (moop 0.40 / dental 0.25 / vision 0.15 / otc 0.15 / fitness 0.05)
 * which weighted MOOP at 40% AND ignored Part B giveback entirely —
 * surfacing low-extras low-MOOP $0 plans (HealthSpring Preferred
 * Select, $1,680 extras) over giveback-rich plans (Wellcare Patriot
 * Giveback Open, $4,600 extras incl. $2,100 giveback) and missing
 * the broker's actual mental model.
 *
 * Upstream of this function, the caller has already enforced the
 * hard gates ($0 premium for standard MAPD, meds-covered, MOOP ≤
 * $9,350) and the soft cascade (dental priority, primary-provider).
 * This function is pure ranking — it doesn't re-litigate gates.
 */
// ─── Hard filter / penalty helpers ───────────────────────────────────
// Plan-type chassis classification. HMO without POS allows zero
// out-of-network care; HMO-POS allows limited OON; PPO/LPPO allows
// OON at higher cost-share. PDPs have no provider concept.
function planTypeChassis(planType: string | null | undefined): 'hmo' | 'hmo-pos' | 'ppo' | 'pdp' | 'other' {
  const t = (planType ?? '').toUpperCase();
  if (t.includes('PDP')) return 'pdp';
  if (t.includes('HMO-POS') || t.includes('HMO POS')) return 'hmo-pos';
  if (t.includes('PPO') || t.includes('LPPO')) return 'ppo';
  if (t.includes('HMO')) return 'hmo';
  return 'other';
}

// True for plans that should be hard-excluded because the user's
// provider is definitively out-of-network and the chassis doesn't
// pay for out-of-network care. Unverified plans (no cache row) and
// PPO/HMO-POS plans both fall through.
function isStrictHmoOonExcluded(s: BrainScoredPlan): boolean {
  if (!s.score.anyProviderDefinitivelyOut) return false;
  return planTypeChassis(s.row.plan_type) === 'hmo';
}

// $300 per uncovered drug, but only when at least one IS covered.
// Zero-covered plans are hard-excluded above; full-coverage plans
// pay nothing. Returns the penalty as a positive number.
const DRUG_UNCOVERED_PENALTY_PER_DRUG = 300;
function drugUncoveredPenalty(s: BrainScoredPlan): number {
  if (s.score.totalCount === 0) return 0;
  if (s.score.coveredCount === 0) return 0; // hard-excluded; no need to penalize
  if (s.score.coveredCount >= s.score.totalCount) return 0;
  const uncovered = s.score.totalCount - s.score.coveredCount;
  return uncovered * DRUG_UNCOVERED_PENALTY_PER_DRUG;
}

// $200 flat penalty when any user-entered provider is definitively out
// on a chassis that allows out-of-network care (PPO / HMO-POS). HMO
// is hard-excluded upstream; PDP has no provider concept; unverified
// reads don't penalize.
const PROVIDER_OON_PENALTY = 200;
function providerOonPenalty(s: BrainScoredPlan): number {
  if (!s.score.anyProviderDefinitivelyOut) return 0;
  const chassis = planTypeChassis(s.row.plan_type);
  if (chassis === 'ppo' || chassis === 'hmo-pos') return PROVIDER_OON_PENALTY;
  return 0;
}

function selectDiversifiedTop4(
  pool: ReadonlyArray<BrainScoredPlan>,
  // The function once consumed a passesPriorityGates predicate and a
  // dentalIntent flag; both are now upstream-of-this-function concerns
  // (the gate cascade has already applied them) so the parameters are
  // accepted but ignored to keep the call site stable. Remove on the
  // next sweep once nothing else reaches for them.
  _passesPriorityGates: (s: BrainScoredPlan) => boolean = () => true,
  options: {
    /** Standard MAPD users see a hard $0-premium gate. C-SNP / D-SNP
     *  populations skip it (their pools are smaller and a premium SNP
     *  often IS the right plan). When every plan in `pool` filed a
     *  premium > $0, falls back to the unfiltered pool with a warning
     *  rather than returning an empty list. */
    enforceZeroPremium?: boolean;
    /** No-op in the broker-formula model — dental contributes via its
     *  annual max in the score, not as a slot rule. Accepted so the
     *  call site doesn't break; safe to remove on the next pass. */
    dentalIntent?: boolean;
  } = {},
): BrainScoredPlan[] {
  if (pool.length === 0) return [];
  const enforceZeroPremium = options.enforceZeroPremium === true;

  // ── $0 premium gate ─────────────────────────────────────────────────
  // Filed monthly_premium === 0 (no giveback math — a broker describing
  // "the $0 plans" means the filed line). When fewer than 4 $0-premium
  // plans exist, backfill with non-$0 plans so the selector always
  // sees ≥4 candidates (Margaret R1 — always 4 plans). $0-premium
  // plans still rank first; backfill plans compete on broker score,
  // where their annual-premium term naturally weighs against them.
  const MIN_TOP_N = 4;
  const isZeroPremium = (s: BrainScoredPlan): boolean =>
    (s.row.monthly_premium ?? 0) === 0;
  const sourcePool: ReadonlyArray<BrainScoredPlan> = (() => {
    if (!enforceZeroPremium) return pool;
    const filtered = pool.filter(isZeroPremium);
    if (filtered.length >= MIN_TOP_N) return filtered;
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(
        `[plan-brain] selectDiversifiedTop4: only ${filtered.length} $0-premium ` +
          `plans in a pool of ${pool.length} — backfilling from non-$0 plans ` +
          `to guarantee ≥${MIN_TOP_N} candidates.`,
      );
    }
    if (filtered.length === 0) return pool;
    const seen = new Set(
      filtered.map((s) => `${s.row.contract_id}-${s.row.plan_id}`),
    );
    const backfill = pool.filter(
      (s) => !seen.has(`${s.row.contract_id}-${s.row.plan_id}`),
    );
    return [...filtered, ...backfill];
  })();

  // ── Score each plan: broker formula ─────────────────────────────────
  // r7ExtrasAnnualValue covers OTC + food (SNP) + giveback + flat
  // transport + flat fitness with the right period detection. Add
  // dental + vision + hearing on top, since those are first-class
  // dollar values a consumer compares directly.
  const scored = sourcePool.map((s) => {
    const dental = extractCategoryAnnualValue(s.benefits, 'dental');
    const vision = extractCategoryAnnualValue(s.benefits, 'vision');
    const hearing = extractCategoryAnnualValue(s.benefits, 'hearing');
    const r7 = r7ExtrasAnnualValue(s.benefits, s.row.plan_type);
    const annualExtras = dental + vision + hearing + r7;
    const annualPremium = (s.row.monthly_premium ?? 0) * 12;
    // Brain hard-filter penalties — applied after the extras-minus-
    // premium baseline. drugUncoveredPenalty fires only on
    // partial-coverage plans (zero-coverage is hard-excluded);
    // providerOonPenalty fires only on PPO / HMO-POS with a
    // definitive out-of-network read (strict HMO is hard-excluded).
    const drugPenalty = drugUncoveredPenalty(s);
    const oonPenalty = providerOonPenalty(s);
    const score = annualExtras - annualPremium - drugPenalty - oonPenalty;
    return { plan: s, annualExtras, annualPremium, drugPenalty, oonPenalty, score };
  });

  // Sort: broker score desc, MOOP asc as soft tiebreaker, then
  // contract-plan id for determinism so two runs with identical
  // inputs surface the same Top 4 ordering.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aMoop = a.plan.row.moop ?? Number.POSITIVE_INFINITY;
    const bMoop = b.plan.row.moop ?? Number.POSITIVE_INFINITY;
    if (aMoop !== bMoop) return aMoop - bMoop;
    const aKey = `${a.plan.row.contract_id}-${a.plan.row.plan_id}`;
    const bKey = `${b.plan.row.contract_id}-${b.plan.row.plan_id}`;
    return aKey.localeCompare(bKey);
  });

  return scored.slice(0, 4).map((x) => x.plan);
}

// Brain debug-mode gate. True when the URL has `?debug=true` (browser)
// or PLAN_BRAIN_DEBUG=true is in process.env (Edge Function / Node).
// Both reads are guarded so the helper is safe to call in either
// runtime — `window` and `process` are reference-checked, never assumed.
function isPlanBrainDebugEnabled(): boolean {
  try {
    const w = (globalThis as { window?: { location?: { search?: string } } }).window;
    if (w?.location?.search) {
      const sp = new URLSearchParams(w.location.search);
      const v = sp.get('debug');
      if (v && v !== '0' && v.toLowerCase() !== 'false') return true;
    }
  } catch {
    // ignore — non-browser context
  }
  try {
    const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const v = p?.env?.PLAN_BRAIN_DEBUG;
    if (v && v !== '0' && v.toLowerCase() !== 'false') return true;
  } catch {
    // ignore — non-Node context
  }
  return false;
}

// Credential suffixes the NPPES feed (and free-text provider entries)
// commonly tail a name with. We strip these before grabbing the "last
// name" so a user-typed "Kombiz Klein DO" or "KOMBIZ KLEIN, DO"
// renders as "Dr. Klein" — never "Dr. DO". Match is case-insensitive,
// optional period, optional leading comma + space.
const CREDENTIAL_SUFFIX_RE =
  /,?\s+(?:M\.?D\.?|D\.?O\.?|N\.?P\.?|P\.?A\.?-?C?|D\.?D\.?S\.?|D\.?M\.?D\.?|D\.?P\.?M\.?|D\.?C\.?|O\.?D\.?|Ph\.?D\.?|Psy\.?D\.?|R\.?N\.?|F\.?N\.?P\.?|A\.?P\.?R\.?N\.?|C\.?N\.?M\.?|MBBS|MBChB)\.?$/i;

/**
 * Pull a display-ready last name from a free-text provider name.
 * Strips a leading "Dr." / "Doctor", trims a trailing credential
 * suffix (DO/MD/NP/PA/etc.), splits on whitespace, and title-cases
 * the last remaining token. Empty input returns ''.
 */
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

/**
 * Personalized "why" text for a diversified Top 4 pick. References
 * the user's actual drugs, providers, and benefit dollars rather
 * than generic ribbon copy. Falls back to ribbonWhyText when there
 * isn't enough plan-level data to write a useful sentence.
 */
function personalizedWhy(args: {
  pick: BrainScoredPlan;
  category: 'best' | 'cheap' | 'extras' | 'value';
  weakestAxis: 'drug' | 'oop' | 'extras';
  userDrugs: ReadonlyArray<{ name: string }>;
  userProviders: ReadonlyArray<{ name: string }>;
}): string {
  const { pick, category, weakestAxis, userDrugs, userProviders } = args;
  const s = pick.score;
  const fmtUSD = (n: number) => `$${Math.round(n).toLocaleString()}`;
  const drugCount = userDrugs.length;
  const allCovered = drugCount > 0 && s.coveredCount === drugCount;
  const lowTier = s.lowTierCount;
  const docsList = userProviders
    .filter((p) => p.name)
    .slice(0, 2)
    .map((p) => `Dr. ${providerLastName(p.name)}`)
    .join(' and ');
  const docsClause = userProviders.length > 0 && s.allProvidersInNetwork
    ? `${docsList ? `${docsList} ` : 'every doctor you listed '}in-network`
    : null;
  const givebackMonthly = Math.round(s.partBGivebackAnnual / 12);
  const dentalAnnual = extractCategoryAnnualValue(pick.benefits, 'dental');
  const visionAnnual = extractCategoryAnnualValue(pick.benefits, 'vision');
  const otcAnnual = extractCategoryAnnualValue(pick.benefits, 'otc');

  const drugClause =
    drugCount === 0
      ? null
      : allCovered
        ? `Covers all ${drugCount} of your medication${drugCount === 1 ? '' : 's'}${lowTier > 0 ? ` — ${lowTier} at Tier 1–2` : ''}`
        : `Covers ${s.coveredCount} of your ${drugCount} medication${drugCount === 1 ? '' : 's'}`;

  const moopClause = pick.row.moop != null ? `MOOP ${fmtUSD(pick.row.moop)}` : null;
  const totalClause = `${fmtUSD(s.realAnnualCost.netAnnual)}/yr expected total`;

  switch (category) {
    case 'best': {
      const parts = [drugClause, docsClause, totalClause].filter(Boolean);
      return parts.length > 0 ? `${parts.join(' · ')}.` : ribbonWhyText(pick);
    }
    case 'cheap': {
      // Address the weakest axis explicitly.
      if (weakestAxis === 'drug') {
        return drugClause
          ? `${drugClause} — drug spend ${fmtUSD(s.totalAnnualDrugCost)}/yr, the lowest among your matches.`
          : ribbonWhyText(pick);
      }
      if (weakestAxis === 'oop') {
        const moopBit = moopClause ? `${moopClause} — ` : '';
        return `${moopBit}${totalClause}, the lowest combined exposure.`;
      }
      // weakestAxis === 'extras'
      const extras: string[] = [];
      if (dentalAnnual > 0) extras.push(`${fmtUSD(dentalAnnual)} dental`);
      if (visionAnnual > 0) extras.push(`${fmtUSD(visionAnnual)} vision`);
      if (otcAnnual > 0) extras.push(`${fmtUSD(otcAnnual)}/mo OTC`);
      return extras.length > 0
        ? `${extras.join(' + ')}${docsClause ? ` with ${docsClause}` : ''}.`
        : ribbonWhyText(pick);
    }
    case 'extras': {
      const extras: string[] = [];
      if (dentalAnnual > 0) extras.push(`${fmtUSD(dentalAnnual)} dental`);
      if (visionAnnual > 0) extras.push(`${fmtUSD(visionAnnual)} vision`);
      if (otcAnnual > 0) extras.push(`${fmtUSD(otcAnnual)}/mo OTC`);
      if (givebackMonthly > 0) extras.push(`$${givebackMonthly}/mo Part B giveback`);
      const lead = extras.length > 0 ? extras.join(' + ') : `${fmtUSD(s.extrasValueAnnual)}/yr in extras`;
      const tail = docsClause
        ? ` with ${docsClause}.`
        : (pick.row.monthly_premium ?? 0) === 0 ? ' on a $0 premium plan.' : '.';
      return `${lead}${tail}`;
    }
    case 'value': {
      const parts = [totalClause];
      if (drugClause) parts.unshift(drugClause);
      if (moopClause) parts.push(moopClause);
      return `${parts.join(' · ')}.`;
    }
  }
}

/**
 * Healthy-archetype premium penalty. Tiered against NET premium
 * (filed premium minus the monthly Part B giveback equivalent) so a
 * $30/mo plan with a $50/mo giveback (net = -$20) takes no penalty,
 * while a $255/mo plan stacks the full -70.
 *
 *   net > $100 → -70 composite
 *   net > $50  → -50
 *   net > $0   → -30
 *
 * Only applied for Profile B (healthy user). Profiles A/C/D ignore
 * this — their meds + provider locks make premium-only ranking
 * misleading.
 */
function healthyPremiumPenalty(netMonthlyPremium: number): number {
  if (netMonthlyPremium > 100) return 70;
  if (netMonthlyPremium > 50)  return 50;
  if (netMonthlyPremium > 0)   return 30;
  return 0;
}

// SNP classifier — same heuristic as rankTop3Live's classifySnp so
// imported plan rows whose snp_type label drifted (e.g., "Chronic
// Condition SNP - Diabetes" vs "C-SNP") still bucket correctly.
function classifySnp(row: PmPlanRow): 'D' | 'C' | 'I' | 'none' {
  const t = (row.snp_type ?? '').toLowerCase().trim();
  if (!t) return row.snp ? 'C' : 'none';
  if (t.includes('d-snp') || t.includes('dsnp') || t.includes('dual')) return 'D';
  if (t.includes('c-snp') || t.includes('csnp') || t.includes('chronic')) return 'C';
  if (t.includes('i-snp') || t.includes('isnp') || t.includes('institutional')) return 'I';
  return 'none';
}

// Strict dual-eligibility check. Returns true ONLY when the user has
// confirmed Medicaid (dsnpEligible === true). Every other value —
// false, null, undefined, 'unsure', any unexpected string — is
// treated as not-dual-eligible. CMS enrollment in a D-SNP requires
// verified dual eligibility; a defensive helper here keeps every
// downstream gate (population, pool filter, archetype) on the same
// strict definition.
function isStrictlyDualEligible(value: unknown): boolean {
  return value === true;
}

// Detect population from the user's About-You answers.
//
// Returns 'dsnp' ONLY when the user has confirmed Medicaid. Previously
// 'dsnp-unsure' was returned for `dsnpEligible === 'unsure'` so the UI
// could render D-SNP-flavored copy with a verification nudge — but that
// produced a header/filter mismatch after ac8f852: filterPlanPool was
// tightened to exclude D-SNPs when !dualEligible, so 'unsure' users
// saw "Here are your top 3 D-SNPs" with standard MAPD plans
// underneath. The unsure-nudge banner now reads
// state.dsnpEligible === 'unsure' directly in Results.tsx, independent
// of the population label.
function detectPopulation(input: BrainInputs): RankPopulation {
  const u = input.userProfile;
  if (u.csnpConditions && u.csnpConditions.length > 0) return 'csnp';
  if (isStrictlyDualEligible(u.dsnpEligible)) return 'dsnp';
  return 'standard';
}

// Healthy client = standard MAPD + < 3 meds + no chronic condition.
// For these users, between-plan medical-cost differences are minimal
// (they won't hit MOOP), so the Part B giveback becomes the biggest
// dollar lever. The brain shifts weights to HEALTHY (40/20/40) and
// adds a composite bonus for plans with giveback so one reliably
// surfaces in Top 3.
function detectIsHealthyClient(input: BrainInputs, pop: RankPopulation): boolean {
  if (pop !== 'standard') return false;
  const u = input.userProfile;
  const medCount = u.drugs.length;
  const hasCondition = (u.csnpConditions ?? []).length > 0;
  return medCount < 3 && !hasCondition;
}

// Step 1 — narrow to the plan pool the user is eligible for. CRITICAL:
// happens BEFORE any scoring so SNPs don't pollute standard MAPD
// rankings (and vice versa).
//
// D-SNP gating is hard: a plan with snp_type === 'D-SNP' is only legal
// to enroll into when the beneficiary is dual-eligible (Medicaid +
// Medicare). dualEligible must be === true — 'unsure' or null both
// fail the gate. This applies even to csnp population (a med-promoted
// diabetic who isn't on Medicaid still can't enroll in a D-SNP) and
// dsnp-unsure (unconfirmed Medicaid is the same as no Medicaid for
// pool eligibility).
function filterPlanPool(
  plans: readonly PmPlanRow[],
  pop: RankPopulation,
  dualEligible: boolean,
): PmPlanRow[] {
  return plans.filter((row) => {
    const klass = classifySnp(row);
    if (klass === 'D' && !dualEligible) return false;
    if (pop === 'dsnp' || pop === 'dsnp-unsure') {
      // D-SNP user sees D-SNPs first. We DO include 'none' (standard
      // MAPD) as a fallback when the inventory has no D-SNPs to
      // surface — better than a blank Top 3. C/I excluded.
      return klass === 'D' || klass === 'none';
    }
    if (pop === 'csnp') {
      // C-SNP pool includes C-SNP, D-SNP (only when dualEligible per
      // gate above), and 'none' as a fallback.
      return klass === 'C' || klass === 'D' || klass === 'none';
    }
    // Standard MAPD — strictly exclude every SNP plan per spec.
    return klass === 'none';
  });
}

// Plan key builders — match the keying convention used in
// usePlansRanked (with-segment for benefits, no-segment for formulary).
function planKeyWithSegment(row: PmPlanRow): string {
  return `${row.contract_id}-${row.plan_id}-${row.segment_id}`;
}
function planKeyNoSegment(row: PmPlanRow): string {
  return `${row.contract_id}-${row.plan_id}`;
}

export function runPlanBrain(input: BrainInputs): BrainOutput {
  // ── C-SNP auto-promotion ────────────────────────────────────────────
  // Detect conditions from the user's medication list. When detection
  // turns up a "certain" CSNP-eligible condition (diabetes, chf, copd,
  // ckd) but the user didn't self-report it on About-You, promote them
  // into the csnp population so the C-SNP pool becomes eligible. The
  // meds are proof — we don't make a diabetic look at standard MAPD
  // when a purpose-built diabetes C-SNP exists in their county.
  // D-SNPs still require a Medicaid signal; med detection can't infer
  // dual eligibility.
  const detectedConditions = detectConditionsFromMeds(input.userProfile.drugs);
  const certainCsnpEligible = detectedConditions.filter(
    (d) =>
      d.confidence === 'certain' &&
      (d.condition === 'diabetes' ||
        d.condition === 'chf' ||
        d.condition === 'copd' ||
        d.condition === 'ckd'),
  );
  const promotedCsnp = detectedToCsnp(certainCsnpEligible);
  const effectiveCsnpConditions = (() => {
    const set = new Set<string>(input.userProfile.csnpConditions ?? []);
    for (const c of promotedCsnp) set.add(c);
    return Array.from(set);
  })();
  // Synth an effective userProfile so detectPopulation + downstream
  // utilization derivation see the promoted conditions without us
  // mutating the caller's input.
  const effectiveInput: BrainInputs = {
    ...input,
    userProfile: {
      ...input.userProfile,
      csnpConditions: effectiveCsnpConditions as typeof input.userProfile.csnpConditions,
    },
  };
  const dualEligible = isStrictlyDualEligible(input.userProfile.dsnpEligible);
  let population = detectPopulation(effectiveInput);
  // Defense in depth — detectPopulation already returns 'standard' for
  // every non-strict-true dsnpEligible, but a future change to that
  // function (or a typo recovery) shouldn't be able to put us in a
  // 'dsnp' state without confirmed dual eligibility. Crash loud, then
  // recover to 'standard'.
  if ((population === 'dsnp' || population === 'dsnp-unsure') && !dualEligible) {
    console.error(
      `[plan-brain] population=${population} but dualEligible=false (dsnpEligible=${String(
        input.userProfile.dsnpEligible,
      )}) — forcing 'standard'. detectPopulation must never return a D-SNP label without confirmed Medicaid.`,
    );
    population = 'standard';
  }
  let eligible = filterPlanPool(input.plans, population, dualEligible);

  // ── MA-only filter ──────────────────────────────────────────────────
  // Plans without Part D drug coverage (no rows in pm_formulary) only
  // fit veterans with VA / TRICARE prescription benefits. For every
  // other Medicare beneficiary, recommending an MA-only plan means a
  // permanent Part D late-enrollment penalty (1% of the national base
  // premium per month uncovered) and zero drug cost help — a competing
  // broker beats the recommendation with any MAPD that covers their
  // meds. When `mapdContractPlanIds` is provided AND the user did not
  // signal VA coverage, drop MA-only plans from the eligible pool
  // entirely. When the signal is absent (legacy callers), behavior is
  // unchanged so we don't accidentally hide plans on caller paths
  // that haven't yet wired the input.
  if (
    input.mapdContractPlanIds &&
    input.userProfile.hasVaDrugCoverage !== true
  ) {
    const mapdSet = input.mapdContractPlanIds;
    const before = eligible.length;
    eligible = eligible.filter((p) => mapdSet.has(`${p.contract_id}-${p.plan_id}`));
    if (typeof console !== 'undefined' && console.info && before !== eligible.length) {
      console.info(
        `[plan-brain] MA-only filter: dropped ${before - eligible.length} plans without Part D ` +
          `(user.hasVaDrugCoverage=false). ${eligible.length} eligible MAPDs remain.`,
      );
    }
  }

  if (eligible.length === 0) {
    return {
      population,
      ranked: [],
      liveTop3: null,
      isHealthyClient: false,
      budgetOption: null,
      detectedConditions,
      archetype: 'general',
      medicationPatterns: [],
    };
  }

  // detectIsHealthyClient + deriveUtilization both read csnpConditions;
  // pass the effective profile so med-promoted conditions count.
  const isHealthyClient = detectIsHealthyClient(effectiveInput, population);
  const { utilization, conditionProfile } = deriveUtilization(effectiveInput.userProfile);

  // ── Broker playbook: archetype + medication patterns ─────────────────
  // Archetype is the single label that summarizes WHO this person is.
  // It's picked from a strict priority order (specialty_drug > insulin
  // > polypharmacy > multi-chronic > single-chronic > provider-locked
  // > healthy). When set to anything other than 'general', the
  // archetype's weight profile takes precedence over the older
  // population/healthy heuristic — the playbook is a more specific
  // signal. weightsOverride from the agent dashboard still wins.
  const conditionsForArchetype = unionConditionLabels(
    effectiveCsnpConditions as ReadonlyArray<CsnpCondition>,
    detectedConditions,
  );
  const archetypeProfile: ArchetypeProfile = {
    age: input.userProfile.age ?? null,
    conditions: conditionsForArchetype,
    detectedConditions,
    medications: input.userProfile.drugs,
    providerCount: input.userProfile.providers.length,
    // Only confirmed-Medicaid users (not 'unsure') flip the dual_eligible
    // archetype on. The brain still routes them into the dsnp population
    // pool for plan filtering — that's separate from the archetype gate.
    dualEligible,
  };
  const archetype = classifyArchetype(archetypeProfile);
  const medicationPatterns = detectMedicationPatterns(input.userProfile.drugs);

  // ── Broker brain v2: detect which of the four profiles this person
  //    fits, then use that profile's weights. Profile detection
  //    short-circuits the older healthy-vs-population heuristic so
  //    the brain's lens matches the consumer-facing "read the person"
  //    spec. Falls through to the legacy weight stack only when
  //    profile == null (shouldn't happen in practice — every user
  //    classifies into one of A/B/C/D).
  const brokerProfile = detectClientProfile({
    medCount: input.userProfile.drugs.length,
    providerCount: input.userProfile.providers.length,
    hasSpecialtyDrug: detectSpecialtyDrug(input.userProfile.drugs),
    // Align "chronic" with the broker playbook's definition (excludes
    // hypertension + depression + pain_management). Without this, a
    // healthy 65-year-old on Lisinopril alone classified as Profile A
    // (sick) and bypassed the premium penalty — the bug Rob saw with
    // Aetna Value Plus surfacing in Top 3.
    hasChronicCondition:
      effectiveCsnpConditions.some((c) => CHRONIC_CONDITION_KEYS.has(c)) ||
      detectedConditions.some(
        (d) =>
          (d.confidence === 'certain' || d.confidence === 'likely') &&
          CHRONIC_CONDITION_KEYS.has(d.condition),
      ),
  });
  const profileWeights = PROFILE_WEIGHTS[brokerProfile];
  // The legacy 3-axis scoring math reads {drug, oop, extras} only —
  // the copay axis (Profile C) is folded into composite separately
  // below so we can keep BrainWeights untouched.
  const playbookWeights =
    archetype !== 'general' ? ARCHETYPE_RULES[archetype].weights : null;
  const legacyBaseWeights =
    input.weightsOverride ??
    playbookWeights ??
    (isHealthyClient ? WEIGHTS_HEALTHY : defaultWeightsFor(population));
  // Renormalize the broker-profile weights into the BrainWeights
  // shape (drug + oop + extras = 1) so existing consumers of
  // s.score.composite see a 0..100 number. The copay weight is
  // applied as a separate additive term during composite assembly
  // below.
  const profileBrainWeights = (() => {
    const triadSum = profileWeights.drug + profileWeights.oop + profileWeights.extras;
    if (triadSum <= 0) return legacyBaseWeights;
    return {
      drug:   profileWeights.drug   / triadSum,
      oop:    profileWeights.oop    / triadSum,
      extras: profileWeights.extras / triadSum,
    };
  })();
  const baseWeights = input.weightsOverride ?? profileBrainWeights;
  const weights =
    input.userProfile.drugs.length === 0
      ? noDrugsRedistribution(baseWeights)
      : baseWeights;

  const userProviderNpis = (input.userProfile.providers ?? [])
    .map((p) => p.npi)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);

  // ── Real annual cost setup ──────────────────────────────────────────
  // The utilization model needs a flat list of UtilizationCondition
  // keys. Source it from the union of:
  //   1. effectiveCsnpConditions — user-self-reported on About-You
  //      plus any C-SNP conditions auto-promoted from meds above.
  //   2. detectedConditions where confidence >= 'likely' — covers
  //      hypertension and similar non-CSNP conditions that won't
  //      appear in csnpConditions but still drive utilization.
  // 'possible' is intentionally excluded — a single anti-hypertensive
  // alone shouldn't promote the user to the hypertension utilization
  // profile (could just as easily be heart-rate management).
  const utilizationConditions = unionUtilizationConditions(
    effectiveCsnpConditions as ReadonlyArray<CsnpCondition>,
    detectedConditions,
  );
  const annualUtilization = combineUtilization(utilizationConditions);
  const isDiabetic = utilizationConditions.includes('diabetes');

  // ── Per-plan raw figures (drug cost, medical cost, extras $) ────────
  // We compute the raw numbers first, then normalize across the pool
  // so the score axes are comparable.
  const rawScored: BrainScoredPlan[] = eligible.map((row) => {
    const benefits = input.benefitsByPlanKey.get(planKeyWithSegment(row)) ?? [];
    const formulary = input.formularyByPlanKey.get(planKeyNoSegment(row)) ?? new Map();

    // Drug cost — sum of per-drug yearly estimates
    const planDrugCache = input.drugCostCacheByPlanKey?.get(planKeyWithSegment(row));
    const drugEstimates = input.userProfile.drugs.map((d) =>
      estimateDrugYearlyCost({
        rxcui: d.rxcui,
        name: d.name,
        formulary,
        benefits,
        cache: planDrugCache,
        rxcuiToNdc: input.rxcuiToNdc,
      }),
    );
    const totalAnnualDrugCost = drugEstimates.reduce((s, x) => s + x.yearlyCost, 0);
    const coveredCount = drugEstimates.filter((x) => x.covered).length;
    const lowTierCount = drugEstimates.filter((x) => x.tier != null && x.tier <= 2).length;
    const totalCount = drugEstimates.length;

    // Medical cost — utilization × per-service copay (capped at MOOP).
    // Cancer-profile patients almost always exhaust their MOOP via
    // Part B chemo + frequent imaging. Skip the line-item math and
    // assume the full MOOP — produces a more realistic ranking
    // signal. Plans with lower MOOPs win.
    const moopBenefit = benefitByCategory(benefits, 'moop_in');
    const moopAmount =
      moopBenefit?.coverage_amount ?? moopBenefit?.copay ?? row.moop ?? null;
    const annualMedicalCost = conditionProfile?.assumeMoopHit && moopAmount != null
      ? moopAmount
      : annualMedicalCostFromUtilization(benefits, utilization, moopAmount);

    // Total OOP — premium + medical + drug, minus Part B giveback
    const annualPremium = (row.monthly_premium ?? 0) * 12;
    const partBGivebackBenefit = benefitByCategory(benefits, 'partb_giveback');
    const partBGivebackAnnual =
      ((partBGivebackBenefit?.coverage_amount ?? partBGivebackBenefit?.copay) ?? 0) * 12;
    const totalOOPEstimate =
      annualPremium + annualMedicalCost + totalAnnualDrugCost - partBGivebackAnnual;

    // Extras — dollarized per category. Two boosts compose:
    // user-priority categories doubled (2×), condition-key extras
    // boosted 1.5× (food card for diabetes, transport for COPD, etc.).
    const extrasValueAnnual = annualExtrasValue(
      benefits,
      input.userProfile.priorities,
      conditionProfile?.keyExtras ?? [],
    );

    // Supply coverage — for each user-selected supply, decide if the
    // plan covers it. Covered supplies add their annualValue to extras
    // (e.g. CGM = $3,600/yr). Gaps surface on Plan Detail and the
    // Top 3 cards. Same condition profile that drives utilization.
    const supplyCoverage = computeSupplyCoverage(
      benefits,
      input.userProfile.conditionSupplies ?? [],
      conditionProfile,
    );
    const suppliesExtrasValue = suppliesValueAnnual(supplyCoverage);
    const suppliesCovered = supplyCoverage.filter((c) => c.status === 'covered').length;
    const suppliesTotal = supplyCoverage.length;
    const suppliesGaps = supplyCoverage
      .filter((c) => c.status !== 'covered')
      .map((c) => ({
        key: c.supply.key,
        humanLabel: c.supply.humanLabel,
        reason: c.status as 'not_covered' | 'brand_mismatch',
      }));

    // Provider network status — soft adjuster on composite, hard
    // disqualifier when EVERY provider is out (allProvidersOutOfNetwork
    // is filtered out of Top 3 below). Two signal sources, priority
    // order:
    //   1. providerNetworkByPlanKey — per-NPI cache from
    //      pm_provider_network_cache. Granular and definitive.
    //   2. verifiedInNetworkContracts — session-derived Set of
    //      contract_ids whose verified providers are all in-network.
    //      Coarser (one bit per contract); cannot derive allOut.
    const providerCache = input.providerNetworkByPlanKey?.get(planKeyNoSegment(row));
    let allInNet = false;
    let anyOut = false;
    let allOut = false;
    // ── New hard-filter signals ──────────────────────────────────────
    // Split the legacy "out or absent" bucket so the brain can apply a
    // strict-HMO hard exclusion only on definitive out-of-network reads
    // (covered === false), and surface "Network status unverified" as a
    // tradeoff-only flag when the cache has no row for an NPI.
    let anyDefinitelyOut = false;
    let anyUnverified = false;
    // Primary = first provider in the user's array, with a non-empty
    // NPI. If the first provider has no NPI we can't confirm; treat
    // primary-in-network as false. Used by the moop_penalty override.
    const primaryProviderNpi = input.userProfile.providers?.[0]?.npi ?? null;
    let primaryInNet = false;
    if (providerCache && userProviderNpis.length > 0) {
      // Per commit 540aece: pm_provider_network_cache is the
      // exhaustive scrape result for NC, so a missing row for a
      // (plan, NPI) pair counts as out_of_network for the legacy
      // allInNet/anyOut/allOut booleans (kept for backward compat).
      // The new anyDefinitelyOut / anyUnverified flags split the
      // signal so HMO-OON hard-exclusion only fires on the strict
      // covered=false read, never on the absent case.
      let inNet = 0;
      let outOrAbsent = 0;
      for (const npi of userProviderNpis) {
        const c = providerCache.get(npi);
        if (c?.covered === true) {
          inNet += 1;
        } else {
          outOrAbsent += 1;
          if (c && c.covered === false) anyDefinitelyOut = true;
          else anyUnverified = true;
        }
      }
      allInNet = inNet === userProviderNpis.length;
      anyOut = outOrAbsent > 0;
      allOut = inNet === 0;
      if (primaryProviderNpi) {
        primaryInNet = providerCache.get(primaryProviderNpi)?.covered === true;
      }
    } else if (input.verifiedInNetworkContracts && userProviderNpis.length > 0) {
      // Coarser path — only know whether every provider is verified
      // in-network on this contract. Can't derive allOut from this
      // signal alone, so allOut stays false (no disqualification on
      // partial data). Primary-in-network is true here only when the
      // contract-level signal confirms ALL verified providers are in,
      // which is the strictest read available without per-NPI data.
      allInNet = input.verifiedInNetworkContracts.has(row.contract_id);
      primaryInNet = allInNet && primaryProviderNpi != null;
      // Without per-NPI data we can't say "definitively out" for any
      // provider — so anyDefinitelyOut stays false. Treat anything not
      // confirmed in-network as unverified so the consumer sees the
      // "call to confirm" banner instead of a hard exclusion.
      if (!allInNet) anyUnverified = true;
    } else if (userProviderNpis.length > 0) {
      // User entered providers but neither cache is available. No
      // signal — treat as unverified so the UI prompts to confirm.
      anyUnverified = true;
    }

    const costBreakdown = buildCostBreakdown({
      conditionProfile,
      benefits,
      utilization,
      drugEstimates,
      annualMedicalCost,
      totalAnnualDrugCost,
      totalOOPEstimate,
      partBGivebackAnnual,
      annualPremium,
      isHealthyClient,
      medCount: input.userProfile.drugs.length,
    });

    // Real annual cost from the utilization model — premium + drugs +
    // medical (utilization × per-service copay) + supplies + expected
    // ER + expected hospital − giveback, with the medical bucket
    // capped at MOOP. Replaces totalOOPEstimate as the OOP axis input
    // because totalOOPEstimate omits ER/hospital risk and supplies,
    // which are the dominant differentiators for chronic-condition
    // patients (a $0-premium plan with a $9k MOOP and no diabetic
    // supplies coverage is NOT cheaper than a C-SNP for a diabetic).
    const realAnnualCost = calculateRealAnnualCost({
      annualPremium,
      totalAnnualDrugCost,
      partBGivebackAnnual,
      moopInNetwork: moopAmount,
      utilization: annualUtilization,
      isDiabetic,
      copays: {
        pcp: copayForCategory(benefits, 'primary_care'),
        specialist: copayForCategory(benefits, 'specialist'),
        lab: copayForCategory(benefits, 'lab'),
        imaging: copayForCategory(benefits, 'imaging'),
        telehealth: copayForCategory(benefits, 'telehealth'),
        er: copayForCategory(benefits, 'emergency'),
        inpatientPerDay: copayForCategory(benefits, 'inpatient'),
        // 'insulin' category is populated by import-pbp-benefits.ts's
        // B15 IRA extractor — copay carries the IRA $35/mo Part B
        // insulin cap. $0 on plans that waive copay at the cap, $35
        // on most MA plans. PDPs leave it unfiled (no Part B exposure).
        diabeticSupplies: copayForCategory(benefits, 'insulin'),
      },
    });

    // Dental tier — read once per plan from the merged benefits list.
    // Same util the Report Card calls so the displayed tier matches
    // the tier the brain scored on.
    const dentalTier = classifyPlanDentalTier(benefits);

    const score: BrainScore = {
      drugCostScore: 0,
      oopCostScore: 0,
      extraBenefitsScore: 0,
      composite: 0,
      totalAnnualDrugCost,
      annualMedicalCost,
      totalOOPEstimate,
      extrasValueAnnual: extrasValueAnnual + suppliesExtrasValue,
      coveredCount,
      totalCount,
      lowTierCount,
      allProvidersInNetwork: allInNet,
      anyProviderOutOfNetwork: anyOut,
      allProvidersOutOfNetwork: allOut,
      anyProviderDefinitivelyOut: anyDefinitelyOut,
      anyProviderUnverified: anyUnverified,
      primaryProviderInNetwork: primaryInNet,
      suppliesCovered,
      suppliesTotal,
      suppliesGaps,
      ribbon: null,
      costBreakdown,
      partBGivebackAnnual,
      realAnnualCost,
      annualUtilization,
      appliedBrokerRules: [],
      redFlags: [],
      disqualifiedByRedFlag: false,
      priorityChecks: [],
      tradeoffWarnings: [],
      dentalTier,
    };
    return { row, benefits, formulary, score };
  });

  // ── Normalize each axis across the pool ─────────────────────────────
  // OOP axis now reads realAnnualCost.netAnnual instead of
  // totalOOPEstimate so the ranking reflects the full condition-aware
  // calendar-year cost (premium + drugs + medical + supplies + ER risk
  // + hospital risk − giveback, capped at MOOP) rather than the older
  // estimate that ignored ER/hospital risk and supplies — those are
  // the differentiators that matter most for chronic-condition users.
  const drugInverse = normalizeInverse(rawScored.map((s) => s.score.totalAnnualDrugCost));
  const oopInverse = normalizeInverse(rawScored.map((s) => s.score.realAnnualCost.netAnnual));
  const extrasDirect = normalizeDirect(rawScored.map((s) => s.score.extrasValueAnnual));
  // ── Profile C copay axis ────────────────────────────────────────────
  // Sum of per-visit copays the consumer pays before MOOP — primary
  // care, specialist, and ER. Lower total = higher score. Only
  // weighted into composite for Profile C (regular doctor visits
  // matter for them); other profiles still see the value computed
  // (cheap, deterministic) but at weight 0.
  const copaySumByPlan = rawScored.map((s) =>
    (copayForCategory(s.benefits, 'primary_care') ?? 0) +
    (copayForCategory(s.benefits, 'specialist') ?? 0) +
    (copayForCategory(s.benefits, 'emergency') ?? 0),
  );
  const copayInverse = normalizeInverse(copaySumByPlan);

  // Resolve user priority + threshold context once for the whole pool.
  // The Priorities screen ("What matters most?") writes
  // FlowState.priorityThresholds for tier picks; toggle-only priorities
  // (low_moop / hearing / fitness / etc.) just appear in priorities.
  const userPriorities = input.userProfile.priorities ?? new Set<string>();
  const userThresholds = input.userProfile.priorityThresholds ?? {};
  // Hoisted for the per-plan forEach below (R2 dental bonus reads
  // wantsDental at L1119). Originally declared in the cascade block;
  // referencing it from inside rawScored.forEach without hoisting
  // produces a TDZ error in production builds (minified `wantsDental`
  // becomes `M`, the loop body accesses it before the cascade
  // declaration runs).
  const wantsDental = userPriorities.has('dental');
  const dentalThreshold = userThresholds.dental ?? 0;
  // R6 — count of $0-premium plans in the candidate pool. Drives the
  // R6 exception: when fewer than R6_ZERO_PREMIUM_FLOOR $0 plans
  // exist, the penalty halves so the brain still ranks meaningfully
  // among premium-only pools (typical for small-county SNPs).
  const zeroPremiumPoolCount = rawScored.reduce(
    (n, s) => ((s.row.monthly_premium ?? 0) === 0 ? n + 1 : n),
    0,
  );

  // Per-plan debug state captured during composite assembly. Read
  // back when isPlanBrainDebugEnabled() emits the structured Top-3
  // dump. Keyed `${contract_id}-${plan_id}`.
  const debugByPlanKey = new Map<
    string,
    {
      monthlyPremium: number;
      netMonthlyPremium: number;
      premiumPenalty: number;
      isHealthyForPremium: boolean;
      dentalTier: 'preventive' | 'basic' | 'comprehensive';
      dentalTier1Penalty: number;
      dentalBonus: number;
      nonDentalBonus: number;
      ppoBonus: number;
      r6Penalty: number;
      r7Bonus: number;
      r7AnnualDollars: number;
      planType: string | null;
      moop: number | null;
      dentalAnnual: number;
    }
  >();

  rawScored.forEach((s, i) => {
    s.score.drugCostScore = drugInverse[i];
    s.score.oopCostScore = oopInverse[i];
    // ── Priority-adjusted extras axis ─────────────────────────────────
    // When the user selected at least one priority, replace the legacy
    // pool-normalized extras score (extrasDirect — extrasValueAnnual
    // ranked across the candidate pool) with a proportional 0..100
    // average of the per-priority scores. Each picked priority
    // contributes equally; tier-pickers score planValue / threshold
    // (capped at 1.0), toggles score 1 or 0. When no priority is set,
    // the legacy normalized axis stays.
    const checks = evaluatePriorityChecks({
      benefits: s.benefits,
      moop: s.row.moop ?? null,
      partBGivebackAnnual: s.score.partBGivebackAnnual,
      drugCostScore: s.score.drugCostScore,
      priorities: userPriorities,
      thresholds: userThresholds,
    });
    s.score.priorityChecks = checks;
    if (checks.length > 0) {
      const priorityMatchAvg =
        checks.reduce((sum, c) => sum + c.score, 0) / checks.length;
      s.score.extraBenefitsScore = Math.round(priorityMatchAvg * 100);
    } else {
      s.score.extraBenefitsScore = extrasDirect[i];
    }
    // ── Composite assembly per broker profile ───────────────────────
    // Weighted triad (drug + oop + extras) using the profile-aware
    // weights computed up top, plus an additive copay term that only
    // matters for Profile C. Each axis is 0..100 already, so the
    // composite stays roughly 0..100 before adjusters.
    const copayScore = copayInverse[i];
    let composite =
      s.score.drugCostScore * weights.drug +
      s.score.oopCostScore * weights.oop +
      s.score.extraBenefitsScore * weights.extras +
      copayScore * profileWeights.copay;
    // ── R2 — proportional dental bonus (Margaret) ───────────────────
    // Dental is universally important to seniors, so the proportional
    // bonus fires for every plan. When the user picked dental as a
    // priority, multiplied by 1.5×. Replaces the older flat
    // PRIORITY_MATCH_BONUS pathway for dental specifically.
    const dentalAnnualForBonus = extractCategoryAnnualValue(s.benefits, 'dental');
    const dentalBonus = dentalProportionalBonus(dentalAnnualForBonus, wantsDental);
    composite += dentalBonus;
    // ── Non-dental priority bonus ───────────────────────────────────
    // Vision / OTC / fitness / hearing keep the legacy proportional
    // shape: avg over the user's *non-dental* priority checks × 50.
    // Capped at +50 when the plan satisfies every non-dental ask
    // perfectly. Dental was already handled above, so we exclude it
    // from this average to avoid double-counting.
    const nonDentalChecks = checks.filter((c) => c.priority !== 'dental');
    let nonDentalBonus = 0;
    if (nonDentalChecks.length > 0) {
      const avg =
        nonDentalChecks.reduce((sum, c) => sum + c.score, 0) /
        nonDentalChecks.length;
      nonDentalBonus = avg * NON_DENTAL_PRIORITY_BONUS;
      composite += nonDentalBonus;
    }
    // ── R3 — PPO preference bonus (Margaret) ────────────────────────
    // PPO/HMO-POS plans get a bonus when:
    //   1. ≥1 priced med + every priced med on tier 1 or 2
    //   2. Primary provider in-network
    // Without these guards the bonus would push PPOs ahead even when
    // they undercut the user on drug coverage or doctor access.
    const ppoBonus = qualifiesForPpoBonus(
      s.formulary,
      input.userProfile.drugs,
      s.score.primaryProviderInNetwork,
    )
      ? ppoChassisBonus(s.row.plan_type)
      : 0;
    composite += ppoBonus;
    // Provider integration — soft boost when every provider is
    // covered. The PENALTY arm is now profile-aware (see hard-filter
    // block below).
    if (s.score.allProvidersInNetwork) composite += PROVIDER_BOOST_ALL_IN_NET;
    // ── HARD provider filter for A/C with 2+ providers ───────────────
    // Per broker spec: Profile A (sick) and C (balance) users with
    // 2+ providers should NEVER see a plan that drops one of their
    // doctors in the top picks. We apply a -50 penalty (vs the
    // legacy soft -10) so the plan reliably falls below the
    // diversification cutoff. The plan stays in `ranked[]` so the
    // full-list view still surfaces it; the diversified Top 4
    // picker downstream skips it. Profile B (healthy / 0-1 doc) and
    // D (specialty drug — will switch doctors for the right drug
    // coverage) keep the soft -10 penalty.
    const isProviderLockedProfile =
      (brokerProfile === 'A' || brokerProfile === 'C') &&
      input.userProfile.providers.length >= 2;
    if (s.score.anyProviderOutOfNetwork) {
      composite -= isProviderLockedProfile ? 50 : PROVIDER_PENALTY_ANY_OUT;
    }
    // Healthy client signal — fires when EITHER the broker profile
    // detector classified the user as B (healthy / few meds) OR the
    // archetype classifier landed on healthy_newly_eligible /
    // healthy_established. Belt-and-suspenders: a future change to
    // either classifier shouldn't be able to silently turn off the
    // premium penalty for a healthy newly-eligible user.
    const isHealthyForPremium =
      brokerProfile === 'B' ||
      archetype === 'healthy_newly_eligible' ||
      archetype === 'healthy_established';
    if (isHealthyForPremium && s.score.partBGivebackAnnual > 0) {
      // Healthy-client giveback boost — promotes plans with a Part B
      // giveback since the giveback is the biggest dollar
      // differentiator for users with minimal medical costs.
      composite += HEALTHY_GIVEBACK_BOOST;
    }
    // Healthy-client premium penalty — broker rule from Rob. NET
    // monthly premium = filed premium minus the monthly Part B
    // giveback equivalent, so a $30/mo plan with a $50/mo giveback
    // (net = -$20) takes no penalty.
    let premiumPenalty = 0;
    let netMonthlyPremium = (s.row.monthly_premium ?? 0) - s.score.partBGivebackAnnual / 12;
    if (isHealthyForPremium) {
      premiumPenalty = healthyPremiumPenalty(netMonthlyPremium);
      composite -= premiumPenalty;
    }
    // R6 — universal premium penalty. Stacks on top of the
    // Profile-B-only healthyPremiumPenalty above. R6 fires for every
    // profile because premium dollars are real money for every client,
    // not just healthy ones; the healthy penalty stays as the extra
    // emphasis on Profile B's premium sensitivity. $10/yr → 1
    // composite point, halved when the candidate pool has fewer than
    // 4 $0-premium options.
    const annualPremiumForR6 = (s.row.monthly_premium ?? 0) * 12;
    const r6Penalty = r6PremiumPenalty(annualPremiumForR6, zeroPremiumPoolCount);
    if (r6Penalty > 0) composite -= r6Penalty;
    // R7 — extras dollar-value bonus. Annual dollars from OTC, food
    // card (SNP-only), Part B giveback (×12), transportation (flat
    // $200), and fitness (flat $300), converted to composite points
    // at the same $10/yr rate as R6. The extras axis above is
    // rank-normalized 0..100, which compresses absolute dollar
    // differences within a tight pool — R7 surfaces the actual
    // dollar value as a composite-point bonus on top, so a $1,200/yr
    // extras bundle reliably outranks a $300/yr bundle by ~90 points.
    const r7AnnualDollars = r7ExtrasAnnualValue(s.benefits, s.row.plan_type);
    const r7Bonus = r7AnnualDollars / R7_DOLLARS_PER_POINT;
    if (r7Bonus > 0) composite += r7Bonus;
    // Tier-1 dental penalty — fires only when the user picked dental
    // as a priority. The dollar-threshold gate already filters $0
    // dental, but a "$1,500 preventive-only annual max" plan slips
    // through (passes a $1,000 threshold) even though it doesn't
    // cover crowns. classifyPlanDentalTier reads description + dollar
    // together to expose that, and we drop the composite enough that
    // a comprehensive alternative in the same county outranks it.
    const dentalTier1Penalty =
      userPriorities.has('dental') && s.score.dentalTier === 'preventive'
        ? DENTAL_TIER1_PENALTY
        : 0;
    if (dentalTier1Penalty > 0) composite -= dentalTier1Penalty;
    // R8 — priority threshold failure penalty (see constant docstring).
    // Fires once per tier-picker priority where threshold > 0 and the
    // plan's score is < 1.0 (below threshold or benefit absent).
    let thresholdFailPenalty = 0;
    for (const c of checks) {
      const isThresholded =
        c.priority === 'dental' ||
        c.priority === 'vision' ||
        c.priority === 'otc' ||
        c.priority === 'partb_giveback';
      if (!isThresholded) continue;
      const t = userThresholds[c.priority as 'dental' | 'vision' | 'otc' | 'partb_giveback'] ?? 0;
      if (t > 0 && !c.meets) thresholdFailPenalty += PRIORITY_THRESHOLD_FAIL_PENALTY;
    }
    if (thresholdFailPenalty > 0) composite -= thresholdFailPenalty;
    debugByPlanKey.set(`${s.row.contract_id}-${s.row.plan_id}`, {
      monthlyPremium: s.row.monthly_premium ?? 0,
      netMonthlyPremium,
      premiumPenalty,
      isHealthyForPremium,
      dentalTier: s.score.dentalTier,
      dentalTier1Penalty,
      // Margaret rule breakdown — surfaced in the Top-N logger below
      // so per-plan composite math is auditable in production.
      dentalBonus,
      nonDentalBonus,
      ppoBonus,
      r6Penalty,
      r7Bonus,
      r7AnnualDollars,
      planType: s.row.plan_type ?? null,
      moop: s.row.moop ?? null,
      dentalAnnual: dentalAnnualForBonus,
    });
    // ── Tradeoff warnings ──────────────────────────────────────────────
    s.score.tradeoffWarnings = detectTradeoffs({
      moop: s.row.moop ?? null,
      partBGivebackAnnual: s.score.partBGivebackAnnual,
      dentalAnnual: extractCategoryAnnualValue(s.benefits, 'dental'),
      premium: (s.row.monthly_premium ?? 0) * 12,
      priorities: userPriorities,
      thresholds: userThresholds,
      providerDefinitivelyOut: s.score.anyProviderDefinitivelyOut,
      providerUnverified: s.score.anyProviderUnverified,
      planChassis: planTypeChassis(s.row.plan_type),
    });
    s.score.composite = Math.round(composite * 100) / 100;
  });

  // ── Broker decision rules ───────────────────────────────────────────
  // Med-derived condition detection + the 12 declarative broker rules
  // run AFTER axis-composite scoring and BEFORE the sort/ribbon pass.
  // Each rule can adjust composite (boost / penalty) or fire as a pure
  // flag (points: 0) to attach a reason without changing rank. The
  // applied list is captured on BrainScore.appliedBrokerRules so the
  // UI can surface broker reasoning per plan.
  // Reuses the detectedConditions + effectiveCsnpConditions computed
  // at the top of this function (also drove the C-SNP auto-promotion).
  const csnpUnion = new Set<string>(effectiveCsnpConditions);
  const clientProfile: ClientProfile = {
    age: input.userProfile.age ?? null,
    conditions: csnpUnion,
    detectedConditions,
    medications: input.userProfile.drugs,
    providerCount: input.userProfile.providers.length,
    isHealthyClient,
  };
  // Capture pre-rule composite per plan so the debug log can show the
  // score shift from broker-rule application.
  const preRuleComposite = new Map<string, number>();
  for (const s of rawScored) {
    preRuleComposite.set(`${s.row.contract_id}-${s.row.plan_id}`, s.score.composite);
    const { adjustment, applied } = applyBrokerRules(clientProfile, s);
    s.score.composite = Math.round((s.score.composite + adjustment) * 100) / 100;
    s.score.appliedBrokerRules = applied;
  }

  // ── Red flag pass ───────────────────────────────────────────────────
  // Per-plan evaluation against the archetype's subscribed flag
  // families. Penalize flags fold their (negative) points into
  // composite; disqualify flags set the disqualifiedByRedFlag bit and
  // get filtered out of Top 3 selection below alongside
  // allProvidersOutOfNetwork. warn/flag actions just attach to the
  // score for UI surfacing without changing the rank.
  for (const s of rawScored) {
    const flags = evaluateRedFlags(archetypeProfile, archetype, s);
    if (flags.length === 0) continue;
    let penalty = 0;
    let disqualify = false;
    for (const f of flags) {
      if (f.action === 'penalize' && f.points) penalty += f.points;
      if (f.action === 'disqualify') disqualify = true;
    }
    if (penalty !== 0) {
      s.score.composite = Math.round((s.score.composite + penalty) * 100) / 100;
    }
    s.score.redFlags = flags;
    s.score.disqualifiedByRedFlag = disqualify;
  }

  // ── Sort + assign ribbons ───────────────────────────────────────────
  // Deterministic tiebreaker — when composites are equal (rare but
  // happens on small pools or after rule-rounding), break by combined
  // contract-plan id alphabetically. Without this Array.prototype.sort
  // is allowed to be non-stable across V8 versions / pool orderings,
  // so two runs with identical inputs could surface different Top 3s
  // when ties exist on the boundary.
  rawScored.sort((a, b) => {
    if (b.score.composite !== a.score.composite) {
      return b.score.composite - a.score.composite;
    }
    const aKey = `${a.row.contract_id}-${a.row.plan_id}`;
    const bKey = `${b.row.contract_id}-${b.row.plan_id}`;
    return aKey.localeCompare(bKey);
  });

  // Priority gates for top-pick badges and diversified Top 4 leader
  // slots. Fire when the user picked dental and/or vision as
  // priorities. Apply to EVERY ribbon (not just BEST_OVERALL /
  // BEST_EXTRAS) — a plan that fails the user's stated dental or
  // vision threshold can't claim "Lowest OOP" or "Lowest Drug Cost"
  // either. The bug we shipped before this fix: Wellcare Giveback
  // Open ($45 dental) won "Lowest OOP" while the user had asked for
  // $2,000+ dental, because cost-leader ribbons used to skip the gate.
  //
  // Per-category logic:
  //
  //   Dental:
  //     - threshold > 0   → plan dental annual must meet/exceed it
  //     - threshold == 0  → "any" tier; plan must have SOME filed
  //                          dental ("dental not filed" = automatic
  //                          fail when dental was a stated priority).
  //   Vision:
  //     - threshold > 0   → plan EYEWEAR allowance (the value
  //                          extractCategoryAnnualValue returns for
  //                          'vision' — exam is usually $0) must
  //                          meet/exceed it.
  //     - threshold == 0  → "Any" tier passes if the plan has ANY
  //                          vision benefit row, including exam-only
  //                          plans. Vision exam alone counts.
  //
  // Cascade fallback (applied below): when fewer than 3 plans pass
  // the strict gate, halve tiered thresholds; if still <3, drop to
  // "any coverage" in each category; if still <3, disable gates and
  // flag the result so the UI can show a "no plans fully match" banner.
  // ── Unified gate cascade (broker brain v3 — horse race) ────────────
  // Vision priority is no longer a gate (it's a scorecard factor in
  // the horse-race model). Two soft gates remain — dental priority
  // and primary-provider — and they relax in order: dental first,
  // then primary-provider. The hard gates ($0 premium, meds-covered,
  // MOOP ≤ $6,500) live downstream and never relax.
  //
  // Cascade walks combos top-down and stops at the first that yields
  // ≥4 plans. If we run off the end, the last (most-relaxed) combo
  // wins so the slate isn't empty in thin-pool counties.
  // wantsDental + dentalThreshold are now hoisted near userPriorities
  // (above the per-plan forEach) so the R2 dental bonus block can
  // read wantsDental without hitting a TDZ error.

  type GateRelaxation = 'strict' | 'half' | 'any' | 'disabled';
  const buildDentalGate = (relax: GateRelaxation) =>
    (s: BrainScoredPlan): boolean => {
      if (!wantsDental || relax === 'disabled') return true;
      const annual = extractCategoryAnnualValue(s.benefits, 'dental');
      const threshold =
        relax === 'any' ? 0
        : relax === 'half' ? Math.floor(dentalThreshold / 2)
        : dentalThreshold;
      return threshold > 0 ? annual >= threshold : annual > 0;
    };

  type ProviderGateMode = 'strict' | 'loose' | 'off';
  const userHasProvidersWithNpis = (input.userProfile.providers ?? []).some(
    (p) => typeof p.npi === 'string' && p.npi.length > 0,
  );
  const buildProviderGate = (mode: ProviderGateMode) =>
    (s: BrainScoredPlan): boolean => {
      if (!userHasProvidersWithNpis || mode === 'off') return true;
      if (mode === 'strict') return s.score.primaryProviderInNetwork;
      // 'loose' — at least one provider in-network (the v2 default).
      return !s.score.allProvidersOutOfNetwork;
    };

  // Hard filter — never relaxed. Red-flagged plans always drop. The
  // zero-drug-coverage drop is gated on whether the formulary system
  // actually returned data: if EVERY plan in the pool came back with
  // an empty formulary map, the lookup itself is broken (rxcui
  // mismatch, brand-vs-generic resolution failure, missing
  // pm_formulary rows for this slate) and we'd be punishing 60+ plans
  // for a data-pipeline bug. In that case, keep all plans and let the
  // axis scoring soft-penalize them. When at least one plan in the
  // pool DOES have formulary data, the lookup works and a plan-
  // specific zero-coverage signal is real → drop those plans.
  const userHasDrugs = input.userProfile.drugs.length > 0;
  const poolHasAnyFormulary = rawScored.some((s) => s.formulary.size > 0);
  const passesHardFilter = (s: BrainScoredPlan): boolean => {
    if (s.score.disqualifiedByRedFlag) return false;
    if (
      userHasDrugs &&
      poolHasAnyFormulary &&
      s.score.totalCount > 0 &&
      s.score.coveredCount === 0
    ) {
      return false;
    }
    // HMO + provider definitively out-of-network → exclude. HMO without
    // POS doesn't pay for out-of-network care at all, so the plan can't
    // be a "best for you" no matter how strong the extras. PPO and
    // HMO-POS chassis fall through and pay the -200 broker-score penalty
    // in selectDiversifiedTop4 instead. Unverified (no cache row)
    // plans pass the filter — see anyProviderDefinitivelyOut docstring.
    if (isStrictHmoOonExcluded(s)) return false;
    return true;
  };
  const hardPool = rawScored.filter(passesHardFilter);
  if (
    typeof console !== 'undefined' &&
    console.warn &&
    userHasDrugs &&
    !poolHasAnyFormulary &&
    rawScored.length > 0
  ) {
    console.warn(
      `[plan-brain] formulary data gap: ${rawScored.length} plans in pool, ` +
        `0 returned any formulary entries for the user's drugs. ` +
        `Skipping zero-drug-coverage hard filter to avoid wiping the slate ` +
        `(likely cause: brand→generic rxcui resolution, or missing pm_formulary rows).`,
    );
  }

  const cascade: ReadonlyArray<{ dental: GateRelaxation; provider: ProviderGateMode }> = [
    { dental: 'strict',   provider: 'strict' },
    { dental: 'half',     provider: 'strict' },
    { dental: 'any',      provider: 'strict' },
    { dental: 'disabled', provider: 'strict' },
    { dental: 'disabled', provider: 'loose'  },
    { dental: 'disabled', provider: 'off'    },
  ];
  const MIN_POOL = 4;
  let activeCombo = cascade[0];
  let activeDentalGate = buildDentalGate(activeCombo.dental);
  let activeProviderGate = buildProviderGate(activeCombo.provider);
  for (const combo of cascade) {
    const dg = buildDentalGate(combo.dental);
    const pg = buildProviderGate(combo.provider);
    activeCombo = combo;
    activeDentalGate = dg;
    activeProviderGate = pg;
    const count = hardPool.filter((s) => dg(s) && pg(s)).length;
    if (count >= MIN_POOL) break;
  }
  const priorityGateRelaxation: GateRelaxation = activeCombo.dental;
  const providerGateMode: ProviderGateMode = activeCombo.provider;
  const anyPriorityActive = wantsDental;

  // Predicate exported for legacy consumers (assignRibbons, the
  // selectDiversifiedTop4 signature, and any debug paths). In the
  // horse-race model rankings come from the scorecard, not from this
  // gate, but ribbon assignment still wants to know whether a plan
  // satisfies the user's stated dental preference.
  const passesPriorityGates = activeDentalGate;

  assignRibbons(rawScored, { passesPriorityGates });

  if (isBrainDebugOn() && anyPriorityActive && typeof console !== 'undefined' && console.debug) {
    const gated = rawScored.filter((s) => !passesPriorityGates(s));
    console.debug(
      `[plan-brain] priority gates: dental=${priorityGateRelaxation} ` +
        `(threshold=${wantsDental ? dentalThreshold || 'any' : 'off'}) ` +
        `provider=${providerGateMode} ` +
        `→ ${rawScored.length - gated.length}/${rawScored.length} pass; ${gated.length} rejected`,
    );
    for (const s of gated.slice(0, 10)) {
      const dental = extractCategoryAnnualValue(s.benefits, 'dental');
      const vision = extractCategoryAnnualValue(s.benefits, 'vision');
      const hasVisionRow = s.benefits.some((b) => b.benefit_category === 'vision');
      console.debug(
        `       gated-out  ${s.row.contract_id}-${s.row.plan_id} "${s.row.plan_name}" ` +
          `dental=$${dental} vision=$${vision}${hasVisionRow ? '' : ' (no row)'}`,
      );
    }
  }

  // Debug dump — top 5 with their score breakdown + broker-rule trail
  // + provider flags. Verbose by design: this is the first stop when
  // "why is plan X in/out of top 3" comes up. Behind VITE_BRAIN_DEBUG
  // so the production console stays quiet; flip the env var on a
  // preview deploy when you need the trail.
  if (isBrainDebugOn() && typeof console !== 'undefined' && console.debug) {
    const promotedNote =
      promotedCsnp.length > 0
        ? ` (auto-promoted from meds: ${promotedCsnp.join(',')})`
        : '';
    console.debug(
      `[plan-brain] population=${population}${promotedNote} weights={drug:${weights.drug.toFixed(2)},oop:${weights.oop.toFixed(2)},extras:${weights.extras.toFixed(2)}} pool=${rawScored.length}`,
    );
    if (detectedConditions.length > 0) {
      console.debug(
        `[plan-brain] detected from meds: ` +
          detectedConditions
            .map((d) => `${d.condition}(${d.confidence})`)
            .join(', '),
      );
    }
    const willDisqualify =
      userProviderNpis.length > 0 &&
      rawScored.some(
        (s) => s.score.allProvidersOutOfNetwork || s.score.allProvidersInNetwork,
      );
    for (const [i, s] of rawScored.slice(0, 5).entries()) {
      const combined = `${s.row.contract_id}-${s.row.plan_id}`;
      const pre = preRuleComposite.get(combined) ?? s.score.composite;
      const delta = s.score.composite - pre;
      const provFlag = s.score.allProvidersInNetwork
        ? 'all in'
        : s.score.allProvidersOutOfNetwork
          ? 'ALL OUT (will be disqualified)'
          : s.score.anyProviderOutOfNetwork
            ? 'some out'
            : 'mixed/pending';
      const disqualified =
        willDisqualify && s.score.allProvidersOutOfNetwork;
      console.debug(
        `  [#${i + 1}] ${combined} "${s.row.plan_name}" composite ${pre.toFixed(1)} → ${s.score.composite.toFixed(1)} (Δ${delta >= 0 ? '+' : ''}${delta.toFixed(1)})` +
          ` ribbon=${s.score.ribbon ?? '—'} | drug=${s.score.drugCostScore} oop=${s.score.oopCostScore} extras=${s.score.extraBenefitsScore}` +
          ` | $drug=${s.score.totalAnnualDrugCost} $oop=${s.score.realAnnualCost.netAnnual} $extras=${s.score.extrasValueAnnual}` +
          ` | covered=${s.score.coveredCount}/${s.score.totalCount}` +
          ` | providers=${provFlag}` +
          (disqualified ? ' DISQUALIFIED — every provider out-of-network' : ''),
      );
      if (s.score.appliedBrokerRules.length > 0) {
        for (const r of s.score.appliedBrokerRules) {
          console.debug(
            `       rule ${r.ruleId} (${r.points >= 0 ? '+' : ''}${r.points}) — ${r.reason}`,
          );
        }
      }
    }
  }

  // ── Budget option ───────────────────────────────────────────────────
  // Cheapest plan that covers every drug on the user's list, provider
  // network deliberately ignored (the Compare screen is allowed to show
  // a "you'd save $X but lose your doctor" tradeoff). Selection rule:
  //   1. Filter to plans where every drug is covered (coveredCount ===
  //      totalCount). When the user has zero drugs, every plan trivially
  //      qualifies.
  //   2. Drop any plan whose in-network MOOP exceeds 1.5× the Best
  //      Match's MOOP. A $9k worst-case year is catastrophic-risk, not
  //      a budget plan — surfacing it would mislead the user about
  //      what they're trading for the lower premium. When no plan
  //      survives the ceiling, budgetOption becomes null and the UI
  //      collapses to 2 columns.
  //   3. If that filter is empty before the MOOP ceiling, fall back
  //      to the plan with the highest coveredCount (most-coverage),
  //      then cheapest among those — gives users with one hard-to-
  //      cover drug a non-null budget pick.
  //   4. Pick the lowest totalOOPEstimate (premium + medical + drug
  //      − Part B giveback). This already excludes provider network
  //      since the brain folds provider into composite as a soft boost,
  //      not into the dollar total.
  const bestMatch = rawScored[0] ?? null;
  const budgetOption = pickBudgetOption(rawScored, bestMatch);

  // ── Hard provider-disqualification filter for Top 3 ─────────────────
  // Per business rule: a plan that doesn't cover ANY of the user's
  // providers is not a recommendation, it's a liability. Filter those
  // out of Top 3 selection. Only fires when the user actually entered
  // ≥1 provider AND we have per-plan provider data (providerCache
  // path); the verifications-only fallback can't compute allOut so
  // disqualification doesn't trigger on coarse data.
  //
  // If filtering would leave fewer than 3 plans (extremely rare in
  // urban counties; possible in rural ones with sparse provider
  // networks), fall back to the unfiltered ranking and flag the UI
  // so it can show the "broaden your search" banner.
  const hasProviderData =
    userProviderNpis.length > 0 &&
    rawScored.some((s) => s.score.allProvidersOutOfNetwork || s.score.allProvidersInNetwork);
  // Disqualification is the union of three filters: every-provider-out
  // (original), any red-flag with action='disqualify', plus the
  // drug-coverage gate. A plan that covers ZERO of the user's
  // medications cannot be a top pick — Rob's Aetna Eagle Giveback bug:
  // 0/2 covered surfaced as "Best Extra Benefits" because the extras
  // axis is independent of drug coverage in the composite. A 65-year-
  // old enrolling in a plan that doesn't fill their prescriptions could
  // face thousands in retail spend, so this is a compliance-grade
  // exclusion, not a UX preference.
  // ── Cascade output → qualifying pool ────────────────────────────────
  // The unified cascade above already picked the (dental, provider)
  // gate combo that lets ≥4 plans survive (or the most-relaxed combo
  // when no setting works). Apply that combo to the hard-filtered
  // pool to produce the qualifying set.
  const qualifyingForTop3 = hardPool.filter(
    (s) => activeDentalGate(s) && activeProviderGate(s),
  );
  // Telemetry: did the provider gate relax below strict? Mirrors the
  // legacy providerFilterFellBack flag the UI consumes for the
  // "broaden your search" banner. Only meaningful when the user
  // actually had providers to gate against.
  const providerFilterFellBack =
    userHasProvidersWithNpis && providerGateMode !== 'strict';
  const preDsnpGuard = qualifyingForTop3;

  // ── D-SNP defense in depth ──────────────────────────────────────────
  // filterPlanPool already drops D-SNPs when !dualEligible, but a bad
  // upstream change (population mis-detection, a future SNP-class
  // override, etc.) could still let one slip through. If a D-SNP
  // reaches Top 3 contention without confirmed dual-eligibility, log
  // loudly and strip it — enrollment in a D-SNP without Medicaid is a
  // CMS compliance issue, not a UX preference.
  const top3Source = preDsnpGuard.filter((s) => {
    if (classifySnp(s.row) === 'D' && !dualEligible) {
      console.error(
        `[plan-brain] D-SNP leak: ${s.row.contract_id}-${s.row.plan_id} "${s.row.plan_name}" ` +
          `reached Top 3 contention with dualEligible=${input.userProfile.dsnpEligible} — filtering out. ` +
          `D-SNP enrollment requires confirmed Medicaid eligibility.`,
      );
      return false;
    }
    return true;
  });

  // ── High-MOOP hard exclusion ─────────────────────────────────────────
  // CMS sets the 2026 in-network MOOP ceiling at $9,350 — anything
  // above that isn't a valid MA filing, so treat it as a hard slate
  // exclusion. Below the cap, the graduated `moop_penalty` rule
  // (-1 composite point per $100 above the $3,000 floor) handles
  // ranking — a $9,250 MOOP pays -62.5 points, plenty to push
  // catastrophic-exposure plans down the list without disqualifying
  // them outright. The previous $6,500 hard gate was eliminating ~50%
  // of Durham's pool (broker-quality plans like Wellcare Patriot
  // Giveback Open with $2,100/yr giveback at $8,850 MOOP) — that's
  // editorial, not regulatory. Fall back to the unfiltered slate when
  // the filtered pool would have fewer than 4 candidates.
  const HIGH_MOOP_HARD_EXCLUDE = 9350;
  const top3SourceLowMoop = top3Source.filter(
    (s) => (s.row.moop ?? 0) <= HIGH_MOOP_HARD_EXCLUDE,
  );
  const highMoopFilterFellBack = top3SourceLowMoop.length < 4;
  let diversifiedSource: ReadonlyArray<BrainScoredPlan> = highMoopFilterFellBack
    ? top3Source
    : top3SourceLowMoop;

  // ── Margaret R1 — guarantee 4 plans (final-tier fallback) ───────────
  // Even after the cascade has fully relaxed (dental=disabled,
  // provider=off) and the MOOP fallback has fired, the source can come
  // back <4 in thin-pool counties or when the D-SNP guard / soft
  // filters have eaten the pool. Pad from `hardPool` (NOT rawScored)
  // so red-flagged plans and confirmed-zero-coverage plans stay
  // excluded — the hard filter is the one rule that never relaxes.
  // Worst case: hardPool itself has <4 plans, in which case this is
  // a noop and the slate is honestly short — but for every county
  // with 4+ filed plans that pass the hard filter, the user always
  // sees 4 results.
  if (diversifiedSource.length < 4) {
    const seen = new Set(
      diversifiedSource.map((s) => `${s.row.contract_id}-${s.row.plan_id}`),
    );
    const padCandidates = hardPool
      .filter((s) => !seen.has(`${s.row.contract_id}-${s.row.plan_id}`))
      .slice()
      .sort((a, b) => b.score.composite - a.score.composite);
    const needed = 4 - diversifiedSource.length;
    const before = diversifiedSource.length;
    diversifiedSource = [...diversifiedSource, ...padCandidates.slice(0, needed)];
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(
        `[plan-brain] R1 final-tier fallback: padded diversifiedSource ` +
          `from ${before} to ${diversifiedSource.length} using top-composite ` +
          `plans from hardPool (red-flag + zero-coverage exclusions preserved).`,
      );
    }
  }

  // ── Diversified Top 4 (broker brain v2) ─────────────────────────────
  // Each pick answers a different question — best match, fix-the-
  // weakest-axis, lifestyle ($0 premium with strong extras), pure
  // value (lowest realAnnualCost). Max 2 plans per carrier. The
  // `LiveTop3` type name is preserved for backward compat with
  // downstream consumers; the `picks` array now carries up to 4
  // entries.
  // Standard MAPD users get the hard $0 premium gate. C-SNP / D-SNP
  // pools are smaller and a premium SNP often IS the right plan, so
  // those populations skip the gate. Dental-intent flag turns on the
  // ≥2-Tier-3 post-pass when the user picked dental as a priority.
  const diversified = selectDiversifiedTop4(diversifiedSource, passesPriorityGates, {
    enforceZeroPremium: population === 'standard',
    dentalIntent: wantsDental,
  });

  // ── Top 4 funnel diagnostic ─────────────────────────────────────────
  // Prints counts at every stage of the funnel so we can see exactly
  // where plans are dropping when the slate comes back short. Logged
  // unconditionally (not gated on debug mode) because "why is this
  // returning 3 when there should be 4?" is exactly the question we
  // need answered in production traffic, not just locally with the
  // debug flag flipped.
  if (typeof console !== 'undefined' && console.info) {
    const enforceZeroPremium = population === 'standard';
    const zeroPremCountInSource = diversifiedSource.filter(
      (s) => (s.row.monthly_premium ?? 0) === 0,
    ).length;
    console.info(
      `[plan-brain] Top 4 funnel: ` +
        `eligible=${eligible.length} → ` +
        `rawScored=${rawScored.length} → ` +
        `hardPool=${hardPool.length} → ` +
        `qualifying(${activeCombo.dental}/${activeCombo.provider})=${qualifyingForTop3.length} → ` +
        `postDsnpGuard=${top3Source.length} → ` +
        `lowMoop=${top3SourceLowMoop.length}${highMoopFilterFellBack ? '*fellBack' : ''} → ` +
        `diversifiedSource=${diversifiedSource.length} ` +
        `(zeroPrem=${zeroPremCountInSource}, gate=${enforceZeroPremium ? 'on' : 'off'}) → ` +
        `picks=${diversified.length}`,
    );
    if (diversified.length < 4) {
      console.warn(
        `[plan-brain] Top 4 returned only ${diversified.length} plans. ` +
          `Most likely cause: ${
            diversifiedSource.length < 4
              ? 'diversifiedSource has <4 plans (cascade or MOOP filter is the bottleneck).'
              : enforceZeroPremium && zeroPremCountInSource < 4 && zeroPremCountInSource > 0
                ? 'zero-premium gate has <4 $0 plans in pool; selector returned only those (no fallback when filtered.length > 0).'
                : 'unexpected — investigate the funnel above.'
          }`,
      );
    }
  }
  // Recompute the weakest axis on pick 1 here so the "cheap" pick's
  // why text can describe the axis it was chosen to address. Mirrors
  // the logic inside selectDiversifiedTop4.
  const pick1ForWhy = diversified[0];
  const weakestAxis: 'drug' | 'oop' | 'extras' = (() => {
    if (!pick1ForWhy) return 'drug';
    const s = pick1ForWhy.score;
    let w: 'drug' | 'oop' | 'extras' = 'drug';
    let m = s.drugCostScore;
    if (s.oopCostScore < m)        { m = s.oopCostScore; w = 'oop'; }
    if (s.extraBenefitsScore < m)  { m = s.extraBenefitsScore; w = 'extras'; }
    return w;
  })();
  // Distinct ribbon per diversified slot. Without this, plans whose
  // pre-existing ribbon was null fell back to BEST_OVERALL inside
  // brainToLiveTop3Pick — producing two cards both reading
  // "STRONGEST MATCH IN DURHAM COUNTY". Each slot now claims its
  // own ribbon based on the pick's role; collisions fall through
  // to a deterministic fallback list.
  const usedRibbons = new Set<string>();
  const claimRibbon = (
    candidates: ReadonlyArray<RibbonType>,
    fallback: RibbonType,
  ): RibbonType => {
    for (const r of candidates) {
      if (!usedRibbons.has(r)) { usedRibbons.add(r); return r; }
    }
    if (!usedRibbons.has(fallback)) { usedRibbons.add(fallback); return fallback; }
    return fallback;
  };
  const ribbonForSlot = (
    s: BrainScoredPlan,
    slot: 'best' | 'cheap' | 'extras' | 'value',
  ): RibbonType => {
    if (slot === 'best') return claimRibbon(['BEST_OVERALL'], 'BEST_OVERALL');
    const hasGiveback = s.score.partBGivebackAnnual > 0;
    const isZeroPremium = (s.row.monthly_premium ?? 0) === 0;
    const allMedsCovered =
      s.score.coveredCount > 0 && s.score.coveredCount === s.score.totalCount;
    if (slot === 'cheap') {
      // Slot 2 fixes the user's weakest axis on pick 1 — describe
      // the axis the diversified picker was hunting for.
      const primary: RibbonType =
        weakestAxis === 'drug'   ? 'LOWEST_DRUG_COST'
        : weakestAxis === 'oop'  ? 'LOWEST_OOP'
        :                          'BEST_EXTRAS';
      return claimRibbon(
        [primary, 'LOWEST_OOP', 'LOWEST_DRUG_COST', 'BEST_EXTRAS'],
        primary,
      );
    }
    if (slot === 'extras') {
      const candidates: RibbonType[] = ['BEST_EXTRAS'];
      if (hasGiveback) candidates.push('PART_B_SAVINGS');
      if (isZeroPremium) candidates.push('ZERO_PREMIUM');
      return claimRibbon(candidates, 'BEST_EXTRAS');
    }
    // slot === 'value' — pick 4 = lowest annual total.
    const candidates: RibbonType[] = ['LOWEST_OOP'];
    if (allMedsCovered) candidates.push('ALL_MEDS_COVERED');
    if (isZeroPremium) candidates.push('ZERO_PREMIUM');
    if (s.score.allProvidersInNetwork && !s.score.anyProviderOutOfNetwork) {
      candidates.push('ALL_DOCS_IN_NETWORK');
    }
    if (hasGiveback) candidates.push('PART_B_SAVINGS');
    return claimRibbon(candidates, 'LOWEST_OOP');
  };

  const liveTop3: LiveTop3 | null = diversified.length >= 1 ? {
    population,
    scopeLabel: input.county ? `in ${input.county} County` : 'in your area',
    qualifyingPlanCount: eligible.length,
    providerFilterFellBack,
    highMoopFilterFellBack,
    priorityGateRelaxation: anyPriorityActive ? priorityGateRelaxation : undefined,
    picks: diversified.map((s, i) => {
      const basePick = brainToLiveTop3Pick(s, i, population, input);
      // Horse-race model: every pick is a "top pick." We keep the
      // category field on the type for backward compat with downstream
      // consumers (styling hooks, ribbon assignment), but assign the
      // same value to all 4 so the UI renders them uniformly. The slot
      // index no longer carries semantic meaning.
      const category: 'best' | 'cheap' | 'extras' | 'value' = 'best';
      const why = personalizedWhy({
        pick: s,
        category,
        weakestAxis,
        userDrugs: input.userProfile.drugs,
        userProviders: input.userProfile.providers,
      });
      // Horse-race model: only the top scorer (i === 0) gets a card
      // ribbon. All four are top picks by definition; repeating the
      // same "STRONGEST MATCH" badge on every card was just visual
      // noise. Picks 2–4 surface no card ribbon. The plan-pool
      // ribbon (s.score.ribbon, set by assignRibbons earlier) is
      // preserved for non-leader picks so downstream consumers
      // (Plan Detail) can still read whatever label the broader
      // ranking pass produced.
      let ribbonText = '';
      if (i === 0) {
        const ribbon = ribbonForSlot(s, category);
        s.score.ribbon = ribbon;
        ribbonText = ribbonDisplayText(
          ribbon,
          population,
          input.county,
          input.userProfile.csnpConditions,
          input.userProfile.providers.filter((p) => typeof p.npi === 'string' && p.npi.length > 0).length,
        );
      }
      return { ...basePick, category, why, ribbon: ribbonText };
    }),
  } : null;

  // ── Final determinism summary ───────────────────────────────────────
  // Single-line summary printed at the END of every brain run so we
  // can confirm that two consecutive runs with the same inputs
  // produced the same Top 3. Logs final contract IDs, composites,
  // ribbons, fired rule IDs, plus the upstream determinism inputs:
  // population (incl. C-SNP auto-promotion), provider data presence,
  // and disqualification fallback state. If two runs print different
  // FINAL TOP 3 lines on identical inputs, the brain is non-
  // deterministic and the cause is upstream of this point.
  if (typeof console !== 'undefined' && console.info) {
    const finalTop3 = diversified.map((s) => {
      const id = `${s.row.contract_id}-${s.row.plan_id}`;
      const ribbon = s.score.ribbon ?? '—';
      const rules =
        s.score.appliedBrokerRules.length > 0
          ? s.score.appliedBrokerRules.map((r) => r.ruleId).join('+')
          : '—';
      return `${id}@${s.score.composite.toFixed(1)}[${ribbon}|${rules}]`;
    });
    const providerDataState =
      userProviderNpis.length === 0
        ? 'none-required'
        : hasProviderData
          ? providerFilterFellBack
            ? 'present-fellback'
            : 'present-applied'
          : 'pending';
    const promotedSummary =
      promotedCsnp.length > 0 ? `csnp-promoted=${promotedCsnp.join(',')}` : 'csnp-promoted=none';
    const patternsSummary =
      medicationPatterns.length > 0
        ? medicationPatterns.map((p) => `${p.id}:${p.variant}`).join(',')
        : 'none';
    console.info(
      `[plan-brain] FINAL TOP ${diversified.length}: ${finalTop3.join(' | ')} ` +
        `(profile=${brokerProfile}, archetype=${archetype}, pop=${population}, ${promotedSummary}, ` +
        `providers=${providerDataState}, patterns=${patternsSummary}, pool=${eligible.length})`,
    );
    // Curated-set summary — premium gate + dental tier counts on the
    // gated source pool + final picks. Use this to confirm the $0
    // gate is firing for MAPD ("zero_premium_gate=enforced, kept=N/M"
    // means N $0 plans out of M survived the gate) and the
    // dental-intent post-pass landed ≥2 Tier-3 picks when intended.
    const enforceZeroPremium = population === 'standard';
    const zeroPremCount = top3Source.filter((s) => (s.row.monthly_premium ?? 0) === 0).length;
    const tier3InPool = top3Source.filter((s) => s.score.dentalTier === 'comprehensive').length;
    const tier3InPicks = diversified.filter((s) => s.score.dentalTier === 'comprehensive').length;
    const hmoInPicks = diversified.filter(
      (s) => /\bhmo\b/i.test(s.row.plan_type ?? '') && !/\bppo\b/i.test(s.row.plan_type ?? ''),
    ).length;
    const ppoInPicks = diversified.filter((s) => /\bppo\b/i.test(s.row.plan_type ?? '')).length;
    console.info(
      `[plan-brain]   curated-set: ` +
        `zero_premium_gate=${enforceZeroPremium ? 'enforced' : 'off'} (${zeroPremCount}/${top3Source.length} $0 in pool) ` +
        `· dental_intent=${wantsDental ? `on (Tier-3 ${tier3InPicks}/${tier3InPool} in pool)` : 'off'} ` +
        `· plan_type=${hmoInPicks}HMO/${ppoInPicks}PPO`,
    );
    // Log per-plan red flags inline beneath the FINAL line so the
    // console diff shows the WHY of any score adjustments / hard
    // exclusions on the same render.
    for (const s of diversified) {
      if (s.score.redFlags.length === 0) continue;
      const id = `${s.row.contract_id}-${s.row.plan_id}`;
      console.info(
        `[plan-brain]   red flags ${id}: ` +
          s.score.redFlags
            .map((f) => `${f.id}(${f.action}${f.points ? ` ${f.points}` : ''})`)
            .join(', '),
      );
    }
  }

  // ── Plan Brain Debug — verbose per-Top-N dump ───────────────────────
  // Activated by ?debug=true in the URL (browser) or PLAN_BRAIN_DEBUG=true
  // in process.env (Edge Function / Node). Surfaces the full decision
  // trail per pick: monthly + net premium, the premium penalty applied,
  // axis scores, composite, red flags, and the rendered why text. Use
  // this to verify the premium penalty is actually firing for a healthy
  // newly-eligible user ("does Aetna Value Plus drop out of Top 3?").
  if (typeof console !== 'undefined' && isPlanBrainDebugEnabled() && liveTop3) {
    const fmtUSD = (n: number) => `$${Math.round(n).toLocaleString()}`;
    const userProfileLine =
      `age=${input.userProfile.age ?? '—'}, county=${input.county ?? '—'}, ` +
      `meds=[${input.userProfile.drugs.map((d) => d.name).join(', ') || '—'}], ` +
      `providers=[${input.userProfile.providers.map((p) => p.name + (p.npi ? `/${p.npi}` : '')).join(', ') || '—'}]`;
    const weightLine =
      `drug=${(weights.drug * 100).toFixed(0)}, ` +
      `oop=${(weights.oop * 100).toFixed(0)}, ` +
      `extras=${(weights.extras * 100).toFixed(0)}` +
      (profileWeights.copay > 0 ? `, copay=${(profileWeights.copay * 100).toFixed(0)}` : '');
    console.info('[Plan Brain Debug]');
    console.info(`  User Profile: ${userProfileLine}`);
    console.info(`  Detected Archetype: ${archetype} (broker profile ${brokerProfile})`);
    console.info(`  Weight Profile: ${weightLine}`);
    diversified.forEach((scored, slotIdx) => {
      const pick = liveTop3.picks[slotIdx];
      const k = `${scored.row.contract_id}-${scored.row.plan_id}`;
      const dbg = debugByPlanKey.get(k);
      const sc = scored.score;
      const moop = scored.row.moop != null ? fmtUSD(scored.row.moop) : '—';
      console.info(`  Plan: ${k}-${scored.row.segment_id} (${scored.row.plan_name})`);
      console.info(
        `    Premium: ${fmtUSD(dbg?.monthlyPremium ?? 0)}/mo | ` +
          `Net Premium: ${fmtUSD(dbg?.netMonthlyPremium ?? 0)}/mo | ` +
          `Premium Penalty: ${dbg?.premiumPenalty ? -dbg.premiumPenalty : 0}` +
          (dbg?.isHealthyForPremium ? ' (healthy gate active)' : ''),
      );
      // Dental tier line — surfaces both the classifier output and the
      // -10 Tier-1 penalty when the user picked dental as a priority.
      // Empty parens when no penalty fired (Tier 2/3 plans, or dental
      // not a stated priority).
      const tier1Note =
        (dbg?.dentalTier1Penalty ?? 0) > 0
          ? ` | Tier-1 Penalty: -${dbg!.dentalTier1Penalty}`
          : '';
      console.info(
        `    Dental Tier: ${dbg?.dentalTier ?? sc.dentalTier}` + tier1Note,
      );
      console.info(
        `    Drug Score: ${sc.drugCostScore} (${sc.coveredCount}/${sc.totalCount} covered, ` +
          `${sc.lowTierCount} Tier 1–2, ${fmtUSD(sc.totalAnnualDrugCost)}/yr)`,
      );
      console.info(
        `    Medical Score: ${sc.oopCostScore} (MOOP ${moop}, ` +
          `${fmtUSD(sc.realAnnualCost.netAnnual)}/yr expected total, ` +
          `providers=${sc.allProvidersInNetwork ? 'all in' : sc.allProvidersOutOfNetwork ? 'all OUT' : sc.anyProviderOutOfNetwork ? 'some out' : 'mixed'})`,
      );
      console.info(
        `    Extras Score: ${sc.extraBenefitsScore} (${fmtUSD(sc.extrasValueAnnual)}/yr value` +
          (sc.partBGivebackAnnual > 0 ? `, Part B giveback ${fmtUSD(sc.partBGivebackAnnual)}/yr` : '') +
          ')',
      );
      console.info(`    Composite: ${sc.composite.toFixed(1)} | Ribbon: ${pick?.ribbon ?? sc.ribbon ?? '—'}`);
      // ── Margaret rule breakdown — surfaces R2/R3 contributions plus
      //    the broker-rules MOOP penalty so the composite is auditable
      //    on every Top-N pick. Read the brain debug output to verify
      //    why a plan landed at its rank.
      const moopRule = sc.appliedBrokerRules.find((r) => r.ruleId === 'moop_penalty');
      const moopPts = moopRule?.points ?? 0;
      console.info(
        `    Margaret breakdown: ` +
          `dentalBonus=${(dbg?.dentalBonus ?? 0).toFixed(1)} ` +
          `(dental=${fmtUSD(dbg?.dentalAnnual ?? 0)}, wantsDental=${wantsDental}) ` +
          `· nonDentalBonus=${(dbg?.nonDentalBonus ?? 0).toFixed(1)} ` +
          `· ppoBonus=${(dbg?.ppoBonus ?? 0).toFixed(1)} ` +
          `(plan_type=${dbg?.planType ?? '—'}) ` +
          `· moopPenalty=${moopPts.toFixed(1)} ` +
          `(MOOP=${dbg?.moop != null ? fmtUSD(dbg.moop) : '—'})`,
      );
      const redFlagSummary =
        sc.redFlags.length > 0
          ? sc.redFlags.map((f) => `${f.id}(${f.action})`).join(', ')
          : 'none';
      console.info(`    Red Flags: ${redFlagSummary}`);
      console.info(`    Why Text: "${pick?.why ?? ''}"`);
    });
  }

  return {
    population,
    ranked: rawScored,
    liveTop3,
    isHealthyClient,
    budgetOption,
    detectedConditions,
    archetype,
    medicationPatterns,
  };
}

// Multiplier of the Best Match's in-network MOOP that the budget option
// is allowed to reach. 1.5× lets a $4,200 best-MOOP tolerate a $6,300
// budget MOOP (still a real plan), but blocks the common $9k+ MAPDs that
// hit users with a catastrophic worst-case for a $0 premium.
const BUDGET_MOOP_CEILING_MULTIPLE = 1.5;

// Cheapest covers-all-meds plan that ALSO keeps the user's providers
// in-network. Older versions ignored provider network and could
// surface Troy / OON-Humana as "Budget Option" even though Klein
// wasn't on it — a misleading recommendation. Now plans flagged
// allProvidersOutOfNetwork drop out of the candidate pool the same
// way they're disqualified from Top 3.
//
// Returns null when nothing survives the joint
// (full-coverage + MOOP-ceiling + provider) filter — Compare /
// SideBySide collapse to 2 columns in that case rather than mislabel
// a high-MOOP / OON plan as "budget."
function pickBudgetOption(
  scored: ReadonlyArray<BrainScoredPlan>,
  bestMatch: BrainScoredPlan | null,
): BrainScoredPlan | null {
  if (scored.length === 0) return null;
  // Drop plans where every user provider is out of network. Mirrors
  // the Top 3 disqualification — the budget pick should never
  // contradict it.
  const providerSafe = scored.filter((s) => !s.score.allProvidersOutOfNetwork);
  const sourcePool = providerSafe.length > 0 ? providerSafe : scored;
  const fullyCovered = sourcePool.filter(
    (s) => s.score.totalCount === 0 || s.score.coveredCount === s.score.totalCount,
  );
  const coveragePool = fullyCovered.length > 0 ? fullyCovered : (() => {
    const maxCovered = sourcePool.reduce((m, s) => Math.max(m, s.score.coveredCount), 0);
    return sourcePool.filter((s) => s.score.coveredCount === maxCovered);
  })();

  // MOOP ceiling — only enforced when the best match has a usable
  // MOOP. A best match without a filed MOOP (rare, usually data-load
  // edge case) means we skip the ceiling rather than nuke the budget
  // column entirely.
  const bestMoop = bestMatch?.row.moop ?? null;
  const moopCap = bestMoop != null && bestMoop > 0
    ? bestMoop * BUDGET_MOOP_CEILING_MULTIPLE
    : null;
  const pool = moopCap == null
    ? coveragePool
    : coveragePool.filter((s) => {
        const m = s.row.moop ?? null;
        // Treat a null MOOP as failing the ceiling — we can't prove
        // it's safe, so don't risk surfacing a $10k worst-case plan.
        return m != null && m > 0 && m <= moopCap;
      });

  if (pool.length === 0) return null;

  let best: BrainScoredPlan | null = null;
  for (const s of pool) {
    // Cheapest by condition-aware annual cost — the same number the
    // cards display. Using realAnnualCost.netAnnual instead of the
    // older totalOOPEstimate keeps the budget pick consistent with the
    // pill on the Compare card (a "$2,847 budget option" pill should
    // match its scoring rationale).
    if (
      best == null ||
      s.score.realAnnualCost.netAnnual < best.score.realAnnualCost.netAnnual
    ) {
      best = s;
    }
  }
  return best;
}

// ─── Cost-breakdown builder ─────────────────────────────────────────
// One-line plain-English summary of the year on this plan, condition-
// aware when a profile applies. Surfaced as the quote callout on Top
// 3 cards and the cost summary on Plan Detail.
//
// Format (condition path):
//   "Your diabetes care on this plan: 4 endocrinologist visits ($100),
//    6 A1C / metabolic panel ($0), supplies ($0), Ozempic ($5,628/yr).
//    Estimated annual total: $6,108."
//
// Format (no-condition path — covered drugs + premium + medical):
//   "Your year on this plan: $0/mo premium, $480/yr medical, $1,626/yr
//    drugs. Estimated annual total: $2,106."
function buildCostBreakdown(args: {
  conditionProfile: ConditionProfile | null;
  benefits: import('./brain-foreign-types').PlanBenefitRow[];
  utilization: import('./plan-brain-types').Utilization;
  drugEstimates: ReadonlyArray<import('./plan-brain-utils').DrugYearlyEstimate>;
  annualMedicalCost: number;
  totalAnnualDrugCost: number;
  totalOOPEstimate: number;
  partBGivebackAnnual: number;
  annualPremium: number;
  isHealthyClient: boolean;
  medCount: number;
}): string {
  const fmt = (n: number) => `$${Math.max(0, Math.round(n)).toLocaleString()}`;
  const total = `Estimated annual total: ${fmt(args.totalOOPEstimate)}.`;

  // Healthy-client path — leads with the giveback when the plan has
  // one, since that's the dominant signal when medical costs are
  // tiny across plans. Skipped when there's no giveback (falls
  // through to the generic path which still mentions premium/drugs).
  if (args.isHealthyClient && args.partBGivebackAnnual > 0) {
    const monthly = Math.round(args.partBGivebackAnnual / 12);
    return (
      `This plan gives you ${fmt(monthly)}/month back on your Medicare ` +
      `Part B premium — that's ${fmt(args.partBGivebackAnnual)}/year in ` +
      `savings. With only ${args.medCount} medication${args.medCount === 1 ? '' : 's'} ` +
      `and no chronic conditions, your medical costs will be minimal on ` +
      `any plan. The Part B giveback is your biggest savings opportunity. ` +
      total
    );
  }

  if (args.conditionProfile) {
    const cp = args.conditionProfile;
    const parts: string[] = [];

    if (args.utilization.specialist_visits > 0) {
      const specCopay = copayForCategory(args.benefits, 'specialist');
      const specCost = args.utilization.specialist_visits * specCopay;
      parts.push(`${args.utilization.specialist_visits} ${cp.specialistLabel} visits (${fmt(specCost)})`);
    }
    if (args.utilization.lab_visits > 0) {
      const labCopay = copayForCategory(args.benefits, 'lab');
      const labCost = args.utilization.lab_visits * labCopay;
      parts.push(`${args.utilization.lab_visits} ${cp.labLabel ?? 'labs'} (${fmt(labCost)})`);
    }
    if (args.utilization.imaging_visits > 0 && cp.imagingLabel) {
      const imgCopay = copayForCategory(args.benefits, 'imaging');
      const imgCost = args.utilization.imaging_visits * imgCopay;
      parts.push(`${args.utilization.imaging_visits} ${cp.imagingLabel} (${fmt(imgCost)})`);
    }
    if (cp.suppliesLabel) {
      // 'insulin' category is populated by import-pbp-benefits.ts's
      // B15 IRA extractor — copay = IRA $35/mo Part B insulin cap.
      const supCopay = copayForCategory(args.benefits, 'insulin');
      parts.push(`${cp.suppliesLabel} (${fmt(supCopay)})`);
    }

    // Highlight the user's high-cost drug if they have one in their
    // list (Ozempic for diabetes, Symbicort for COPD, etc.). Picks
    // the single most expensive matched drug.
    const matchedDrugs = args.drugEstimates
      .filter((d) => cp.highCostDrugRe.test(d.name))
      .sort((a, b) => b.yearlyCost - a.yearlyCost);
    if (matchedDrugs[0] && matchedDrugs[0].yearlyCost > 0) {
      const d = matchedDrugs[0];
      parts.push(`${displayDrugName(d.name)} (${fmt(d.yearlyCost)}/yr)`);
    }

    return `Your ${cp.label} care on this plan: ${parts.join(', ')}. ${total}`;
  }

  // Generic path — premium + medical + drug
  const segments: string[] = [];
  segments.push(`${fmt(args.annualPremium / 12)}/mo premium`);
  if (args.annualMedicalCost > 0) segments.push(`${fmt(args.annualMedicalCost)}/yr medical`);
  if (args.totalAnnualDrugCost > 0) segments.push(`${fmt(args.totalAnnualDrugCost)}/yr drugs`);
  if (args.partBGivebackAnnual > 0) segments.push(`Part B savings ${fmt(args.partBGivebackAnnual)}/yr`);
  return `Your year on this plan: ${segments.join(', ')}. ${total}`;
}

// Drug names from autocomplete arrive as "Ozempic (0.25 or 0.5 MG/DOSE)"
// — strip the parenthetical so the cost-breakdown reads cleanly.
function displayDrugName(raw: string): string {
  return raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

// Map the union of self-reported CSNP conditions and med-detected
// conditions onto the utilization-model vocabulary. The two source
// vocabularies overlap but aren't identical: CsnpCondition has 'cardio'
// (a broad cardiovascular bucket); DetectedConditionKey splits it into
// 'chf' and 'afib'. We collapse both to the model's 'chf' profile —
// it's the higher-utilization fit (frequent cardiologist visits,
// higher hospital risk) and a broker treats both as "this person needs
// the cardiology-friendly plan" for ranking purposes.
//
// Detected conditions are filtered to confidence >= 'likely'. 'possible'
// matches (a single ACE inhibitor → "possibly hypertensive") are too
// weak to drive utilization — they'd inflate the medical bucket on
// every plan and wash out real signal.
function unionUtilizationConditions(
  csnp: ReadonlyArray<CsnpCondition>,
  detected: ReadonlyArray<{ condition: DetectedConditionKey; confidence: 'certain' | 'likely' | 'possible' }>,
): UtilizationCondition[] {
  const out = new Set<UtilizationCondition>();
  for (const c of csnp) {
    const mapped = csnpToUtilization(c);
    if (mapped) out.add(mapped);
  }
  for (const d of detected) {
    if (d.confidence === 'possible') continue;
    const mapped = detectedToUtilization(d.condition);
    if (mapped) out.add(mapped);
  }
  return Array.from(out);
}

function csnpToUtilization(c: CsnpCondition): UtilizationCondition | null {
  switch (c) {
    case 'diabetes': return 'diabetes';
    case 'cardio': return 'chf';
    case 'copd': return 'copd';
    case 'esrd': return 'ckd';
    case 'hypertension': return 'hypertension';
    default: return null;
  }
}

// Union of self-reported csnpConditions and likely+ detected
// conditions, returned as a flat string[] in the canonical lowercase
// vocabulary the broker playbook reads ('diabetes' / 'chf' / 'copd' /
// 'ckd' / 'cardio' / 'hypertension' / 'esrd' / 'cancer'). Different
// shape from unionUtilizationConditions, which collapses cardio+afib
// to a single 'chf' utilization profile — archetypes need the
// distinction so multi-chronic counts cardio + diabetes as 2.
function unionConditionLabels(
  csnp: ReadonlyArray<CsnpCondition>,
  detected: ReadonlyArray<{ condition: DetectedConditionKey; confidence: 'certain' | 'likely' | 'possible' }>,
): string[] {
  const out = new Set<string>();
  for (const c of csnp) out.add(c);
  for (const d of detected) {
    if (d.confidence === 'possible') continue;
    out.add(d.condition);
  }
  return Array.from(out);
}

function detectedToUtilization(c: DetectedConditionKey): UtilizationCondition | null {
  switch (c) {
    case 'diabetes': return 'diabetes';
    case 'chf': return 'chf';
    case 'afib': return 'chf';
    case 'copd': return 'copd';
    case 'ckd': return 'ckd';
    case 'hypertension': return 'hypertension';
    // depression / pain_management have no utilization profile yet
    default: return null;
  }
}

// Map a Brain-scored plan to the LiveTop3Pick the existing UI renders.
// `category` mostly drives the pick's role on the existing card —
// 'best' is plan #1, 'cheap' is the OOP/drug-cost leader, 'extras'
// is the supplemental-benefit leader.
function brainToLiveTop3Pick(
  s: BrainScoredPlan,
  index: number,
  population: RankPopulation,
  input: BrainInputs,
): LiveTop3Pick {
  const ribbon = s.score.ribbon ?? 'BEST_OVERALL';
  const ribbonText = ribbonDisplayText(
    ribbon,
    population,
    input.county,
    input.userProfile.csnpConditions,
    input.userProfile.providers.filter((p) => typeof p.npi === 'string' && p.npi.length > 0).length,
  );
  // Prefer the strongest broker-rule reason over the generic
  // ribbon-why text — when a rule fired (R1 diabetic_csnp_match,
  // R2 diabetic_needs_supplies, etc.) it carries broker-grade copy
  // ("Designed for diabetes — $0 supplies + Klein in-network") that
  // beats the axis-derived "Lowest drug cost in Durham" line.
  // Falls back to ribbonWhyText when no rule applied.
  const topRule = strongestRule(s.score.appliedBrokerRules);
  const why = topRule ? topRule.reason : ribbonWhyText(s);
  // Pick the existing-shape category based on the ribbon character —
  // best/cheap/extras buckets used by Results card heuristics.
  const cat: 'best' | 'cheap' | 'extras' =
    index === 0 ? 'best'
    : ribbon === 'LOWEST_DRUG_COST' || ribbon === 'LOWEST_OOP' || ribbon === 'PART_B_SAVINGS' || ribbon === 'ZERO_PREMIUM' ? 'cheap'
    : ribbon === 'BEST_EXTRAS' ? 'extras'
    : index === 1 ? 'cheap' : 'extras';
  return {
    category: cat,
    plan: {
      row: s.row,
      benefits: s.benefits,
      formulary: s.formulary,
      // ScoredPlan's existing fields — fill from Brain score so legacy
      // consumers (rank-time card data) keep working.
      drugsCovered: s.score.coveredCount,
      drugsCoveredLowTier: s.score.lowTierCount,
      drugsTotal: s.score.totalCount,
      drugsAllCovered: s.score.coveredCount === s.score.totalCount && s.score.totalCount > 0,
      estimatedAnnualDrugCost: s.score.totalAnnualDrugCost,
      totalAnnualCost: s.score.realAnnualCost.netAnnual,
      extrasValue: s.score.extrasValueAnnual,
      allProvidersInNetwork: s.score.allProvidersInNetwork,
      suppliesCovered: s.score.suppliesCovered,
      suppliesTotal: s.score.suppliesTotal,
      dentalTier: s.score.dentalTier,
    },
    ribbon: ribbonText,
    why,
    priorityChecks: s.score.priorityChecks,
    tradeoffWarnings: s.score.tradeoffWarnings,
  };
}

// ─── Priority threshold scoring + tradeoff detection ─────────────────
//
// `evaluatePriorityChecks` returns one entry per user-selected priority,
// answering "how well does this plan serve what the user picked?" Each
// entry carries a proportional 0..1 score:
//   - Tier picker (dental / vision / otc / partb_giveback):
//       score = min(planValue / threshold, 1.0)
//     so a $1,000 dental plan scores 0.5 against a $2,000 pick, and a
//     $2,000+ plan scores 1.0 (capped). Plans without the benefit
//     score 0.
//   - Toggle (low_moop / low_drug_costs / hearing / fitness /
//       telehealth / transportation / healthy_foods): score = 1 when
//       the benefit is present (or the proxy condition met), 0 otherwise.
//
// runPlanBrain averages these scores across the user's selected
// priorities and uses the result as the plan's extras-axis score
// (overriding the legacy pool-normalized extrasValueAnnual axis when
// any priority is set). meets/partial booleans are kept for the
// Results card ✓/~/✗ badges.

interface PriorityCheckInternal {
  priority: string;
  label: string;
  meets: boolean;
  partial: boolean;
  /** Proportional 0..1 score for this priority on this plan. */
  score: number;
}

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

// Monthly Part B giveback for the threshold gate. Giveback is filed
// monthly per CMS convention, so coverage_amount is the user-comparable
// number. OTC follows a different unit (quarterly) and is read via
// extractOtcQuarterly.
function extractGivebackMonthly(
  benefits: ReadonlyArray<{ benefit_category: string; coverage_amount: number | null; max_coverage: number | null }>,
): number {
  const row = benefits.find((b) => b.benefit_category === 'partb_giveback');
  if (!row) return 0;
  const filed = row.coverage_amount ?? row.max_coverage ?? null;
  if (filed == null) return 0;
  return filed;
}

function fmtUSD(n: number): string {
  return `$${Math.max(0, Math.round(n)).toLocaleString()}`;
}

function evaluatePriorityChecks(args: {
  benefits: ReadonlyArray<{ benefit_category: string; coverage_amount: number | null; max_coverage: number | null }>;
  moop: number | null;
  partBGivebackAnnual: number;
  drugCostScore: number; // 0..100 — used as a proxy for "low_drug_costs" priority
  priorities: ReadonlySet<string>;
  thresholds: Partial<Record<'dental' | 'vision' | 'otc' | 'partb_giveback', number>>;
}): PriorityCheckInternal[] {
  const out: PriorityCheckInternal[] = [];
  for (const pri of args.priorities) {
    if (pri === 'dental' || pri === 'vision') {
      const annual = extractCategoryAnnualValue(args.benefits, pri);
      const threshold = args.thresholds[pri] ?? 0;
      // Proportional score: planValue / threshold, capped at 1.0. When
      // the user picked the "Cleanings only" / "Any" basic tier
      // (threshold === 0), any filed dollar scores 1.0; absence scores 0.
      const score =
        threshold > 0
          ? Math.min(annual / threshold, 1.0)
          : annual > 0 ? 1 : 0;
      const meets = score >= 1;
      const partial = !meets && score > 0;
      out.push({
        priority: pri,
        label:
          annual > 0
            ? `${TIER_LABEL_BY_KEY[pri]} ${fmtUSD(annual)}` +
              (threshold > 0 ? ` (your pick: ${fmtUSD(threshold)}+)` : '')
            : `${TIER_LABEL_BY_KEY[pri]} not filed` + (threshold > 0 ? ` (your pick: ${fmtUSD(threshold)}+)` : ''),
        meets,
        partial,
        score,
      });
    } else if (pri === 'otc') {
      // OTC compares quarterly: ~95% of MA plans file OTC as a quarterly
      // benefit per CMS PBP convention, so the threshold gate and the
      // displayed plan value are both /qtr. extractOtcQuarterly handles
      // monthly-filing edge cases by ×3.
      const { quarterly, period } = extractOtcQuarterly(args.benefits);
      const threshold = args.thresholds.otc ?? 0;
      const score =
        threshold > 0
          ? Math.min(quarterly / threshold, 1.0)
          : quarterly > 0 ? 1 : 0;
      const meets = score >= 1;
      const partial = !meets && score > 0;
      // Display unit follows the plan's filed period — a plan filed
      // monthly reads "$30/mo" while quarterly filings (the default)
      // read "$90/qtr". The user's pick label is always /qtr since the
      // tier picker is per-quarter.
      const displayValue = period === 'month' ? Math.round(quarterly / 3) : quarterly;
      const displayUnit = period === 'month' ? '/mo' : '/qtr';
      out.push({
        priority: 'otc',
        label:
          quarterly > 0
            ? `${TIER_LABEL_BY_KEY.otc} ${fmtUSD(displayValue)}${displayUnit}` +
              (threshold > 0 ? ` (your pick: ${fmtUSD(threshold)}+/qtr)` : '')
            : `${TIER_LABEL_BY_KEY.otc} not offered` + (threshold > 0 ? ` (your pick: ${fmtUSD(threshold)}+/qtr)` : ''),
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
          : monthly > 0 ? 1 : 0;
      const meets = score >= 1;
      const partial = !meets && score > 0;
      out.push({
        priority: 'partb_giveback',
        label:
          monthly > 0
            ? `${TIER_LABEL_BY_KEY.partb_giveback} ${fmtUSD(monthly)}/mo` +
              (threshold > 0 ? ` (your pick: ${fmtUSD(threshold)}+/mo)` : '')
            : `${TIER_LABEL_BY_KEY.partb_giveback} not offered` + (threshold > 0 ? ` (your pick: ${fmtUSD(threshold)}+/mo)` : ''),
        meets,
        partial,
        score,
      });
    } else if (pri === 'low_moop') {
      // Toggle: reward plans with a MOOP at or below the median NC
      // 2026 in-network MOOP (~$5,500). Plans without a filed MOOP fail.
      const moop = args.moop ?? null;
      const meets = moop != null && moop > 0 && moop <= 5500;
      out.push({
        priority: pri,
        label:
          moop != null && moop > 0
            ? `Max out-of-pocket ${fmtUSD(moop)}` + (meets ? ' (strong protection)' : '')
            : 'Max out-of-pocket not filed',
        meets,
        partial: false,
        score: meets ? 1 : 0,
      });
    } else if (pri === 'low_drug_costs') {
      // Treat top-third drug-cost score (>=66) as "meets" — the plan
      // ranks favorably on the drug axis vs the candidate pool.
      const meets = args.drugCostScore >= 66;
      out.push({
        priority: pri,
        label: meets ? 'Low drug costs (top third of plans)' : 'Drug costs middle/lower third',
        meets,
        partial: false,
        score: meets ? 1 : 0,
      });
    } else {
      // Toggle-only priorities (hearing / fitness / telehealth /
      // transportation / healthy_foods): credit any filed coverage.
      const cat: 'hearing' | 'fitness' | 'transportation' | 'telehealth' | null =
        pri === 'hearing' ? 'hearing'
        : pri === 'fitness' ? 'fitness'
        : pri === 'transportation' ? 'transportation'
        : pri === 'telehealth' ? 'telehealth'
        : null;
      const filed =
        cat ? extractCategoryAnnualValue(args.benefits, cat) : 0;
      // healthy_foods isn't a pm_plan_benefits category yet — D-SNP food
      // cards usually arrive as 'meals' or 'food_card'. Fall back to
      // checking 'meals'.
      const fallback = pri === 'healthy_foods'
        ? args.benefits.some((b) => b.benefit_category === 'meals' || b.benefit_category === 'food_card')
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

function detectTradeoffs(args: {
  moop: number | null;
  partBGivebackAnnual: number;
  dentalAnnual: number;
  premium: number;
  priorities: ReadonlySet<string>;
  thresholds: Partial<Record<'dental' | 'vision' | 'otc' | 'partb_giveback', number>>;
  providerDefinitivelyOut?: boolean;
  providerUnverified?: boolean;
  planChassis?: 'hmo' | 'hmo-pos' | 'ppo' | 'pdp' | 'other';
}): import('./plan-brain-types').TradeoffWarning[] {
  const out: import('./plan-brain-types').TradeoffWarning[] = [];
  const wantsGiveback = args.priorities.has('partb_giveback');
  const wantsLowMoop = args.priorities.has('low_moop');
  const wantsDental = args.priorities.has('dental');
  const moop = args.moop ?? null;

  // Provider out-of-network on a chassis that pays for OON care
  // (PPO / HMO-POS). Strict HMO would be hard-excluded upstream so
  // the message would be invisible — guarding on chassis here keeps
  // it scoped to plans actually shown to the user.
  if (
    args.providerDefinitivelyOut &&
    (args.planChassis === 'ppo' || args.planChassis === 'hmo-pos')
  ) {
    out.push({
      type: 'provider_out_of_network',
      message: 'Your provider is out-of-network — higher copays may apply.',
    });
  }
  // No cache row for at least one user-entered NPI on this plan. We
  // can't say in or out — surface the unknown so the consumer calls
  // to confirm before relying on the network read.
  if (args.providerUnverified) {
    out.push({
      type: 'provider_network_unverified',
      message: 'Network status unverified — call to confirm.',
    });
  }

  // Giveback + low MOOP — high giveback often pairs with high MOOP.
  if (wantsGiveback && wantsLowMoop && args.partBGivebackAnnual > 600 && moop != null && moop > 6000) {
    out.push({
      type: 'giveback_vs_moop',
      message:
        `This plan gives back ${fmtUSD(args.partBGivebackAnnual / 12)}/month ` +
        `(${fmtUSD(args.partBGivebackAnnual)}/yr) but the max out-of-pocket is ${fmtUSD(moop)}. ` +
        `If you stay healthy, the giveback wins. If you need significant care, a lower-MOOP ` +
        `plan would protect you better.`,
    });
  }

  // High-tier dental + high MOOP. Trigger floor matches the "best"
  // dental threshold in TIER_THRESHOLDS — bumped down from $2,500 to
  // $2,000 to track real 2026-NC market norms (almost no plans file
  // $2,500+ comprehensive dental).
  const dentalThreshold = args.thresholds.dental ?? 0;
  if (wantsDental && dentalThreshold >= 2000 && args.dentalAnnual >= 2000 && moop != null && moop > 6000) {
    out.push({
      type: 'dental_vs_moop',
      message:
        `This plan has ${fmtUSD(args.dentalAnnual)} dental but a ${fmtUSD(moop)} max ` +
        `out-of-pocket. The dental is generous — but if you end up in the hospital, your ` +
        `worst-case exposure is higher than some alternatives.`,
    });
  }

  // Premium-rich extras-rich plan flagged when premium > $80/mo and the
  // user picked at least one priority — broker-style "you're paying for
  // it somewhere" callout. Fires only when the user has expressed a
  // priority (skipping if they picked nothing — no preference to check).
  if (args.priorities.size > 0 && args.premium > 12 * 80) {
    out.push({
      type: 'extras_vs_premium',
      message:
        `This plan charges ${fmtUSD(args.premium / 12)}/month — premium plans usually pack ` +
        `richer extras, but if you don't use them, a $0-premium plan with similar coverage ` +
        `may be a better fit.`,
    });
  }
  return out;
}
