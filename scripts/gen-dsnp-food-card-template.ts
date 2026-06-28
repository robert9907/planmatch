// Generate the manual-fill CSV template for the remaining gap D-SNPs.
// Columns: plan_id, carrier, state, plan_name, food_card_amount,
// frequency, notes. First four prefilled from pm_plans; last three
// blank for Rob to capture from carrier portals.
//
// Output paths:
//   ~/Code/plan-match/_tmp/dsnp-food-card-manual-template.csv
//   ~/Desktop/dsnp-food-card-manual-template.csv (also)

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import os from 'node:os';

const env: Record<string, string> = {};
for (const l of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  if (!l || l.startsWith('#') || !l.includes('=')) continue;
  const i = l.indexOf('=');
  let v = l.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[l.slice(0, i).trim()] = v;
}
const sb = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

function csvEscape(s: string): string {
  if (s == null) return '';
  const str = String(s);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

(async () => {
  // 1. Fetch all NC/TX/GA D-SNP contract-plan pairs from pm_plans
  let from = 0;
  const seen = new Set<string>();
  const plans: Array<{ contract_id: string; plan_id: string; cp: string; carrier: string; state: string; plan_name: string }> = [];
  for (;;) {
    const { data, error } = await sb
      .from('pm_plans')
      .select('contract_id, plan_id, state, carrier, plan_name')
      .in('state', ['NC', 'TX', 'GA'])
      .eq('snp_type', 'D-SNP')
      .range(from, from + 999);
    if (error || !data || data.length === 0) break;
    for (const r of data as any[]) {
      const cp = `${r.contract_id}-${r.plan_id}`;
      if (seen.has(cp)) continue;
      seen.add(cp);
      plans.push({ contract_id: r.contract_id, plan_id: r.plan_id, cp, carrier: r.carrier ?? '', state: r.state, plan_name: r.plan_name ?? '' });
    }
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`NC/TX/GA D-SNP contract-plan pairs: ${plans.length}`);

  // 2. Pull current food/OTC rows for these plans, find which have real $
  const cpList = plans.map((p) => p.cp);
  const haveDollar = new Set<string>();
  for (let i = 0; i < cpList.length; i += 200) {
    const chunk = cpList.slice(i, i + 200);
    const { data } = await sb
      .from('pbp_benefits')
      .select('plan_id, benefit_type, copay, copay_max, description, source')
      .in('plan_id', chunk)
      .in('benefit_type', ['food_card', 'meal_benefit', 'meals', 'otc', 'otc_allowance']);
    for (const r of (data ?? []) as any[]) {
      const hasMax = r.copay_max != null && r.copay_max > 0;
      const hasCopay = r.copay != null && r.copay > 0;
      const hasDescDollar = typeof r.description === 'string' && /\$\s*\d/.test(r.description);
      if (hasMax || hasCopay || hasDescDollar) haveDollar.add(r.plan_id);
    }
  }

  // 3. Gap = D-SNPs lacking any food/OTC $ today
  const gap = plans.filter((p) => !haveDollar.has(p.cp));
  console.log(`Plans with food/OTC \$ today: ${haveDollar.size}`);
  console.log(`GAP plans for template: ${gap.length}`);

  // 4. Sort: state ASC, then carrier ASC, then plan_id ASC
  gap.sort((a, b) =>
    a.state.localeCompare(b.state) ||
    a.carrier.localeCompare(b.carrier) ||
    a.cp.localeCompare(b.cp),
  );

  // 5. Emit CSV
  const lines: string[] = ['plan_id,carrier,state,plan_name,food_card_amount,frequency,notes'];
  for (const p of gap) {
    lines.push([
      csvEscape(p.cp),
      csvEscape(p.carrier),
      csvEscape(p.state),
      csvEscape(p.plan_name),
      '', // food_card_amount
      '', // frequency (monthly / quarterly / annual)
      '', // notes
    ].join(','));
  }
  const body = lines.join('\n') + '\n';

  const path1 = resolve(process.cwd(), '../../Code/plan-match/_tmp/dsnp-food-card-manual-template.csv');
  const path2 = resolve(os.homedir(), 'Desktop/dsnp-food-card-manual-template.csv');
  writeFileSync(path1, body);
  writeFileSync(path2, body);

  console.log(`\nWrote ${gap.length} gap plans to:`);
  console.log(`  ${path1}`);
  console.log(`  ${path2}`);

  // 6. Summary breakdown
  const byState = new Map<string, Map<string, number>>();
  for (const p of gap) {
    if (!byState.has(p.state)) byState.set(p.state, new Map());
    const m = byState.get(p.state)!;
    m.set(p.carrier, (m.get(p.carrier) ?? 0) + 1);
  }
  console.log(`\nBreakdown:`);
  for (const [s, m] of [...byState.entries()].sort()) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    console.log(`  ${s}: ${total} plans`);
    for (const [c, n] of [...m.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${n.toString().padStart(3)}  ${c}`);
    }
  }
})();
