// scripts/probe-aetna-h3146-006-raw.ts — confirm the raw inpatient
// row for Aetna H3146-006 plan Durham, no ilike filter so we can see
// exactly what's stored.

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
const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  // ALL rows for H3146 plan 006 — no category filter at all
  const { data, error } = await sb
    .from('pm_plan_benefits')
    .select('*')
    .eq('contract_id', 'H3146')
    .eq('plan_id', '006');
  if (error) { console.error(error); process.exit(1); }
  console.log(`Total rows for H3146-006: ${data?.length ?? 0}`);

  // Print every row whose category contains "inpat" in JS
  const inpRows = (data ?? []).filter((r) => {
    const c = (r as Record<string, unknown>).benefit_category as string;
    return typeof c === 'string' && /inpat/i.test(c);
  });
  console.log(`\nRows with category matching /inpat/i (JS-side filter): ${inpRows.length}`);
  for (const r of inpRows) {
    console.log(JSON.stringify(r, null, 2));
  }

  // Also: dump every category for this plan (no dedupe so we can count)
  console.log('\nAll categories on H3146-006:');
  const counts = new Map<string, number>();
  for (const r of data ?? []) {
    const c = (r as Record<string, unknown>).benefit_category as string;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  for (const [c, n] of [...counts.entries()].sort()) {
    console.log(`  ${n}× ${JSON.stringify(c)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
