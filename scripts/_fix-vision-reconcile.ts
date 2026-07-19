// Vision brute-force fix. Reads _tmp/parity-data/_vision-reconcile.json
// mismatches and applies the appropriate fix per plan.
//
// Fix strategy — force landscape (pm_plan_benefits.vision) to win the
// merge with the CMS-truth value:
//   - If pm.vision row exists: UPDATE coverage_amount = CMS (landCov
//     non-null blocks synth in ALLOWANCE_CATEGORIES branch, so agent
//     sees pm's value).
//   - If pm.vision row missing: INSERT one.
//   - Also INSERT pbp_benefits_v2.vision_allowance if missing (belt +
//     suspenders — makes the row visible to consumer plans-with-extras
//     too, and covers any future pm import that clears pm.coverage_
//     amount).
//
// This approach is robust to biennial descriptions on pbp — landscape
// wins first, so biennial-halving is bypassed.
//
// Idempotent, --write guarded.
// Run: npx tsx scripts/_fix-vision-reconcile.ts           (dry-run)
//      npx tsx scripts/_fix-vision-reconcile.ts --write

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const WRITE = process.argv.includes('--write');

interface Mismatch {
  contract_id: string; plan_id: string; segment: string;
  plan_name: string; carrier: string; slice: string;
  cmsMax: number; agent: { eyewear: number; pmCov: number | null; pmMax: number | null; pbpCopay: number | null };
  fixNote: string;
}

async function main() {
  const mode = WRITE ? 'WRITE' : 'DRY-RUN';
  console.log(`Vision brute-force fix (${mode})`);
  console.log('─'.repeat(70));

  const rec = JSON.parse(readFileSync('_tmp/parity-data/_vision-reconcile.json', 'utf8'));
  const mismatches: Mismatch[] = rec.mismatches;
  console.log(`Reconciliation mismatches: ${mismatches.length}`);

  // Skip plans with known per-segment CMS divergence (confirmed by
  // checking multiple detail files). Bulk update would corrupt the
  // other segment. Manual review needed.
  const MULTI_SEGMENT_SKIP = new Set(['H8849-011']);
  let pmUpdated = 0, pmInserted = 0, pbpInserted = 0, skipped = 0;
  for (const m of mismatches) {
    const c = m.contract_id, p = m.plan_id;
    if (MULTI_SEGMENT_SKIP.has(`${c}-${p}`)) {
      console.log(`  SKIP ${c}-${p} (per-segment CMS values differ — needs manual per-segment fix)`);
      skipped++;
      continue;
    }
    const cms = m.cmsMax;

    // 1. Ensure pm_plan_benefits.vision.max_coverage = cms AND
    //    coverage_amount = cms. api/plans.ts:1441-1445 buildBenefits
    //    reads `max_coverage ?? coverage_amount` — max_coverage wins.
    //    A stale max_coverage will shadow a fresh coverage_amount.
    //    Update both columns to keep them in sync and force the
    //    correct value.
    const { data: pmRows } = await sb.from('pm_plan_benefits')
      .select('id, coverage_amount, max_coverage')
      .eq('benefit_category', 'vision').eq('contract_id', c).eq('plan_id', p);
    if (pmRows && pmRows.length > 0) {
      const needsUpdate = pmRows.some((r: any) => r.coverage_amount !== cms || r.max_coverage !== cms);
      if (needsUpdate) {
        if (!WRITE) {
          console.log(`  ${c}-${p} pm UPDATE cov+max → $${cms} (was cov=${pmRows[0].coverage_amount} max=${pmRows[0].max_coverage})  (${m.carrier.slice(0, 30)})`);
        } else {
          const { data, error } = await sb.from('pm_plan_benefits')
            .update({ coverage_amount: cms, max_coverage: cms })
            .eq('benefit_category', 'vision').eq('contract_id', c).eq('plan_id', p)
            .select('id');
          if (error) { console.error('  UPDATE pm err:', error.message); continue; }
          console.log(`  ✓ ${c}-${p} pm cov+max=$${cms} (${data?.length ?? 0} rows)  (${m.carrier.slice(0, 30)})`);
        }
        pmUpdated += pmRows.length;
      }
    } else {
      // INSERT pm.vision row
      if (!WRITE) {
        console.log(`  ${c}-${p} pm INSERT vision (no row exists) coverage_amount=$${cms}`);
      } else {
        const { data, error } = await sb.from('pm_plan_benefits').insert({
          contract_id: c, plan_id: p,
          benefit_category: 'vision', coverage_amount: cms, max_coverage: cms,
          benefit_description: `Vision eyewear allowance $${cms}/yr (CMS-verified)`,
        }).select('id');
        if (error) { console.error('  INSERT pm err:', error.message); }
        else { console.log(`  ✓ ${c}-${p} pm INSERTED → $${cms}`); pmInserted += (data?.length ?? 0); }
      }
    }

    // 2. Ensure pbp_benefits_v2.vision_allowance exists (belt + suspenders)
    const { data: pbpRows } = await sb.from('pbp_benefits_v2')
      .select('id, copay').eq('contract_id', c).eq('plan_id', p)
      .eq('benefit_type', 'vision_allowance');
    if (!pbpRows || pbpRows.length === 0) {
      if (!WRITE) {
        console.log(`    + pbp INSERT vision_allowance copay=$${cms}`);
      } else {
        const { data, error } = await sb.from('pbp_benefits_v2').insert({
          contract_id: c, plan_id: p, segment_id: m.segment ?? '0',
          plan_year: 2026, benefit_type: 'vision_allowance', tier_id: '0',
          copay: cms, description: `Vision eyewear allowance (CMS-verified $${cms}/yr)`,
          source: 'medicare_gov',
        }).select('id');
        if (error) console.error('    INSERT pbp err:', error.message);
        else { console.log(`    + pbp INSERTED → $${cms}`); pbpInserted += (data?.length ?? 0); }
      }
    }
  }

  console.log('\n' + '─'.repeat(70));
  console.log(`Summary: pm rows updated=${pmUpdated}  pm inserted=${pmInserted}  pbp inserted=${pbpInserted}`);
  console.log(WRITE ? 'DONE (writes committed)' : 'DRY-RUN complete. Re-run with --write.');
}
main().catch((e) => { console.error(e); process.exit(1); });
