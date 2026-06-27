// scripts/diagnose-klein-metformin-lisinopril.ts
//
// Brain diagnostic for Rob's scenario:
//   • Durham County 27713 NC
//   • Provider: Dr. Klein (NPI 1619976297)
//   • Meds: Metformin, Lisinopril
//   • No extras selected
//
// Schema note:
//   • pm_plans                     keyed by (contract_id, plan_id, segment_id)
//   • pm_provider_network_cache   keyed by (plan_id="<contract>-<plan>", segment_id, npi)
//   • pm_formulary                keyed by (contract_id, plan_id, rxcui)
//   • pm_drug_cost_cache          keyed by (plan_id="<contract>-<plan>", segment_id, ndc)
// We collapse to (contract_id, plan_id) = 2-part key for the diagnostic
// since segment_id is mostly cosmetic for cost-share rollups.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const sb = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const KLEIN_NPI = '1619976297';
const COUNTY = 'Durham';
const STATE = 'NC';
const ZIP = '27713';

const METFORMIN_RXCUIS = ['860975', '860981', '861007'];
const LISINOPRIL_RXCUIS = ['314076', '314077', '197884', '311354'];
const ALL_RXCUIS = [...METFORMIN_RXCUIS, ...LISINOPRIL_RXCUIS];

async function fetchAllRows<T>(
  build: () => ReturnType<ReturnType<typeof sb.from>['select']>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < 60000; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) {
      console.error('paginate error:', error.message);
      break;
    }
    if (!data || data.length === 0) break;
    out.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

type PlanRow = {
  contract_id: string;
  plan_id: string;
  segment_id: string | null;
  plan_name: string;
  carrier: string;
  plan_type: string;
  monthly_premium: number | null;
  moop: number | null;
  star_rating: number | null;
  county_name: string;
};

async function main() {
  console.log('====================================================');
  console.log('BRAIN DIAGNOSTIC');
  console.log(`Durham County NC ${ZIP}`);
  console.log(`Provider: Dr. Klein (NPI ${KLEIN_NPI})`);
  console.log('Meds: Metformin, Lisinopril · no extras');
  console.log('====================================================\n');

  // ── 1. Durham plan pool ────────────────────────────────────────
  const plans = await fetchAllRows<PlanRow>(() =>
    sb
      .from('pm_plans')
      .select(
        'contract_id, plan_id, segment_id, plan_name, carrier, plan_type, monthly_premium, moop, star_rating, county_name',
      )
      .eq('state', STATE)
      .or(`county_name.ilike.%${COUNTY}%,county_name.eq.All Counties`),
  );
  const seen = new Set<string>();
  const uniq = plans.filter((p) => {
    const k = `${p.contract_id}-${p.plan_id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log(`STEP 1 — Plan pool`);
  console.log(`  Durham NC: ${uniq.length} unique (contract_id, plan_id)`);

  const contractPlans = uniq.map((p) => `${p.contract_id}-${p.plan_id}`);
  const contractIds = [...new Set(uniq.map((p) => p.contract_id))];
  const planIds = [...new Set(uniq.map((p) => p.plan_id))];

  // ── 2. Klein provider cache ───────────────────────────────────
  const kleinRows = await fetchAllRows<{
    plan_id: string;
    segment_id: string | null;
    npi: string;
    covered: boolean | null;
  }>(() =>
    sb
      .from('pm_provider_network_cache')
      .select('plan_id, segment_id, npi, covered')
      .eq('npi', KLEIN_NPI)
      .in('plan_id', contractPlans),
  );
  console.log(`\nSTEP 2 — Klein provider cache (NPI ${KLEIN_NPI})`);
  console.log(`  Cache rows for Durham pool: ${kleinRows.length}`);
  const kleinIn = kleinRows.filter((r) => r.covered === true).length;
  const kleinOut = kleinRows.filter((r) => r.covered === false).length;
  const kleinUnk = kleinRows.filter((r) => r.covered === null).length;
  console.log(`  In-network:   ${kleinIn}`);
  console.log(`  Out-network:  ${kleinOut}`);
  console.log(`  Unknown row:  ${kleinUnk}`);

  // Roll up to one verdict per contract-plan (prefer 'in' > 'out' > 'unknown').
  const kleinByPlan = new Map<string, 'in' | 'out' | 'unknown'>();
  for (const r of kleinRows) {
    const status: 'in' | 'out' | 'unknown' =
      r.covered === true ? 'in' : r.covered === false ? 'out' : 'unknown';
    const prev = kleinByPlan.get(r.plan_id);
    if (
      !prev ||
      (prev === 'unknown' && status !== 'unknown') ||
      (prev === 'out' && status === 'in')
    ) {
      kleinByPlan.set(r.plan_id, status);
    }
  }
  const missing = contractPlans.filter((k) => !kleinByPlan.has(k));
  console.log(`  Plans with NO cache row for Klein: ${missing.length} / ${uniq.length}`);

  // ── 3. Formulary (Metformin, Lisinopril) ─────────────────────
  const formRows = await fetchAllRows<{
    contract_id: string;
    plan_id: string;
    rxcui: string;
    tier: number | string | null;
    copay: number | null;
    coinsurance: number | null;
  }>(() =>
    sb
      .from('pm_formulary')
      .select('contract_id, plan_id, rxcui, tier, copay, coinsurance')
      .in('contract_id', contractIds)
      .in('plan_id', planIds)
      .in('rxcui', ALL_RXCUIS),
  );
  type FormHit = {
    rxcui: string;
    tier: number | string | null;
    copay: number | null;
    coinsurance: number | null;
  };
  const formByPlan = new Map<string, FormHit[]>();
  for (const r of formRows) {
    const k = `${r.contract_id}-${r.plan_id}`;
    const arr = formByPlan.get(k) ?? [];
    arr.push({ rxcui: r.rxcui, tier: r.tier, copay: r.copay, coinsurance: r.coinsurance });
    formByPlan.set(k, arr);
  }
  // formByPlan can contain spurious cross-contract keys (the .in()
  // queries are a cartesian over contractIds × planIds; H4-001 may
  // exist in the formulary even if H4-001 isn't a Durham plan). Filter
  // back to the Durham pool before counting so the summary is honest.
  const durhamPoolKeys = new Set(contractPlans);
  const durhamFormByPlan = new Map<string, FormHit[]>();
  for (const [k, v] of formByPlan.entries()) {
    if (durhamPoolKeys.has(k)) durhamFormByPlan.set(k, v);
  }
  console.log(`\nSTEP 3 — Formulary (Metformin/Lisinopril × Durham plans)`);
  console.log(`  Raw rows from PostgREST: ${formRows.length}`);
  console.log(`  Plans (in Durham pool) with ≥1 hit: ${durhamFormByPlan.size} / ${uniq.length}`);
  const planHit = (key: string) => {
    const hits = formByPlan.get(key) ?? [];
    return {
      metformin: hits.find((h) => METFORMIN_RXCUIS.includes(h.rxcui)) ?? null,
      lisinopril: hits.find((h) => LISINOPRIL_RXCUIS.includes(h.rxcui)) ?? null,
    };
  };
  const fullCov = uniq.filter((p) => {
    const c = planHit(`${p.contract_id}-${p.plan_id}`);
    return c.metformin && c.lisinopril;
  }).length;
  const partCov = uniq.filter((p) => {
    const c = planHit(`${p.contract_id}-${p.plan_id}`);
    return (c.metformin || c.lisinopril) && !(c.metformin && c.lisinopril);
  }).length;
  console.log(`  Both drugs covered: ${fullCov}`);
  console.log(`  Only one drug:      ${partCov}`);
  console.log(`  Neither:            ${uniq.length - fullCov - partCov}`);

  // ── 4. Drug cost cache (per contract-plan, aggregated across NDCs) ──
  const drugCostRows = await fetchAllRows<{
    plan_id: string;
    segment_id: string | null;
    ndc: string;
    estimated_yearly_total: number | null;
  }>(() =>
    sb
      .from('pm_drug_cost_cache')
      .select('plan_id, segment_id, ndc, estimated_yearly_total')
      .in('plan_id', contractPlans),
  );
  // Yearly total here is NDC-keyed; without an rxcui→NDC map we can't
  // narrow to our two drugs from this table alone. We sum everything
  // the cache has for the plan as a *ceiling* signal — production code
  // does this properly by intersecting with the patient's medications
  // before summing. For this diagnostic, the formulary fallback below
  // is the cleaner number.
  const drugCostByPlan = new Map<string, number>();
  for (const r of drugCostRows) {
    if (r.estimated_yearly_total == null) continue;
    drugCostByPlan.set(r.plan_id, (drugCostByPlan.get(r.plan_id) ?? 0) + r.estimated_yearly_total);
  }

  // Formulary-derived monthly cost → yearly. For tier-1 generics with a
  // flat copay, this is the truth. For coinsurance, ceiling × pct.
  const TIER_ANNUAL_CEILING: Record<number, number> = {
    1: 360,
    2: 720,
    3: 1800,
    4: 4800,
    5: 18000,
  };
  function formularyAnnual(key: string): number {
    const c = planHit(key);
    let t = 0;
    for (const h of [c.metformin, c.lisinopril]) {
      if (!h) continue;
      if (typeof h.copay === 'number' && h.copay > 0) {
        t += h.copay * 12;
      } else if (typeof h.coinsurance === 'number' && h.coinsurance > 0) {
        const n = typeof h.tier === 'number' ? h.tier : Number(h.tier);
        const ceiling = Number.isFinite(n) ? (TIER_ANNUAL_CEILING[n] ?? 1800) : 1800;
        t += ceiling * (h.coinsurance / 100);
      }
      // tier 1 with $0 copay & $0 coinsurance → $0 annual, correct.
    }
    return t;
  }

  // ── 5. Score per plan ─────────────────────────────────────────
  type Scored = {
    plan: PlanRow;
    key: string;
    network: 'in' | 'out' | 'unknown';
    met: FormHit | null;
    lis: FormHit | null;
    covered: 0 | 1 | 2;
    drugAnnual: number;
    drugSource: 'formulary' | 'cache' | 'none';
    annualCost: number;
  };
  const scored: Scored[] = uniq.map((plan) => {
    const key = `${plan.contract_id}-${plan.plan_id}`;
    const network = kleinByPlan.get(key) ?? 'unknown';
    const cov = planHit(key);
    const covered = ((cov.metformin ? 1 : 0) + (cov.lisinopril ? 1 : 0)) as 0 | 1 | 2;
    const formVal = formularyAnnual(key);
    // We trust the formulary copay number over the per-NDC cache total
    // when both meds appear on formulary — the cache total often
    // includes other drugs we don't care about (it's keyed by plan, not
    // by patient-rxcui).
    const drugAnnual = covered === 2 ? formVal : (drugCostByPlan.get(key) ?? formVal);
    const drugSource: 'formulary' | 'cache' | 'none' =
      covered === 2 ? 'formulary' : drugAnnual > 0 ? 'cache' : 'none';
    const premium = plan.monthly_premium ?? 0;
    const annualCost = premium * 12 + drugAnnual;
    return { plan, key, network, met: cov.metformin, lis: cov.lisinopril, covered, drugAnnual, drugSource, annualCost };
  });

  // ── Sort with tiebreakers ──────────────────────────────────
  // Pure annual-cost ties dominate: nearly every Durham MA plan has
  // $0 premium and Tier-1 generics at $0/mo. Tiebreakers mirror what
  // the brain does in usePlanBrain.diversify():
  //   1. annual cost asc
  //   2. star rating desc (more stars wins)
  //   3. MOOP asc (lower OOP ceiling wins)
  //   4. carrier name asc (stable)
  scored.sort((a, b) => {
    if (a.annualCost !== b.annualCost) return a.annualCost - b.annualCost;
    const sa = a.plan.star_rating ?? 0;
    const sb = b.plan.star_rating ?? 0;
    if (sa !== sb) return sb - sa;
    const ma = a.plan.moop ?? Number.POSITIVE_INFINITY;
    const mb = b.plan.moop ?? Number.POSITIVE_INFINITY;
    if (ma !== mb) return ma - mb;
    return a.plan.carrier.localeCompare(b.plan.carrier);
  });
  const top = scored.slice(0, 4);

  // ── Apply the production brain's Gate 1 (cut Klein-OON) ────
  // src/lib/plan-brain.ts:applyProviderGate eliminates any plan where
  // anyProviderDefinitivelyOut === true. Plans with a confirmed
  // covered=false row are gone from the post-gate pool. Unknown
  // (no row) plans survive — the brain treats them as "could be
  // in-network, NPPES never probed."
  const postGate = scored.filter((s) => s.network !== 'out');
  const postGateTop = postGate.slice(0, 4);

  // ── 6. Print Top 4 — both pre- and post-gate ────────────────
  console.log('\n====================================================');
  console.log('TOP 4 — raw score (NO provider gate applied)');
  console.log('  cost asc, star desc, MOOP asc, carrier asc');
  console.log('====================================================');
  for (let i = 0; i < top.length; i += 1) {
    printScored(i + 1, top[i]);
  }

  console.log('\n====================================================');
  console.log('TOP 4 — post Gate 1 (Klein-OON cut)');
  console.log('  This is what the brain actually returns when Klein');
  console.log('  is added as a provider with a definitive cache verdict.');
  console.log('====================================================');
  for (let i = 0; i < postGateTop.length; i += 1) {
    printScored(i + 1, postGateTop[i]);
  }

  function printScored(rank: number, s: Scored) {
    console.log(`\n#${rank}  ${s.plan.carrier} · ${s.plan.plan_name}`);
    console.log(`     ${s.plan.contract_id}-${s.plan.plan_id} · ${s.plan.plan_type} · ${s.plan.star_rating ?? '?'}★`);
    console.log(`     premium ${fmt$(s.plan.monthly_premium)}/mo · MOOP ${fmt$(s.plan.moop)} · county=${s.plan.county_name}`);
    console.log(`     ── Gates ─────────────────────────────────────`);
    console.log(`     Klein network:     ${gateLabel(s.network)}`);
    console.log(`     Metformin:         ${rxLabel(s.met)}`);
    console.log(`     Lisinopril:        ${rxLabel(s.lis)}`);
    console.log(`     Drug annual:       ${fmt$(s.drugAnnual)} (src=${s.drugSource})`);
    console.log(`     Premium annual:    ${fmt$((s.plan.monthly_premium ?? 0) * 12)}`);
    console.log(`     Projected total:   ${fmt$(s.annualCost)}/yr`);
  }

  // ── 7. Why are OON plans beating IN plans? ───────────────────
  console.log('\n====================================================');
  console.log('Why are OON plans beating IN plans?');
  console.log('====================================================');
  const inPlans = scored.filter((s) => s.network === 'in');
  const outPlans = scored.filter((s) => s.network === 'out');
  const unkPlans = scored.filter((s) => s.network === 'unknown');
  console.log(`  Pool: ${inPlans.length} IN · ${outPlans.length} OON · ${unkPlans.length} Klein-not-probed`);

  const cheapIn = inPlans[0];
  const cheapOut = outPlans[0];
  const cheapUnk = unkPlans[0];
  if (cheapIn) {
    console.log(
      `  Cheapest IN:        ${cheapIn.plan.carrier} · ${cheapIn.plan.plan_name} → ${fmt$(cheapIn.annualCost)}/yr  (premium ${fmt$(cheapIn.plan.monthly_premium)}/mo, drugs ${fmt$(cheapIn.drugAnnual)}/yr)`,
    );
  } else {
    console.log('  Cheapest IN:        (none — Klein not in-network for any Durham plan)');
  }
  if (cheapOut) {
    console.log(
      `  Cheapest OON:       ${cheapOut.plan.carrier} · ${cheapOut.plan.plan_name} → ${fmt$(cheapOut.annualCost)}/yr  (premium ${fmt$(cheapOut.plan.monthly_premium)}/mo, drugs ${fmt$(cheapOut.drugAnnual)}/yr)`,
    );
  }
  if (cheapUnk) {
    console.log(
      `  Cheapest UNK:       ${cheapUnk.plan.carrier} · ${cheapUnk.plan.plan_name} → ${fmt$(cheapUnk.annualCost)}/yr  (premium ${fmt$(cheapUnk.plan.monthly_premium)}/mo, drugs ${fmt$(cheapUnk.drugAnnual)}/yr)`,
    );
  }

  console.log(`\n  Analysis:`);
  if (cheapIn && cheapOut && cheapOut.annualCost < cheapIn.annualCost) {
    const gap = cheapIn.annualCost - cheapOut.annualCost;
    const pGap = (cheapIn.plan.monthly_premium ?? 0) * 12 - (cheapOut.plan.monthly_premium ?? 0) * 12;
    const dGap = cheapIn.drugAnnual - cheapOut.drugAnnual;
    console.log(`  • Cheapest OON beats cheapest IN by ${fmt$(gap)}/yr`);
    console.log(`    — ${fmt$(pGap)}/yr of that gap is premium`);
    console.log(`    — ${fmt$(dGap)}/yr of that gap is drug-cost`);
    console.log(`  • Score is pure dollars (premium + drug). No network`);
    console.log(`    penalty is baked in. With "no extras" and no priorities,`);
    console.log(`    keep_doctor is off — so Klein's in/out status doesn't`);
    console.log(`    feed the score and a cheaper OON premium wins outright.`);
    console.log(`  • Toggle the "keep_doctor" priority (or Step-4 ProvidersScreen`);
    console.log(`    cuts) to push OON plans down. Without it the brain treats`);
    console.log(`    a $0-premium OON plan the same as a $0-premium IN plan.`);
  } else if (cheapIn && cheapUnk && cheapUnk.annualCost < cheapIn.annualCost) {
    const gap = cheapIn.annualCost - cheapUnk.annualCost;
    console.log(`  • Cheapest UNK (Klein never probed) beats cheapest IN by ${fmt$(gap)}/yr`);
    console.log(`  • The brain treats unknown-network plans the same as IN`);
    console.log(`    plans for scoring — there's no penalty for "we don't`);
    console.log(`    know yet." Provider verification on those plans happens`);
    console.log(`    lazily on the Providers screen.`);
    console.log(`  • In a fresh demo run, this is the most common reason`);
    console.log(`    OON-looking plans float up: they're not actually OON,`);
    console.log(`    they're UNK pending an NPPES probe.`);
  } else {
    console.log('  • IN ≤ OON on cheapest. No paradox to explain.');
  }

  console.log(`\n  Klein cache stats:`);
  console.log(`    cache rows present:  ${kleinRows.length}/${uniq.length} plans`);
  console.log(`    in-network:          ${kleinIn}`);
  console.log(`    out-of-network:      ${kleinOut}`);
  console.log(`    unknown verdict:     ${kleinUnk}`);
  console.log(`    no row at all:       ${missing.length} (NPPES never probed)`);

  // Bonus: show Top 10 IN-only and OON-only side-by-side for context.
  console.log('\n  Top 10 IN-network by annual:');
  for (const s of inPlans.slice(0, 10)) {
    console.log(`    ${fmt$(s.annualCost).padStart(8)}  ${s.plan.carrier} · ${s.plan.plan_name}`);
  }
  console.log('\n  Top 10 OON by annual:');
  for (const s of outPlans.slice(0, 10)) {
    console.log(`    ${fmt$(s.annualCost).padStart(8)}  ${s.plan.carrier} · ${s.plan.plan_name}`);
  }
  console.log('\n  Top 10 UNK (Klein never probed) by annual:');
  for (const s of unkPlans.slice(0, 10)) {
    console.log(`    ${fmt$(s.annualCost).padStart(8)}  ${s.plan.carrier} · ${s.plan.plan_name}`);
  }
}

function fmt$(n: number | null | undefined): string {
  if (n == null) return '—';
  if (!Number.isFinite(n)) return '—';
  return `$${Math.round(n).toLocaleString()}`;
}

function gateLabel(s: 'in' | 'out' | 'unknown'): string {
  if (s === 'in') return '✓ in-network';
  if (s === 'out') return '✗ out-of-network';
  return '? not in cache (NPPES never probed)';
}

function rxLabel(h: {
  rxcui: string;
  tier: number | string | null;
  copay: number | null;
  coinsurance: number | null;
} | null): string {
  if (!h) return '✗ not on formulary';
  const tier = h.tier ?? '?';
  const cost =
    typeof h.copay === 'number' && h.copay > 0
      ? `$${h.copay}/mo`
      : typeof h.coinsurance === 'number' && h.coinsurance > 0
        ? `${h.coinsurance}% coins`
        : '$0/mo';
  return `✓ tier ${tier} · ${cost} (rxcui=${h.rxcui})`;
}

main().then(() => process.exit(0));
