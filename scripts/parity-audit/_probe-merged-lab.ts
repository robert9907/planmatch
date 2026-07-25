#!/usr/bin/env tsx
// Trace exactly what merged rows pm-snapshot sees for H9808-009 'lab' category
// after all filtering (source allowlist + dedup + transform).

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
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function main() {
  const contract = 'H9808';
  const plan = '009';

  console.log('=== pbp_benefits_v2 source column check ===');
  const pbp = await sb
    .from('pbp_benefits_v2')
    .select('segment_id, benefit_type, copay, description, source')
    .eq('contract_id', contract)
    .eq('plan_id', plan)
    .in('benefit_type', ['lab', 'lab_diagnostic', 'specialist_visit', 'imaging', 'diagnostic_radiology']);
  console.log(pbp.data);

  console.log('\n=== pm-snapshot-style filter (source in allowlist) ===');
  const pbpFiltered = await sb
    .from('pbp_benefits_v2')
    .select('segment_id, benefit_type, copay, description, source, tier_id')
    .eq('contract_id', contract)
    .eq('plan_id', plan)
    .in('source', ['medicare_gov', 'sb_ocr', 'cms_pbp', 'manual'])
    .in('benefit_type', ['lab', 'lab_diagnostic', 'specialist_visit', 'imaging', 'diagnostic_radiology']);
  console.log(pbpFiltered.data);
}

main().catch((e) => { console.error(e); process.exit(1); });
