// Fix 2 — insert Clear Spring GA plans into pm_non_commissionable_contracts.
//
// Phase 1 finding: H6672-005 and H9589-003 appear in Fulton pool with
// sanctioned=false. Mission owner has decided the fix is to add them
// to the non-commissionable filter (not the sanctioned flag), so they
// drop out of the compare pool without touching pm_plans.sanctioned.
//
// Actual table = pm_non_commissionable_contracts. Columns:
//   contract_id (text), plan_number (text, NULL = whole-contract),
//   carrier (text), notes (text)
// The user-spec SQL referenced pm_non_commissionable (contract_id,
// plan_id, level, reason) — those columns don't exist here.
//
// Idempotent: SELECTs first, only INSERTs missing rows.
//
// Run: npx tsx scripts/_fix2-add-clear-spring-noncomm.ts

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const url = process.env.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (write requires service role)');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const ROWS = [
  { contract_id: 'H6672', plan_number: '005', carrier: 'Clear Spring Health', notes: 'CMS sanctioned (Phase 1 smoke test)' },
  { contract_id: 'H9589', plan_number: '003', carrier: 'Clear Spring Health', notes: 'CMS sanctioned (Phase 1 smoke test)' },
];

async function main() {
  console.log(`Target: ${url.replace(/https:\/\//, '').split('.')[0]}.pm_non_commissionable_contracts`);
  const { data: existing, error: selErr } = await sb
    .from('pm_non_commissionable_contracts')
    .select('contract_id, plan_number, carrier, notes')
    .in('contract_id', ROWS.map((r) => r.contract_id));
  if (selErr) { console.error('SELECT failed:', selErr); process.exit(1); }
  const existingKeys = new Set((existing ?? []).map((r) => `${r.contract_id}-${r.plan_number ?? '(all)'}`));
  console.log(`Existing rows for these contracts: ${existing?.length ?? 0}`);
  (existing ?? []).forEach((r) => console.log(`   ${r.contract_id}-${r.plan_number ?? '(all)'}  ${r.carrier}  ${r.notes}`));

  const toInsert = ROWS.filter((r) => !existingKeys.has(`${r.contract_id}-${r.plan_number}`));
  if (toInsert.length === 0) {
    console.log('\nAll target rows already present. No-op.');
    return;
  }

  console.log(`\nInserting ${toInsert.length} row(s):`);
  toInsert.forEach((r) => console.log(`   ${r.contract_id}-${r.plan_number}  ${r.carrier}`));
  const { data: ins, error: insErr } = await sb
    .from('pm_non_commissionable_contracts')
    .insert(toInsert)
    .select();
  if (insErr) { console.error('INSERT failed:', insErr); process.exit(1); }
  console.log(`\nInserted ${ins?.length ?? 0} row(s). Post-insert readback:`);

  const { data: after } = await sb
    .from('pm_non_commissionable_contracts')
    .select('contract_id, plan_number, carrier, notes')
    .in('contract_id', ROWS.map((r) => r.contract_id));
  (after ?? []).forEach((r) => console.log(`   ${r.contract_id}-${r.plan_number ?? '(all)'}  ${r.carrier}  ${r.notes}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
