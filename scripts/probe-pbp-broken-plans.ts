// scripts/probe-pbp-broken-plans.ts — dump every pbp_benefits row
// whose benefit_type maps to category='inpatient' for the still-null
// plans, so we can see why my fix doesn't catch them.

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
  const targets = [
    ['H6351', '004'],
    ['H4676', '001'],
    ['H9725', '015'],
    ['H3146', '006'], // control (works after fix)
  ];

  for (const [c, p] of targets) {
    console.log(`\n=== ${c}-${p} ===`);
    // ALL pbp rows (every key variant) that could map to inpatient
    const { data } = await sb
      .from('pbp_benefits')
      .select('plan_id, benefit_type, copay, copay_max, coinsurance, tier_id, description, source')
      .or(`plan_id.eq.${c}-${p},plan_id.eq.${c}-${p}-0,plan_id.eq.${c}-${p}-000`)
      .in('source', ['medicare_gov', 'sb_ocr', 'cms_pbp', 'manual'])
      .in('benefit_type', ['inpatient_hospital', 'inpatient_acute', 'inpatient_psych']);
    for (const r of data ?? []) {
      console.log(`  ${JSON.stringify(r)}`);
    }
    if (!data?.length) console.log('  (no rows)');
  }

  console.log('\n\n=== Reproduce the bestByKey winner ===');
  // For each, simulate bestByKey: pick row with highest sourceRank per
  // (plan_id, benefit_type, tier_id). Then call my fix's predicate.
  const SOURCE_PRIORITY: Record<string, number> = {
    medicare_gov: 5, sb_ocr: 4, cms_pbp: 3, manual: 2, pbp_federal: 1,
  };
  for (const [c, p] of targets) {
    const { data } = await sb
      .from('pbp_benefits')
      .select('plan_id, benefit_type, copay, copay_max, coinsurance, tier_id, description, source')
      .or(`plan_id.eq.${c}-${p},plan_id.eq.${c}-${p}-0,plan_id.eq.${c}-${p}-000`)
      .in('source', ['medicare_gov', 'sb_ocr', 'cms_pbp', 'manual'])
      .in('benefit_type', ['inpatient_hospital']);
    const best = new Map<string, Record<string, unknown>>();
    for (const r of data ?? []) {
      const k = `${r.plan_id}|${r.benefit_type}|${r.tier_id ?? 0}`;
      const cur = best.get(k);
      const curRank = cur ? SOURCE_PRIORITY[cur.source as string] ?? 0 : -1;
      const newRank = SOURCE_PRIORITY[(r as Record<string, unknown>).source as string] ?? 0;
      if (!cur || newRank > curRank) best.set(k, r);
    }
    console.log(`\n${c}-${p}: bestByKey for inpatient_hospital — ${best.size} winners`);
    for (const w of best.values()) {
      const copayNull = w.copay == null;
      const copayMaxNull = w.copay_max == null;
      const coinsNull = w.coinsurance == null;
      const descBlank = w.description == null || (w.description as string).trim() === '';
      const skipped = copayNull && copayMaxNull && coinsNull && descBlank;
      console.log(`  winner: ${JSON.stringify(w)}`);
      console.log(`    my-fix skips this? ${skipped}`);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
