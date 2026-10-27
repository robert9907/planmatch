// CP10 scorecard — our brain top-4 drug total vs live PF plan-level total.
// PF total = retail_total when valid (>0), else mail_total (plan is mail-preferred /
// no in-network retail pharmacy). Our brain models 30-day retail; a mail-only PF
// plan is flagged (channel mismatch).
import { readFileSync, readdirSync } from 'node:fs';
const DIR = '/private/tmp/claude-501/-Users-robertsimm/8a7bc184-b582-48cc-986a-ce6d6f708fbb/scratchpad/rescore';
const NAMES = { C01:'Linda Pruitt',C02:'Wayne Edwards',C03:'Tamara Wilkes',C06:'Marcus Reyes',C07:'Elena Garza',C08:'Denise Holloway',C09:'Gerald Banks',A01:'Steven Mabry',A02:'Jason Ridley',A03:'Carol Whitfield',A06:'Patricia Nguyen',A07:'Brenda Kowalski',A08:'Harold Simmons',A10:'Terrence Lowe' };
const pids = readdirSync(DIR).filter(f=>f.endsWith('-pf.json')).map(f=>f.replace('-pf.json',''));
let planPass=0, planTotal=0; const rows=[]; const byP={};
for (const pid of pids.sort()) {
  const b = JSON.parse(readFileSync(`${DIR}/${pid}-brain.json`,'utf8'));
  const pf = JSON.parse(readFileSync(`${DIR}/${pid}-pf.json`,'utf8'));
  for (const t of b.top4) {
    const p = pf.plans[t.plan_id]; if (!p) continue;
    const brainSum = Math.round((t.meds||[]).reduce((s,m)=>s+(m.annual||0),0));
    const hasUncovNull = (t.meds||[]).some(m=>m.covered===false && (m.annual==null));
    const retailOk = (p.retail_total||0) > 0;
    const pfTotal = Math.round(retailOk ? p.retail_total : (p.mail_total||0));
    const chan = retailOk ? 'retail' : 'mail';
    const tol = Math.max(25, 0.02*pfTotal);
    const diff = brainSum - pfTotal; const pass = Math.abs(diff) <= tol;
    planTotal++; if (pass) planPass++;
    rows.push({ pid, plan:t.plan_id, surface:b.surface, brain:brainSum, pf:pfTotal, chan, diff, pass, hasUncovNull });
    (byP[pid] ||= {pid,surface:b.surface,all:true,n:0,callForPrice:false}); byP[pid].n++; if(!pass) byP[pid].all=false; if(hasUncovNull) byP[pid].callForPrice=true;
  }
}
console.log('ID   Name                 Surf Plan            Brain     PF     Chan   Diff   CP10  note');
for (const r of rows) console.log(
  `${r.pid.padEnd(4)} ${(NAMES[r.pid]||'').padEnd(20)} ${r.surface[0].toUpperCase()}    ${r.plan.padEnd(14)} ${('$'+r.brain).padStart(7)} ${('$'+r.pf).padStart(7)} ${r.chan.padEnd(6)} ${String(r.diff).padStart(6)}  ${r.pass?'PASS':'FAIL'}  ${r.hasUncovNull?'call-for-price drug':''}`);
console.log(`\nCP10 per-plan: ${planPass}/${planTotal} = ${(100*planPass/planTotal).toFixed(1)}%`);
// per-surface
for (const surf of ['consumer','agent']) {
  const rs = rows.filter(r=>r.surface===surf); const pass = rs.filter(r=>r.pass).length;
  console.log(`  ${surf}: ${pass}/${rs.length} = ${rs.length?(100*pass/rs.length).toFixed(1):'-'}%`);
}
console.log('\nPer-persona:');
for (const p of Object.values(byP)) console.log(`  ${p.pid} ${(NAMES[p.pid]||'').padEnd(18)} ${p.all?'PASS':'FAIL'}  (${p.n} plans)${p.callForPrice?'  [has call-for-price drug]':''}`);
const pp = Object.values(byP);
console.log(`Per-persona overall: ${pp.filter(p=>p.all).length}/${pp.length}`);
