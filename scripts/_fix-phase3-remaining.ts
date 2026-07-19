// Phase 3 remaining data fixes — the true drifts after Part A
// reclassifier honesty pass.
//
// P4 — dental_annual_max A (7 plans):
//   H1112-034 $5000, H1914-011 $2000, H2293-009 $4000, H3288-051 $1500,
//   H4506-010 $1500, H5294-014 $3000, H9808-009 $1500
//   Action: UPDATE pm_plan_benefits SET max_coverage = CMS,
//           coverage_amount = CMS WHERE benefit_category='dental'
//
// P5 — transportation A (3) + otc A (2):
//   transport: H2293-009, H5302-022, H5521-598
//   otc:       H3404-004, H3777-002
//   Action: INSERT pbp_benefits_v2 presence rows (copay=0 +
//           description; triggers Phase 1 Fix 5 rescue) with
//           source='medicare_gov'
//
// P7 (true drifts only, excluding multi-segment plans handled by
//    Part A reclassifier):
//   H9725-015 vision: pm=$150 → $200 (both segs consistent)
//   H3449-023 specialist: pm=$25 → $40
//   H5216-043 specialist: pm=$40 → $30
//   H9725-009 specialist: pm=$20 → $15
//
// Idempotent, --write guarded. Per-row before/after.
//
// Run: npx tsx scripts/_fix-phase3-remaining.ts           (dry-run)
//      npx tsx scripts/_fix-phase3-remaining.ts --write   (execute)

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

// ─── Detail cache ───────────────────────────────────────────────
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

const COVERAGE_TYPES = new Set(['BENEFIT_LIMIT_TYPE_COVERAGE', 'BENEFIT_LIMIT_TYPE_COMBINED_COVERAGE']);
function annualMax(card: any, cmsCat: string): number | null {
  const hits = (card.ma_benefits ?? []).filter((b: any) => b.category === cmsCat);
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
function specialistCopay(card: any): number | null {
  const hits = (card.ma_benefits ?? []).filter((b: any) =>
    b.category === 'BENEFIT_DOCTOR_VISITS' && b.service === 'SERVICE_SPECIALIST');
  for (const h of hits) {
    const cs = h.cost_sharing ?? [];
    const inNet = cs.find((c: any) => c.network_status === 'IN_NETWORK')
               ?? cs.find((c: any) => c.network_status === 'NO_NETWORK');
    if (inNet && typeof inNet.min_copay === 'number') return inNet.min_copay;
  }
  return null;
}

// Presence checkers — MATCH Phase 3's extractCms logic exactly so the
// audit and the fix agree on "CMS confirms this benefit".
function asbHas(card: any, categoryKey: string, benefitKey: string): boolean {
  const list = card.additional_supplemental_benefits?.special_benefits ?? [];
  const hit = list.find((c: any) => c.category === categoryKey);
  const b = (hit?.benefits ?? []).find((x: any) => x.benefit === benefitKey);
  return !!b && b.coverage && b.coverage !== 'SB_COVERAGE_NOT_COVERED';
}
function cmsTransportationPresent(card: any): boolean {
  const mb = card.ma_benefits ?? [];
  if (mb.some((b: any) => b.category === 'BENEFIT_TRANSPORTATION')) return true;
  return asbHas(card, 'SB_CAT_TRANSPORTATION_SERVICES', 'SB_ANY_HEALTH_RELATED_LOCATION') ||
         asbHas(card, 'SB_CAT_TRANSPORTATION_SERVICES', 'SB_PLAN_APPROVED_HEALTH_RELATED_LOCATION') ||
         asbHas(card, 'SB_CAT_NON_PRIMARILY_HEALTH_RELATED_BENEFITS', 'SB_TRANSPORTATION_FOR_NON_MEDICAL_NEEDS');
}
function cmsOtcPresent(card: any): boolean {
  const mb = card.ma_benefits ?? [];
  if (mb.some((b: any) => b.category === 'OTHER_SERVICES' && b.service === 'OTC_ITEMS')) return true;
  return asbHas(card, 'SB_CAT_OTC_ITEMS', 'SB_OTC_ITEMS');
}

// ─── Targets from _tmp/phase3-failures.json ─────────────────────
const P4_DENTAL = ['H1112-034','H1914-011','H2293-009','H3288-051','H4506-010','H5294-014','H9808-009'];
const P5_TRANSPORT = ['H2293-009','H5302-022','H5521-598'];
const P5_OTC = ['H3404-004','H3777-002'];
// P7 targets — only plans with CONSISTENT CMS values across segments
// (real drift). H3449-023 and H5216-043 were multi-segment and are
// added to the reclassifier's perSegmentAccepted set instead.
const P7_UPDATES: Array<{key: string; cat: string; field: 'copay'|'coverage_amount'; cms: number}> = [
  { key: 'H9725-015', cat: 'vision',     field: 'coverage_amount', cms: 200 },  // consistent across seg3/seg4
  { key: 'H9725-009', cat: 'specialist', field: 'copay',           cms: 15  },  // consistent across seg3/seg4
];

async function main() {
  const mode = WRITE ? 'WRITE' : 'DRY-RUN';
  console.log(`Fix Phase 3 remaining (${mode})`);
  console.log(`DB: ${(process.env.SUPABASE_URL ?? '').replace('https://', '').split('.')[0]}`);
  console.log('─'.repeat(70));

  // ═══════════════════════════════════════════════════════════════
  // P4 — dental_annual_max UPDATE (both max + cov)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── P4 — dental_annual_max UPDATE (7 plans) ──');
  let p4Ok = 0, p4Skip = 0;
  for (const key of P4_DENTAL) {
    const [c, p] = key.split('-');
    const det = findDetail(c, p);
    if (!det) { console.log(`  ${key}: no detail cache — skip`); p4Skip++; continue; }
    const cms = annualMax(det.card, 'BENEFIT_COMPREHENSIVE_DENTAL');
    if (cms == null) { console.log(`  ${key}: CMS silent — skip`); p4Skip++; continue; }
    // Check current pm rows
    const { data: rows } = await sb.from('pm_plan_benefits')
      .select('id, max_coverage, coverage_amount, segment_id')
      .eq('benefit_category', 'dental').eq('contract_id', c).eq('plan_id', p);
    if (!rows || rows.length === 0) {
      // INSERT
      if (!WRITE) { console.log(`  ${key}: INSERT dental row cov+max=$${cms}  (no pm row)`); p4Ok++; continue; }
      const { data, error } = await sb.from('pm_plan_benefits').insert({
        contract_id: c, plan_id: p,
        benefit_category: 'dental', max_coverage: cms, coverage_amount: cms,
        benefit_description: `Dental annual max $${cms} (CMS-verified)`,
      }).select('id');
      if (error) { console.error(`  INSERT err ${key}:`, error.message); continue; }
      console.log(`  ✓ ${key}: INSERTED dental cov+max=$${cms}`); p4Ok++;
      continue;
    }
    // UPDATE existing
    const needs = rows.filter((r: any) => r.max_coverage !== cms || r.coverage_amount !== cms);
    if (needs.length === 0) { console.log(`  ${key}: already matches`); continue; }
    console.log(`  ${key}: UPDATE ${needs.length} row(s) → cov+max=$${cms} (was max=${needs[0].max_coverage} cov=${needs[0].coverage_amount})`);
    if (!WRITE) { p4Ok++; continue; }
    for (const r of needs) {
      const { error } = await sb.from('pm_plan_benefits')
        .update({ max_coverage: cms, coverage_amount: cms })
        .eq('id', r.id);
      if (error) console.error(`    err id=${r.id}:`, error.message);
    }
    p4Ok++;
  }
  console.log(`  P4 done: ${p4Ok} plans processed, ${p4Skip} skipped`);

  // ═══════════════════════════════════════════════════════════════
  // P5 — transportation + otc INSERT pbp presence
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── P5 — transportation + otc INSERT pbp_benefits_v2 (5 plans) ──');
  const p5Targets: Array<{key: string; benefit_type: string; check: (c: any) => boolean; desc: string}> = [
    ...P5_TRANSPORT.map((key) => ({ key, benefit_type: 'transportation', check: cmsTransportationPresent, desc: 'Transportation benefit (CMS-confirmed presence)' })),
    ...P5_OTC.map((key) => ({ key, benefit_type: 'otc_allowance', check: cmsOtcPresent, desc: 'OTC benefit (CMS-confirmed presence)' })),
  ];
  let p5Ok = 0, p5Skip = 0;
  for (const t of p5Targets) {
    const [c, p] = t.key.split('-');
    const det = findDetail(c, p);
    if (!det) { console.log(`  ${t.key} ${t.benefit_type}: no detail cache — skip`); p5Skip++; continue; }
    if (!t.check(det.card)) { console.log(`  ${t.key} ${t.benefit_type}: CMS did NOT confirm — skip`); p5Skip++; continue; }
    // Check existing pbp row
    const { data: exist } = await sb.from('pbp_benefits_v2')
      .select('id, copay').eq('contract_id', c).eq('plan_id', p)
      .eq('segment_id', det.segment).eq('benefit_type', t.benefit_type);
    if (exist && exist.length > 0) { console.log(`  ${t.key} ${t.benefit_type}: already exists (id=${exist[0].id})`); p5Skip++; continue; }
    console.log(`  ${t.key} ${t.benefit_type} seg=${det.segment}: INSERT copay=0 + desc`);
    if (!WRITE) { p5Ok++; continue; }
    const { data, error } = await sb.from('pbp_benefits_v2').insert({
      contract_id: c, plan_id: p, segment_id: det.segment,
      plan_year: 2026, benefit_type: t.benefit_type, tier_id: '0',
      copay: 0, description: t.desc, source: 'medicare_gov',
    }).select('id');
    if (error) { console.error(`    INSERT err:`, error.message); continue; }
    console.log(`    ✓ inserted id=${data?.[0]?.id}`);
    p5Ok++;
  }
  console.log(`  P5 done: ${p5Ok} inserts, ${p5Skip} skipped`);

  // ═══════════════════════════════════════════════════════════════
  // P7 — true drifts (specialist_copay + one vision UPDATE)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── P7 — true drifts (specialist + vision UPDATE, 4 plans) ──');
  let p7Ok = 0, p7Skip = 0;
  for (const t of P7_UPDATES) {
    const [c, p] = t.key.split('-');
    // Verify CMS truth from cache to be safe
    const det = findDetail(c, p);
    if (!det) { console.log(`  ${t.key} ${t.cat}: no detail — skip`); p7Skip++; continue; }
    let cmsVerified: number | null;
    if (t.cat === 'vision') cmsVerified = annualMax(det.card, 'BENEFIT_VISION');
    else if (t.cat === 'specialist') cmsVerified = specialistCopay(det.card);
    else cmsVerified = null;
    if (cmsVerified !== t.cms) {
      console.log(`  ${t.key} ${t.cat}: expected CMS $${t.cms} but detail says $${cmsVerified} — skip for safety`);
      p7Skip++; continue;
    }
    const { data: rows } = await sb.from('pm_plan_benefits')
      .select('id, copay, coverage_amount, max_coverage, segment_id')
      .eq('benefit_category', t.cat).eq('contract_id', c).eq('plan_id', p);
    if (!rows || rows.length === 0) { console.log(`  ${t.key} ${t.cat}: no pm row — skip`); p7Skip++; continue; }
    const target = t.field === 'coverage_amount' ? { max_coverage: t.cms, coverage_amount: t.cms } : { copay: t.cms };
    const needs = rows.filter((r: any) => {
      if (t.field === 'coverage_amount') return r.coverage_amount !== t.cms || r.max_coverage !== t.cms;
      return r.copay !== t.cms;
    });
    if (needs.length === 0) { console.log(`  ${t.key} ${t.cat}: already matches`); continue; }
    console.log(`  ${t.key} ${t.cat}: UPDATE ${needs.length} row(s) → ${JSON.stringify(target)} (was ${JSON.stringify(needs[0])})`);
    if (!WRITE) { p7Ok++; continue; }
    for (const r of needs) {
      const { error } = await sb.from('pm_plan_benefits').update(target).eq('id', r.id);
      if (error) console.error(`    err id=${r.id}:`, error.message);
    }
    p7Ok++;
  }
  console.log(`  P7 done: ${p7Ok} plans processed, ${p7Skip} skipped`);

  console.log('\n' + '─'.repeat(70));
  console.log(WRITE ? 'DONE (writes committed)' : 'DRY-RUN complete. Re-run with --write.');
}
main().catch((e) => { console.error(e); process.exit(1); });
