// scripts/_probe-durham-brain-four.ts
// Acceptance probe for the agent-side sellable ranking exclusion.
//
// Runs runPlanBrain() over REAL Durham NC 2027 data for a drug-having user,
// with the sellable filter WIRED (pm_non_commissionable_rules + carrier flags
// + pm_plan_sellability appointment flags attached per plan). Prints the local
// brain's top four and Troy Medicare (H4676-001, is_appointed=false)'s
// disposition. Mirrors the consumer acceptance.
//
// Read-only. tsx + Node 22 (native WebSocket). Loads env from the worktree
// or the main checkout's .env.local.
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { runPlanBrain } from '../src/lib/plan-brain';
import type {
  BrainInputs,
  UserProfile,
} from '../src/lib/plan-brain-types';
import type {
  PmPlanRow,
  PlanBenefitRow,
  FormularyCoverage,
} from '../src/lib/brain-foreign-types';
import { getSellableRules, getSellableFlags } from '../api/_lib/sellable-rules';

for (const p of ['.env.local', '/Users/robertsimm/planmatch/planmatch/.env.local']) {
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const SB_URL = process.env.SUPABASE_URL ?? '';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!SB_URL || !SB_KEY) { console.error('Missing env'); process.exit(1); }
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const COUNTY = 'Durham';
const STATE = 'NC';
const YEAR = 2027;
// A common statin — drug-having user. rxcui 617318 = Atorvastatin 80 MG tab.
const DRUG = { rxcui: '617318', name: 'Atorvastatin 80 MG', isBrand: false };

type PlanRowDB = {
  contract_id: string; plan_id: string; segment_id: string | null; plan_name: string;
  carrier: string | null; parent_organization: string | null; plan_type: string | null;
  state: string; county_name: string; monthly_premium: number | null;
  annual_deductible: number | null; moop: number | null; drug_deductible: number | null;
  star_rating: number | null; snp: boolean | null; snp_type: string | null; sanctioned: boolean | null;
};

async function main() {
  // ── Durham 2027 pool ──────────────────────────────────────────────
  const { data: planRows, error: e1 } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, carrier, parent_organization, plan_type, state, county_name, monthly_premium, annual_deductible, moop, drug_deductible, star_rating, snp, snp_type, sanctioned')
    .eq('state', STATE).ilike('county_name', COUNTY).eq('plan_year', YEAR).eq('sanctioned', false)
    .limit(2000);
  if (e1) throw e1;
  const plans = (planRows ?? []) as PlanRowDB[];

  // ── Appointment flags (pm_plan_sellability) ───────────────────────
  const { data: sellRows, error: e2 } = await sb
    .from('pm_plan_sellability')
    .select('contract_id, plan_number, is_appointed, is_certified, pays_commission');
  if (e2) throw e2;
  const byContract = new Map<string, { is_appointed: boolean; is_certified: boolean; pays_commission: boolean }>();
  const byPlan = new Map<string, { is_appointed: boolean; is_certified: boolean; pays_commission: boolean }>();
  for (const r of sellRows ?? []) {
    const f = { is_appointed: !!r.is_appointed, is_certified: !!r.is_certified, pays_commission: !!r.pays_commission };
    if (r.plan_number == null) byContract.set(r.contract_id, f);
    else byPlan.set(`${r.contract_id}-${r.plan_number}`, f);
  }
  const resolveSell = (c: string, p: string) =>
    byPlan.get(`${c}-${p}`) ?? byContract.get(c) ?? { is_appointed: true, is_certified: true, pays_commission: true };

  // ── Build PmPlanRow[] (mirror of usePlanBrain.planToPmRow) ─────────
  const pmRows: PmPlanRow[] = plans.map((p, i) => {
    const seg = (p.segment_id ?? '0').replace(/^0+/, '') || '0';
    const t = (p.snp_type ?? '').toUpperCase();
    const snpKind = t.includes('D-SNP') || t.includes('DSNP') ? 'D-SNP'
      : t.includes('C-SNP') || t.includes('CSNP') ? 'C-SNP'
      : t.includes('I-SNP') || t.includes('ISNP') ? 'I-SNP' : null;
    const f = resolveSell(p.contract_id, p.plan_id);
    return {
      id: i + 1, contract_id: p.contract_id, plan_id: p.plan_id, segment_id: seg,
      plan_name: p.plan_name, carrier: p.carrier, parent_organization: p.parent_organization,
      plan_type: p.plan_type, state: p.state, county_name: COUNTY, county_fips: null,
      monthly_premium: p.monthly_premium, annual_deductible: p.annual_deductible ?? 0,
      moop: p.moop, drug_deductible: p.drug_deductible, star_rating: p.star_rating,
      snp: snpKind != null, snp_type: snpKind, sanctioned: false,
      enrollment_count: null, enrollment_as_of: null,
      is_appointed: f.is_appointed, is_certified: f.is_certified, pays_commission: f.pays_commission,
    };
  });

  // ── Formulary coverage for the user's drug (so Gate 2 can pass) ────
  const contracts = [...new Set(plans.map((p) => p.contract_id))];
  const planNums = [...new Set(plans.map((p) => p.plan_id))];
  const { data: formRows } = await sb
    .from('pm_formulary')
    .select('contract_id, plan_id, rxcui, tier, copay, coinsurance, prior_auth, step_therapy')
    .eq('plan_year', YEAR).in('contract_id', contracts).in('plan_id', planNums).eq('rxcui', DRUG.rxcui)
    .limit(2000);
  const formularyByPlanKey = new Map<string, Map<string, FormularyCoverage>>();
  for (const r of formRows ?? []) {
    const key = `${r.contract_id}-${r.plan_id}`;
    const inner = formularyByPlanKey.get(key) ?? new Map<string, FormularyCoverage>();
    inner.set(r.rxcui, {
      rxcui: r.rxcui, drug_name: null, tier: r.tier, copay: r.copay, coinsurance: r.coinsurance,
      prior_auth: r.prior_auth === true, step_therapy: r.step_therapy === true,
      quantity_limit: false, quantity_limit_amount: null, quantity_limit_days: null, match_type: 'rxcui',
    });
    formularyByPlanKey.set(key, inner);
  }

  // ── Sellable rules + flags via the shared loader ───────────────────
  const rules = await getSellableRules(SB_URL, SB_KEY, YEAR);
  const flags = getSellableFlags();

  const userProfile: UserProfile = {
    drugs: [DRUG],
    providers: [],
    priorities: new Set<string>(),
    csnpConditions: [],
    dsnpEligible: null,
    medicaidLevel: 'none',
    lisTier: 'none',
    livingSetting: 'community',
  };

  const inputs: BrainInputs = {
    plans: pmRows,
    benefitsByPlanKey: new Map<string, PlanBenefitRow[]>(),
    formularyByPlanKey,
    userProfile,
    county: COUNTY,
    formularyPublished: true,
    planYear: YEAR,
    sellableRules: rules,
    sellableFlags: flags,
    now: new Date('2026-10-15T12:00:00Z'),
  };

  const out = runPlanBrain(inputs);

  // ── Report ─────────────────────────────────────────────────────────
  const troyKey = 'H4676-001';
  const troyRow = pmRows.find((r) => `${r.contract_id}-${r.plan_id}` === troyKey);
  console.log('═'.repeat(76));
  console.log(`DURHAM NC ${YEAR} — local brain (runPlanBrain) top four — drug: ${DRUG.name}`);
  console.log(`pool: ${pmRows.length} plans · sellableRules: ${rules.length} · uhcExcludedFrom=${flags.uhcExcludedFrom} devotedExcluded=${flags.devotedExcluded}`);
  console.log('═'.repeat(76));
  console.log(`Troy Medicare H4676-001 in pool: ${troyRow ? 'YES' : 'NO'}` +
    (troyRow ? ` (premium $${troyRow.monthly_premium}/mo, is_appointed=${troyRow.is_appointed}, is_certified=${troyRow.is_certified})` : ''));

  const picks = out.liveTop3?.picks ?? [];
  console.log(`\nTOP FOUR (${picks.length}):`);
  picks.forEach((pk, i) => {
    const r = pk.plan.row;
    console.log(`  ${i + 1}. ${r.carrier} — ${r.plan_name} [${r.contract_id}-${r.plan_id}-${r.segment_id}] ` +
      `premium $${r.monthly_premium}/mo · annualCost $${Math.round(pk.plan.totalAnnualCost)} · sellable=${pk.plan.row.is_appointed !== false && pk.plan.row.is_certified !== false}`);
  });

  const inFour = picks.some((pk) => `${pk.plan.row.contract_id}-${pk.plan.row.plan_id}` === troyKey);
  const troyScored = out.ranked.find((s) => `${s.row.contract_id}-${s.row.plan_id}` === troyKey);
  console.log('\n── TROY DISPOSITION ──');
  console.log(`  In top four: ${inFour ? 'YES (REGRESSION!)' : 'NO ✓'}`);
  if (troyScored) {
    console.log(`  On bench (ranked): YES ✓`);
    console.log(`  score.sellable = ${troyScored.score.sellable}`);
    console.log(`  score.sellableReason = ${JSON.stringify(troyScored.score.sellableReason)}`);
  } else {
    console.log(`  On bench (ranked): NO — Troy was filtered out of the eligible pool entirely (not just benched).`);
  }

  // Sellable-partition summary.
  const nonSellable = out.ranked.filter((s) => s.score.sellable === false);
  console.log(`\n── SELLABLE PARTITION ──`);
  console.log(`  ranked (eligible pool): ${out.ranked.length}`);
  console.log(`  non-sellable (benched): ${nonSellable.length}`);
  console.log(`  sample non-sellable: ` +
    nonSellable.slice(0, 8).map((s) => `${s.row.carrier}/${s.row.contract_id}-${s.row.plan_id}`).join(', '));

  const pass = !inFour && troyScored?.score.sellable === false;
  console.log('\n' + '═'.repeat(76));
  console.log(pass ? 'ACCEPTANCE: PASS ✓  Troy is NOT in the four and is benched sellable=false.'
                   : 'ACCEPTANCE: FAIL ✗  (see above)');
  console.log('═'.repeat(76));
  process.exit(pass ? 0 : 2);
}
main().catch((e) => { console.error(e); process.exit(1); });
