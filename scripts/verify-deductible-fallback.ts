// Verify FIX #6: simulate the loader's PBP medical_deductible fallback
// against real Durham data and report before/after coverage.

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
  fn: (f: number, t: number) => PromiseLike<PostgrestSingleResponse<T[]>>,
): Promise<T[]> {
  const out: T[] = [];
  for (let n = 0; n < 50; n += 1) {
    const { data, error } = await fn(n * 1000, n * 1000 + 999);
    if (error) throw error;
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

const RANK: Record<string, number> = {
  medicare_gov: 5, sb_ocr: 4, cms_pbp: 3, manual: 2, pbp_federal: 1,
};

const plans = await paginate<any>((f, t) =>
  sb.from('pm_plans')
    .select('contract_id, plan_id, plan_name, annual_deductible')
    .eq('state', 'NC').ilike('county_name', 'Durham').range(f, t),
);
const keys = plans.map((p) => `${p.contract_id}-${p.plan_id}`);

// Same fetch the loader does (broad PBP, source-rank dedup).
const pbp = await paginate<any>((f, t) =>
  sb.from('pbp_benefits')
    .select('plan_id, benefit_type, copay, tier_id, source')
    .in('plan_id', keys)
    .eq('benefit_type', 'medical_deductible')
    .in('source', ['medicare_gov', 'sb_ocr', 'cms_pbp', 'manual'])
    .range(f, t),
);
const best = new Map<string, any>();
for (const r of pbp) {
  const k = `${r.plan_id}|medical_deductible|${r.tier_id ?? 0}`;
  const prior = best.get(k);
  if (!prior || (RANK[r.source] ?? 0) > (RANK[prior.source] ?? 0)) best.set(k, r);
}
// Min copay per plan (loader convention).
const minByPlan = new Map<string, { copay: number; source: string }>();
for (const r of best.values()) {
  if (typeof r.copay !== 'number') continue;
  const prior = minByPlan.get(r.plan_id);
  if (!prior || r.copay < prior.copay) minByPlan.set(r.plan_id, { copay: r.copay, source: r.source });
}

let pmHas = 0, pbpHas = 0, finalHas = 0;
const conflicts: any[] = [];
const recovered: any[] = [];
for (const p of plans) {
  const k = `${p.contract_id}-${p.plan_id}`;
  const pbpHit = minByPlan.get(k);
  const before = p.annual_deductible;
  const after = pbpHit?.copay ?? before;
  if (before != null) pmHas += 1;
  if (pbpHit != null) pbpHas += 1;
  if (after != null) finalHas += 1;
  if (before == null && pbpHit != null) {
    recovered.push({ plan: k, name: String(p.plan_name).slice(0, 38), pbp_copay: pbpHit.copay, source: pbpHit.source });
  }
  if (before != null && pbpHit != null && before !== pbpHit.copay) {
    conflicts.push({ plan: k, name: String(p.plan_name).slice(0, 38), pm: before, pbp: pbpHit.copay, winning: pbpHit.copay, source: pbpHit.source });
  }
}

console.log(`Durham plans: ${plans.length}`);
console.log(`Before fix — pm_plans.annual_deductible populated:        ${pmHas} (${((pmHas / plans.length) * 100).toFixed(0)}%)`);
console.log(`PBP medical_deductible populated for same plans:          ${pbpHas} (${((pbpHas / plans.length) * 100).toFixed(0)}%)`);
console.log(`After fix — final annual_deductible non-null on Plan:     ${finalHas} (${((finalHas / plans.length) * 100).toFixed(0)}%)`);
console.log(`Net recovered (was null, now has value):                  +${finalHas - pmHas} plans\n`);

if (recovered.length) {
  console.log(`── Plans where PBP recovers a value (${recovered.length}) ──`);
  console.table(recovered);
}
if (conflicts.length) {
  console.log(`── PM/PBP conflicts (PBP wins per fix design) (${conflicts.length}) ──`);
  console.table(conflicts);
}
