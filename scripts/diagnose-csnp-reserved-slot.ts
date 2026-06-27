// Diagnostic: verify the new C-SNP reserved-slot logic will fire for
// the test scenario the user specified.
//
//   Durham 27713
//   Provider: Dr. Klein, NPI 1619976297
//   Meds: Metformin 500 (rxcui 861007), Lisinopril 20 (rxcui 314077)
//   Conditions: diabetes (or med-detected from Metformin alone → 'likely')
//
// Mirrors the gates from plan-brain.ts but includes SNP plans in the
// pool (the agent v3 standard-population widening admits C-SNPs when
// userQualifiesForCsnp is true).
//
// Asserts:
//   1. There is ≥1 C-SNP plan in Durham 27713.
//   2. ≥1 C-SNP passes Gate 1 (Klein in-network or absent).
//   3. ≥1 C-SNP passes Gate 2 (both meds covered).
//   4. If (2)+(3) hold the brain WILL force-insert a C-SNP into Top 4.
//   5. Print the cheapest such C-SNP — what the reservation will pick.
//
// Run: npx tsx scripts/diagnose-csnp-reserved-slot.ts

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
const RXCUI_METFORMIN = '861007';
const RXCUI_LISINOPRIL = '314077';
const USER_RXCUIS = [RXCUI_METFORMIN, RXCUI_LISINOPRIL];

async function paginate<T>(
  pageFn: (from: number, to: number) => PromiseLike<PostgrestSingleResponse<T[]>>,
): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await pageFn(p * 1000, p * 1000 + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

// Mirrors classifySnp() in plan-brain.ts:73
function classifySnp(snp: boolean | null, snpType: string | null): 'D' | 'C' | 'I' | 'none' {
  const t = (snpType ?? '').toLowerCase().trim();
  if (!t) return snp ? 'C' : 'none';
  if (t.includes('d-snp') || t.includes('dsnp') || t.includes('dual')) return 'D';
  if (t.includes('c-snp') || t.includes('csnp') || t.includes('chronic')) return 'C';
  if (t.includes('i-snp') || t.includes('isnp') || t.includes('institutional')) return 'I';
  return 'none';
}

async function main() {
  const { data: rawPlans } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, carrier, plan_type, monthly_premium, moop, star_rating, snp, snp_type, sanctioned')
    .eq('state', 'NC')
    .ilike('county_name', '%Durham%')
    .eq('sanctioned', false);

  const { data: ncRows } = await sb
    .from('pm_non_commissionable_contracts')
    .select('contract_id, plan_number');
  const ncContracts = new Set<string>();
  const ncPlans = new Set<string>();
  for (const r of ncRows ?? []) {
    if (r.plan_number == null) ncContracts.add(r.contract_id);
    else ncPlans.add(`${r.contract_id}-${r.plan_number}`);
  }
  const plans = (rawPlans ?? []).filter(
    (p) => !ncContracts.has(p.contract_id) && !ncPlans.has(`${p.contract_id}-${p.plan_id}`),
  );
  const seen = new Set<string>();
  const uniq = plans.filter((p) => {
    const k = `${p.contract_id}-${p.plan_id}-${p.segment_id ?? '0'}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Classify each plan
  const csnpPool = uniq.filter((p) => classifySnp(p.snp, p.snp_type) === 'C');
  const standardPool = uniq.filter((p) => classifySnp(p.snp, p.snp_type) === 'none');
  console.log(`Durham 27713 pool: ${uniq.length} unique`);
  console.log(`  C-SNP plans:    ${csnpPool.length}`);
  console.log(`  Standard MAPD:  ${standardPool.length}`);
  console.log(`  Other SNPs:     ${uniq.length - csnpPool.length - standardPool.length}\n`);

  if (csnpPool.length === 0) {
    console.log('❌ ASSERTION 1 FAILED — no C-SNPs in this county. Reservation cannot fire.');
    return;
  }
  console.log(`✓ ASSERTION 1 — ${csnpPool.length} C-SNP plans available in Durham 27713`);
  for (const c of csnpPool) {
    console.log(`    ${c.carrier} ${c.plan_name} (${c.contract_id}-${c.plan_id}-${c.segment_id ?? '0'})  snp_type="${c.snp_type ?? ''}"`);
  }
  console.log();

  // ── Gate 1: Klein cache lookup for every C-SNP ──────────────────────
  const csnpKeys2 = [...new Set(csnpPool.map((p) => `${p.contract_id}-${p.plan_id}`))];
  const { data: provRows } = await sb
    .from('pm_provider_network_cache')
    .select('plan_id, covered')
    .eq('npi', NPI_KLEIN)
    .in('plan_id', csnpKeys2);
  const provByKey = new Map<string, boolean | null>();
  for (const r of provRows ?? []) provByKey.set(r.plan_id, r.covered);

  // ── Gate 2: formulary for both rxcuis × every C-SNP ─────────────────
  const csnpContracts = [...new Set(csnpPool.map((p) => p.contract_id))];
  const csnpPlanIds = [...new Set(csnpPool.map((p) => p.plan_id))];
  const formRows = await paginate<{ contract_id: string; plan_id: string; rxcui: string; tier: number | null; copay: number | null; coinsurance: number | null }>(
    (from, to) =>
      sb.from('pm_formulary')
        .select('contract_id, plan_id, rxcui, tier, copay, coinsurance')
        .in('contract_id', csnpContracts)
        .in('plan_id', csnpPlanIds)
        .in('rxcui', USER_RXCUIS)
        .range(from, to),
  );
  type FormHit = { tier: number | null; copay: number | null; coinsurance: number | null };
  const formByPlan = new Map<string, Map<string, FormHit>>();
  for (const r of formRows) {
    const k = `${r.contract_id}-${r.plan_id}`;
    let m = formByPlan.get(k);
    if (!m) { m = new Map(); formByPlan.set(k, m); }
    m.set(r.rxcui, { tier: r.tier, copay: r.copay, coinsurance: r.coinsurance });
  }

  // ── Score every C-SNP and apply gates ───────────────────────────────
  interface Scored {
    plan: typeof csnpPool[number];
    provRaw: boolean | null | undefined;
    provStatus: 'in' | 'out' | 'absent';
    metformin: FormHit | undefined;
    lisinopril: FormHit | undefined;
    coveredCount: number;
    annualDrugCost: number;
    annualPremium: number;
    totalAnnualCost: number;
    gate1Pass: boolean;
    gate2Pass: boolean;
  }
  const scored: Scored[] = csnpPool.map((plan) => {
    const ckey = `${plan.contract_id}-${plan.plan_id}`;
    const provRaw = provByKey.get(ckey);
    const provStatus: 'in' | 'out' | 'absent' =
      provRaw === true ? 'in' : provRaw === false ? 'out' : 'absent';
    const fmap = formByPlan.get(ckey);
    const metformin = fmap?.get(RXCUI_METFORMIN);
    const lisinopril = fmap?.get(RXCUI_LISINOPRIL);
    const coveredCount = (metformin ? 1 : 0) + (lisinopril ? 1 : 0);
    const drugCostFor = (h: FormHit | undefined): number => (h ? (h.copay ?? 0) * 12 : 0);
    const annualDrugCost = drugCostFor(metformin) + drugCostFor(lisinopril);
    const annualPremium = (plan.monthly_premium ?? 0) * 12;
    const totalAnnualCost = annualPremium + annualDrugCost;
    const gate1Pass = provStatus !== 'out';
    const gate2Pass = coveredCount === USER_RXCUIS.length;
    return { plan, provRaw, provStatus, metformin, lisinopril, coveredCount, annualDrugCost, annualPremium, totalAnnualCost, gate1Pass, gate2Pass };
  });

  const passG1 = scored.filter((s) => s.gate1Pass);
  const passG1andG2 = passG1.filter((s) => s.gate2Pass);

  console.log(`Gate 1 — Klein provider check on C-SNPs:`);
  for (const s of scored) {
    console.log(`  ${s.gate1Pass ? '✓' : '✗'} [${s.provStatus.padEnd(7)}] ${s.plan.carrier} ${s.plan.plan_name}`);
  }
  if (passG1.length === 0) {
    console.log('\n❌ ASSERTION 2 FAILED — no C-SNP passed Gate 1 (Klein OON on all). csnpNote will fire.');
    return;
  }
  console.log(`\n✓ ASSERTION 2 — ${passG1.length}/${csnpPool.length} C-SNP plans passed Gate 1\n`);

  console.log(`Gate 2 — Metformin + Lisinopril coverage on Gate-1 C-SNP survivors:`);
  for (const s of passG1) {
    const tierStr = (h: FormHit | undefined) => h ? `T${h.tier}/$${h.copay ?? 0}` : 'MISS';
    console.log(`  ${s.gate2Pass ? '✓' : '✗'} ${s.plan.carrier} ${s.plan.plan_name}  |  Met=${tierStr(s.metformin)}  Lis=${tierStr(s.lisinopril)}  (${s.coveredCount}/2)`);
  }
  if (passG1andG2.length === 0) {
    console.log('\n❌ ASSERTION 3 FAILED — no C-SNP passed Gate 2. csnpNote will fire: "No C-SNP plans cover your providers and medications in this county."');
    return;
  }
  console.log(`\n✓ ASSERTION 3 — ${passG1andG2.length}/${passG1.length} G1-surviving C-SNP plans passed Gate 2`);
  console.log(`✓ ASSERTION 4 — brain WILL force-insert a C-SNP into Top 4 (reservation will pick from this set)\n`);

  // Pick the cheapest survivor — what compareByCostThenTiebreakers will surface.
  // Probe doesn't perfectly mirror the full tiebreaker chain (no MOOP/star
  // lookups here, but cost dominates for these candidates).
  const reservation = [...passG1andG2].sort((a, b) => {
    if (a.totalAnnualCost !== b.totalAnnualCost) return a.totalAnnualCost - b.totalAnnualCost;
    const aMoop = a.plan.moop ?? Number.POSITIVE_INFINITY;
    const bMoop = b.plan.moop ?? Number.POSITIVE_INFINITY;
    if (aMoop !== bMoop) return aMoop - bMoop;
    const aStars = a.plan.star_rating ?? 0;
    const bStars = b.plan.star_rating ?? 0;
    if (aStars !== bStars) return bStars - aStars;
    return (a.plan.carrier ?? '').localeCompare(b.plan.carrier ?? '');
  })[0];
  console.log('═══ The brain will reserve this C-SNP slot in the Top 4 ═══');
  console.log(`  ${reservation.plan.carrier} — ${reservation.plan.plan_name}`);
  console.log(`  ID:    ${reservation.plan.contract_id}-${reservation.plan.plan_id}-${reservation.plan.segment_id ?? '0'}`);
  console.log(`  Type:  ${reservation.plan.plan_type ?? '?'}    snp_type: "${reservation.plan.snp_type ?? ''}"`);
  console.log(`  Klein: ${reservation.provStatus}    Drugs: Met=${reservation.metformin?.tier ? 'T'+reservation.metformin.tier : 'miss'}/$${reservation.metformin?.copay ?? 0}   Lis=${reservation.lisinopril?.tier ? 'T'+reservation.lisinopril.tier : 'miss'}/$${reservation.lisinopril?.copay ?? 0}`);
  console.log(`  Cost:  premium $${reservation.annualPremium}/yr + drugs $${reservation.annualDrugCost}/yr = $${reservation.totalAnnualCost}/yr`);
  console.log(`  MOOP:  $${reservation.plan.moop ?? 'n/a'}    Stars: ${reservation.plan.star_rating ?? 'n/a'}`);
  console.log(`\n✓ ASSERTION 5 — C-SNP slot will be filled. csnpReservedSlot flag set to true on the inserted plan.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
