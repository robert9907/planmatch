// CP9: brain-surfaced PA/ST/QL(+amount) vs pm_formulary (the CMS filing PF shows),
// for covered drugs on each persona's top-4, matched by the resolved rxcui.
import { readFileSync, readdirSync } from 'node:fs';
const DIR = '/private/tmp/claude-501/-Users-robertsimm/8a7bc184-b582-48cc-986a-ce6d6f708fbb/scratchpad/rescore';
const SB = process.env.SUPABASE_URL.replace(/\/$/,''); const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const pids = readdirSync(DIR).filter(f=>f.endsWith('-brain.json')).map(f=>f.replace('-brain.json',''));
let pass=0, tot=0; const misses=[];
for (const pid of pids.sort()) {
  const b = JSON.parse(readFileSync(`${DIR}/${pid}-brain.json`,'utf8'));
  const rxByLabel = Object.fromEntries(b.resolved.map(r=>[r.label, r.rxcui]));
  for (const t of b.top4) {
    const m = t.plan_id.match(/^([A-Z]\d{4})-(\d{3})-/); if(!m) continue;
    for (const med of t.meds) {
      if (med.covered !== true) continue; // CP9 only meaningful for covered drugs
      const rxcui = rxByLabel[med.name]; if (!rxcui) continue;
      // pm_formulary exact-rxcui row for this plan (the CMS filing)
      const u = new URL(`${SB}/rest/v1/pm_formulary`);
      u.searchParams.set('select','prior_auth,step_therapy,quantity_limit,quantity_limit_amount');
      u.searchParams.set('contract_id',`eq.${m[1]}`); u.searchParams.set('plan_id',`eq.${m[2]}`);
      u.searchParams.set('rxcui',`eq.${rxcui}`); u.searchParams.set('plan_year','eq.2027'); u.searchParams.set('limit','1');
      const r = await fetch(u, { headers: H }); const rows = r.ok ? await r.json() : [];
      if (rows.length === 0) continue; // exact rxcui not filed → brain used a sibling; skip (not an exact CP9 datapoint)
      const f = rows[0];
      tot++;
      const ok = (!!f.prior_auth === !!med.pa) && (!!f.step_therapy === !!med.st) && (!!f.quantity_limit === !!med.ql)
        && ((f.quantity_limit_amount ?? null) === (med.ql_amt ?? null));
      if (ok) pass++; else misses.push(`${pid} ${t.plan_id} ${med.name}: brain pa=${med.pa}/st=${med.st}/ql=${med.ql}(${med.ql_amt}) vs cms pa=${f.prior_auth}/st=${f.step_therapy}/ql=${f.quantity_limit}(${f.quantity_limit_amount})`);
    }
  }
}
console.log(`CP9 (exact-rxcui filed rows): ${pass}/${tot} = ${tot?(100*pass/tot).toFixed(1):'-'}%`);
for (const mm of misses.slice(0,30)) console.log('  MISS', mm);
