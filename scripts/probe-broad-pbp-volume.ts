import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', { auth: { persistSession: false, autoRefreshToken: false }});
async function main() {
  // Same query the agent uses for broadPbpRows
  const { data: planRows } = await sb.from('pm_plans').select('contract_id, plan_id, segment_id').eq('state','NC').eq('county_name','Durham').eq('sanctioned', false).limit(2000);
  const seen = new Set<string>();
  const plans = (planRows ?? []).filter(p => { const k = `${p.contract_id}-${p.plan_id}-${p.segment_id}`; if (seen.has(k)) return false; seen.add(k); return true; });
  console.log('plans:', plans.length);
  const variants = new Set<string>();
  for (const p of plans) {
    variants.add(`${p.contract_id}-${p.plan_id}`);
    variants.add(`${p.contract_id}-${p.plan_id}-${p.segment_id}`);
    const seg1 = (p.segment_id ?? '').replace(/^0+/, '') || '0';
    variants.add(`${p.contract_id}-${p.plan_id}-${seg1}`);
  }
  console.log('pbpKeyVariants:', variants.size);
  // Now do the agent's broad fetch with pagination
  const PAGE = 1000;
  let total = 0;
  for (let pageNum = 0; pageNum < 20; pageNum++) {
    const from = pageNum * PAGE;
    const to = from + PAGE - 1;
    const { data } = await sb.from('pbp_benefits')
      .select('plan_id, benefit_type, copay, copay_max, coinsurance, tier_id, description, source')
      .in('plan_id', [...variants])
      .in('source', ['medicare_gov','sb_ocr','cms_pbp','manual'])
      .range(from, to);
    const got = data?.length ?? 0;
    console.log(`page ${pageNum}: ${got} rows`);
    total += got;
    // Check if H6351-004 inpatient_hospital is on this page
    const found = (data ?? []).filter(r => r.plan_id === 'H6351-004' && r.benefit_type === 'inpatient_hospital');
    if (found.length) console.log(`  -> H6351-004/inpatient_hospital on page ${pageNum}: ${found.length}`);
    if (got < PAGE) break;
  }
  console.log('total:', total);
}
main().catch(e => { console.error(e); process.exit(1); });
