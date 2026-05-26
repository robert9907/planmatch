// Full horse-race diagnostic for the agent brain. Mirrors the
// consumer's scripts/diagnose-full-horse-race-27713.ts so both repos
// can be cross-checked under the same strict-gates rules.
//
//   ZIP 27713 / Durham County NC
//   Provider:   Dr. Klein (NPI 1619976297)
//   Meds:       Metformin (861007), Lisinopril (314077), Ozempic (2398842)
//   Conditions: diabetes (self-reported → population='csnp')
//   Priorities: dental ≥ $2,000 + vision + OTC
//
// Run: npx tsx scripts/diagnose-full-horse-race-27713.ts

import { createClient, type PostgrestSingleResponse } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { runPlanBrain } from '../src/lib/plan-brain';
import type {
  PmPlanRow,
  PlanBenefitRow,
  FormularyCoverage,
} from '../src/lib/brain-foreign-types';
import type { ProviderNetworkCacheEntry } from '../src/lib/plan-brain-types';

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

const NPI_KLEIN = '1619976297';
const RX_METFORMIN = '861007';
const RX_LISINOPRIL = '314077';
const RX_OZEMPIC = '2398842';

async function paginate<T>(
  fn: (from: number, to: number) => PromiseLike<PostgrestSingleResponse<T[]>>,
): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await fn(p * 1000, p * 1000 + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log('# Agent horse race — Durham 27713 / Klein / Met+Lis+Ozempic / diabetes / dental $2K + vision + OTC\n');

  // 1. NC Durham plans (sanctioned=false), apply non-comm filter.
  const { data: rawPlans } = await sb
    .from('pm_plans')
    .select('*')
    .eq('state', 'NC')
    .ilike('county_name', '%Durham%')
    .eq('sanctioned', false);
  const { data: ncRows } = await sb
    .from('pm_non_commissionable_contracts')
    .select('contract_id, plan_number');
  const ncContracts = new Set<string>();
  const ncPlans = new Set<string>();
  for (const r of (ncRows ?? []) as Array<{ contract_id: string; plan_number: string | null }>) {
    if (r.plan_number == null) ncContracts.add(r.contract_id);
    else ncPlans.add(`${r.contract_id}-${r.plan_number}`);
  }
  const filteredPlans = (rawPlans ?? []).filter(
    (p) => !ncContracts.has(p.contract_id) && !ncPlans.has(`${p.contract_id}-${p.plan_id}`),
  );
  const seen = new Set<string>();
  const plans: PmPlanRow[] = filteredPlans.filter((p) => {
    const k = `${p.contract_id}-${p.plan_id}-${p.segment_id ?? '0'}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }) as PmPlanRow[];
  console.log(`Durham plans: ${plans.length} unique (after non-commissionable filter)`);

  const contractIds = [...new Set(plans.map((p) => p.contract_id))];
  const planIds = [...new Set(plans.map((p) => p.plan_id))];

  // 2. Benefits.
  const benefitsRows = await paginate<PlanBenefitRow>((from, to) =>
    sb.from('pm_plan_benefits').select('*').in('contract_id', contractIds).in('plan_id', planIds).range(from, to),
  );
  const benefitsByPlanKey = new Map<string, PlanBenefitRow[]>();
  for (const b of benefitsRows) {
    const key = `${b.contract_id}-${b.plan_id}-${b.segment_id ?? '0'}`;
    const list = benefitsByPlanKey.get(key) ?? [];
    list.push(b);
    benefitsByPlanKey.set(key, list);
  }
  console.log(`Benefits rows: ${benefitsRows.length} → ${benefitsByPlanKey.size} plan-segments`);

  // 3. Formulary scoped to user rxcuis only (faster than full pull).
  const formRows = await paginate<{
    contract_id: string;
    plan_id: string;
    rxcui: string;
    tier: number | null;
    copay: number | null;
    coinsurance: number | null;
    prior_auth: boolean | null;
    step_therapy: boolean | null;
  }>((from, to) =>
    sb
      .from('pm_formulary')
      .select('contract_id, plan_id, rxcui, tier, copay, coinsurance, prior_auth, step_therapy')
      .in('contract_id', contractIds)
      .in('plan_id', planIds)
      .in('rxcui', [RX_METFORMIN, RX_LISINOPRIL, RX_OZEMPIC])
      .range(from, to),
  );
  const formularyByPlanKey = new Map<string, Map<string, FormularyCoverage>>();
  for (const r of formRows) {
    const key = `${r.contract_id}-${r.plan_id}`;
    let inner = formularyByPlanKey.get(key);
    if (!inner) { inner = new Map(); formularyByPlanKey.set(key, inner); }
    inner.set(r.rxcui, {
      rxcui: r.rxcui,
      drug_name: null,
      tier: r.tier,
      copay: r.copay,
      coinsurance: r.coinsurance,
      prior_auth: !!r.prior_auth,
      step_therapy: !!r.step_therapy,
      quantity_limit: false,
      quantity_limit_amount: null,
      quantity_limit_days: null,
      match_type: 'rxcui',
    } as FormularyCoverage);
  }
  console.log(`Formulary rows (3 rxcuis): ${formRows.length}`);

  // 4. Provider cache for Klein only.
  const cpKeys = [...new Set(plans.map((p) => `${p.contract_id}-${p.plan_id}`))];
  const provRows = await paginate<{ plan_id: string; covered: boolean | null }>((from, to) =>
    sb.from('pm_provider_network_cache').select('plan_id, covered').eq('npi', NPI_KLEIN).in('plan_id', cpKeys).range(from, to),
  );
  const providerNetworkByPlanKey = new Map<string, Map<string, ProviderNetworkCacheEntry>>();
  for (const r of provRows) {
    const inner = providerNetworkByPlanKey.get(r.plan_id) ?? new Map();
    inner.set(NPI_KLEIN, { npi: NPI_KLEIN, covered: r.covered === true });
    providerNetworkByPlanKey.set(r.plan_id, inner);
  }
  console.log(`Klein cache rows: ${provRows.length}\n`);

  // 5. Run the brain.
  const brain = runPlanBrain({
    plans,
    benefitsByPlanKey,
    formularyByPlanKey,
    providerNetworkByPlanKey,
    userProfile: {
      drugs: [
        { rxcui: RX_METFORMIN, name: 'Metformin 500mg' },
        { rxcui: RX_LISINOPRIL, name: 'Lisinopril 20mg' },
        { rxcui: RX_OZEMPIC, name: 'Ozempic 1mg/0.75mL' },
      ],
      providers: [{ npi: NPI_KLEIN, name: 'Dr. Kombiz Klein' }],
      priorities: new Set(['dental', 'vision', 'otc']),
      priorityThresholds: { dental: 2000 },
      csnpConditions: ['diabetes'],
      conditionSupplies: [],
      dsnpEligible: null,
      age: 65,
    },
    county: 'Durham',
  });
  const picks = brain.liveTop3?.picks ?? [];
  console.log(`Brain population: ${brain.population}`);
  console.log(`Top 4: ${picks.length} picks`);
  console.log(`csnpNote: ${brain.csnpNote ?? '(null)'}\n`);

  console.log('═══ TOP 4 ═══');
  for (let i = 0; i < picks.length; i++) {
    const pick = picks[i];
    const row = pick.plan.row;
    const triple = `${row.contract_id}-${row.plan_id}-${row.segment_id ?? '0'}`;
    const cpKey = `${row.contract_id}-${row.plan_id}`;
    const provEntry = providerNetworkByPlanKey.get(cpKey)?.get(NPI_KLEIN);
    const klein = provEntry == null ? 'absent' : provEntry.covered ? 'IN' : 'OUT';
    const score = brain.ranked.find(
      (s) => s.row.contract_id === row.contract_id && s.row.plan_id === row.plan_id && s.row.segment_id === row.segment_id,
    )?.score;
    const status = score?.csnpReservedSlot
      ? 'csnp_reserved'
      : score?.nearMiss
        ? 'near_miss'
        : 'full_match';
    const nm = score?.nearMiss;
    console.log(`\n${i + 1}. ${row.carrier} — ${row.plan_name}`);
    console.log(`   ID:            ${triple}    snp_type: "${row.snp_type ?? ''}"`);
    console.log(`   Status:        ${status}${nm ? `  (missed ${nm.preference}: plan=${nm.planValue}${nm.userThreshold != null ? ` vs user ≥${nm.userThreshold}` : ''})` : ''}`);
    console.log(`   Klein (NPI):   ${klein}`);
    console.log(`   Drugs cov:     ${score?.coveredCount}/${score?.totalCount}`);
    console.log(`   Cost:          $${Math.round((row.monthly_premium ?? 0) * 12 + (score?.totalAnnualDrugCost ?? 0) - (score?.partBGivebackAnnual ?? 0))}/yr (premium ${(row.monthly_premium ?? 0) * 12} + drugs ${Math.round(score?.totalAnnualDrugCost ?? 0)} − giveback ${Math.round(score?.partBGivebackAnnual ?? 0)})`);
    console.log(`   MOOP:          $${row.moop ?? 'n/a'}    Stars: ${row.star_rating ?? 'n/a'}`);
  }

  // Verification
  console.log('\n═══ VERIFICATION ═══');
  const absent = picks.filter((p) => {
    const cpKey = `${p.plan.row.contract_id}-${p.plan.row.plan_id}`;
    const v = providerNetworkByPlanKey.get(cpKey)?.get(NPI_KLEIN);
    return v == null || !v.covered;
  });
  if (absent.length === 0) {
    console.log('✓ Zero absent providers in Top 4 — strict Gate 1 held.');
  } else {
    console.log(`✗ ${absent.length} Top-4 plans have Klein NOT confirmed in-network:`);
    for (const p of absent) console.log(`  ${p.plan.row.contract_id}-${p.plan.row.plan_id}`);
  }
  const csnp = picks.find((p) => /c-snp|csnp|chronic/i.test(p.plan.row.snp_type ?? ''));
  if (csnp) console.log(`✓ C-SNP in Top 4: ${csnp.plan.row.carrier} ${csnp.plan.row.plan_name}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
