#!/usr/bin/env tsx
// Probe: what formulary tables + pbp rx-tier rows exist.

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
  console.log('=== pm_formulary_v2 (H1036-335, first 3 rows) ===');
  const f1 = await sb
    .from('pm_formulary_v2')
    .select('*')
    .eq('contract_id', 'H1036')
    .eq('plan_id', '335')
    .limit(3);
  console.log(f1.data);

  console.log('\n=== pm_formulary_v2 for Eliquis (H1036-335) ===');
  const f2 = await sb
    .from('pm_formulary_v2')
    .select('*')
    .eq('contract_id', 'H1036')
    .eq('plan_id', '335')
    .in('rxcui', ['1364430', '1364443']) // Eliquis 5mg rxcuis
    .limit(3);
  console.log(f2.data);

  console.log('\n=== pbp_benefits_v2 rx_tier rows (H9808-010) ===');
  const t = await sb
    .from('pbp_benefits_v2')
    .select('segment_id, benefit_type, tier_id, copay, copay_max, coinsurance, description, source')
    .eq('contract_id', 'H9808')
    .eq('plan_id', '010')
    .like('benefit_type', 'rx_tier%');
  console.log(t.data);

  console.log('\n=== pm_plan_benefits rx_tier rows (H9808-010) ===');
  const t2 = await sb
    .from('pm_plan_benefits')
    .select('segment_id, benefit_category, copay, coinsurance, max_coverage, benefit_description')
    .eq('contract_id', 'H9808')
    .eq('plan_id', '010')
    .like('benefit_category', 'rx_tier%');
  console.log(t2.data);

  // List all tables (via information_schema won't work in supabase directly)
  // Try known landing table names
  console.log('\n=== SPUF landing tables (check existence) ===');
  for (const t of ['cms_spuf_formulary', 'spuf_formulary', 'formulary_raw', 'pm_formulary_raw', 'cms_formulary_landing']) {
    const q = await sb.from(t).select('*', { count: 'exact', head: true });
    console.log(`  ${t}: ${q.error ? `error: ${q.error.message}` : `count=${q.count}`}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
