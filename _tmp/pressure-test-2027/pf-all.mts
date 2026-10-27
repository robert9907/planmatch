// Phase C: live medicare.gov Plan Finder 2027 for each persona's top-4 plans.
// Playwright-through-real-Chrome (Akamai bypass). Reads rescore/<pid>-brain.json.
// Run from ~/Code/plan-match:  npx tsx <this> C09,C06
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium, type Page } from '@playwright/test';
const DIR = '/private/tmp/claude-501/-Users-robertsimm/14954979-1804-41b3-bff8-2d8477e359f4/scratchpad/rescore';
const YEAR = 2027, BASE = 'https://www.medicare.gov/plan-compare', API = '/api/v1/data/plan-compare';
const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms));
// Store-name matcher. Catch hyphen/apostrophe/separator variants so real in-ZIP
// chain STORES aren't missed: NPPES lists "WAL-MART STORES EAST LP" and "SAMS
// EAST INC" (no "club"), which the old `walmart`/`sam.s club` tokens skipped —
// stranding Cobb 30060 on the lone corporate "WALGREEN CO" HQ (out-of-network)
// → PF retail=$0 (A08 false mail-only). Separators made optional (wal.?mart etc.).
const CHAIN=/(cvs|walgreen|rite.?aid|wal.?mart|kroger|publix|harris teeter|food lion|costco|\bsam.?s\b|target|safeway|albertsons|winn.?dixie|meijer|hy.?vee|wegmans|giant|stop.?shop|piggly|ingles|h.?e.?b|\bheb\b|tom thumb|randalls|brookshire)/i;

async function pf<T>(page:Page,opts:{method:'GET'|'POST';path:string;body?:unknown}):Promise<T|null>{
  const r=await page.evaluate(async({method,path,body})=>{try{const init:RequestInit={method,headers:{Accept:'application/json',...(method==='POST'?{'Content-Type':'application/json'}:{})}};if(body!=null)init.body=JSON.stringify(body);const resp=await fetch(path,init);return{status:resp.status,text:await resp.text()};}catch(e){return{status:-1,text:(e as Error).message};}},opts as any);
  if(r.status===403||/Access Denied/i.test(r.text))throw new Error(`AKAMAI 403 ${opts.path}`);
  if(r.status!==200){console.warn(`  ${opts.method} ${opts.path} ${r.status} ${r.text.slice(0,80)}`);return null;}
  try{return JSON.parse(r.text) as T;}catch{return null;}
}
async function pharmacies(zip:string,state:string){
  const grab=async(q:string)=>{try{const r=await fetch(`https://npiregistry.cms.hhs.gov/api/?taxonomy_description=Pharmacy&${q}&version=2.1&limit=200`);if(!r.ok)return[] as any[];const j=await r.json();return (j.results||[]).map((x:any)=>({npi:String(x.number),name:x.basic?.organization_name||x.basic?.name||''}));}catch{return[] as any[];}};
  let all=await grab(`postal_code=${zip}`); let ch=all.filter((x:any)=>CHAIN.test(x.name));
  if(ch.length<3&&state){const m=await grab(`state=${state}`);ch=ch.concat(m.filter((x:any)=>CHAIN.test(x.name)));}
  // Well-covered ZIPs (≥3 chain stores) keep the chain-only top-5 (no regression).
  // Thin/corporate-only ZIPs pad with local non-chain pharmacies so a real
  // in-network retail store is passed to /drugs/cost instead of a lone corporate
  // HQ NPI → avoids spurious retail=$0 (Cobb 30060). medicare.gov ignores
  // out-of-network NPIs and prices the lowest in-network one.
  if(ch.length>=3) return ch.slice(0,5).map((x:any)=>x.npi);
  const pad=[...ch, ...all.filter((x:any)=>!ch.some((c:any)=>c.npi===x.npi))];
  return pad.slice(0,8).map((x:any)=>x.npi);
}
const sTok=(l:string)=>{const m=l.match(/(\d+(?:\.\d+)?)/);return m?m[1]:null;};
// query = label minus trailing device words that break autocomplete rarely; keep it simple
function toQS(label:string){ return { q: label.replace(/\s+\d+(\/\d+)?(mcg|mg)?$/i,'').trim() || label, s: sTok(label), label }; }

async function runPersona(page:Page, b:any){
  // Verified 2026-10-25 vs medicare.gov (H5302-022 Eliquis tier-3 brand): LIS_LEVEL_2
  // → $5.00 brand (= full_low / FBDE ≤100% FPL), LIS_LEVEL_1A → $14.40 (= full_high),
  // LIS_LEVEL_3 → $0 (institutional). The old full_low→LIS_LEVEL_3 map was WRONG ($0) and
  // caused false "LIS regressed/failed" verdicts.
  const lisMap:Record<string,string>={full_low:'LIS_LEVEL_2',full_high:'LIS_LEVEL_1A',institutional:'LIS_LEVEL_3',none:'LIS_NO_HELP'};
  const lis = lisMap[b.flags?.lis||'none'] || 'LIS_NO_HELP';
  const landing=`${BASE}/#/search-results?plan_type=PLAN_TYPE_MAPD&fips=${b.fips}&zip=${b.zip}&year=${YEAR}`;
  await page.goto(landing,{waitUntil:'domcontentloaded',timeout:60000}); await page.waitForTimeout(3500);
  const st=await pf<any>(page,{method:'GET',path:`${API}/status`}); if(!st)throw new Error('warmup fail');
  const npis=await pharmacies(b.zip,b.st);
  const drugs=b.resolved.map((r:any)=>toQS(r.label));
  const rx:any[]=[];
  for(const d of drugs){
    const auto=await pf<any>(page,{method:'GET',path:`${API}/drugs/autocomplete?name=${encodeURIComponent(d.q)}&year=${YEAR}`});
    const cands=auto?.drugs||[]; if(!cands.length){rx.push({...d,ndc:null});continue;}
    const tok=d.q.toLowerCase().split(/\s+/)[0];
    const isCombo=(n:string)=>/\s\/\s|-/.test(n)&&!/hfa|er\b/i.test(n);
    const first=cands.find((c:any)=>String(c.name||'').toLowerCase().startsWith(tok)&&!isCombo(String(c.name||'')))||cands.find((c:any)=>String(c.name||'').toLowerCase().startsWith(tok))||cands[0];
    const forms=await pf<any>(page,{method:'GET',path:`${API}/drugs/${first.rxcui||first.id}/forms?year=${YEAR}`});
    const dos=forms?.dosages||[];
    let dd=d.s?dos.find((x:any)=>(String(x.strength||'').match(/\d+(?:\.\d+)?/g)||[]).includes(d.s)):null; dd=dd||dos[0];
    const pkg=dd?.packages?.[0]; if(!dd||!pkg){rx.push({...d,ndc:null});continue;}
    rx.push({...d,ndc:String(pkg.ndc||''),qty:typeof pkg.default_quantity_30==='number'?pkg.default_quantity_30:30,resolved:`${dd.name} ${dd.strength}${dd.strength_units||''}`});
    await sleep(120);
  }
  const out:any={pid:b.pid,lis,plans:{}};
  for(const t of b.top4){
    const triple=t.plan_id.replace(/-0$/,'-0'); const m=t.plan_id.match(/^([A-Z]\d{4})-(\d{3})-(\d+)$/); if(!m)continue;
    const body={npis,prescriptions:rx.filter((r:any)=>r.ndc).map((r:any)=>({ndc:r.ndc,quantity:r.qty,frequency:'FREQUENCY_30_DAYS'})),lis,full_year:true,retailOnly:false,plans:[{contract_id:m[1],plan_id:m[2],segment_id:m[3],contract_year:String(YEAR)}]};
    const resp=await pf<any>(page,{method:'POST',path:`${API}/drugs/cost`,body}); const pd=resp?.plans?.[0];
    const retail=new Map<string,number>(),meta=new Map<string,any>();
    for(const e of pd?.costs||[]){if(e.mail_order!==false)continue;for(const dc of e.drug_costs||[]){const n=String(dc.ndc||'');const y=dc.estimated_yearly_total;if(typeof y==='number'&&(!retail.has(n)||y<retail.get(n)!))retail.set(n,y);}}
    for(const e of pd?.costs||[])for(const dc of e.drug_costs||[]){const n=String(dc.ndc||'');const sc=(dc.covered===true?2:0)+(dc.tier!=null?1:0);const cur=meta.get(n);const cs=cur?((cur.covered===true?2:0)+(cur.tier!=null?1:0)):-1;if(sc>cs)meta.set(n,dc);}
    const excl=new Map<string,string>();for(const x of pd?.excluded_drugs||[])excl.set(String(x.ndc),x.reason||'EXCL');
    let sum=0; const drugsOut:any[]=[];
    for(const r of rx){const y=r.ndc?retail.get(r.ndc):undefined;const mt=r.ndc?meta.get(r.ndc):undefined;const ex=r.ndc?excl.get(r.ndc):undefined;if(typeof y==='number')sum+=y;
      drugsOut.push({label:r.label,ndc:r.ndc,yr:y??null,covered:mt?.covered??(ex?false:null),tier:mt?.tier??null,reason:mt?.coverage_reason??ex??null});}
    out.plans[t.plan_id]={retail_total:pd?.lowest_retail_total??null,mail_total:pd?.lowest_mail_total??null,sum:Math.round(sum),restrictions:pd?.restrictions??null,drugs:drugsOut};
    await sleep(700);
  }
  writeFileSync(`${DIR}/${b.pid}-pf.json`,JSON.stringify(out,null,2));
  const line=b.top4.map((t:any)=>`${t.plan_id}=$${out.plans[t.plan_id]?.sum}`).join(' ');
  console.log(`${b.pid} PF: ${line}`);
}

const pids=(process.argv[2]||'').split(',').filter(Boolean);
const browser=await chromium.launch({headless:process.env.MG_HEADFUL!=='1',channel:'chrome',args:['--disable-blink-features=AutomationControlled']});
const ctx=await browser.newContext({userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',viewport:{width:1280,height:900},locale:'en-US',timezoneId:'America/New_York'});
await ctx.addInitScript(()=>{Object.defineProperty(navigator,'webdriver',{get:()=>undefined});});
const page=await ctx.newPage();
for(const pid of pids){
  try{ const b=JSON.parse(readFileSync(`${DIR}/${pid}-brain.json`,'utf8')); if(!b.top4?.length){console.log(`${pid} no top plans, skip`);continue;} await runPersona(page,b); }
  catch(e){ console.log(`${pid} ERROR ${(e as Error).message}`); if(/AKAMAI/.test((e as Error).message)){console.log('Akamai block — stopping');break;} }
  await sleep(1500);
}
await ctx.close(); await browser.close(); console.log('PF DONE');
