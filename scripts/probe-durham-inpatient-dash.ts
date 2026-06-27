// scripts/probe-durham-inpatient-dash.ts — find every Durham MA plan
// whose pm_plan_benefits 'inpatient' row would render as "—" on the
// agent's Compare screen.
//
// formatInpatientLadder returns null (rendered as "—") when:
//   1. The inpatient row is missing entirely, OR
//   2. The row's description doesn't match either regex AND copay is
//      null AND coinsurance is null.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const url = process.env.SUPABASE_URL ?? '';
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  '';
if (!url || !key) {
  console.error('Missing env');
  process.exit(1);
}

const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const RANGE_FIRST = /Days?\s+(\d+)\s*[–-]\s*(\d+)\s*:\s*\$\s*(\d+(?:\.\d+)?)\s*\/\s*day/i;
const AMOUNT_FIRST = /\$\s*(\d+(?:\.\d+)?)\s*\/\s*day\s*\(\s*days?\s+(\d+)\s*[–-]\s*(\d+)\s*\)/i;

async function main() {
  // Distinct Durham MA plans
  const { data: planRows } = await sb
    .from('pm_plans')
    .select('contract_id, plan_id, segment_id, plan_name, carrier, plan_type')
    .eq('state', 'NC')
    .eq('county_name', 'Durham');
  const seen = new Set<string>();
  const plans = (planRows ?? []).filter((p) => {
    if (p.plan_type === 'PDP') return false;
    const k = `${p.contract_id}-${p.plan_id}-${p.segment_id ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log(`Durham MA plans (deduped): ${plans.length}`);

  // For each, look up its inpatient pm_plan_benefits row
  const culprits: Array<{
    contract: string;
    plan: string;
    name: string;
    carrier: string;
    reason: string;
    desc: string | null;
    copay: number | null;
    coins: number | null;
  }> = [];

  const formatPreview: Array<{
    contract: string;
    plan: string;
    carrier: string;
    desc: string;
    matchesRegex: boolean;
    copay: number | null;
    coins: number | null;
  }> = [];

  for (const p of plans) {
    const { data: rows } = await sb
      .from('pm_plan_benefits')
      .select('benefit_description, copay, coinsurance')
      .eq('contract_id', p.contract_id)
      .eq('plan_id', p.plan_id)
      .eq('benefit_category', 'inpatient');
    const r = rows?.[0];
    if (!r) {
      culprits.push({
        contract: p.contract_id,
        plan: p.plan_id,
        name: p.plan_name ?? '',
        carrier: p.carrier ?? '',
        reason: 'NO INPATIENT ROW',
        desc: null,
        copay: null,
        coins: null,
      });
      continue;
    }
    const desc = (r.benefit_description as string | null) ?? null;
    const copay = (r.copay as number | null) ?? null;
    const coins = (r.coinsurance as number | null) ?? null;
    const matchesRegex = !!desc && (RANGE_FIRST.test(desc) || AMOUNT_FIRST.test(desc));
    if (!matchesRegex && copay == null && coins == null) {
      culprits.push({
        contract: p.contract_id,
        plan: p.plan_id,
        name: p.plan_name ?? '',
        carrier: p.carrier ?? '',
        reason: 'desc unparseable + copay null + coins null',
        desc,
        copay,
        coins,
      });
    } else if (!matchesRegex && desc) {
      // The description doesn't parse but copay or coinsurance saves
      // the render. Useful to know if we should widen the regex.
      formatPreview.push({
        contract: p.contract_id,
        plan: p.plan_id,
        carrier: p.carrier ?? '',
        desc,
        matchesRegex,
        copay,
        coins,
      });
    }
  }

  console.log('\n=== PLANS THAT WOULD RENDER "—" ===');
  console.table(culprits);

  console.log('\n=== UNPARSEABLE DESCRIPTIONS (would fall back to $X/day or coins%) ===');
  const dedupedDescs = new Map<string, number>();
  for (const f of formatPreview) {
    dedupedDescs.set(f.desc, (dedupedDescs.get(f.desc) ?? 0) + 1);
  }
  console.log('Unique unparseable descriptions (count):');
  for (const [d, c] of [...dedupedDescs.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c}× : ${d}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
