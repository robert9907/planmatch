// scripts/probe-noncomm-h3146.ts — is H3146 (Aetna) flagged
// non-commissionable for Rob (NPN 10447418)?

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

async function main() {
  console.log('=== H3146 entries in pm_non_commissionable_contracts ===');
  const { data: h3146 } = await sb
    .from('pm_non_commissionable_contracts')
    .select('*')
    .eq('contract_id', 'H3146');
  console.table(h3146 ?? []);

  console.log('\n=== Plan-level entries for H3146 (the kill switch) ===');
  for (const r of h3146 ?? []) {
    const planNum = (r as Record<string, unknown>).plan_number;
    console.log(`  contract=H3146 plan_number=${JSON.stringify(planNum)}`);
  }

  console.log('\n=== Is H3146-006 specifically in the kill list? ===');
  const hit = (h3146 ?? []).find((r) => {
    const pn = (r as Record<string, unknown>).plan_number;
    return pn === '006';
  });
  console.log(hit ? `YES → ${JSON.stringify(hit)}` : 'no exact match for plan_number=006');

  console.log('\n=== Whole-contract block (plan_number IS NULL)? ===');
  const wholeContract = (h3146 ?? []).find((r) => {
    const pn = (r as Record<string, unknown>).plan_number;
    return pn == null;
  });
  console.log(wholeContract ? `YES, entire H3146 contract blocked → ${JSON.stringify(wholeContract)}` : 'no whole-contract block');

  // Also check the schema
  console.log('\n=== pm_non_commissionable_contracts columns ===');
  const { data: cols } = await sb.from('pm_non_commissionable_contracts').select('*').limit(1);
  if (cols?.[0]) console.log(Object.keys(cols[0]));
}

main().catch((err) => { console.error(err); process.exit(1); });
