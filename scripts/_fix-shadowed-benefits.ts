// Fix max_coverage/coverage_amount shadowing on allowance categories.
//
// SCOPE (deliberately narrow): only vision, dental, hearing — the
// three categories where api/plans.ts buildBenefits reads
// `max_coverage ?? coverage_amount` (lines 1438, 1442, 1445). Other
// categories deliberately keep max_coverage and coverage_amount in
// DIFFERENT UNITS:
//   otc:            coverage_amount = quarterly, max = annual
//   food_card:      coverage_amount = monthly
//   partb_giveback: coverage_amount = monthly, max = annual
//   insulin:        coverage_amount = presence marker, max = annual
//   meals:          coverage_amount = per-period (weekly/etc), max = annual
// Those are intentional per the code comments at api/plans.ts:1447-
// 1467. Do NOT touch them.
//
// For vision + dental + hearing:
//   1. Shadowed rows (both set, differ) → UPDATE both to CMS truth
//      (or, if CMS not in cache, sync cov = max as safest default)
//   2. Max-only rows (max set, cov null/0) → sync cov = max as
//      belt-and-suspenders (protects future updaters from re-introducing
//      the shadow)
//   3. Cov-only rows (cov set, max null/0) → sync max = cov to keep
//      buildBenefits stable (max wins by design)
//
// Per-segment plans (like H8849-011 for vision) are updated
// per-(contract, plan, segment) — the fix respects the segment_id
// dimension.
//
// Idempotent, --write guarded, dry-run first pattern.
// Run: npx tsx scripts/_fix-shadowed-benefits.ts           (dry-run)
//      npx tsx scripts/_fix-shadowed-benefits.ts --write   (execute)

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const WRITE = process.argv.includes('--write');
const TARGET_CATEGORIES = ['vision', 'dental', 'hearing'] as const;

// ─── CMS truth cache ────────────────────────────────────────────
const detailByKey = new Map<string, any>();
function loadDetailCache() {
  for (const dir of ['_tmp/medicare-gov-mapd/detail', '_tmp/medicare-gov-snp/detail']) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const parts = f.replace('.json', '').split('-');
      const key = `${parts[0]}-${parts[1]}-${parts[2] ?? '0'}`;
      if (detailByKey.has(key)) continue;
      try {
        const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        if (j.response?.plan_card) detailByKey.set(key, j.response.plan_card);
      } catch {}
    }
  }
}
const COVERAGE_TYPES = new Set(['BENEFIT_LIMIT_TYPE_COVERAGE', 'BENEFIT_LIMIT_TYPE_COMBINED_COVERAGE']);
function cmsAllowance(card: any, cmsCategory: string): number | null {
  const hits = (card.ma_benefits ?? []).filter((b: any) => b.category === cmsCategory);
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
function getCmsTruth(cat: string, contract: string, plan: string, segment: string): number | null {
  // Try exact segment first, then any other segment for the same plan.
  const seg = String(segment ?? '0').replace(/^0+/, '') || '0';
  const cmsCategoryMap: Record<string, string> = {
    vision: 'BENEFIT_VISION',
    dental: 'BENEFIT_COMPREHENSIVE_DENTAL',
    hearing: 'HEARING_AIDS',
  };
  const cmsCat = cmsCategoryMap[cat];
  if (!cmsCat) return null;
  const card = detailByKey.get(`${contract}-${plan}-${seg}`);
  if (card) return cmsAllowance(card, cmsCat);
  // Fall through: try any segment
  for (const [k, c] of detailByKey) {
    if (k.startsWith(`${contract}-${plan}-`)) return cmsAllowance(c, cmsCat);
  }
  return null;
}

// ─── Per-segment override for known-multi-segment plans ─────────
// H8849-011 already fixed in prior session: seg 3 = $350, others = $125.
// Do not overwrite here.
const KNOWN_PER_SEGMENT: Set<string> = new Set([
  'H8849-011|vision',
]);

async function paginate<T>(fn: (from: number, to: number) => any): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await fn(p * 1000, p * 1000 + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

interface Row {
  id: number; contract_id: string; plan_id: string; segment_id: string | null;
  benefit_category: string; coverage_amount: number | null; max_coverage: number | null;
}

async function main() {
  const mode = WRITE ? 'WRITE' : 'DRY-RUN';
  console.log(`Fix shadowed benefits (${mode})`);
  console.log('─'.repeat(70));
  loadDetailCache();
  console.log(`CMS detail cache loaded: ${detailByKey.size} plan+segment tuples`);

  // Fetch all rows for target categories that could be shadowed or
  // shadow-vulnerable (either col non-null > 0).
  const rows: Row[] = await paginate<Row>((from, to) =>
    sb.from('pm_plan_benefits')
      .select('id, contract_id, plan_id, segment_id, benefit_category, coverage_amount, max_coverage')
      .in('benefit_category', TARGET_CATEGORIES as any)
      .range(from, to)
  );
  console.log(`Rows in target categories: ${rows.length}`);

  interface Action {
    id: number; contract_id: string; plan_id: string; segment_id: string;
    category: string; oldMax: number | null; oldCov: number | null;
    newMax: number; newCov: number; source: 'cms' | 'sync-max-to-cov' | 'sync-cov-to-max';
  }
  const actions: Action[] = [];
  let skipPerSegment = 0, alreadyMatch = 0, noAction = 0, noCms = 0;

  for (const r of rows) {
    const seg = String(r.segment_id ?? '0').replace(/^0+/, '') || '0';
    const cat = r.benefit_category;
    const perSegKey = `${r.contract_id}-${r.plan_id}|${cat}`;
    if (KNOWN_PER_SEGMENT.has(perSegKey)) { skipPerSegment++; continue; }
    const maxN = r.max_coverage;
    const covN = r.coverage_amount;
    const both = maxN != null && maxN > 0 && covN != null && covN > 0;
    const maxOnly = maxN != null && maxN > 0 && (covN == null || covN === 0);
    const covOnly = covN != null && covN > 0 && (maxN == null || maxN === 0);

    if (!both && !maxOnly && !covOnly) { noAction++; continue; }
    if (both && maxN === covN) { alreadyMatch++; continue; }

    let target: number | null = null;
    let source: Action['source'] = 'sync-max-to-cov';
    const cms = getCmsTruth(cat, r.contract_id, r.plan_id, seg);
    if (cms != null && cms > 0) {
      target = cms; source = 'cms';
    } else if (both) {
      // No CMS truth, both set and differ. max_coverage wins (buildBenefits
      // reads max first). Trust max.
      target = maxN!;
      source = 'sync-max-to-cov';
    } else if (maxOnly) {
      target = maxN!;
      source = 'sync-max-to-cov';
    } else if (covOnly) {
      target = covN!;
      source = 'sync-cov-to-max';
    }
    if (target == null || target <= 0) { noCms++; continue; }
    if (maxN === target && covN === target) { alreadyMatch++; continue; }

    actions.push({
      id: r.id, contract_id: r.contract_id, plan_id: r.plan_id, segment_id: seg,
      category: cat, oldMax: maxN, oldCov: covN,
      newMax: target, newCov: target, source,
    });
  }

  // Summary by category + source
  const byCatSource: Record<string, Record<string, number>> = {};
  for (const a of actions) {
    (byCatSource[a.category] ||= {})[a.source] = (byCatSource[a.category]?.[a.source] ?? 0) + 1;
  }
  console.log('\nActions summary:');
  for (const cat of Object.keys(byCatSource).sort()) {
    console.log(`  ${cat.padEnd(10)}`);
    for (const src of Object.keys(byCatSource[cat]).sort()) {
      console.log(`    ${src.padEnd(20)} ${byCatSource[cat][src]} rows`);
    }
  }
  console.log(`  (skipped: per-segment=${skipPerSegment}, already_match=${alreadyMatch}, no-op=${noAction}, no_cms=${noCms})`);

  // Sample actions
  console.log('\nSample actions (first 12):');
  for (const a of actions.slice(0, 12)) {
    console.log(`  ${a.contract_id}-${a.plan_id}-${a.segment_id.padStart(1)} ${a.category.padEnd(8)}  max=$${a.oldMax} cov=$${a.oldCov} → both=$${a.newMax}  (${a.source})`);
  }
  if (actions.length > 12) console.log(`  …+${actions.length - 12} more`);

  if (!WRITE) {
    console.log('\nDRY-RUN complete. Re-run with --write.');
    return;
  }

  // Execute per-row by id
  let ok = 0, fail = 0;
  for (const a of actions) {
    const { data, error } = await sb.from('pm_plan_benefits')
      .update({ max_coverage: a.newMax, coverage_amount: a.newCov })
      .eq('id', a.id).select('id');
    if (error) { fail++; console.error(`  UPDATE err id=${a.id}:`, error.message); continue; }
    ok += (data?.length ?? 0);
    if (ok % 20 === 0) console.log(`  [${ok}/${actions.length}] wrote id=${a.id}`);
  }
  console.log(`\nDONE. rows_updated=${ok}  errors=${fail}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
