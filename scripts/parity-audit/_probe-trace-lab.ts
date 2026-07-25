#!/usr/bin/env tsx
// Mimic pm-snapshot's fetchBenefitsByTriple + fetchPbpFallback for
// H9808-009-000 and print the merged rows for benefit_category='lab'.

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

const PBP_TYPE_TO_CATEGORY: Record<string, string> = {
  lab_diagnostic: 'lab',
  imaging: 'advanced_imaging',
  specialist_visit: 'specialist',
  primary_care_visit: 'primary_care',
  emergency_room: 'emergency',
  urgent_care: 'urgent_care',
};

async function main() {
  const contract = 'H9808';
  const plan = '009';

  console.log('--- landscape (pm_plan_benefits, ALL rows) ---');
  const land = await sb
    .from('pm_plan_benefits')
    .select('*')
    .eq('contract_id', contract)
    .eq('plan_id', plan);
  const landLab = (land.data ?? []).filter((r: {benefit_category?: string}) => r.benefit_category === 'lab');
  const landXray = (land.data ?? []).filter((r: {benefit_category?: string}) => r.benefit_category === 'xray');
  console.log(`  ${(land.data ?? []).length} total rows`);
  console.log(`  lab rows:`, JSON.stringify(landLab));
  console.log(`  xray rows:`, JSON.stringify(landXray));

  console.log('\n--- pbp (with source-priority dedup) ---');
  const pbp = await sb
    .from('pbp_benefits_v2')
    .select('contract_id, plan_id, segment_id, benefit_type, copay, copay_max, coinsurance, tier_id, description, source')
    .eq('contract_id', contract)
    .eq('plan_id', plan)
    .in('source', ['medicare_gov', 'sb_ocr', 'cms_pbp', 'manual']);

  const SOURCE_RANK: Record<string, number> = { medicare_gov: 5, sb_ocr: 4, cms_pbp: 3, manual: 2 };
  const best = new Map<string, unknown>();
  for (const r of pbp.data ?? []) {
    const rr = r as Record<string, unknown>;
    const seg = String(rr.segment_id ?? '0').padStart(3, '0');
    const key = `${rr.contract_id}-${rr.plan_id}-${seg}|${rr.benefit_type}|${rr.tier_id ?? ''}`;
    const prior = best.get(key) as Record<string, unknown> | undefined;
    const rank = SOURCE_RANK[String(rr.source)] ?? 0;
    const priorRank = prior ? (SOURCE_RANK[String(prior.source)] ?? 0) : -1;
    if (!prior || rank > priorRank) best.set(key, r);
  }
  const transformed = [...best.values()]
    .filter((r) => {
      const rr = r as Record<string, unknown>;
      return PBP_TYPE_TO_CATEGORY[String(rr.benefit_type)];
    })
    .map((r) => {
      const rr = r as Record<string, unknown>;
      return {
        benefit_category: PBP_TYPE_TO_CATEGORY[String(rr.benefit_type)],
        benefit_type_source: rr.benefit_type,
        copay: rr.copay,
        description: rr.description,
        source: rr.source,
      };
    });
  const pbpLab = transformed.filter((r) => r.benefit_category === 'lab');
  const pbpAdvImg = transformed.filter((r) => r.benefit_category === 'advanced_imaging');
  console.log(`  transformed pbp 'lab' rows:`, JSON.stringify(pbpLab, null, 2));
  console.log(`  transformed pbp 'advanced_imaging' rows:`, JSON.stringify(pbpAdvImg, null, 2));

  console.log('\n--- merged lab (my new [...landscape, ...pbp]) ---');
  const merged = [...landLab, ...pbpLab];
  console.log(JSON.stringify(merged, null, 2));

  // Simulate pickBestRow scoring
  console.log('\n--- pickBestRow simulation on merged lab rows ---');
  for (const r of merged) {
    const rr = r as Record<string, unknown>;
    const copay = rr.copay != null ? Number(rr.copay) : null;
    const coins = rr.coinsurance != null ? Number(rr.coinsurance) : null;
    const desc = rr.description ?? rr.benefit_description;
    const hasReal = (copay ?? 0) > 0 || (coins ?? 0) > 0;
    const hasDesc = !!desc && String(desc).trim().length > 0;
    const score = (hasDesc ? 2 : 0) + (hasReal ? 1 : 0);
    console.log(`  score=${score} copay=${copay} desc=${JSON.stringify(desc)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
