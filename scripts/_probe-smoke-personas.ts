// scripts/_probe-smoke-personas.ts — Phase 1 smoke test of 5 personas.
// Read-only. Query plan-match-prod. Report data completeness per persona.
import { createClient, type PostgrestSingleResponse } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const url = process.env.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
if (!url || !key) { console.error('Missing env'); process.exit(1); }
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function paginate<T>(fn: (from: number, to: number) => PromiseLike<PostgrestSingleResponse<T[]>>): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let p = 0; p < 30; p++) {
    const { data, error } = await fn(p * PAGE, p * PAGE + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

type Persona = {
  name: string;
  county: string;
  state: string;
  fips: string;
  dual: boolean;
  meds: string[];
  providers: string[];
};

const PERSONAS: Persona[] = [
  { name: 'Margaret Chen',    county: 'Durham',    state: 'NC', fips: '37063', dual: false, meds: ['Eliquis', 'Atorvastatin', 'Lisinopril'], providers: ['Sarah Kim'] },
  { name: 'James Morton',     county: 'Harris',    state: 'TX', fips: '48201', dual: false, meds: ['Jardiance', 'Metformin', 'Ozempic'], providers: ['Michael Rivera'] },
  { name: 'Rosa Gutierrez',   county: 'Bexar',     state: 'TX', fips: '48029', dual: true,  meds: ['Amlodipine'], providers: [] },
  { name: 'William Davis',    county: 'Fulton',    state: 'GA', fips: '13121', dual: false, meds: [], providers: [] },
  { name: 'Linda Patterson',  county: 'Alleghany', state: 'NC', fips: '37005', dual: false, meds: ['Eliquis', 'Metoprolol', 'Omeprazole', 'Levothyroxine', 'Vitamin D3'], providers: ['James Wright'] },
];

async function auditPersona(p: Persona) {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`PERSONA: ${p.name}  (${p.county} County, ${p.state}  FIPS ${p.fips})`);
  console.log(`  dual=${p.dual}  meds=${p.meds.length}  providers=${p.providers.length}`);
  console.log('═'.repeat(72));

  // ── Plan pool ─────────────────────────────────────────────────
  const plans = await paginate<any>((from, to) =>
    sb.from('pm_plans')
      .select('contract_id, plan_id, plan_name, carrier, plan_type, snp_type, snp, monthly_premium, moop, moop_combined, annual_deductible, drug_deductible, star_rating, sanctioned, county_name, state, county_fips, dsnp_eligible_tiers, dsnp_accepted_populations, zero_cost_sharing')
      .eq('state', p.state)
      .ilike('county_name', `%${p.county}%`)
      .range(from, to)
  );

  const anyPlanTypes = new Set(plans.map(pl => pl.plan_type));
  const snpTypes = new Set(plans.map(pl => pl.snp_type).filter(Boolean));
  console.log(`\n[POOL] total rows returned: ${plans.length}`);
  console.log(`       plan_type values: ${[...anyPlanTypes].join(', ')}`);
  console.log(`       snp_type values : ${[...snpTypes].join(', ') || '(none)'}`);
  console.log(`       sanctioned=true count: ${plans.filter(pl => pl.sanctioned).length} (should be 0 after filter)`);

  // MA (exclude PDP)
  const maPlans = plans.filter(pl => pl.plan_type !== 'PDP');
  console.log(`       MA-only (non-PDP) plans: ${maPlans.length}`);
  const distinctCarriers = new Set(maPlans.map(pl => pl.carrier));
  console.log(`       distinct carriers: ${distinctCarriers.size}  → ${[...distinctCarriers].sort().join(', ')}`);

  // ── Sanctioned check ──────────────────────────────────────────
  const sanctioned = plans.filter(pl => pl.sanctioned === true);
  if (sanctioned.length > 0) {
    console.log(`\n[SANCTIONED PRESENT] ${sanctioned.length}:`);
    sanctioned.slice(0, 5).forEach(s => console.log(`   - ${s.contract_id}-${s.plan_id} ${s.carrier} ${s.plan_name}`));
  } else {
    console.log(`\n[SANCTIONED] none present in raw pool (good, or nothing marked)`);
  }
  const clearSpringSusp = plans.filter(pl =>
    (pl.contract_id === 'H6672' && pl.plan_id === '005') ||
    (pl.contract_id === 'H9589' && pl.plan_id === '003')
  );
  if (clearSpringSusp.length > 0) {
    console.log(`[CLEAR SPRING] present in pool:`);
    clearSpringSusp.forEach(s => console.log(`   ${s.contract_id}-${s.plan_id} sanctioned=${s.sanctioned}`));
  }

  // ── Non-commissionable filter ─────────────────────────────────
  const { data: ncRows } = await sb.from('pm_non_commissionable_contracts').select('contract_id, plan_number');
  const ncContract = new Set((ncRows ?? []).filter((r: any) => !r.plan_number).map((r: any) => r.contract_id));
  const ncPlan = new Set((ncRows ?? []).filter((r: any) => r.plan_number).map((r: any) => `${r.contract_id}-${r.plan_number}`));
  const inPoolNC = plans.filter(pl => ncContract.has(pl.contract_id) || ncPlan.has(`${pl.contract_id}-${pl.plan_id}`));
  console.log(`\n[NON-COMM TABLE] contract-level entries: ${ncContract.size}   plan-level entries: ${ncPlan.size}`);
  console.log(`                 in current pool (would be filtered by API): ${inPoolNC.length}`);
  if (inPoolNC.length > 0 && inPoolNC.length < 20) {
    inPoolNC.forEach(n => console.log(`   - ${n.contract_id}-${n.plan_id} ${n.carrier}`));
  }
  const commPool = plans.filter(pl => !ncContract.has(pl.contract_id) && !ncPlan.has(`${pl.contract_id}-${pl.plan_id}`) && !pl.sanctioned);
  const commMaPool = commPool.filter(pl => pl.plan_type !== 'PDP');
  console.log(`                 after sanction+non-comm filter (ALL): ${commPool.length}`);
  console.log(`                 after sanction+non-comm filter (MA only): ${commMaPool.length}`);

  // ── Null-field audit on MA commissionable pool ────────────────
  const nullPremium = commMaPool.filter(pl => pl.monthly_premium === null);
  const nullMoop    = commMaPool.filter(pl => pl.moop === null && pl.moop_combined === null);
  const nullDed     = commMaPool.filter(pl => pl.annual_deductible === null);
  const nullStar    = commMaPool.filter(pl => pl.star_rating === null);
  const nullFips    = commMaPool.filter(pl => !pl.county_fips);
  console.log(`\n[NULL FIELDS on commissionable MA pool of ${commMaPool.length}]`);
  console.log(`   null monthly_premium  : ${nullPremium.length}`);
  console.log(`   null moop AND combined: ${nullMoop.length}`);
  console.log(`   null annual_deductible: ${nullDed.length}`);
  console.log(`   null star_rating      : ${nullStar.length}  (OK if 'Too new to rate')`);
  console.log(`   null county_fips      : ${nullFips.length}  (memory: county_fips wiped)`);
  if (nullPremium.length > 0) nullPremium.slice(0,3).forEach(x => console.log(`      • ${x.contract_id}-${x.plan_id} ${x.carrier}`));
  if (nullMoop.length > 0) nullMoop.slice(0,3).forEach(x => console.log(`      • MOOP null: ${x.contract_id}-${x.plan_id} ${x.carrier} moop=${x.moop} combined=${x.moop_combined}`));

  // ── pm_plan_benefits coverage ────────────────────────────────
  const contractIds = [...new Set(commMaPool.map(pl => pl.contract_id))];
  const planIds     = [...new Set(commMaPool.map(pl => pl.plan_id))];
  const pbRows = await paginate<any>((from, to) =>
    sb.from('pm_plan_benefits')
      .select('contract_id, plan_id, benefit_category, copay, coinsurance, coverage_amount')
      .in('contract_id', contractIds)
      .in('plan_id', planIds)
      .range(from, to)
  );
  const bySet = new Map<string, Set<string>>();
  for (const r of pbRows) {
    const k = `${r.contract_id}-${r.plan_id}`;
    if (!bySet.has(k)) bySet.set(k, new Set());
    bySet.get(k)!.add(r.benefit_category);
  }
  const cats = [...new Set(pbRows.map(r => r.benefit_category))].sort();
  console.log(`\n[pm_plan_benefits] rows=${pbRows.length}  distinct categories=${cats.length}`);
  const missingBenefits = commMaPool.filter(pl => !bySet.has(`${pl.contract_id}-${pl.plan_id}`));
  console.log(`   plans with ZERO benefit rows: ${missingBenefits.length}`);
  const wantCats = ['dental_comprehensive', 'dental_preventive', 'vision', 'hearing', 'specialist', 'primary_care', 'otc', 'food_card', 'transportation', 'fitness'];
  for (const cat of wantCats) {
    const withCat = commMaPool.filter(pl => bySet.get(`${pl.contract_id}-${pl.plan_id}`)?.has(cat));
    const marker = withCat.length === 0 ? ' ← ABSENT' : (withCat.length === commMaPool.length ? '' : '');
    console.log(`   plans with '${cat}': ${withCat.length} / ${commMaPool.length}${marker}`);
  }
  console.log(`   sample categories in pool: ${cats.slice(0, 25).join(', ')}${cats.length > 25 ? '…' : ''}`);

  // ── D-SNP audit for dual persona ─────────────────────────────
  if (p.dual) {
    const dsnps = commMaPool.filter(pl => pl.snp_type === 'D-SNP');
    console.log(`\n[D-SNP] D-SNP count in commissionable pool: ${dsnps.length}`);
    if (dsnps.length === 0) {
      console.log(`   *** NO D-SNP PLANS for dual-eligible persona — routing broken ***`);
    } else {
      const withTiers = dsnps.filter((r: any) => r.dsnp_eligible_tiers && (Array.isArray(r.dsnp_eligible_tiers) ? r.dsnp_eligible_tiers.length > 0 : true));
      const withPop   = dsnps.filter((r: any) => r.dsnp_accepted_populations && (Array.isArray(r.dsnp_accepted_populations) ? r.dsnp_accepted_populations.length > 0 : true));
      const zeroCS    = dsnps.filter((r: any) => r.zero_cost_sharing === true);
      console.log(`   dsnp_eligible_tiers populated       : ${withTiers.length} / ${dsnps.length}`);
      console.log(`   dsnp_accepted_populations populated : ${withPop.length} / ${dsnps.length}`);
      console.log(`   zero_cost_sharing=true              : ${zeroCS.length} / ${dsnps.length}`);
      dsnps.slice(0,3).forEach(d => console.log(`      • ${d.contract_id}-${d.plan_id} ${d.carrier} tiers=${JSON.stringify(d.dsnp_eligible_tiers)} pop=${JSON.stringify(d.dsnp_accepted_populations)}`));
    }
  }

  // ── Medication formulary + drug cost cache ───────────────────
  if (p.meds.length > 0) {
    console.log(`\n[FORMULARY audit]`);
    for (const med of p.meds) {
      const fRows = await paginate<any>((from, to) =>
        sb.from('pm_formulary')
          .select('contract_id, plan_id, drug_name, tier, copay, coinsurance')
          .in('contract_id', contractIds)
          .in('plan_id', planIds)
          .ilike('drug_name', `%${med}%`)
          .range(from, to)
      );
      const withPrice = fRows.filter((r: any) => r.copay !== null || r.coinsurance !== null);
      const distinctPlans = new Set(fRows.map((r: any) => `${r.contract_id}-${r.plan_id}`));
      const gap = commMaPool.length - distinctPlans.size;
      const gapMark = gap > 0 ? ` ← ${gap} plans MISSING formulary row` : '';
      console.log(`   ${med.padEnd(15)} matches=${fRows.length.toString().padStart(5)} distinctPlans=${distinctPlans.size.toString().padStart(3)}/${commMaPool.length}${gapMark}  withPrice=${withPrice.length}`);
      if (fRows.length > 0) {
        const tierHist: Record<string, number> = {};
        for (const r of fRows) tierHist[String(r.tier ?? '?')] = (tierHist[String(r.tier ?? '?')] ?? 0) + 1;
        console.log(`     tier histogram: ${JSON.stringify(tierHist)}`);
      }
      const { data: dccRows } = await sb.from('pm_drug_cost_cache')
        .select('plan_id, estimated_yearly_total, covered, tier')
        .in('plan_id', planIds)
        .limit(2000);
      // no drug filter possible without NDC; just report presence
      const nCovered = (dccRows ?? []).filter((r: any) => r.covered === true).length;
      const withCost = (dccRows ?? []).filter((r: any) => r.estimated_yearly_total !== null).length;
      // NOTE: this is a coarse check — the cache is keyed by NDC, not drug name.
      // A proper med-specific check needs the drug's NDC list from an NDC dictionary.
      // Reporting overall cache presence:
      if (med === p.meds[0]) {
        console.log(`   (drug_cost_cache overall: ${(dccRows ?? []).length} rows for pool, covered=${nCovered}, withYearlyTotal=${withCost})`);
      }
    }
  }

  // ── Provider network cache ───────────────────────────────────
  if (p.providers.length > 0) {
    console.log(`\n[PROVIDER NETWORK]`);
    for (const prov of p.providers) {
      const { data: dirRows } = await sb.from('pm_provider_directory')
        .select('npi, display_name, specialties, primary_state, primary_city, primary_zip')
        .ilike('display_name', `%${prov}%`)
        .limit(20);
      console.log(`   "${prov}": directory matches = ${(dirRows ?? []).length}`);
      if (!dirRows || dirRows.length === 0) {
        console.log(`     *** NO DIRECTORY MATCH — network status cannot be determined ***`);
        continue;
      }
      // narrow by state
      const inState = dirRows.filter((d: any) => d.primary_state === p.state);
      const focus = inState.length > 0 ? inState : dirRows;
      for (const d of focus.slice(0, 3)) {
        const { data: cache } = await sb.from('pm_provider_network_cache')
          .select('plan_id, covered, data_unavailable, source, county_fips')
          .eq('npi', d.npi)
          .in('plan_id', planIds)
          .limit(500);
        const nCovYes = (cache ?? []).filter((c: any) => c.covered === true).length;
        const nCovNo  = (cache ?? []).filter((c: any) => c.covered === false).length;
        const nUnav   = (cache ?? []).filter((c: any) => c.data_unavailable === true).length;
        console.log(`     NPI ${d.npi}  ${d.display_name}  ${d.primary_city}, ${d.primary_state}  cache=${(cache ?? []).length}  covered=${nCovYes}  not-covered=${nCovNo}  unavailable=${nUnav}`);
      }
    }
  }
}

async function main() {
  console.log(`Probe start ${new Date().toISOString()}  DB=${url.replace(/https:\/\//, '').split('.')[0]}`);
  for (const p of PERSONAS) {
    try { await auditPersona(p); }
    catch (e: any) { console.error(`FAIL ${p.name}: ${e.message}`); }
  }
  console.log(`\nProbe done ${new Date().toISOString()}`);
}
main().catch(e => { console.error(e); process.exit(1); });
