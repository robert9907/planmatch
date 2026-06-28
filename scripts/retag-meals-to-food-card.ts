// Re-tag pbp_federal/meals rows (SSBCI fd / food-produce origin) to
// benefit_type='food_card'. See probe-meals-retag.ts for the safety
// analysis that justifies this filter.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const env: Record<string, string> = {};
for (const l of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  if (!l || l.startsWith('#') || !l.includes('=')) continue;
  const i = l.indexOf('=');
  let v = l.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[l.slice(0, i).trim()] = v;
}
const sb = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

(async () => {
  // Snapshot count before
  const { count: before } = await sb.from('pbp_benefits_v2').select('*', { count: 'exact', head: true })
    .eq('source', 'pbp_federal').eq('benefit_type', 'meals');
  console.log(`Before: ${before ?? 0} rows with source=pbp_federal AND benefit_type=meals`);

  const { data, error } = await sb
    .from('pbp_benefits_v2')
    .update({ benefit_type: 'food_card' })
    .eq('source', 'pbp_federal')
    .eq('benefit_type', 'meals')
    .select('contract_id, plan_id, segment_id, copay_max, description');
  if (error) {
    console.error(`UPDATE failed: ${error.message}`);
    process.exit(1);
  }
  console.log(`UPDATE succeeded. Rows changed: ${data?.length ?? 0}`);

  // Snapshot count after
  const { count: afterMeals } = await sb.from('pbp_benefits_v2').select('*', { count: 'exact', head: true })
    .eq('source', 'pbp_federal').eq('benefit_type', 'meals');
  const { count: afterFood } = await sb.from('pbp_benefits_v2').select('*', { count: 'exact', head: true })
    .eq('source', 'pbp_federal').eq('benefit_type', 'food_card');
  console.log(`\nAfter:`);
  console.log(`  source=pbp_federal AND benefit_type=meals:     ${afterMeals ?? 0}  (should be 0)`);
  console.log(`  source=pbp_federal AND benefit_type=food_card: ${afterFood ?? 0}  (should be 228)`);

  // Sample $-bearing rows that just got re-tagged
  const withDollar = (data ?? []).filter((r: any) => r.copay_max != null && r.copay_max > 0);
  console.log(`\nOf the re-tagged rows, ${withDollar.length} carry a real \$ ceiling. First 8:`);
  for (const r of withDollar.slice(0, 8)) console.log(`  ${r.contract_id}-${r.plan_id}-${r.segment_id}  \$${r.copay_max}/yr  "${r.description}"`);
})();
