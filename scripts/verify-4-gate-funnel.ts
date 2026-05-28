// Verify the 4-gate brain funnel against real Durham NC data, running
// three priority scenarios to exercise the new Gate 3:
//
//   A. dental + otc                    — pure richness rank
//   B. dental + vision + partb_giveback— 3-way richness rank
//   C. dental + transportation         — richness + binary filter
//
// Client: Christopher Eckstein MD (NPI 1003023201, Durham, neurology)
// + 2 widely-covered Tier 1/2 generics.
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

// ── Load shared inputs ───────────────────────────────────────────
const plans = await paginate<PmPlanRow>((f, t) =>
  sb.from('pm_plans')
    .select(
      'contract_id, plan_id, segment_id, plan_name, carrier, parent_organization, plan_type, state, county_name, monthly_premium, annual_deductible, moop, drug_deductible, star_rating, snp, snp_type, sanctioned',
    )
    .eq('state', 'NC').ilike('county_name', 'Durham')
    .range(f, t),
);
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

const mapdContractPlanIds = new Set<string>();
for (const key of formularyByPlanKey.keys()) mapdContractPlanIds.add(key);

// ── Probe each scenario ──────────────────────────────────────────
const baseProfile = {
  drugs: drugRxcuis.map((rxcui) => ({ rxcui, name: `drug-${rxcui}` })),
  providers: [{ npi: providerNpi, name: 'Eckstein, Christopher MD' }],
  csnpConditions: [] as ReadonlyArray<never>,
  conditionSupplies: [] as ReadonlyArray<string>,
  age: 67,
  hasVaDrugCoverage: false,
};

function runScenario(label: string, priorities: string[]) {
  const input: BrainInputs = {
    plans,
    benefitsByPlanKey,
    formularyByPlanKey,
    userProfile: { ...baseProfile, priorities: new Set<string>(priorities) },
    county: 'Durham',
    providerNetworkByPlanKey,
    mapdContractPlanIds,
  };
  const output = runPlanBrain(input);
  console.log(`\n══════════ ${label} ══════════`);
  console.log(`priorities: [${priorities.join(', ')}]`);
  console.log(`pool=${plans.length} → eligible+ranked=${output.ranked.length}`);
  console.log(`top picks: ${output.liveTop3?.picks.length ?? 0}`);

  const picks = output.liveTop3?.picks ?? [];
  if (picks.length === 0) {
    console.log('(no picks)');
    return { label, priorities, top4: [] };
  }
  // Pull per-priority dollar values so we can show WHY each plan ranked.
  console.log('\nTop 4:');
  const head: string[] = ['#', 'plan', 'name'.padEnd(36)];
  for (const p of priorities) {
    if (p === 'transportation') continue; // binary filter, not scored
    head.push(`${p}/yr`);
  }
  head.push('Σ rich', 'cost/yr');
  console.log('  ' + head.join(' │ '));
  const rows: any[] = [];
  for (let i = 0; i < picks.length; i += 1) {
    const pick = picks[i];
    const scored = output.ranked.find(
      (s) =>
        s.row.contract_id === pick.plan.row.contract_id &&
        s.row.plan_id === pick.plan.row.plan_id &&
        s.row.segment_id === pick.plan.row.segment_id,
    )!;
    const b = scored.benefits;
    const dental = (() => {
      const r = b.find((x) => x.benefit_category === 'dental');
      return r ? r.coverage_amount ?? r.max_coverage ?? 0 : 0;
    })();
    const vision = (() => {
      const r = b.find((x) => x.benefit_category === 'vision');
      return r ? r.coverage_amount ?? r.max_coverage ?? 0 : 0;
    })();
    const otcAnnual = (() => {
      const r = b.find((x) => x.benefit_category === 'otc');
      return r ? (r.coverage_amount ?? 0) * 4 : 0;
    })();
    const giveback = (() => {
      const r = b.find((x) => x.benefit_category === 'partb_giveback');
      return r ? (r.coverage_amount ?? r.max_coverage ?? 0) * 12 : 0;
    })();
    const valMap: Record<string, number> = {
      dental, vision, otc: otcAnnual, partb_giveback: giveback,
    };
    const sum = priorities
      .filter((p) => p !== 'transportation')
      .reduce((acc, p) => acc + (valMap[p] ?? 0), 0);
    const row: any = {
      n: i + 1,
      plan: `${pick.plan.row.contract_id}-${pick.plan.row.plan_id}`,
      name: String(pick.plan.row.plan_name).slice(0, 36),
    };
    for (const p of priorities) {
      if (p === 'transportation') continue;
      row[p] = `$${valMap[p] ?? 0}`;
    }
    row.richness = `$${sum}`;
    row.cost = `$${scored.score.realAnnualCost.netAnnual}`;
    rows.push(row);
  }
  console.table(rows);

  // Confirm transportation filter behavior when applicable.
  if (priorities.includes('transportation')) {
    const passTransport = output.ranked.filter((s) =>
      s.benefits.some((b) => b.benefit_category === 'transportation'),
    );
    const failTransport = output.ranked.filter(
      (s) => !s.benefits.some((b) => b.benefit_category === 'transportation'),
    );
    console.log(
      `\nTransportation filter: ${passTransport.length} kept, ${failTransport.length} would have been dropped (the "ranked" list shows pre-filter pool, but Top picks should NEVER include a plan from the dropped set).`,
    );
    const top4Set = new Set(picks.map((p) => `${p.plan.row.contract_id}-${p.plan.row.plan_id}`));
    const violations = failTransport.filter((s) =>
      top4Set.has(`${s.row.contract_id}-${s.row.plan_id}`),
    );
    if (violations.length > 0) {
      console.log(`⚠️  ${violations.length} top picks lack transportation — filter failed.`);
    } else {
      console.log(`✓ All top picks file transportation.`);
    }
  }
  return {
    label,
    priorities,
    top4: picks.map((p) => `${p.plan.row.contract_id}-${p.plan.row.plan_id}`),
  };
}

const a = runScenario('A. dental + OTC', ['dental', 'otc']);
const b = runScenario('B. dental + vision + partb_giveback', ['dental', 'vision', 'partb_giveback']);
const c = runScenario('C. dental + transportation (binary filter)', ['dental', 'transportation']);

console.log('\n══════════ TOP-4 COMPARISON ACROSS SCENARIOS ══════════');
console.table([a, b, c].map((s) => ({ scenario: s.label, picks: s.top4.join(', ') })));
