// Quick probe — does pm_drugs return rows for the drugs that show
// "No RxNorm match" on clientId=188? Run via:
//   npx tsx scripts/probe-pm-drugs-hits.ts
//
// One-shot diagnostic, safe to delete after.

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
  process.env.SUPABASE_SECRET_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  '';

if (!url || !key) {
  console.error('missing SUPABASE_URL / SUPABASE_*_KEY in .env.local');
  process.exit(1);
}

const ref = url.match(/https:\/\/([^.]+)/)?.[1] ?? 'unknown';
console.log(`Supabase project: ${ref}`);
console.log(`  (expecting rpcbrkmvalvdmroqzpaq for plan-match-prod)\n`);

const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const drugs = [
  'synthroid',
  'losartan',
  'simvastatin',
  'oxybutynin',
  'metoprolol',
  'venlafaxine',
  'rivaroxaban',
];

(async () => {
  for (const d of drugs) {
    const { data, error } = await sb
      .from('pm_drugs')
      .select('rxcui, name, generic_name, brand_name, is_prescribable')
      .ilike('search_text', `%${d}%`)
      .limit(3);
    if (error) {
      console.log(`${d.padEnd(14)} → ERROR: ${error.message}`);
      continue;
    }
    const rows = data ?? [];
    const sample = rows
      .map((r) => `${r.rxcui} ${r.brand_name || r.generic_name || r.name}`)
      .join(' | ');
    console.log(
      `${d.padEnd(14)} → ${String(rows.length).padStart(3)} hits  ${sample}`,
    );
  }

  // Also probe is_prescribable filter alone (the useResolveRxcuis path).
  console.log('\nWith is_prescribable=true filter:');
  for (const d of drugs) {
    const { data, error } = await sb
      .from('pm_drugs')
      .select('rxcui, name')
      .ilike('search_text', `%${d}%`)
      .eq('is_prescribable', true)
      .limit(1);
    if (error) {
      console.log(`${d.padEnd(14)} → ERROR: ${error.message}`);
      continue;
    }
    console.log(
      `${d.padEnd(14)} → ${(data?.length ?? 0) > 0 ? '✓' : '✗ no prescribable rows'}`,
    );
  }
})();
