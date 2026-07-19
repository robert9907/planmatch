// Vision-allowance-only agent-side audit. READ-ONLY.
//
// The rendering chain (Step 1 findings):
//   pm_plan_benefits.vision.max_coverage (or coverage_amount fallback)
//     → api/plans.ts:1441-1445 buildBenefits(): visionEyewear numeric
//     → planDisplay.ts:52-63: `visionAllowance` string
//        > 1  → "$X" dollar figure
//        = 1  → "Included" (sentinel: filed but no ceiling)
//        = 0  → "$0" (no data — agent sees this as "zero dollars")
//     → CompareScreen.tsx:336 renders in the Vision column
//     → CompareModal.tsx:87 + PlanDetailModal.tsx:115 render "Vision $"
//
// CMS ground truth (per cached details):
//   plan_card.ma_benefits[]
//     .filter(b => b.category === 'BENEFIT_VISION')
//     For allowance: plan_limits_details[
//       limit_type=BENEFIT_LIMIT_TYPE_COVERAGE,
//       limit_period=BENEFIT_LIMIT_PERIOD_EVERY_YEAR
//     ].limit_value  (max across services)
//     For exam copay: cost_sharing[IN_NETWORK|NO_NETWORK].min_copay
//
// Categorization:
//   A — Full match: PM dollar ≈ CMS dollar (± $0 tolerance)
//   B — Presence-only: CMS has real $, PM shows "Included" (sentinel=1)
//        or "$0" while a `vision` row exists in pm_plan_benefits
//   C — Wrong amount: both have $, values differ
//   D — Missing entirely: no pm_plan_benefits `vision` row at all
//   E — PM richer: CMS silent on allowance, PM has a real $ value
//
// Run: npx tsx scripts/_audit-vision.ts

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// ─── CMS extractor ──────────────────────────────────────────────
interface CmsVision {
  eyewear_allowance_year: number | null;   // parsed $ from plan_limits_details
  exam_copay: number | null;                // in-network min_copay
  descriptions: string[];                    // all service-level descriptions
  services: Array<{ service: string; copay: number | null; coinsurance: number | null; allowance: number | null }>;
}
function extractCmsVision(card: any): CmsVision | null {
  const hits = (card.ma_benefits ?? []).filter((b: any) => b.category === 'BENEFIT_VISION');
  if (hits.length === 0) return null;
  let maxAllowance: number | null = null;
  let examCopay: number | null = null;
  const services: CmsVision['services'] = [];
  for (const b of hits) {
    // In-network cost_sharing
    const cs = b.cost_sharing ?? [];
    const inNet = cs.find((c: any) => c.network_status === 'IN_NETWORK')
               ?? cs.find((c: any) => c.network_status === 'NO_NETWORK')
               ?? cs.find((c: any) => c.network_status === 'NETWORK_TYPE_NA');
    const copay = inNet && typeof inNet.min_copay === 'number' ? inNet.min_copay : null;
    const coins = inNet && typeof inNet.min_coinsurance === 'number' ? inNet.min_coinsurance : null;
    // Annual allowance from plan_limits_details. Vision uses BOTH
    // BENEFIT_LIMIT_TYPE_COVERAGE (per-service cap) and BENEFIT_LIMIT_
    // TYPE_COMBINED_COVERAGE (shared cap across frames/lenses/exams).
    // Take the max across all annual-limit rows.
    const COVERAGE_TYPES = new Set(['BENEFIT_LIMIT_TYPE_COVERAGE', 'BENEFIT_LIMIT_TYPE_COMBINED_COVERAGE']);
    let svcAllowance: number | null = null;
    for (const d of (b.plan_limits_details ?? [])) {
      if (COVERAGE_TYPES.has(d.limit_type) &&
          d.limit_period === 'BENEFIT_LIMIT_PERIOD_EVERY_YEAR' &&
          typeof d.limit_value === 'number') {
        svcAllowance = svcAllowance == null ? d.limit_value : Math.max(svcAllowance, d.limit_value);
        if (maxAllowance == null || d.limit_value > maxAllowance) maxAllowance = d.limit_value;
      }
    }
    // Track the exam copay from SERVICE_ROUTINE_EYE_EXAMS specifically
    if (b.service === 'SERVICE_ROUTINE_EYE_EXAMS' || b.service === 'SERVICE_ROUTINE_VISION_EYE_EXAMS' || b.service?.toLowerCase().includes('exam')) {
      if (copay != null && examCopay == null) examCopay = copay;
    }
    services.push({ service: b.service ?? '', copay, coinsurance: coins, allowance: svcAllowance });
  }
  return {
    eyewear_allowance_year: maxAllowance,
    exam_copay: examCopay,
    descriptions: hits.map((b: any) => `${b.service}${b.plan_limits ? ' [limits]' : ''}`),
    services,
  };
}

// ─── PM extractor (mirrors api/plans.ts buildBenefits + planDisplay) ─
interface PmVision {
  has_row: boolean;
  max_coverage: number | null;
  coverage_amount: number | null;
  copay: number | null;
  coinsurance: number | null;
  description: string | null;
  eyewear_allowance_year: number;   // what the API returns (max_coverage ?? coverage_amount ?? 0)
  vision_string: string;             // planDisplay's `vision` label
  visionAllowance_string: string;    // planDisplay's `visionAllowance` label
  // pbp evidence — is the $ present in pbp_benefits_v2 but not reaching PM output?
  pbp_vision_allowance_copay: number | null;
  pbp_vision_allowance_source: string | null;
  pbp_vision_exam_copay: number | null;
}
function toNum(v: any): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return isFinite(n) ? n : null;
}
function fmtMoney(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}
async function loadPmVision(contract: string, plan: string): Promise<PmVision> {
  const [pmRes, pbpRes] = await Promise.all([
    sb.from('pm_plan_benefits')
      .select('copay, coinsurance, max_coverage, coverage_amount, benefit_description')
      .eq('benefit_category', 'vision').eq('contract_id', contract).eq('plan_id', plan),
    // pbp_benefits VIEW — same select as api/plans.ts:895-905 broad merge fetch.
    // The api MERGE combines pbp vision_allowance with pm.vision. Simulate it.
    sb.from('pbp_benefits')
      .select('plan_id, benefit_type, copay, copay_max, coinsurance, tier_id, description, source')
      .eq('plan_id', `${contract}-${plan}`)
      .in('source', ['medicare_gov', 'sb_ocr', 'cms_pbp', 'manual'])
      .in('benefit_type', ['vision_allowance']),
  ]);
  const row = pmRes.data && pmRes.data.length > 0 ? pmRes.data[0] : null;
  // Simulate api/plans.ts: bestByKey source-priority winner
  const rank: Record<string, number> = { medicare_gov: 5, sb_ocr: 4, cms_pbp: 3, manual: 2, pbp_federal: 1 };
  let bestPbp: any = null;
  for (const p of (pbpRes.data ?? [])) {
    if (!bestPbp || (rank[p.source] ?? 0) > (rank[bestPbp.source] ?? 0)) bestPbp = p;
  }
  // transformPbpRow for vision_allowance (line 507-513 in api/plans.ts)
  let synthCoverage: number | null = null;
  if (bestPbp && typeof bestPbp.copay === 'number' && bestPbp.copay > 0) {
    const desc = (bestPbp.description ?? '').toLowerCase();
    const biennial = /every 2 years|every 24 months|every two years|biennial/.test(desc);
    synthCoverage = biennial ? Math.round(bestPbp.copay / 2) : bestPbp.copay;
  }
  // Merge decision (line 1101-1111): ALLOWANCE_CATEGORIES.has('vision') → keep synth if land.coverage_amount is null
  const landCov = row ? toNum(row.coverage_amount) : null;
  const landMax = row ? toNum(row.max_coverage) : null;
  // Post-merge coverage: if landscape has coverage_amount, that wins; otherwise synth's.
  let mergedCoverage: number | null;
  let mergedMax: number | null;
  if (landCov != null) {
    mergedCoverage = landCov;
    mergedMax = landMax;
  } else if (synthCoverage != null) {
    mergedCoverage = synthCoverage;
    mergedMax = synthCoverage; // transformPbpRow sets max_coverage = annual when null
  } else {
    mergedCoverage = null;
    mergedMax = landMax;
  }
  const max = mergedMax;
  const cov = mergedCoverage;
  const desc = row?.benefit_description ?? bestPbp?.description ?? null;
  const eyewear = max ?? cov ?? 0;
  (row as any) && ((row as any).__hasPbpDollar = bestPbp && typeof bestPbp.copay === 'number' && bestPbp.copay > 0);
  // planDisplay.ts logic (line 54-63)
  const visionStr = row
    ? eyewear > 0 ? 'Routine + eyewear' : 'Exam only'
    : 'None';
  const allowanceStr = eyewear > 1
    ? fmtMoney(eyewear)
    : eyewear === 1
      ? (desc?.trim() || 'Included')
      : '$0';
  return {
    has_row: !!row,
    max_coverage: max,
    coverage_amount: cov,
    copay: row ? toNum(row.copay) : null,
    coinsurance: row ? toNum(row.coinsurance) : null,
    description: desc,
    eyewear_allowance_year: eyewear,
    vision_string: visionStr,
    visionAllowance_string: allowanceStr,
    pbp_vision_allowance_copay: bestPbp ? toNum(bestPbp.copay) : null,
    pbp_vision_allowance_source: bestPbp?.source ?? null,
    pbp_vision_exam_copay: null,
    pm_raw_max_coverage: landMax,
    pm_raw_coverage_amount: landCov,
  } as any;
}

// ─── Categorization ─────────────────────────────────────────────
type Category = 'A' | 'B' | 'C' | 'D' | 'E' | 'NONE';
function classify(cms: CmsVision | null, pm: PmVision): { cat: Category; note: string } {
  const cmsHas = cms && cms.eyewear_allowance_year != null && cms.eyewear_allowance_year > 0;
  const pmHas = pm.eyewear_allowance_year > 1;    // > 1 excludes the sentinel
  const pmSentinel = pm.eyewear_allowance_year === 1;
  // Both silent on allowance
  if (!cms && !pm.has_row) return { cat: 'NONE', note: 'neither side has vision' };
  if (!cms && pm.has_row && !pmHas && !pmSentinel) return { cat: 'NONE', note: 'CMS silent, PM row present but no $' };
  if (!cms) return { cat: 'E', note: 'CMS silent; PM has $ (richer source)' };
  // CMS has vision benefit
  if (!pm.has_row) return { cat: 'D', note: 'CMS confirms vision; PM has no row' };
  if (!cmsHas) {
    // CMS silent on $; PM might have $ or sentinel
    if (pmHas) return { cat: 'E', note: 'CMS JSON silent on $ allowance; PM has real $' };
    return { cat: 'NONE', note: 'both agree: vision offered, no $ published' };
  }
  // Both have data
  if (!pmHas) {
    return { cat: 'B', note: `presence-only: CMS $${cms.eyewear_allowance_year}, PM shows "${pm.visionAllowance_string}"` };
  }
  if (cms.eyewear_allowance_year === pm.eyewear_allowance_year) {
    return { cat: 'A', note: 'exact $ match' };
  }
  return { cat: 'C', note: `wrong $: CMS $${cms.eyewear_allowance_year} vs PM $${pm.eyewear_allowance_year}` };
}

// ─── Main ───────────────────────────────────────────────────────
interface Record {
  contract_id: string; plan_id: string; segment_id: string;
  plan_name: string; carrier: string; slice: string;
  counties: string[];
  cms: CmsVision | null;
  pm: PmVision;
  cat: Category; note: string; gap: number;
}
function sliceOf(snp: string | null | undefined): string {
  if (!snp || snp === 'SNP_TYPE_NOT_SNP') return 'MAPD non-SNP';
  if (snp === 'SNP_TYPE_DUAL_ELIGIBLE') return 'D-SNP';
  if (snp === 'SNP_TYPE_CHRONIC_OR_DISABLING' || snp === 'SNP_TYPE_CHRONIC_CONDITION') return 'C-SNP';
  if (snp === 'SNP_TYPE_INSTITUTIONAL') return 'I-SNP';
  return 'MAPD non-SNP';
}

async function main() {
  console.log('Vision allowance audit');
  console.log('─'.repeat(70));

  // Enumerate cached details
  const files: string[] = [];
  for (const dir of ['_tmp/medicare-gov-mapd/detail', '_tmp/medicare-gov-snp/detail']) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith('.json')) files.push(join(dir, f));
  }
  console.log(`Detail files: ${files.length}`);

  const records: Record[] = [];
  for (let i = 0; i < files.length; i++) {
    const j = JSON.parse(readFileSync(files[i], 'utf8'));
    const pc = j.response?.plan_card;
    if (!pc) continue;
    const cms = extractCmsVision(pc);
    const pm = await loadPmVision(pc.contract_id, pc.plan_id);
    const { cat, note } = classify(cms, pm);
    const gap = cms?.eyewear_allowance_year != null && cat !== 'A'
      ? Math.max(0, cms.eyewear_allowance_year - (pm.eyewear_allowance_year > 1 ? pm.eyewear_allowance_year : 0))
      : 0;
    records.push({
      contract_id: pc.contract_id, plan_id: pc.plan_id, segment_id: String(pc.segment_id ?? '0'),
      plan_name: pc.name, carrier: pc.organization_name,
      slice: sliceOf(pc.snp_type),
      counties: j.counties ?? [],
      cms, pm, cat, note, gap,
    });
    if (i % 25 === 0) process.stdout.write(`  [${i+1}/${files.length}]\r`);
  }
  console.log(`\nProcessed ${records.length} plans.`);

  // Aggregate
  const byCat: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, NONE: 0 };
  for (const r of records) byCat[r.cat] = (byCat[r.cat] ?? 0) + 1;
  console.log('\nCategorization:');
  for (const c of ['A','B','C','D','E','NONE']) {
    const n = byCat[c] ?? 0;
    const pct = Math.round((n / records.length) * 10000) / 100;
    console.log(`  ${c}: ${n.toString().padStart(4)} = ${pct}%`);
  }
  const auditablePct = ((byCat.A) / (byCat.A + byCat.B + byCat.C + byCat.D + (byCat.E ?? 0)) * 100).toFixed(2);
  console.log(`\nA-match rate (of auditable): ${auditablePct}%`);

  // Carrier breakdown
  const byCarrier: Record<string, { total: number; a: number; b: number; c: number; d: number; e: number }> = {};
  for (const r of records) {
    if (!byCarrier[r.carrier]) byCarrier[r.carrier] = { total: 0, a: 0, b: 0, c: 0, d: 0, e: 0 };
    const bc = byCarrier[r.carrier];
    bc.total += 1;
    if (r.cat === 'A') bc.a++;
    else if (r.cat === 'B') bc.b++;
    else if (r.cat === 'C') bc.c++;
    else if (r.cat === 'D') bc.d++;
    else if (r.cat === 'E') bc.e++;
  }
  console.log('\nBy carrier (only carriers with 3+ plans):');
  console.log(`  ${'carrier'.padEnd(48)} ${'plans'.padStart(5)} ${'A'.padStart(4)} ${'B'.padStart(4)} ${'C'.padStart(4)} ${'D'.padStart(4)} ${'E'.padStart(4)}  A%`);
  const sorted = Object.entries(byCarrier).filter(([, v]) => v.total >= 3).sort((a, b) => b[1].total - a[1].total);
  for (const [name, v] of sorted) {
    const auditable = v.a + v.b + v.c + v.d + v.e;
    const aPct = auditable > 0 ? ((v.a / auditable) * 100).toFixed(1) : '—';
    console.log(`  ${name.slice(0, 48).padEnd(48)} ${String(v.total).padStart(5)} ${String(v.a).padStart(4)} ${String(v.b).padStart(4)} ${String(v.c).padStart(4)} ${String(v.d).padStart(4)} ${String(v.e).padStart(4)}  ${aPct}%`);
  }

  // Worst offenders
  const worst = [...records].filter((r) => r.gap > 0).sort((a, b) => b.gap - a.gap).slice(0, 8);
  console.log('\nWorst 8 by gap (CMS $allowance − PM $ shown):');
  for (const r of worst) {
    console.log(`  gap=$${r.gap.toString().padStart(4)}  ${r.contract_id}-${r.plan_id}  ${r.cat}  ${r.plan_name.slice(0, 55)}`);
    console.log(`     CMS eyewear: $${r.cms?.eyewear_allowance_year}   PM: ${r.pm.visionAllowance_string}   note: ${r.note}`);
  }

  // Save raw
  writeFileSync('_tmp/parity-data/_vision-audit.json', JSON.stringify({ records, byCat, byCarrier }, null, 2));
  console.log('\nRaw: _tmp/parity-data/_vision-audit.json');
}
main().catch((e) => { console.error(e); process.exit(1); });
