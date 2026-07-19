// Fix 2 + Fix 3 — vision allowance backfill.
//
// From the merge-aware vision audit (_tmp/parity-data/_vision-audit.json):
//   Category C = pm_plan_benefits.vision has a STALE max_coverage/coverage_amount.
//     The merge in api/plans.ts keeps landscape when landscape.coverage_amount
//     is non-null (ALLOWANCE_CATEGORIES branch, line 1105-1106). So the
//     stale pm value wins over the correct pbp value.
//     Fix: UPDATE pm_plan_benefits.vision.max_coverage = <CMS $>.
//   Category B = both pm and pbp are null on the allowance.
//     Fix: INSERT pbp_benefits_v2.vision_allowance with copay=<CMS $>,
//     source='medicare_gov'. The merge will then surface it because
//     landscape.coverage_amount is still null.
//
// CMS extraction accepts BOTH:
//   BENEFIT_LIMIT_TYPE_COVERAGE + BENEFIT_LIMIT_TYPE_COMBINED_COVERAGE
// (This is the fix Phase 3 comparator needs — 79% of MA plans file
//  vision under COMBINED_COVERAGE.)
//
// Idempotent; --write required. Every UPDATE/INSERT is guarded on
// the old value / row absence.
//
// Run: npx tsx scripts/_fix-vision-stale.ts           (dry-run)
//      npx tsx scripts/_fix-vision-stale.ts --write   (execute)

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const WRITE = process.argv.includes('--write');

// ─── CMS extractor: accept both COVERAGE and COMBINED_COVERAGE,
// and both EVERY_YEAR and EVERY_TWO_YEARS (biennial). Halve biennial
// to annual. Mirrors api/plans.ts:507-513 transformPbpRow biennial
// halving so post-insert values flow through the merge correctly.
const COVERAGE_TYPES = new Set(['BENEFIT_LIMIT_TYPE_COVERAGE', 'BENEFIT_LIMIT_TYPE_COMBINED_COVERAGE']);
function cmsVisionMax(card: any): number | null {
  const hits = (card.ma_benefits ?? []).filter((b: any) => b.category === 'BENEFIT_VISION');
  let max: number | null = null;
  for (const b of hits) {
    for (const d of (b.plan_limits_details ?? [])) {
      if (!COVERAGE_TYPES.has(d.limit_type)) continue;
      if (typeof d.limit_value !== 'number') continue;
      let annual: number | null = null;
      if (d.limit_period === 'BENEFIT_LIMIT_PERIOD_EVERY_YEAR') annual = d.limit_value;
      else if (d.limit_period === 'BENEFIT_LIMIT_PERIOD_EVERY_TWO_YEARS') annual = Math.round(d.limit_value / 2);
      if (annual == null) continue;
      if (max == null || annual > max) max = annual;
    }
  }
  return max;
}
function findDetail(contract: string, plan: string): { card: any; segment: string } | null {
  for (const dir of ['_tmp/medicare-gov-snp/detail', '_tmp/medicare-gov-mapd/detail']) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(`${contract}-${plan}-`)) continue;
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (j.response?.plan_card) return { card: j.response.plan_card, segment: String(j.response.plan_card.segment_id ?? '0') };
    }
  }
  return null;
}

// ─── Load audit records ────────────────────────────────────────
interface AuditRec {
  contract_id: string; plan_id: string; segment_id: string;
  plan_name: string; carrier: string; slice: string;
  cat: 'A'|'B'|'C'|'D'|'E'|'NONE';
  cms: any; pm: any;
}
function loadAudit(): AuditRec[] {
  const raw = JSON.parse(readFileSync('_tmp/parity-data/_vision-audit.json', 'utf8'));
  return raw.records as AuditRec[];
}

async function main() {
  const mode = WRITE ? 'WRITE' : 'DRY-RUN';
  console.log(`Fix 2+3 — vision allowance backfill (${mode})`);
  console.log('─'.repeat(70));
  const audit = loadAudit();
  const cPlans = audit.filter((r) => r.cat === 'C');
  const bPlans = audit.filter((r) => r.cat === 'B');
  console.log(`Audit has ${cPlans.length} C plans (stale UPDATE) + ${bPlans.length} B plans (missing INSERT)`);

  // ═══════════════════════════════════════════════════════════════
  // FIX 2 — Category C: UPDATE pm_plan_benefits.vision.max_coverage
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── Fix 2 — Category C: UPDATE pm_plan_benefits.vision.max_coverage ──');
  let cSkipNoDetail = 0, cSkipNoCms = 0, cAlreadyMatches = 0, cToUpdate = 0, cUpdatedRows = 0;
  for (const r of cPlans) {
    const det = findDetail(r.contract_id, r.plan_id);
    if (!det) { cSkipNoDetail++; continue; }
    const cmsMax = cmsVisionMax(det.card);
    if (cmsMax == null || cmsMax <= 0) { cSkipNoCms++; continue; }
    // Check current pm max_coverage
    const { data: rows } = await sb.from('pm_plan_benefits')
      .select('max_coverage, coverage_amount')
      .eq('benefit_category', 'vision')
      .eq('contract_id', r.contract_id).eq('plan_id', r.plan_id);
    if (!rows || rows.length === 0) { console.log(`  ${r.contract_id}-${r.plan_id}: no pm row (unexpected for C)`); continue; }
    // Guard: if all rows already at cmsMax, skip
    const differs = rows.some((row: any) => (row.max_coverage ?? row.coverage_amount) !== cmsMax);
    if (!differs) { cAlreadyMatches++; continue; }
    cToUpdate++;
    if (!WRITE) {
      console.log(`  ${r.contract_id}-${r.plan_id} ${r.plan_name.slice(0,50)} pm=$${rows[0].max_coverage ?? rows[0].coverage_amount ?? 'null'} → cms=$${cmsMax}  (${rows.length} rows)`);
    } else {
      const { data, error } = await sb.from('pm_plan_benefits')
        .update({ max_coverage: cmsMax })
        .eq('benefit_category', 'vision')
        .eq('contract_id', r.contract_id).eq('plan_id', r.plan_id)
        .or(`max_coverage.neq.${cmsMax},max_coverage.is.null`)
        .select('id');
      if (error) { console.error('  UPDATE err:', error.message); continue; }
      cUpdatedRows += (data?.length ?? 0);
      if (cToUpdate % 15 === 0) console.log(`  [${cToUpdate}] ${r.contract_id}-${r.plan_id} → $${cmsMax} (${data?.length} rows)`);
    }
  }
  console.log(`  Fix 2 summary:  target=${cPlans.length}  updated=${cToUpdate}  already_match=${cAlreadyMatches}  no_detail=${cSkipNoDetail}  no_cms=${cSkipNoCms}${WRITE ? `  rows=${cUpdatedRows}` : ''}`);

  // ═══════════════════════════════════════════════════════════════
  // FIX 3 — Category B: INSERT pbp_benefits_v2.vision_allowance
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── Fix 3 — Category B: INSERT pbp_benefits_v2.vision_allowance ──');
  let bSkipNoDetail = 0, bSkipNoCms = 0, bAlreadyExists = 0, bToInsert = 0, bInsertedRows = 0, bUpdatedRows = 0;
  for (const r of bPlans) {
    const det = findDetail(r.contract_id, r.plan_id);
    if (!det) { bSkipNoDetail++; continue; }
    const cmsMax = cmsVisionMax(det.card);
    if (cmsMax == null || cmsMax <= 0) { bSkipNoCms++; continue; }
    // Check existing pbp_benefits_v2 row
    const { data: existing } = await sb.from('pbp_benefits_v2')
      .select('id, copay, description, source, segment_id')
      .eq('contract_id', r.contract_id).eq('plan_id', r.plan_id)
      .eq('benefit_type', 'vision_allowance');
    const hasRealCopay = (existing ?? []).some((row: any) => typeof row.copay === 'number' && row.copay > 0);
    if (hasRealCopay) { bAlreadyExists++; continue; }
    // Determine target: UPDATE existing null-copay row OR INSERT new
    const nullCopayRow = (existing ?? []).find((row: any) => row.copay == null || row.copay === 0);
    const segment = det.segment;
    bToInsert++;
    if (!WRITE) {
      const action = nullCopayRow ? `UPDATE (id=${nullCopayRow.id})` : `INSERT seg=${segment}`;
      console.log(`  ${r.contract_id}-${r.plan_id} ${r.plan_name.slice(0,50)}  ${action}  copay=$${cmsMax}`);
    } else {
      if (nullCopayRow) {
        const { data, error } = await sb.from('pbp_benefits_v2')
          .update({ copay: cmsMax, description: `Vision eyewear allowance (CMS-confirmed $${cmsMax}/yr)` })
          .eq('id', nullCopayRow.id).select('id');
        if (error) { console.error('  UPDATE err:', error.message); continue; }
        bUpdatedRows += (data?.length ?? 0);
      } else {
        const { data, error } = await sb.from('pbp_benefits_v2').insert({
          contract_id: r.contract_id, plan_id: r.plan_id, segment_id: segment,
          plan_year: 2026, benefit_type: 'vision_allowance', tier_id: '0',
          copay: cmsMax, description: `Vision eyewear allowance (CMS-confirmed $${cmsMax}/yr)`,
          source: 'medicare_gov',
        }).select('id');
        if (error) { console.error('  INSERT err:', error.message); continue; }
        bInsertedRows += (data?.length ?? 0);
      }
      if (bToInsert % 15 === 0) console.log(`  [${bToInsert}] ${r.contract_id}-${r.plan_id} → $${cmsMax}`);
    }
  }
  console.log(`  Fix 3 summary:  target=${bPlans.length}  actionable=${bToInsert}  already_has_copay=${bAlreadyExists}  no_detail=${bSkipNoDetail}  no_cms=${bSkipNoCms}${WRITE ? `  inserted=${bInsertedRows}  updated=${bUpdatedRows}` : ''}`);

  console.log('\n' + '─'.repeat(70));
  console.log(WRITE ? 'DONE (writes committed)' : 'DRY-RUN complete. Re-run with --write.');
}
main().catch((e) => { console.error(e); process.exit(1); });
