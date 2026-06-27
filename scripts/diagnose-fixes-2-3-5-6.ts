// Diagnostics for FIX #2 (rx_tier source), #3 (transportation source),
// #5 (provider state census), #6 (annual_deductible coverage). Read-only.

import { createClient, type PostgrestSingleResponse } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function paginate<T>(
  pageFn: (from: number, to: number) => PromiseLike<PostgrestSingleResponse<T[]>>,
  maxPages = 200,
): Promise<T[]> {
  const out: T[] = [];
  for (let n = 0; n < maxPages; n += 1) {
    const from = n * 1000;
    const to = from + 999;
    const { data, error } = await pageFn(from, to);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

function table(rows: any[], cols?: string[]) {
  if (!rows || rows.length === 0) { console.log('  (no rows)'); return; }
  const c = cols ?? Object.keys(rows[0]);
  const w: Record<string, number> = {};
  for (const k of c) {
    w[k] = k.length;
    for (const r of rows) {
      const v = r[k];
      const s = v == null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      w[k] = Math.min(60, Math.max(w[k], s.length));
    }
  }
  const fmt = (v: any) => {
    const s = v == null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.length > 60 ? s.slice(0, 57) + '...' : s;
  };
  console.log('  ' + c.map((k) => k.padEnd(w[k])).join(' │ '));
  console.log('  ' + c.map((k) => '─'.repeat(w[k])).join('─┼─'));
  for (const r of rows) console.log('  ' + c.map((k) => fmt(r[k]).padEnd(w[k])).join(' │ '));
}

const TARGET_COMBINED = 'H1914-009';
const TARGET_CONTRACT = 'H1914';
const TARGET_PLAN = '009';

// ───────────────────── FIX #2: rx_tier source merge ─────────────────────
console.log('\n=== FIX #2 — rx_tier source merge for H1914-009 ===\n');

console.log('pm_plan_benefits rx_tier rows:');
const pmRx = await paginate<any>((f, t) =>
  sb.from('pm_plan_benefits')
    .select('benefit_category, copay, coinsurance, segment_id, benefit_description')
    .eq('contract_id', TARGET_CONTRACT).eq('plan_id', TARGET_PLAN)
    .like('benefit_category', 'rx_tier%').range(f, t),
);
table(pmRx);

console.log('\npbp_benefits rx_tier rows (all sources):');
const pbpRx = await paginate<any>((f, t) =>
  sb.from('pbp_benefits')
    .select('benefit_type, tier_id, copay, coinsurance, source, description')
    .eq('plan_id', TARGET_COMBINED).like('benefit_type', 'rx_tier%').range(f, t),
);
table(pbpRx);

console.log('\nSimulated merge (medicare_gov=5, sb_ocr=4, cms_pbp=3, manual=2, pbp_federal=1):');
const RANK: Record<string, number> = { medicare_gov: 5, sb_ocr: 4, cms_pbp: 3, manual: 2, pbp_federal: 1 };
const winners = new Map<string, any>();
for (const r of pbpRx) {
  const key = `${r.benefit_type}|${r.tier_id ?? 0}`;
  const prior = winners.get(key);
  if (!prior || (RANK[r.source] ?? 0) > (RANK[prior.source] ?? 0)) winners.set(key, r);
}
const synth = [...winners.values()];
table(synth.map((r) => ({ tier: r.benefit_type, copay: r.copay, coinsurance: r.coinsurance, source: r.source })));

console.log('\nMerged result (PBP overrides pm on same category):');
const pmByCat = new Map(pmRx.map((r) => [r.benefit_category, r]));
const merged: any[] = [];
for (const tier of ['rx_tier_1', 'rx_tier_2', 'rx_tier_3', 'rx_tier_4', 'rx_tier_5', 'rx_tier_6']) {
  const pbpHit = synth.find((s) => s.benefit_type === tier);
  const pmHit = pmByCat.get(tier);
  const final = pbpHit ?? pmHit;
  merged.push({
    tier,
    pm_copay: pmHit?.copay ?? null,
    pbp_copay: pbpHit?.copay ?? null,
    pbp_coins: pbpHit?.coinsurance ?? null,
    pbp_source: pbpHit?.source ?? null,
    final_copay: final?.copay ?? null,
    final_coins: final?.coinsurance ?? final?.coinsurance ?? null,
    winning_source: pbpHit ? `pbp:${pbpHit.source}` : pmHit ? 'pm_plan_benefits' : 'none',
  });
}
table(merged);

// ───────────────────── FIX #3: transportation source ─────────────────────
console.log('\n=== FIX #3 — transportation source merge for H1914-009 ===\n');

const pmTrans = await paginate<any>((f, t) =>
  sb.from('pm_plan_benefits')
    .select('benefit_category, copay, coinsurance, coverage_amount, max_coverage, benefit_description')
    .eq('contract_id', TARGET_CONTRACT).eq('plan_id', TARGET_PLAN)
    .like('benefit_category', '%transport%').range(f, t),
);
console.log('pm_plan_benefits transportation rows:');
table(pmTrans);

const pbpTrans = await paginate<any>((f, t) =>
  sb.from('pbp_benefits')
    .select('benefit_type, copay, copay_max, coinsurance, source, description, tier_id')
    .eq('plan_id', TARGET_COMBINED)
    .or('benefit_type.like.%transport%,benefit_type.eq.air_transportation').range(f, t),
);
console.log('\npbp_benefits transport-ish rows (all sources):');
table(pbpTrans);

// Sample 10 other plans with sb_ocr "Not covered" transport to gauge prevalence
const sample = await paginate<any>((f, t) =>
  sb.from('pbp_benefits')
    .select('plan_id, source, description, copay')
    .eq('benefit_type', 'transportation').eq('source', 'sb_ocr')
    .ilike('description', '%not covered%').range(f, Math.min(t, f + 19)),
);
console.log('\nOther plans where sb_ocr transportation = "Not covered" (sample 20):');
table(sample);

// ───────────────────── FIX #5: provider state census ─────────────────────
console.log('\n=== FIX #5 — provider network cache by state (true count) ===\n');

// Defeat the 1000-row cap by using an RPC-less approach: pull state column
// at high page count. Increase pages so we span the whole table.
console.log('Counting via paginated state column scan (cap 200k rows)...');
const provStates = await paginate<{ state: string | null }>((f, t) =>
  sb.from('pm_provider_network_cache').select('state').range(f, t),
  200,
);
const stateCount = new Map<string, number>();
for (const r of provStates) {
  const s = r.state ?? '(null)';
  stateCount.set(s, (stateCount.get(s) ?? 0) + 1);
}
console.log(`Total rows seen: ${provStates.length}`);
table([...stateCount.entries()].sort((a, b) => b[1] - a[1]).map(([state, rows]) => ({ state, rows })));
const hitMaxPages = provStates.length === 200 * 1000;
if (hitMaxPages) console.log('⚠️  Hit the 200-page cap — true total exceeds 200k.');

// Distinct NPIs in Durham NC
const durhamRows = await paginate<{ npi: number | string }>((f, t) =>
  sb.from('pm_provider_network_cache').select('npi')
    .eq('state', 'NC').eq('county_fips', 37063).range(f, t),
  200,
);
const distinctDurhamNpis = new Set(durhamRows.map((r) => String(r.npi)));
console.log(`\nDistinct NPIs covered by ANY plan in Durham NC (37063): ${distinctDurhamNpis.size}`);
console.log(`(Total cache rows for Durham NC: ${durhamRows.length})`);

// Covered=true subset
const durhamCovered = await paginate<{ npi: number | string }>((f, t) =>
  sb.from('pm_provider_network_cache').select('npi')
    .eq('state', 'NC').eq('county_fips', 37063).eq('covered', true).range(f, t),
  200,
);
console.log(`Of those, covered=true: ${durhamCovered.length} rows, ${new Set(durhamCovered.map((r) => String(r.npi))).size} distinct NPIs.`);

// ───────────────────── FIX #6: annual_deductible gap ─────────────────────
console.log('\n=== FIX #6 — annual_deductible (Durham) pm_plans vs pbp_benefits ===\n');

const durhamPlans = await paginate<any>((f, t) =>
  sb.from('pm_plans')
    .select('contract_id, plan_id, contract_plan_id, plan_name, annual_deductible, monthly_premium')
    .eq('state', 'NC').ilike('county_name', 'Durham').range(f, t),
);

// pbp_benefits.medical_deductible matching by combined plan_id variants
const planIdVariants = new Set<string>();
for (const p of durhamPlans) {
  planIdVariants.add(`${p.contract_id}-${p.plan_id}`);
}
const pbpDed = await paginate<any>((f, t) =>
  sb.from('pbp_benefits')
    .select('plan_id, benefit_type, copay, copay_max, description, source')
    .in('plan_id', [...planIdVariants])
    .or('benefit_type.eq.medical_deductible,benefit_type.eq.deductible,benefit_type.like.%deductible%')
    .range(f, t),
);

const pbpByPlan = new Map<string, any[]>();
for (const r of pbpDed) {
  const arr = pbpByPlan.get(r.plan_id) ?? [];
  arr.push(r);
  pbpByPlan.set(r.plan_id, arr);
}

const cmp = durhamPlans.map((p) => {
  const combined = `${p.contract_id}-${p.plan_id}`;
  const matches = pbpByPlan.get(combined) ?? [];
  const med = matches.find((m) => m.benefit_type === 'medical_deductible');
  return {
    plan: combined,
    name: String(p.plan_name).slice(0, 40),
    pm_annual_deductible: p.annual_deductible,
    pbp_medical_deductible_copay: med?.copay ?? null,
    pbp_medical_deductible_copay_max: med?.copay_max ?? null,
    pbp_source: med?.source ?? null,
    pbp_other_deductible_types: matches.filter((m) => m.benefit_type !== 'medical_deductible').map((m) => m.benefit_type).join(',') || null,
  };
});
table(cmp);

const pmHas = cmp.filter((c) => c.pm_annual_deductible != null).length;
const pbpHas = cmp.filter((c) => c.pbp_medical_deductible_copay != null || c.pbp_medical_deductible_copay_max != null).length;
console.log(`\nTotal Durham plans: ${cmp.length}`);
console.log(`pm_plans.annual_deductible populated: ${pmHas} (${((pmHas / cmp.length) * 100).toFixed(0)}%)`);
console.log(`pbp_benefits.medical_deductible populated: ${pbpHas} (${((pbpHas / cmp.length) * 100).toFixed(0)}%)`);
