// Phase A+B: re-resolve every persona drug via PRODUCTION drug-search (the
// real-user path, replacing stale fixture rxcuis), then POST prod rank-plans.
// Saves rescore/<pid>-brain.json {persona, resolved[], top4[]}.
import { writeFileSync, mkdirSync } from 'node:fs';
const OUT = '/private/tmp/claude-501/-Users-robertsimm/14954979-1804-41b3-bff8-2d8477e359f4/scratchpad/rescore';
mkdirSync(OUT, { recursive: true });
const DS = 'https://planmatch.generationhealth.me/api/library/drug-search';
const RP = 'https://planmatch.generationhealth.me/api/library/rank-plans';

// label → {q (search query), s (strength token to prefer), part (Part B?)}
const P = {
  C01:{n:'Linda Pruitt',st:'NC',c:'Durham',z:'27704',fips:'37063',d:['atorvastatin 20','levothyroxine 50mcg'],npi:['1184693160']},
  C02:{n:'Wayne Edwards',st:'NC',c:'Alleghany',z:'28675',fips:'37005',d:['lisinopril 10','metformin 500','tamsulosin 0.4'],npi:['1477758142']},
  C03:{n:'Tamara Wilkes',st:'NC',c:'Mecklenburg',z:'28262',fips:'37119',d:['teriflunomide 14','dalfampridine ER 10','baclofen 10','gabapentin 300','sertraline 100','modafinil 200','oxybutynin ER 10','lisinopril 20','omeprazole 20'],npi:['1235102187','1700144938']},
  C06:{n:'Marcus Reyes',st:'TX',c:'Harris',z:'77070',fips:'48201',d:['Entresto 49/51','Eliquis 5','Jardiance 10','Lantus SoloStar','metformin 1000','metoprolol succ ER 50','furosemide 40','spironolactone 25','atorvastatin 80'],npi:['1750314217','1538146022']},
  C07:{n:'Elena Garza',st:'TX',c:'Hidalgo',z:'78503',fips:'48215',d:['amlodipine 5','Januvia 100','omeprazole 20'],npi:['1124535257']},
  C08:{n:'Denise Holloway',st:'GA',c:'Fulton',z:'30318',fips:'13121',d:['Hyrimoz 40','methotrexate 2.5','folic acid 1','Trelegy Ellipta','albuterol HFA','prednisone 5','duloxetine 60','pantoprazole 40','Linzess 145'],npi:['1710121140','1104385079']},
  C09:{n:'Gerald Banks',st:'GA',c:'Chatham',z:'31406',fips:'13051',d:['Eliquis 5','metoprolol tartrate 25'],npi:['1851101869']},
  A01:{n:'Steven Mabry',st:'NC',c:'Wake',z:'27615',fips:'37183',d:['rosuvastatin 10','Xarelto 20'],npi:['1104832534']},
  A02:{n:'Jason Ridley',st:'NC',c:'Buncombe',z:'28803',fips:'37021',d:['Breo Ellipta 100/25','Spiriva Respimat 2.5','albuterol HFA','Ozempic 1mg','metformin ER 500','Vraylar 3','gabapentin 600','atorvastatin 40','montelukast 10'],npi:['1144312604','1457445066']},
  A03:{n:'Carol Whitfield',st:'NC',c:'New Hanover',z:'28401',fips:'37129',d:['alendronate 70','losartan 50','Linzess 72'],npi:['1497752554']},
  A06:{n:'Patricia Nguyen',st:'TX',c:'Dallas',z:'75237',fips:'48113',d:['Tresiba FlexTouch','NovoLog FlexPen','Mounjaro 7.5','Farxiga 10','levothyroxine 88','pregabalin 150','losartan 100','rosuvastatin 20','carvedilol 12.5'],npi:['1417535154','1184856759']},
  A07:{n:'Brenda Kowalski',st:'TX',c:'Lubbock',z:'79424',fips:'48303',d:['levothyroxine 75','Ozempic 0.5','metformin 500'],npi:['1508837790']},
  A08:{n:'Harold Simmons',st:'GA',c:'Cobb',z:'30060',fips:'13067',d:['Eliquis 5','atorvastatin 40','finasteride 5'],npi:['1164984738']},
  A10:{n:'Terrence Lowe',st:'GA',c:'Bibb',z:'31206',fips:'13021',d:['Kerendia 20','amlodipine 10','carvedilol 25','furosemide 80','allopurinol 100','sevelamer carbonate 800','calcitriol 0.25','Januvia 25','atorvastatin 40'],npi:['1760914733','1609071448']},
};
const FLAGS = {
  C03:{lis:'full_high'}, C08:{dsnp:true,medicaid:'fbde',lis:'full_low',living:'community'},
  A06:{lis:'full_low'}, A10:{dsnp:true,medicaid:'fbde',lis:'full_low',living:'community'},
};
const strengthTok = (label) => { const m = label.match(/(\d+(?:\.\d+)?)/); return m ? m[1] : null; };

async function resolveDrug(label) {
  const r = await fetch(DS, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ query: label, limit: 15 }) });
  const j = await r.json(); const rows = j.drugs || [];
  if (rows.length === 0) return null;
  const tok = strengthTok(label);
  // Prefer a result whose name contains the strength token; else top.
  let pick = tok ? rows.find((x) => (x.name||'').includes(tok) || (x.strength||'').includes(tok)) : null;
  pick = pick || rows[0];
  return { rxcui: pick.rxcui, name: pick.name, strength: pick.strength, dose_form: pick.dose_form, isBrand: !!pick.is_brand };
}

const want = process.argv[2] ? process.argv[2].split(',') : Object.keys(P);
for (const pid of want) {
  const per = P[pid]; if (!per) continue;
  const f = FLAGS[pid] || {};
  const resolved = [];
  for (const label of per.d) {
    const rr = await resolveDrug(label);
    resolved.push({ label, ...(rr || { rxcui: null }) });
  }
  const meds = resolved.filter((x) => x.rxcui).map((x) => ({ rxcui: x.rxcui, name: x.label, isBrand: x.isBrand }));
  const body = { state: per.st, county: per.c, zip: per.z, plan_year: 2027, medications: meds, providers: per.npi.map((n)=>({npi:n,name:`${per.n} provider`})), extras: [] };
  if (f.dsnp) body.dsnp_eligible = true;
  if (f.medicaid && f.medicaid !== 'none') body.medicaid_level = f.medicaid;
  if (f.lis && f.lis !== 'none') body.lis_tier = f.lis;
  if (f.living) body.living_setting = f.living;
  let resp;
  for (let a=0;a<3;a++){ const r=await fetch(RP,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const t=await r.text(); if(r.ok){resp=JSON.parse(t);break;} await new Promise(x=>setTimeout(x,3000)); }
  if (!resp) { console.log(`${pid} FAILED rank-plans`); continue; }
  const top4 = (resp.top_plans||[]).map((p)=>({ plan_id:p.plan_id, carrier:p.carrier, plan_type:p.plan_type, premium:p.premium,
    meds:(p.medications||[]).map((m)=>({ name:m.name, covered:m.covered, tier:m.tier, annual:m.annual_cost, copay:m.copay,
      pa:m.prior_auth, st:m.step_therapy, ql:m.quantity_limit, ql_amt:m.quantity_limit_amount, ql_days:m.quantity_limit_days })) }));
  writeFileSync(`${OUT}/${pid}-brain.json`, JSON.stringify({ pid, name:per.n, surface: pid[0]==='C'?'consumer':'agent', st:per.st, county:per.c, zip:per.z, fips:per.fips, flags:f, resolved, top4 }, null, 2));
  console.log(`${pid} ${per.n}: top=${top4.length} resolved=${resolved.map(r=>r.rxcui||'NULL').join(',')}`);
}
console.log('DONE');
