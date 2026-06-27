// Probe round 2: verify drug_deductible=NULL really marks MA-only by
// cross-checking pbp_benefits for rx_tier presence.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const url = process.env.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function main() {
  // (1) Confirm H9725-005 (drug_deductible NULL) has no rx_tier in pbp_benefits
  const targets = [
    { id: 'H9725-005', label: 'HealthSpring Courage (NULL drug_deductible)' },
    { id: 'H9725-015', label: 'HealthSpring Preferred Savings (drug_deductible=0)' },
  ];
  for (const t of targets) {
    const { data } = await sb
      .from('pbp_benefits')
      .select('benefit_type')
      .eq('plan_id', t.id);
    const types = new Set((data ?? []).map((r) => r.benefit_type));
    const hasRx = [...types].some((s) => /^rx_tier/i.test(s));
    console.log(`${t.id}  ${t.label}`);
    console.log(`  ${types.size} distinct benefit_types, has_rx_tier=${hasRx}`);
    console.log(`  rx types: ${[...types].filter((s) => /rx|drug/i.test(s)).join(', ') || '(none)'}`);
  }

  // (2) Distinct contract_id of NC "drug_deductible IS NULL, non-SNP, non-PDP" plans —
  //     these are the candidates for the VA filter.
  const { data: page1 } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, plan_name, carrier, plan_type, drug_deductible, snp')
    .eq('state', 'NC')
    .eq('sanctioned', false)
    .is('drug_deductible', null)
    .eq('snp', false)
    .neq('plan_type', 'PDP')
    .range(0, 999);
  const { data: page2 } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, plan_name, carrier, plan_type, drug_deductible, snp')
    .eq('state', 'NC')
    .eq('sanctioned', false)
    .is('drug_deductible', null)
    .eq('snp', false)
    .neq('plan_type', 'PDP')
    .range(1000, 1999);
  const all = [...(page1 ?? []), ...(page2 ?? [])];
  const distinct = new Map<string, { name: string; carrier: string; type: string }>();
  for (const r of all) {
    const k = `${r.contract_id}-${r.plan_id}`;
    if (!distinct.has(k)) distinct.set(k, { name: r.plan_name, carrier: r.carrier ?? '—', type: r.plan_type ?? '—' });
  }
  console.log(`\nNC VA candidates (distinct contract-plan, drug_deductible NULL, non-SNP, non-PDP):`);
  console.log(`  ${distinct.size} distinct plans across ${all.length} county rows`);
  for (const [k, v] of distinct) {
    console.log(`    ${k}  ${v.type}  ${v.carrier} — ${v.name}`);
  }

  // (3) Distinct snp_type values across full NC dataset, paginated
  const snpCount = new Map<string, number>();
  for (let pg = 0; pg < 20; pg++) {
    const from = pg * 1000, to = from + 999;
    const { data } = await sb
      .from('pm_plans')
      .select('snp_type, snp')
      .eq('state', 'NC')
      .eq('sanctioned', false)
      .range(from, to);
    if (!data || data.length === 0) break;
    for (const r of data) {
      const k = `snp=${r.snp} snp_type=${r.snp_type ?? 'null'}`;
      snpCount.set(k, (snpCount.get(k) ?? 0) + 1);
    }
    if (data.length < 1000) break;
  }
  console.log(`\nFull NC snp_type distribution (all county rows):`);
  for (const [k, v] of [...snpCount.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v.toString().padStart(5)}  ${k}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
