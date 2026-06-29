// Execute the DSNP food card import against pbp_benefits_v2.
//
// Mirrors scripts/migrations/dsnp-food-card-import.sql exactly:
//   - source='manual', description prefixed with [manual_capture_2026-06-29]
//   - copay = monthly $ (read-path source of truth per api/plans.ts:412)
//   - copay_max = monthly * 12 (annual cap)
//   - coverage_amount = monthly $ (semantic + gap-detector future-proof)
//   - tier_id = NULL (manual source wins over existing tier_id='0' placeholders)
//   - ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type, COALESCE(tier_id,''))
//     DO UPDATE
//
// Re-parses the CSV and re-queries pm_plans (same logic as
// gen-dsnp-food-card-sql.ts) so the executor doesn't drift from
// the generator. Pre-counts existing rows, runs the upserts, then
// emits the verification queries' results inline.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const env: Record<string, string> = {};
for (const l of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  if (!l || l.startsWith('#') || !l.includes('=')) continue;
  const i = l.indexOf('=');
  let v = l.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[l.slice(0, i).trim()] = v;
}
const url = env.SUPABASE_URL!;
const key = env.SUPABASE_SERVICE_ROLE_KEY!;
const projectId = url.replace(/^https?:\/\//, '').split('.')[0];
console.log(`Connected to Supabase project: ${projectId}`);
if (projectId !== 'rpcbrkmvalvdmroqzpaq') {
  console.error(`ABORT: expected rpcbrkmvalvdmroqzpaq, got ${projectId}`);
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const CSV_PATH = '/Users/robertsimm/Downloads/dsnp-food-card-capture - D-SNP Food Card Capture.csv';
const PROVENANCE_TAG = '[manual_capture_2026-06-29]';
const PLAN_YEAR = 2026;
const DRY_RUN = process.argv.includes('--dry-run');

function parseCsv(text: string): string[][] {
  const out: string[][] = []; let cur: string[] = []; let field = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i+1]==='"') {field+='"';i++;} else inQ=false; } else field+=c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { cur.push(field); field=''; }
    else if (c === '\n') { cur.push(field); out.push(cur); cur=[]; field=''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || cur.length) { cur.push(field); out.push(cur); }
  return out;
}
function classify(f: string): 'food_card' | 'otc_allowance' {
  const s = f.toLowerCase();
  if (s.includes('no food (otc') || s.startsWith('no food')) return 'otc_allowance';
  return 'food_card';
}
function parseAmount(raw: string): number {
  const cleaned = raw.replace(/[$,]/g, '').trim();
  if (!cleaned) return 0;
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

(async () => {
  const rows = parseCsv(readFileSync(CSV_PATH, 'utf8'));
  const planIdRe = /^H\d{4,5}-\d{3,}$/;
  type Row = { contract_id: string; plan_id: string; cp: string; carrier: string; state: string; amount: number; frequency: string; notes: string; benefit_type: 'food_card'|'otc_allowance' };
  const captured: Row[] = [];
  for (const r of rows) {
    const planId = (r[0] ?? '').trim();
    if (!planIdRe.test(planId)) continue;
    const [contract_id, plan_id] = planId.split('-');
    captured.push({
      contract_id, plan_id, cp: planId,
      carrier: (r[1]??'').trim(),
      state: (r[3]??'').trim(),
      amount: parseAmount(r[5]??''),
      frequency: ((r[6]??'').trim() || 'monthly'),
      notes: (r[7]??'').trim(),
      benefit_type: classify((r[8]??'').trim()),
    });
  }
  console.log(`CSV: ${captured.length} rows (${captured.filter(r=>r.benefit_type==='food_card').length} food_card, ${captured.filter(r=>r.benefit_type==='otc_allowance').length} otc_allowance)`);

  // Resolve segment_id per plan
  const planSegs = new Map<string, string[]>();
  for (const r of captured) {
    const { data, error } = await sb.from('pm_plans').select('segment_id').eq('contract_id', r.contract_id).eq('plan_id', r.plan_id);
    if (error) { console.error(`pm_plans query failed ${r.cp}:`, error.message); process.exit(1); }
    const segs = [...new Set((data ?? []).map((x: any) => String(x.segment_id ?? '0')))];
    planSegs.set(r.cp, segs.length ? segs : ['0']);
  }
  const totalUpserts = captured.reduce((a, r) => a + (planSegs.get(r.cp)?.length ?? 0), 0);
  console.log(`Expanded by segments → ${totalUpserts} upserts`);

  // Pre-snapshot existing rows for our 54 plans (food_card + otc_allowance only)
  const ors = captured.map((r) => `and(contract_id.eq.${r.contract_id},plan_id.eq.${r.plan_id})`).join(',');
  const { data: before } = await sb.from('pbp_benefits_v2').select('contract_id, plan_id, benefit_type, source, copay').or(ors).in('benefit_type', ['food_card', 'otc_allowance']);
  console.log(`\nPRE-INSERT snapshot: ${before?.length ?? 0} existing food_card+otc_allowance rows`);
  const beforeBySrc = (before ?? []).reduce((m: any, r: any) => { m[r.source] = (m[r.source] ?? 0) + 1; return m; }, {});
  console.log(`  by source: ${JSON.stringify(beforeBySrc)}`);

  if (DRY_RUN) { console.log('\n--dry-run set, exiting before any writes.'); process.exit(0); }

  // Run upserts
  console.log(`\nRunning ${totalUpserts} upserts...`);
  let ok = 0, fail = 0;
  for (const r of captured) {
    let monthly = r.amount;
    if (r.frequency.toLowerCase() === 'quarterly') monthly = r.amount / 3;
    else if (r.frequency.toLowerCase() === 'annual') monthly = r.amount / 12;
    const annualCap = monthly * 12;
    const description = `${PROVENANCE_TAG} $${monthly.toFixed(2)} per month — ${r.notes}`.slice(0, 1000);
    for (const segment_id of planSegs.get(r.cp) ?? []) {
      const payload = {
        contract_id: r.contract_id,
        plan_id: r.plan_id,
        segment_id,
        plan_year: PLAN_YEAR,
        benefit_type: r.benefit_type,
        copay: Number(monthly.toFixed(2)),
        copay_max: Number(annualCap.toFixed(2)),
        coverage_amount: Number(monthly.toFixed(2)),
        source: 'manual' as const,
        description,
      };
      // PostgREST's onConflict can't target the expression unique index
      // uq_pbp_benefits_v2_natural (it uses COALESCE(tier_id,'')).
      // Workaround: DELETE any existing tier_id IS NULL row at this
      // natural key first, then plain INSERT. Existing tier_id='0'
      // rows in a different COALESCE bucket are untouched.
      const { error: delErr } = await sb.from('pbp_benefits_v2').delete()
        .eq('contract_id', r.contract_id)
        .eq('plan_id', r.plan_id)
        .eq('segment_id', segment_id)
        .eq('plan_year', PLAN_YEAR)
        .eq('benefit_type', r.benefit_type)
        .is('tier_id', null);
      if (delErr) {
        console.error(`  FAIL DELETE ${r.cp} seg=${segment_id} ${r.benefit_type}: ${delErr.message}`);
        fail++;
        continue;
      }
      const { error: insErr } = await sb.from('pbp_benefits_v2').insert(payload);
      if (insErr) {
        console.error(`  FAIL INSERT ${r.cp} seg=${segment_id} ${r.benefit_type}: ${insErr.message}`);
        fail++;
      } else {
        ok++;
      }
    }
  }
  console.log(`\nResult: ${ok} ok, ${fail} failed`);

  // Verification 1: our batch
  const { data: v1 } = await sb.from('pbp_benefits_v2').select('benefit_type').eq('source', 'manual').like('description', `${PROVENANCE_TAG}%`);
  const v1count = (v1 ?? []).reduce((m: any, r: any) => { m[r.benefit_type] = (m[r.benefit_type] ?? 0) + 1; return m; }, {});
  console.log(`\nVerification 1 — manual+tag rows by benefit_type:`);
  console.log(`  ${JSON.stringify(v1count)}`);
  console.log(`  expected: {"food_card": >=32, "otc_allowance": >=22}  (>= because multi-segment expansion)`);

  // Verification 2: D-SNP coverage in NC/TX/GA
  const { data: dsnps } = await sb.from('pm_plans').select('contract_id, plan_id').eq('snp_type', 'D-SNP').in('state', ['NC', 'TX', 'GA']);
  const dsnpSet = new Set((dsnps ?? []).map((r: any) => `${r.contract_id}-${r.plan_id}`));
  const dsnpOrs = [...dsnpSet].map((cp) => { const [c, p] = cp.split('-'); return `and(contract_id.eq.${c},plan_id.eq.${p})`; }).join(',');
  let benefits: any[] = [];
  for (let i = 0; i < dsnpOrs.length; i += 50000) {
    // chunk if long
  }
  const { data: bRows } = await sb.from('pbp_benefits_v2').select('contract_id, plan_id, benefit_type').or(dsnpOrs).in('benefit_type', ['food_card', 'otc_allowance']);
  const hasFood = new Set<string>();
  const hasOtc = new Set<string>();
  for (const r of (bRows ?? []) as any[]) {
    const cp = `${r.contract_id}-${r.plan_id}`;
    if (!dsnpSet.has(cp)) continue;
    if (r.benefit_type === 'food_card') hasFood.add(cp);
    if (r.benefit_type === 'otc_allowance') hasOtc.add(cp);
  }
  console.log(`\nVerification 2 — D-SNP NC/TX/GA coverage:`);
  console.log(`  total_dsnps:       ${dsnpSet.size}`);
  console.log(`  has_food_card:     ${hasFood.size}  (${(hasFood.size/dsnpSet.size*100).toFixed(1)}%)`);
  console.log(`  has_otc_allowance: ${hasOtc.size}  (${(hasOtc.size/dsnpSet.size*100).toFixed(1)}%)`);

  // Spot check H5253-184 (prompt says should show $331/mo)
  const { data: spot } = await sb.from('pbp_benefits_v2').select('segment_id, benefit_type, copay, copay_max, coverage_amount, source, description').eq('contract_id', 'H5253').eq('plan_id', '184').eq('source', 'manual');
  console.log(`\nSpot check H5253-184 (expected: food_card copay=331):`);
  for (const r of (spot ?? []) as any[]) {
    console.log(`  seg=${r.segment_id} ${r.benefit_type} copay=${r.copay} copay_max=${r.copay_max} cov=${r.coverage_amount}`);
  }
})();
