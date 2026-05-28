// Verify the 4-gate brain funnel against real Durham NC data.
//
// Client profile: Christopher Eckstein MD (NPI 1003023201, Durham,
// neurology) + 2 common drugs (metformin + atorvastatin generics) +
// priorities = dental + OTC.
//
// Reports:
//   • Pool size + Gate 1 / 2 / 3 survivors
//   • Top 4 after Gate 3 (richness)
//   • Gate 4 cost sort
//   • Side-by-side: old 3-term cost vs new full-bucket cost per pick
//
// Read-only.

import { createClient, type PostgrestSingleResponse } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { runPlanBrain } from '../src/lib/plan-brain';
import type {
  BrainInputs,
  ProviderNetworkCacheEntry,
  FormularyCoverage,
} from '../src/lib/plan-brain-types';
import type { PmPlanRow, PlanBenefitRow } from '../src/lib/brain-foreign-types';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function paginate<T>(
  fn: (f: number, t: number) => PromiseLike<PostgrestSingleResponse<T[]>>,
  maxPages = 100,
): Promise<T[]> {
  const out: T[] = [];
  for (let n = 0; n < maxPages; n += 1) {
    const { data, error } = await fn(n * 1000, n * 1000 + 999);
    if (error) throw error;
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

// ── 1. Load Durham plans ─────────────────────────────────────────
const plans = await paginate<PmPlanRow>((f, t) =>
  sb.from('pm_plans')
    .select(
      'contract_id, plan_id, segment_id, plan_name, carrier, parent_organization, plan_type, state, county_name, monthly_premium, annual_deductible, moop, drug_deductible, star_rating, snp, snp_type, sanctioned',
    )
    .eq('state', 'NC').ilike('county_name', 'Durham')
    .range(f, t),
);
console.log(`Pool: ${plans.length} Durham plan-segments`);

// ── 2. Benefits ─────────────────────────────────────────────────
const contractIds = [...new Set(plans.map((p) => p.contract_id))];
const benefits = await paginate<PlanBenefitRow>((f, t) =>
  sb.from('pm_plan_benefits')
    .select(
      'contract_id, plan_id, segment_id, benefit_category, benefit_description, copay, coinsurance, coverage_amount, max_coverage',
    )
    .in('contract_id', contractIds).range(f, t),
);
const benefitsByPlanKey = new Map<string, PlanBenefitRow[]>();
for (const b of benefits) {
  const key = `${b.contract_id}-${b.plan_id}-${b.segment_id || '000'}`;
  const list = benefitsByPlanKey.get(key) ?? [];
  list.push(b);
  benefitsByPlanKey.set(key, list);
}
console.log(`Benefits rows: ${benefits.length} across ${benefitsByPlanKey.size} plan keys`);

// ── 3. Pick 2 widely-stocked rxcuis ─────────────────────────────
// Two widely-covered Durham generics — picked by sampling H1914-009's
// formulary and confirming both appear on 64/74 Durham plans.
const drugRxcuis = ['313096', '1010739'];
const formularyHits = await paginate<{ contract_id: string; plan_id: string; rxcui: string; tier: number | null; copay: number | null; coinsurance: number | null }>(
  (f, t) =>
    sb.from('pm_formulary')
      .select('contract_id, plan_id, rxcui, tier, copay, coinsurance')
      .in('contract_id', contractIds)
      .in('rxcui', drugRxcuis)
      .range(f, t),
);
const formularyByPlanKey = new Map<string, Map<string, FormularyCoverage>>();
for (const r of formularyHits) {
  const key = `${r.contract_id}-${r.plan_id}`;
  const map = formularyByPlanKey.get(key) ?? new Map();
  map.set(r.rxcui, {
    rxcui: r.rxcui,
    tier: r.tier,
    copay: r.copay,
    coinsurance: r.coinsurance,
    prior_auth: false,
    step_therapy: false,
    quantity_limit: false,
  } as unknown as FormularyCoverage);
  formularyByPlanKey.set(key, map);
}
console.log(`Formulary hits: ${formularyHits.length} across ${formularyByPlanKey.size} plan keys`);

// ── 4. Provider cache for NPI 1003023201 (Eckstein, Durham) ─────
const providerNpi = '1003023201';
const provRows = await paginate<{ plan_id: string; npi: string; covered: boolean }>(
  (f, t) =>
    sb.from('pm_provider_network_cache')
      .select('plan_id, npi, covered')
      .eq('state', 'NC').eq('county_fips', 37063)
      .eq('npi', providerNpi)
      .range(f, t),
);
const providerNetworkByPlanKey = new Map<string, Map<string, ProviderNetworkCacheEntry>>();
for (const r of provRows) {
  const map = providerNetworkByPlanKey.get(r.plan_id) ?? new Map();
  map.set(String(r.npi), { npi: String(r.npi), covered: r.covered });
  providerNetworkByPlanKey.set(r.plan_id, map);
}
console.log(`Provider rows for NPI ${providerNpi}: ${provRows.length}`);

// MAPD set so the brain doesn't drop MA-only plans on the no-VA path
const mapdContractPlanIds = new Set<string>();
for (const key of formularyByPlanKey.keys()) mapdContractPlanIds.add(key);

// ── 5. Build BrainInputs ────────────────────────────────────────
const userProfile = {
  drugs: drugRxcuis.map((rxcui) => ({ rxcui, name: `drug-${rxcui}` })),
  providers: [{ npi: providerNpi, name: 'Eckstein, Christopher MD' }],
  priorities: new Set<string>(['dental', 'otc']),
  csnpConditions: [],
  conditionSupplies: [],
  age: 67,
  hasVaDrugCoverage: false,
};
const input: BrainInputs = {
  plans,
  benefitsByPlanKey,
  formularyByPlanKey,
  userProfile,
  county: 'Durham',
  providerNetworkByPlanKey,
  mapdContractPlanIds,
};

// ── 6. Run the brain ────────────────────────────────────────────
console.log('\nRunning brain…\n');
const output = runPlanBrain(input);
console.log(`Final ranked plans: ${output.ranked.length}`);
console.log(`liveTop3 picks: ${output.liveTop3?.picks.length ?? 0}\n`);

const top4 = output.liveTop3?.picks.map((p) => p.plan.row) ?? [];

// ── 7. Side-by-side cost: old 3-term vs new full bucket ─────────
function oldCost(s: { score: { totalAnnualDrugCost: number; partBGivebackAnnual: number }; row: { monthly_premium: number | null } }): number {
  return (s.row.monthly_premium ?? 0) * 12 + s.score.totalAnnualDrugCost - s.score.partBGivebackAnnual;
}

console.log('Top 4 after Gate 3 (richness DESC) — Gate 4 cost columns side-by-side:');
console.log();
const head = ['#', 'plan', 'name', 'premium/yr', 'drugs', 'med bucket', 'ded', 'snf+amb+dme', 'giveback', 'old 3-term', 'new full', 'Δ'];
console.log('  ' + head.join(' │ '));
for (let i = 0; i < top4.length; i += 1) {
  const row = top4[i];
  const scored = output.ranked.find(
    (s) => s.row.contract_id === row.contract_id && s.row.plan_id === row.plan_id && s.row.segment_id === row.segment_id,
  )!;
  const r = scored.score.realAnnualCost;
  const old = oldCost(scored);
  const nu = r.netAnnual;
  const extras = r.snfExpected + r.ambulanceExpected + r.dmeExpected;
  console.log(`  ${i + 1} │ ${row.contract_id}-${row.plan_id} │ ${String(row.plan_name).slice(0, 32).padEnd(32)} │ $${r.premium} │ $${r.drugCost} │ $${r.cappedMedicalBucket - r.deductibleCost - extras} │ $${r.deductibleCost} │ $${extras} │ -$${r.partBGivebackSavings} │ $${old} │ $${nu} │ ${nu - old >= 0 ? '+' : ''}$${nu - old}`);
}

// ── 8. Show Gate funnel stats from console.info (we captured them above) ──
console.log('\nGate funnel summary from runPlanBrain (see prior [brain-funnel] lines).');

// ── 9. Cost-rank comparison: how does the top 4 ORDER change? ───
console.log('\nRank changes between old and new cost formula (top 10):');
const allScored = output.ranked.slice(0, 30);
const oldRank = [...allScored].sort((a, b) => oldCost(a) - oldCost(b));
const newRank = [...allScored].sort((a, b) => a.score.realAnnualCost.netAnnual - b.score.realAnnualCost.netAnnual);
const rows = [];
for (let i = 0; i < Math.min(10, oldRank.length); i += 1) {
  const oldPick = oldRank[i];
  const newPick = newRank[i];
  rows.push({
    rank: i + 1,
    old_plan: `${oldPick.row.contract_id}-${oldPick.row.plan_id}`,
    old_cost: oldCost(oldPick),
    new_plan: `${newPick.row.contract_id}-${newPick.row.plan_id}`,
    new_cost: newPick.score.realAnnualCost.netAnnual,
    changed: oldPick.row.contract_id !== newPick.row.contract_id || oldPick.row.plan_id !== newPick.row.plan_id ? 'YES' : '',
  });
}
console.table(rows);
