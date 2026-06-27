// scripts/probe-zip-county.ts — verify pm_zip_county serves Durham
// 27713 + adjacent NC ZIPs. Bug 2 from Rob: "ZIP 27713 shows county
// as '—'" on the agent-v3 Client screen.

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
  console.error('Missing SUPABASE_URL / SERVICE_ROLE_KEY|ANON_KEY');
  process.exit(1);
}

const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ZIPS = ['27713', '27707', '27517', '27278', '27514'];

async function main() {
  console.log('=== pm_zip_county probe ===');
  for (const zip of ZIPS) {
    const { data, error } = await sb
      .from('pm_zip_county')
      .select('zip, county, state')
      .eq('zip', zip)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.log(`[${zip}] ERROR:`, error.message);
      continue;
    }
    if (!data) {
      console.log(`[${zip}] MISSING — no row in pm_zip_county`);
      continue;
    }
    console.log(`[${zip}] ${data.county}, ${data.state}`);
  }
  const { count: total, error: cntErr } = await sb
    .from('pm_zip_county')
    .select('*', { count: 'exact', head: true });
  if (cntErr) {
    console.log('[count] ERROR:', cntErr.message);
  } else {
    console.log(`[count] total rows in pm_zip_county: ${total}`);
  }
  // What does the table look like for Durham specifically?
  const { data: durham, error: durErr } = await sb
    .from('pm_zip_county')
    .select('zip')
    .eq('county', 'Durham')
    .eq('state', 'NC')
    .order('zip');
  if (durErr) {
    console.log('[durham] ERROR:', durErr.message);
  } else {
    console.log(
      `[durham] ${durham?.length ?? 0} Durham NC zips: ${(durham ?? []).map(r => r.zip).join(', ')}`,
    );
  }
}

main().then(() => process.exit(0));
