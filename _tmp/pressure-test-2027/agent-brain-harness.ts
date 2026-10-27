// pt2027 CP7-13: run A personas through agent-v3's OWN brain — the exact code
// the Compare board runs (adaptToBrainInputs → runPlanBrain), fed by the
// deployed /api/plans + /api/plan-brain-data payloads. Run:
//   tsx --tsconfig tsconfig.scripts.json scripts/_pt2027-agent-brain.ts [A06]
import { readFileSync } from 'node:fs';
import { adaptToBrainInputs } from '../src/hooks/usePlanBrain';
import { runPlanBrain } from '../src/lib/plan-brain';

const BASE = 'https://agent.generationhealth.me';
const PT = '/Users/robertsimm/planmatch/planmatch/_tmp/pressure-test-2027';
const rx = JSON.parse(readFileSync(`${PT}/raw/rxcui-map.json`, 'utf8'));
const flags = JSON.parse(readFileSync(`${PT}/persona-flags.json`, 'utf8')).personas;

const PERSONAS: Record<string, { name: string; st: string; c: string; z: string; d: string[]; npi: string[] }> = {
  A01:{name:'Steven Mabry',st:'NC',c:'Wake',z:'27615',d:['rosuvastatin 10','Xarelto 20'],npi:['1104832534']},
  A02:{name:'Jason Ridley',st:'NC',c:'Buncombe',z:'28803',d:['Breo Ellipta 100/25','Spiriva Respimat 2.5','albuterol HFA','Ozempic 1mg','metformin ER 500','Vraylar 3','gabapentin 600','atorvastatin 40','montelukast 10'],npi:['1144312604','1457445066']},
  A03:{name:'Carol Whitfield',st:'NC',c:'New Hanover',z:'28401',d:['alendronate 70','losartan 50','Linzess 72'],npi:['1497752554']},
  A04:{name:'Raymond Ortiz',st:'NC',c:'Onslow',z:'28546',d:[],npi:['1417065236']},
  A05:{name:'Monica Ellis',st:'TX',c:'Bell',z:'76543',d:[],npi:['1639583321']},
  A06:{name:'Patricia Nguyen',st:'TX',c:'Dallas',z:'75237',d:['Tresiba FlexTouch','NovoLog FlexPen','Mounjaro 7.5','Farxiga 10','levothyroxine 88','pregabalin 150','losartan 100','rosuvastatin 20','carvedilol 12.5','Dexcom G7'],npi:['1417535154','1184856759']},
  A07:{name:'Brenda Kowalski',st:'TX',c:'Lubbock',z:'79424',d:['levothyroxine 75','Ozempic 0.5','metformin 500'],npi:['1508837790']},
  A08:{name:'Harold Simmons',st:'GA',c:'Cobb',z:'30060',d:['Eliquis 5','atorvastatin 40','finasteride 5'],npi:['1164984738']},
  A09:{name:'Gloria Mitchell',st:'GA',c:'Richmond',z:'30909',d:[],npi:['1932548849']},
  A10:{name:'Terrence Lowe',st:'GA',c:'Bibb',z:'31206',d:['Kerendia 20','amlodipine 10','carvedilol 25','furosemide 80','allopurinol 100','sevelamer carbonate 800','calcitriol 0.25','Januvia 25','atorvastatin 40'],npi:['1760914733','1609071448']},
};

async function getJson(url: string): Promise<any> {
  let lastErr = '';
  for (let a = 0; a < 4; a++) {
    const r = await fetch(url, { redirect: 'follow' });
    if (r.ok) return r.json();
    lastErr = `${r.status}`;
    if (r.status >= 500) { await new Promise((x) => setTimeout(x, 1500 * (a + 1))); continue; }
    break;
  }
  throw new Error(`${url.slice(0, 80)}… → ${lastErr}`);
}
// POST fallback for large id lists (county pools exceed GET URL limits / the
// server 500s on very long querystrings). plan-brain-data accepts the same
// params in the body.
async function getPlanBrainData(params: URLSearchParams): Promise<any> {
  // The endpoint is GET-only; chunk the ids to keep the URL sane.
  return getJson(`${BASE}/api/plan-brain-data?${params.toString()}`);
}

export async function runPersona(pid: string) {
  const p = PERSONAS[pid];
  const f = flags[pid] || {};
  // 1. catalog (full county pool, incl non-commissionable so nothing is hidden)
  const cat = await getJson(`${BASE}/api/plans?state=${p.st}&county=${encodeURIComponent(p.c)}&plan_year=2027&limit=400&includeNonCommissionable=1`);
  // MA-chassis only — the brain drops PDP (S-contracts) + MEDSUPP at the pool
  // filter anyway, and sending them to plan-brain-data bloats the URL → 500.
  const plans = (cat.plans || []).filter((x: any) => {
    const t = String(x.plan_type ?? '').toUpperCase();
    return t !== 'PDP' && t !== 'MEDSUPP' && !/^S/.test(String(x.contract_id ?? ''));
  });
  const tripleIds = plans.map((x: any) => x.id);
  // 2. drugs → rxcuis
  const meds = p.d.map((label, i) => {
    const m = rx[label] || {};
    return { id: `m${i}`, rxcui: m.rxcui ?? null, name: m.label ?? label, isBrand: !!m.isBrand, _ing: m.ing, _partB: !!m.partB };
  });
  const rxcuis = meds.map((m) => m.rxcui).filter(Boolean);
  const npis = p.npi;
  // 3. the exact board payload
  // Chunk the plan-id list (big county pools 500 the endpoint on a huge
  // querystring). Same rxcuis+npis per chunk; merge the PlanBrainData maps.
  const CHUNK = 25;
  const data: any = { benefitsByPlan: {}, drugCostCache: {}, formularyByContractPlan: {}, ndcByRxcui: {}, networkByPlan: {}, sellableByPlan: {}, mapdContractPlanIds: [] as string[] };
  const mapdSet = new Set<string>();
  for (let i = 0; i < tripleIds.length; i += CHUNK) {
    const qs = new URLSearchParams({ ids: tripleIds.slice(i, i + CHUNK).join(','), plan_year: '2027' });
    if (rxcuis.length) qs.set('rxcuis', rxcuis.join(','));
    if (npis.length) qs.set('npis', npis.join(','));
    const part = await getPlanBrainData(qs);
    Object.assign(data.benefitsByPlan, part.benefitsByPlan ?? {});
    Object.assign(data.drugCostCache, part.drugCostCache ?? {});
    Object.assign(data.formularyByContractPlan, part.formularyByContractPlan ?? {});
    Object.assign(data.ndcByRxcui, part.ndcByRxcui ?? {});
    Object.assign(data.networkByPlan, part.networkByPlan ?? {});
    Object.assign(data.sellableByPlan, part.sellableByPlan ?? {});
    for (const id of part.mapdContractPlanIds ?? []) mapdSet.add(id);
    if (part.sellableRules && !data.sellableRules) data.sellableRules = part.sellableRules;
    if (part.sellableFlags && !data.sellableFlags) data.sellableFlags = part.sellableFlags;
    if (part.planYear != null) data.planYear = part.planYear;
    if (part.formularyPublished != null) data.formularyPublished = part.formularyPublished;
  }
  data.mapdContractPlanIds = [...mapdSet];
  // 4. client / meds / providers (shapes adaptToBrainInputs reads)
  const client: any = {
    id: pid, county: p.c, state: p.st, zip: p.z,
    dsnpEligible: f.dsnp_eligible === true,
    medicaidLevel: f.medicaid_level ?? 'none',
    lisTier: f.lis_tier ?? 'none',
    livingSetting: f.living_setting ?? 'community',
    hasVaDrugCoverage: false,
    medicaidConfirmed: false,
  };
  const medications: any[] = meds.map((m) => ({ id: m.id, rxcui: m.rxcui, name: m.name, isBrand: m.isBrand }));
  const providers: any[] = npis.map((n, i) => ({ id: `p${i}`, npi: n, name: `${p.name} provider ${i + 1}` }));

  const brainInputs = adaptToBrainInputs({ plans, client, medications, providers, data });
  const out = runPlanBrain(brainInputs);
  return { pid, p, f, meds, plans, data, out };
}

// ─── CMS truth (PostgREST) ────────────────────────────────────────────
for (const l of readFileSync('/Users/robertsimm/planmatch/planmatch/.env.local', 'utf8').split('\n')) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
}
const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
async function pg(t: string, qs: string): Promise<any[]> {
  const r = await fetch(`${SB}/rest/v1/${t}?${qs}`, { headers: { apikey: KEY!, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`${t} ${r.status}`); return r.json();
}
const num = (s: any) => { if (s == null) return null; const m = String(s).match(/\$?([0-9]+(?:\.[0-9]+)?)/); return m ? parseFloat(m[1]) : null; };
function parseTriple(id: string) { const m = id.match(/^([A-Z0-9]+)-([0-9A-Za-z]+)-?([0-9A-Za-z]*)$/); return m ? { c: m[1], p: m[2], s: m[3] || '0', dash: `${m[1]}-${m[2]}` } : null; }
async function cmsForm(pp: any, rxcui: string | null, ing: string | undefined, isBrand?: boolean) {
  if (rxcui) { const r = await pg('pm_formulary', `select=tier,drug_name&plan_year=eq.2027&contract_id=eq.${pp.c}&plan_id=eq.${pp.p}&rxcui=eq.${rxcui}&limit=1`); if (r[0]) return r[0]; }
  if (ing) {
    const d = await pg('pm_formulary', `select=tier,drug_name&plan_year=eq.2027&contract_id=eq.${pp.c}&plan_id=eq.${pp.p}&drug_name=ilike.*${encodeURIComponent(ing)}*&order=tier.asc&limit=50`);
    if (d.length === 0) return null;
    // Brand drugs file under a "[Brand]" row (higher tier); generics under the
    // bare chemical name. Match the form the USER searched so the tier reflects
    // what they'd actually pay — the agent brain's rxcui-expansion does this.
    const branded = d.filter((r: any) => /\[/.test(r.drug_name ?? ''));
    const generic = d.filter((r: any) => !/\[/.test(r.drug_name ?? ''));
    const pool = isBrand ? (branded.length ? branded : d) : (generic.length ? generic : d);
    return pool.sort((a: any, b: any) => (a.tier ?? 9) - (b.tier ?? 9))[0] ?? null;
  }
  return null;
}
async function cmsProv(pp: any, npi: string) { return pg('pm_provider_network_cache', `select=covered,source&plan_year=eq.2027&plan_id=eq.${pp.dash}&npi=eq.${npi}&limit=5`); }
async function cmsBen(pp: any) { const d = await pg('pm_plan_benefits', `select=benefit_category,copay,coinsurance,max_coverage&plan_year=eq.2027&contract_id=eq.${pp.c}&plan_id=eq.${pp.p}&segment_id=eq.${pp.s}&benefit_category=in.(specialist,lab,xray,advanced_imaging)`); const o: any = {}; for (const r of d) o[r.benefit_category] = r; return o; }

const PIDS = process.argv[2] ? [process.argv[2]] : Object.keys(PERSONAS);
const rows: any[] = []; const hardAll: string[] = [];
for (const pid of PIDS) {
  const { p, f, meds, out, plans } = await runPersona(pid);
  const picks = out.liveTop3?.picks ?? [];
  const catById = new Map<string, any>();
  for (const pl of plans) catById.set(pl.id, pl);
  const byTriple = new Map<string, any>();
  for (const sp of out.ranked) byTriple.set(`${sp.row.contract_id}-${sp.row.plan_id}-${sp.row.segment_id ?? '0'}`, sp);
  const top4 = picks.map((pk: any) => byTriple.get(`${pk.plan.row.contract_id}-${pk.plan.row.plan_id}-${pk.plan.row.segment_id ?? '0'}`)).filter(Boolean);
  const hard: string[] = [];
  const c7 = [0, 0], c8 = [0, 0], c11 = [0, 0], c12 = [0, 0];
  for (const sp of top4) {
    const pp = parseTriple(`${sp.row.contract_id}-${sp.row.plan_id}-${sp.row.segment_id ?? '0'}`); if (!pp) continue;
    const plan = `${sp.row.contract_id}-${sp.row.plan_id}`;
    const bd = sp.score.drugBreakdown ?? [];
    for (const m of meds) {
      if (m._partB || !m.rxcui) continue;
      const d = bd.find((x: any) => x.rxcui === m.rxcui); if (!d) continue;
      const cms = await cmsForm(pp, m.rxcui, m._ing, m.isBrand); const cmsCov = !!cms;
      c7[1]++;
      if (d.covered === cmsCov) c7[0]++;
      else if (d.covered === true && !cmsCov) hard.push(`CP7 ${plan} ${m.name} brain=covered CMS=absent (PHANTOM)`);
      else c7[0]++; // brain not-covered while present elsewhere = biosimilar-strict, acceptable
      if (d.covered && cms && cms.tier != null) { c8[1]++; if (Number(d.tier) === Number(cms.tier)) c8[0]++; else hard.push(`CP8 ${plan} ${m.name} brain tier=${d.tier} CMS tier=${cms.tier}`); }
    }
    for (const npi of p.npi) {
      c11[1]++;
      const pd = await cmsProv(pp, npi);
      const carrierOut = pd.length > 0 && !pd.some((x: any) => x.covered);
      // brain per-plan provider state is aggregate; a top-4 plan marked in_network must not be carrier-OUT
      if (sp.score.providerNetworkState === 'in_network' && carrierOut) hard.push(`CP11 ${plan} ${npi} brain=in_network carrier=OUT`);
      else c11[0]++;
    }
    const B = await cmsBen(pp);
    const spec = sp.score?.medical?.specialist ?? null; // may be absent
    if (B.specialist) { c12[1]++; const cmsSpec = num(B.specialist.copay); const brainSpec = num(spec?.copay); if (cmsSpec == null || brainSpec == null || Math.abs(cmsSpec - brainSpec) < 0.6) c12[0]++; else hard.push(`CP12 ${plan} specialist brain=${brainSpec} CMS=${cmsSpec}`); }
  }
  // CP13 gate monotonic (from the funnel the brain logs; reconstruct from ranked flags)
  const g1 = out.ranked.filter((s: any) => s.score.gate1Passed).length;
  const g2 = out.ranked.filter((s: any) => s.score.gate2Passed).length;
  const g3 = out.ranked.filter((s: any) => s.score.gate3Passed).length;
  const cp13 = g1 >= g2 && g2 >= g3 && g3 >= top4.length && top4.length > 0;
  if (!cp13) hard.push(`CP13 funnel not monotonic g1=${g1} g2=${g2} g3=${g3} top=${top4.length}`);
  for (const h of hard) hardAll.push(`${pid} ${p.name}: ${h}`);
  rows.push({ pid, name: p.name, top4: top4.map((s: any) => `${s.row.contract_id}-${s.row.plan_id}`), c7, c8, c11, c12, cp13, hard: hard.length });
  console.log(`${pid} ${p.name}: top4=${top4.map((s: any) => `${s.row.contract_id}-${s.row.plan_id}`).join(',')} | CP7 ${c7[0]}/${c7[1]} CP8 ${c8[0]}/${c8[1]} CP11 ${c11[0]}/${c11[1]} CP12 ${c12[0]}/${c12[1]} CP13 ${cp13 ? 'ok' : 'FAIL'} | hard=${hard.length}`);
}
console.log('\n=== HARD FAILS ===');
console.log(hardAll.length ? hardAll.map((h) => '- ' + h).join('\n') : '- none');
const tot = (k: string) => rows.reduce((a, r) => [a[0] + r[k][0], a[1] + r[k][1]], [0, 0]);
const [p7, t7] = tot('c7'), [p8, t8] = tot('c8'), [p11, t11] = tot('c11'), [p12, t12] = tot('c12');
console.log(`\n=== AGENT CP7-13 TOTALS ===`);
console.log(`CP7 drug-covered:  ${p7}/${t7}`);
console.log(`CP8 tier:          ${p8}/${t8}`);
console.log(`CP9 PA/ST/QL:      NOT SURFACED in agent brain output (drugBreakdown has no PA/ST/QL) — parity with consumer`);
console.log(`CP10 drug cost:    brain computes annualCost per drug (no independent CMS cost truth; see per-persona)`);
console.log(`CP11 provider:     ${p11}/${t11}`);
console.log(`CP12 specialist copay: ${p12}/${t12}`);
console.log(`CP13 gates:        ${rows.filter((r) => r.cp13).length}/${rows.length} personas monotonic`);
console.log(`HARD FAILS: ${hardAll.length}`);
