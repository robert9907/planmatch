// Replicate the agent's broadPbpRows + bestByKey logic for Durham at scale
// to confirm what bestByKey winner emerges for the broken plans' inpatient_hospital.
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', { auth: { persistSession: false, autoRefreshToken: false }});
const SOURCE_PRIORITY: Record<string, number> = { medicare_gov: 5, sb_ocr: 4, cms_pbp: 3, manual: 2, pbp_federal: 1 };

async function main() {
  // Step A: build pbpKeyVariants the same way the agent does
  const { data: planRows } = await sb.from('pm_plans').select('contract_id, plan_id, segment_id').eq('state','NC').eq('county_name','Durham').eq('sanctioned',false).limit(2000);
  const seen = new Set<string>();
  const triples = (planRows ?? []).filter(p => { const k = `${p.contract_id}-${p.plan_id}-${p.segment_id}`; if (seen.has(k)) return false; seen.add(k); return true; });
  console.log('triples:', triples.length);
  const variants = new Set<string>();
  for (const p of triples) {
    const key = `${p.contract_id}-${p.plan_id}-${p.segment_id || '000'}`;
    variants.add(key);
    const norm = `${p.contract_id}-${p.plan_id}`;
    variants.add(norm);
    const seg1 = (p.segment_id || '').replace(/^0+/, '') || '0';
    variants.add(`${p.contract_id}-${p.plan_id}-${seg1}`);
  }
  console.log('variants:', variants.size);

  // Step B: paginate the broad pbp fetch
  const all: any[] = [];
  const PAGE = 1000;
  for (let i = 0; i < 20; i++) {
    const from = i*PAGE, to = from+PAGE-1;
    const { data } = await sb.from('pbp_benefits')
      .select('plan_id, benefit_type, copay, copay_max, coinsurance, tier_id, description, source')
      .in('plan_id', [...variants])
      .in('source', ['medicare_gov','sb_ocr','cms_pbp','manual'])
      .range(from, to);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  console.log('total broadPbp rows:', all.length);

  // Step C: bestByKey
  const best = new Map<string, any>();
  for (const r of all) {
    const k = `${r.plan_id}|${r.benefit_type}|${r.tier_id ?? 0}`;
    const cur = best.get(k);
    const curRank = cur ? SOURCE_PRIORITY[cur.source] ?? 0 : -1;
    const newRank = SOURCE_PRIORITY[r.source] ?? 0;
    if (!cur || newRank > curRank) best.set(k, r);
  }
  console.log('bestByKey size:', best.size);

  // Step D: for each plan_id of interest, get inpatient_hospital winner
  for (const pid of ['H3146-006', 'H6351-004', 'H4676-001', 'H9725-015']) {
    const k = `${pid}|inpatient_hospital|0`;
    const w = best.get(k);
    if (!w) { console.log(`${pid}: no inpatient_hospital winner`); continue; }
    const copayNull = w.copay == null;
    const copayMaxNull = w.copay_max == null;
    const coinsNull = w.coinsurance == null;
    const descBlank = w.description == null || (w.description as string).trim() === '';
    const skipped = copayNull && copayMaxNull && coinsNull && descBlank;
    console.log(`${pid} winner: source=${w.source} copay=${w.copay} desc=${JSON.stringify(w.description)} → my-fix-skips=${skipped}`);
  }

  // Step E: also check ALL inpatient_hospital winners — find any with non-null data that would NOT be skipped
  console.log('\n=== Every inpatient_hospital winner across all Durham plans ===');
  for (const [k, w] of best.entries()) {
    if (!k.includes('inpatient_hospital')) continue;
    const allNull = w.copay == null && w.copay_max == null && w.coinsurance == null && (w.description == null || (w.description as string).trim() === '');
    if (!allNull) {
      console.log(`  ${k}: source=${w.source} copay=${w.copay} desc=${JSON.stringify((w.description||'').slice(0,60))}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
