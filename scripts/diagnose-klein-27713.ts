// Diagnostic: run the elimination funnel for Rob's exact scenario.
//   Geo:      Durham County NC, ZIP 27713 (matches county_name filter)
//   Provider: Dr. Kombiz Klein, NPI 1619976297 (Klein Internal Medicine)
//   Meds:     Metformin 500 mg (rxcui 861007), Lisinopril 20 mg (rxcui 314077)
//   Extras:   none
//
// Mirrors gates from src/lib/plan-brain.ts so we can see who survives and
// why an OON plan might out-rank an in-network plan. Approximations:
//   • Annual drug cost = sum across the 2 meds of (covered ? 12×copay : 0).
//     Brain uses pm_drug_cost_cache when present; the probe falls back to
//     the formulary copay so we don't depend on the cache being warm.
//   • partB_giveback annual pulled from pbp_benefits.
//
// Run: npx tsx scripts/diagnose-klein-27713.ts

import { createClient, type PostgrestSingleResponse } from '@supabase/supabase-js';
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

const NPI_KLEIN = '1619976297';
const RXCUI_METFORMIN = '861007'; // Metformin 500 MG Oral Tablet
const RXCUI_LISINOPRIL = '314077'; // Lisinopril 20 MG Oral Tablet
const USER_RXCUIS = [RXCUI_METFORMIN, RXCUI_LISINOPRIL];

async function paginate<T>(
  pageFn: (from: number, to: number) => PromiseLike<PostgrestSingleResponse<T[]>>,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let pageNum = 0; pageNum < 20; pageNum += 1) {
    const from = pageNum * PAGE;
    const to = from + PAGE - 1;
    const { data, error } = await pageFn(from, to);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

interface PlanRow {
  contract_id: string;
  plan_id: string;
  segment_id: string | null;
  plan_name: string;
  carrier: string;
  plan_type: string | null;
  monthly_premium: number | null;
  snp: boolean | null;
  snp_type: string | null;
  sanctioned: boolean | null;
}

async function main() {
  // ── 1. Plan pool: Durham NC plans, sanctioned=false ─────────────────
  const { data: rawPlans, error: planErr } = await sb
    .from('pm_plans')
    .select(
      'contract_id, plan_id, segment_id, plan_name, carrier, plan_type, monthly_premium, snp, snp_type, sanctioned',
    )
    .eq('state', 'NC')
    .ilike('county_name', '%Durham%')
    .eq('sanctioned', false);
  if (planErr) throw planErr;

  // ── 2. Non-commissionable filter ────────────────────────────────────
  const { data: ncRows } = await sb
    .from('pm_non_commissionable_contracts')
    .select('contract_id, plan_number');
  const ncContracts = new Set<string>();
  const ncPlans = new Set<string>();
  for (const r of ncRows ?? []) {
    if (r.plan_number == null) ncContracts.add(r.contract_id);
    else ncPlans.add(`${r.contract_id}-${r.plan_number}`);
  }
  const plans: PlanRow[] = (rawPlans ?? []).filter(
    (p) => !ncContracts.has(p.contract_id) && !ncPlans.has(`${p.contract_id}-${p.plan_id}`),
  );

  // Dedupe by (contract, plan, segment)
  const seen = new Set<string>();
  const uniq = plans.filter((p) => {
    const k = `${p.contract_id}-${p.plan_id}-${p.segment_id ?? '0'}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Drop SNP plans (standard population, no widening because no
  // conditions/meds in this scenario qualify for C-SNP — Metformin alone
  // only flags 'likely' for diabetes per condition-detector.ts).
  const eligible = uniq.filter((p) => !p.snp);

  console.log(`Durham 27713 pool: ${rawPlans?.length ?? 0} raw → ${uniq.length} unique → ${eligible.length} non-SNP MAPD/MA candidates\n`);

  const contractIds = [...new Set(eligible.map((p) => p.contract_id))];
  const planIds = [...new Set(eligible.map((p) => p.plan_id))];

  // ── 3. Provider network cache for Dr. Klein ─────────────────────────
  const netRows = await paginate<{ plan_id: string; segment_id: string | null; npi: string; covered: boolean | null }>(
    (from, to) =>
      sb
        .from('pm_provider_network_cache')
        .select('plan_id, segment_id, npi, covered')
        .eq('npi', NPI_KLEIN)
        .range(from, to),
  );
  // pm_provider_network_cache.plan_id is "<contract>-<plan>" or "<contract>-<plan>-<segment>"
  const provByContractPlan = new Map<string, boolean | null>();
  for (const r of netRows) {
    const parts = r.plan_id.split('-');
    const key = `${parts[0]}-${parts[1]}`;
    // Last write wins; if any row says true treat as true, any false beats absent.
    const prev = provByContractPlan.get(key);
    if (prev === undefined) provByContractPlan.set(key, r.covered);
    else if (prev !== true && r.covered === true) provByContractPlan.set(key, true);
    else if (prev == null && r.covered === false) provByContractPlan.set(key, false);
  }

  // ── 4. Formulary for Metformin + Lisinopril ─────────────────────────
  const formRows = await paginate<{ contract_id: string; plan_id: string; rxcui: string; tier: number | null; copay: number | null; coinsurance: number | null }>(
    (from, to) =>
      sb
        .from('pm_formulary')
        .select('contract_id, plan_id, rxcui, tier, copay, coinsurance')
        .in('contract_id', contractIds)
        .in('plan_id', planIds)
        .in('rxcui', USER_RXCUIS)
        .range(from, to),
  );
  type FormHit = { tier: number | null; copay: number | null; coinsurance: number | null };
  const formByPlan = new Map<string, Map<string, FormHit>>();
  for (const r of formRows) {
    const k = `${r.contract_id}-${r.plan_id}`;
    let m = formByPlan.get(k);
    if (!m) {
      m = new Map();
      formByPlan.set(k, m);
    }
    m.set(r.rxcui, { tier: r.tier, copay: r.copay, coinsurance: r.coinsurance });
  }

  // ── 5. partb_giveback from pm_plan_benefits (brain's source-of-truth
  //       benefits table; brain reads coverage_amount → copay → 0). ───
  const benefitRows = await paginate<{ contract_id: string; plan_id: string; segment_id: string | null; benefit_category: string; coverage_amount: number | null; copay: number | null; max_coverage: number | null }>(
    (from, to) =>
      sb
        .from('pm_plan_benefits')
        .select('contract_id, plan_id, segment_id, benefit_category, coverage_amount, copay, max_coverage')
        .in('contract_id', contractIds)
        .in('plan_id', planIds)
        .eq('benefit_category', 'partb_giveback')
        .range(from, to),
  );
  const givebackByPlan = new Map<string, number>();
  for (const r of benefitRows) {
    const k = `${r.contract_id}-${r.plan_id}-${r.segment_id ?? '0'}`;
    const monthly = r.coverage_amount ?? r.copay ?? r.max_coverage ?? 0;
    givebackByPlan.set(k, monthly);
  }

  // ── 6. Score every eligible plan ─────────────────────────────────────
  interface Scored {
    plan: PlanRow;
    triple: string;
    provStatus: 'in' | 'out' | 'absent';
    metformin: FormHit | undefined;
    lisinopril: FormHit | undefined;
    coveredCount: number;
    annualDrugCost: number;
    annualPremium: number;
    annualGiveback: number;
    totalAnnualCost: number;
    gate1Pass: boolean;
    gate2Pass: boolean;
  }
  const poolHasAnyFormulary = formByPlan.size > 0;

  const scored: Scored[] = eligible.map((plan) => {
    const ckey = `${plan.contract_id}-${plan.plan_id}`;
    const triple = `${plan.contract_id}-${plan.plan_id}-${plan.segment_id ?? '0'}`;

    const provRaw = provByContractPlan.get(ckey);
    const provStatus: 'in' | 'out' | 'absent' =
      provRaw === true ? 'in' : provRaw === false ? 'out' : 'absent';

    const fmap = formByPlan.get(ckey);
    const metformin = fmap?.get(RXCUI_METFORMIN);
    const lisinopril = fmap?.get(RXCUI_LISINOPRIL);
    const coveredCount = (metformin ? 1 : 0) + (lisinopril ? 1 : 0);

    const drugCostFor = (h: FormHit | undefined): number => {
      if (!h) return 0;
      return (h.copay ?? 0) * 12;
    };
    const annualDrugCost = drugCostFor(metformin) + drugCostFor(lisinopril);
    const annualPremium = (plan.monthly_premium ?? 0) * 12;
    const annualGiveback = (givebackByPlan.get(triple) ?? 0) * 12;
    const totalAnnualCost = annualPremium + annualDrugCost - annualGiveback;

    // Gate 1: drop if provider definitively OON. absent passes.
    const gate1Pass = provStatus !== 'out';
    // Gate 2: drop if any user med uncovered, unless pool has zero formulary rows.
    const gate2Pass = !poolHasAnyFormulary || coveredCount === USER_RXCUIS.length;

    return {
      plan, triple, provStatus, metformin, lisinopril, coveredCount,
      annualDrugCost, annualPremium, annualGiveback, totalAnnualCost,
      gate1Pass, gate2Pass,
    };
  });

  // ── 7. Funnel counts ────────────────────────────────────────────────
  const g1 = scored.filter((s) => s.gate1Pass);
  const g2 = g1.filter((s) => s.gate2Pass);
  const sorted = [...g2].sort((a, b) => a.totalAnnualCost - b.totalAnnualCost);
  const top4 = sorted.slice(0, 4);

  console.log(`Pool has any formulary rows? ${poolHasAnyFormulary} (gate 2 ${poolHasAnyFormulary ? 'enforced' : 'RELAXED — data-gap carve-out'})\n`);
  console.log(`Gate counts: eligible=${scored.length} → gate1=${g1.length} → gate2=${g2.length} → top4=${top4.length}`);
  console.log(`Provider status across pool: in=${scored.filter((s) => s.provStatus === 'in').length}, out=${scored.filter((s) => s.provStatus === 'out').length}, absent=${scored.filter((s) => s.provStatus === 'absent').length}\n`);

  // ── 8. Top 4 detail ─────────────────────────────────────────────────
  console.log('═══ TOP 4 ═══');
  for (let i = 0; i < top4.length; i++) {
    const s = top4[i];
    const tierStr = (h: FormHit | undefined) =>
      h ? `tier ${h.tier} / $${h.copay ?? 0} copay${h.coinsurance ? ` (${h.coinsurance}% coins)` : ''}` : 'NOT ON FORMULARY';
    console.log(`\n${i + 1}. ${s.plan.carrier} — ${s.plan.plan_name}`);
    console.log(`   ID: ${s.triple}   type: ${s.plan.plan_type ?? '?'}`);
    console.log(`   Provider cache (Klein NPI ${NPI_KLEIN}): ${s.provStatus.toUpperCase()}${s.provStatus === 'absent' ? ' (no row → pass-through, flag as Unverified)' : ''}`);
    console.log(`   Gate 1: ${s.gate1Pass ? 'PASS' : 'FAIL'} — ${s.provStatus === 'in' ? 'in-network' : s.provStatus === 'out' ? 'definitively OON, eliminated' : 'unverified, allowed through'}`);
    console.log(`   Drugs: Metformin ${tierStr(s.metformin)}  |  Lisinopril ${tierStr(s.lisinopril)}  (covered ${s.coveredCount}/2)`);
    console.log(`   Cost: premium $${s.annualPremium}/yr + drugs $${s.annualDrugCost}/yr − giveback $${s.annualGiveback}/yr = $${s.totalAnnualCost}/yr`);
  }

  // ── 9. In-network plans that lost — show top 4 of those for comparison
  const inNetSurvivors = sorted.filter((s) => s.provStatus === 'in').slice(0, 4);
  if (inNetSurvivors.length > 0) {
    console.log('\n═══ TOP 4 IN-NETWORK SURVIVORS (for comparison) ═══');
    for (let i = 0; i < inNetSurvivors.length; i++) {
      const s = inNetSurvivors[i];
      const rank = sorted.findIndex((x) => x.triple === s.triple) + 1;
      console.log(`\n  #${rank}: ${s.plan.carrier} — ${s.plan.plan_name} (${s.triple})`);
      console.log(`     cost $${s.totalAnnualCost}/yr  |  Metformin ${s.metformin ? `T${s.metformin.tier}/$${s.metformin.copay}` : 'MISS'}  |  Lisinopril ${s.lisinopril ? `T${s.lisinopril.tier}/$${s.lisinopril.copay}` : 'MISS'}`);
    }
  }

  // ── 10. Summary of who beat in-network plans ────────────────────────
  const cheapestInNet = inNetSurvivors[0];
  const oonAboveCheapestInNet = top4.filter((s) => s.provStatus !== 'in' && (!cheapestInNet || s.totalAnnualCost <= cheapestInNet.totalAnnualCost));
  if (cheapestInNet && oonAboveCheapestInNet.length > 0) {
    console.log(`\n⚠️  ${oonAboveCheapestInNet.length} non-in-network plan(s) in the Top 4 are ranked at or above the cheapest IN-NETWORK survivor ($${cheapestInNet.totalAnnualCost}/yr — ${cheapestInNet.plan.carrier} ${cheapestInNet.plan.plan_name}).`);
    console.log(`   Cause: Gate 1 treats cache-absent as pass-through, so unscraped carriers compete on raw cost only.`);
  }

  // ── 11. The 9 OON-eliminated plans — what would they have ranked? ───
  const oonEliminated = scored
    .filter((s) => s.provStatus === 'out' && s.gate2Pass)
    .sort((a, b) => a.totalAnnualCost - b.totalAnnualCost);
  console.log(`\n═══ OON-ELIMINATED PLANS (failed Gate 1, would have passed Gate 2) — ${oonEliminated.length} ═══`);
  for (const s of oonEliminated) {
    const wouldRank = [...sorted, s].sort((a, b) => a.totalAnnualCost - b.totalAnnualCost).findIndex((x) => x.triple === s.triple) + 1;
    console.log(`  $${String(s.totalAnnualCost).padStart(6)}/yr  hypothetical rank #${wouldRank}  ${s.plan.carrier} — ${s.plan.plan_name} (${s.triple})`);
  }

  // ── 12. The 3 absent plans — currently passing through with "Confirm" ─
  const absentPlans = scored
    .filter((s) => s.provStatus === 'absent' && s.gate2Pass)
    .sort((a, b) => a.totalAnnualCost - b.totalAnnualCost);
  console.log(`\n═══ ABSENT-CACHE PLANS (Gate 1 pass-through, flagged Unverified) — ${absentPlans.length} ═══`);
  for (const s of absentPlans) {
    const rank = sorted.findIndex((x) => x.triple === s.triple) + 1;
    console.log(`  rank #${rank}  $${s.totalAnnualCost}/yr  ${s.plan.carrier} — ${s.plan.plan_name} (${s.triple})`);
  }

  // ── 13. No-gate cost ranking — would any OON plan be in the Top 4
  //       if Gate 1 didn't exist? ──────────────────────────────────────
  const noGate = scored
    .filter((s) => s.gate2Pass)
    .sort((a, b) => a.totalAnnualCost - b.totalAnnualCost)
    .slice(0, 6);
  console.log('\n═══ TOP 6 IF GATE 1 WERE DISABLED ═══');
  for (let i = 0; i < noGate.length; i++) {
    const s = noGate[i];
    console.log(`  ${i + 1}. $${String(s.totalAnnualCost).padStart(6)}/yr  [${s.provStatus}]  ${s.plan.carrier} — ${s.plan.plan_name} (${s.triple})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
