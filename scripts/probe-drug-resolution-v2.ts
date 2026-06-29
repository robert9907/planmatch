// Deeper probe — count pm_formulary rows per pramipexole rxcui, check
// pm_drug_ndc seed for the resolved rxcui, and run the full fallback
// path locally.

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
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/ANON_KEY');
  process.exit(1);
}

const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function rowsByRxcui(rxcui: string): Promise<number> {
  const { count, error } = await sb
    .from('pm_formulary')
    .select('*', { count: 'exact', head: true })
    .eq('rxcui', rxcui);
  if (error) throw error;
  return count ?? 0;
}

async function pmDrugNdcByRxcui(rxcui: string): Promise<unknown[]> {
  const { data, error } = await sb
    .from('pm_drug_ndc')
    .select('rxcui,drug_name')
    .eq('rxcui', rxcui)
    .limit(3);
  if (error) throw error;
  return data ?? [];
}

async function main() {
  // ── Pramipexole — count pm_formulary rows per rxcui ─────────────────
  console.log('Pramipexole pm_formulary row counts per rxcui:');
  const pramRxcuis = [
    { rx: '859033', s: '0.125 MG' },
    { rx: '859040', s: '0.25 MG' },
    { rx: '859044', s: '0.5 MG' },
    { rx: '858625', s: '0.75 MG' },
    { rx: '859052', s: '1 MG' },
    { rx: '859048', s: '1.5 MG' },
    // Mirapex SBDs
    { rx: '859035', s: '0.125 MG [Mirapex]' },
    { rx: '859042', s: '0.25 MG [Mirapex]' },
    { rx: '859046', s: '0.5 MG [Mirapex]' },
    { rx: '858627', s: '0.75 MG [Mirapex]' },
    { rx: '859050', s: '1.5 MG [Mirapex]' },
  ];
  for (const { rx, s } of pramRxcuis) {
    const ndc = await pmDrugNdcByRxcui(rx);
    const fm = await rowsByRxcui(rx);
    console.log(
      `  rxcui=${rx} (${s})  pm_formulary rows: ${fm}  pm_drug_ndc rows: ${ndc.length}`,
    );
  }

  // ── What is pm_formulary.drug_name for 859052? ──────────────────────
  const { data: fm859052 } = await sb
    .from('pm_formulary')
    .select('contract_id,plan_id,rxcui,drug_name,tier,copay')
    .eq('rxcui', '859052')
    .limit(5);
  console.log('\nSample pm_formulary rows for rxcui 859052 (1 MG):');
  for (const r of fm859052 ?? []) console.log(' ', JSON.stringify(r));

  // ── Now Fluoxetine ──────────────────────────────────────────────────
  console.log('\nFluoxetine pm_formulary row counts per rxcui:');
  const fluRxcuis = [
    { rx: '310384', s: '10 MG Capsule' },
    { rx: '310385', s: '20 MG Capsule' },
    { rx: '313989', s: '40 MG Capsule' },
    { rx: '261287', s: '40 MG Capsule [Prozac]' },
    { rx: '313990', s: '10 MG Tablet' },
    { rx: '248642', s: '20 MG Tablet' },
    { rx: '1190110', s: '60 MG Tablet' },
  ];
  for (const { rx, s } of fluRxcuis) {
    const fm = await rowsByRxcui(rx);
    console.log(`  rxcui=${rx} (${s})  pm_formulary rows: ${fm}`);
  }

  // Sample rows for 313989
  const { data: fm313989 } = await sb
    .from('pm_formulary')
    .select('contract_id,plan_id,rxcui,drug_name,tier,copay')
    .eq('rxcui', '313989')
    .limit(5);
  console.log('\nSample pm_formulary rows for rxcui 313989 (Fluoxetine 40 MG Cap):');
  for (const r of fm313989 ?? []) console.log(' ', JSON.stringify(r));

  // ── Check pm_formulary distribution by tier for 859052 ─────────────
  const { data: fmDist } = await sb
    .from('pm_formulary')
    .select('tier')
    .eq('rxcui', '859052');
  const tierCounts: Record<string, number> = {};
  for (const r of (fmDist ?? []) as Array<{ tier: number | null }>) {
    const k = r.tier == null ? 'null' : String(r.tier);
    tierCounts[k] = (tierCounts[k] ?? 0) + 1;
  }
  console.log('\n859052 tier distribution:', tierCounts);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
