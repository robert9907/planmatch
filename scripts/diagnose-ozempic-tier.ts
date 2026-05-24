// Diagnose Ozempic-as-Tier-1: for every Durham plan, query pm_formulary
// for the full Ozempic RxCUI family and report which (plan, rxcui)
// combinations return Tier 1, 2, 3, 4, 5. Truncation-safe via the
// paginated fetchAllRows pattern.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const sb = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// Ozempic RxCUI family from probe-ozempic-formulary.ts (anchor +
// expansion via RxNav SCD/SBD/GPCK/BPCK/IN). 2398842 is the seed's
// primary; the others are sibling strengths + the ingredient + the
// upcoming oral tablet forms.
const OZEMPIC_RXCUIS = [
  '1991297', // IN/SCD semaglutide variant
  '1991302', // IN semaglutide
  '1991306', // SCD semaglutide pen 1.34 MG/ML
  '1991311', // SBD 0.25/0.5 MG Dose 1.5 ML Ozempic
  '2398842', // SBD 3 ML semaglutide 1.34 MG/ML Pen Injector [Ozempic]  ← agent seed
  '2599365', // SBD 3 ML semaglutide 2.68 MG/ML Pen Injector [Ozempic]
  '2619154', // SBD 0.25/0.5 MG Dose 3 ML 0.68 MG/ML Ozempic
  '2736944', // SBD semaglutide 1.5 MG Oral Tablet [Ozempic]
  '2736946', // SBD semaglutide 4 MG Oral Tablet [Ozempic]
  '2736948', // SBD semaglutide 9 MG Oral Tablet [Ozempic]
];

async function main() {
  // 1. Total pm_formulary rows across the Ozempic family (paginated)
  const PAGE = 1000;
  let total = 0;
  const tierCounts: Record<string, number> = {};
  for (let offset = 0; offset < 20000; offset += PAGE) {
    const { data, error } = await sb
      .from('pm_formulary')
      .select('tier', { count: 'exact' })
      .in('rxcui', OZEMPIC_RXCUIS)
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    total += data.length;
    for (const r of data) {
      const t = String(r.tier ?? 'null');
      tierCounts[t] = (tierCounts[t] ?? 0) + 1;
    }
    if (data.length < PAGE) break;
  }
  console.log(`Total Ozempic-family rows in pm_formulary: ${total}`);
  console.log('Tier distribution:');
  for (const [tier, n] of Object.entries(tierCounts).sort()) {
    console.log(`  Tier ${tier}: ${n}`);
  }

  // 2. Any Tier 1 / Tier 2 rows? Show the carriers.
  const { data: lowTier } = await sb
    .from('pm_formulary')
    .select('rxcui, contract_id, plan_id, tier, copay, coinsurance')
    .in('rxcui', OZEMPIC_RXCUIS)
    .in('tier', [1, 2])
    .limit(50);
  console.log(`\nTier 1 or 2 rows (any contract/plan): ${lowTier?.length ?? 0}`);
  console.table(lowTier ?? []);

  // 3. For 5 Durham plans we previously audited, what tier does Ozempic
  // resolve to?
  const DURHAM_TARGETS = [
    { name: 'Wellcare Simple HMO-POS', contract: 'H4073', plan: '001' },
    { name: 'UHC AARP NC-0007', contract: 'H5253', plan: '039' },
    { name: 'BCBS Blue Medicare Freedom+', contract: 'H3404', plan: '004' },
    { name: 'Aetna Eagle Giveback', contract: 'H5521', plan: '241' },
    { name: 'Humana Gold Plus H1036-335', contract: 'H1036', plan: '335' },
  ];
  console.log('\n=== Per-plan Ozempic tier ===');
  for (const t of DURHAM_TARGETS) {
    const { data } = await sb
      .from('pm_formulary')
      .select('rxcui, tier, copay, coinsurance, prior_auth, step_therapy')
      .eq('contract_id', t.contract)
      .eq('plan_id', t.plan)
      .in('rxcui', OZEMPIC_RXCUIS);
    console.log(`\n${t.name} (${t.contract}-${t.plan}) — ${data?.length ?? 0} rows:`);
    console.table(data ?? []);
  }
}

main().catch(console.error);
