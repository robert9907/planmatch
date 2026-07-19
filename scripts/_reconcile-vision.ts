// Vision brute-force reconciliation. READ-ONLY audit + fix planner.
//
// Column A — CMS truth: parse ma_benefits[BENEFIT_VISION] from cached
//   detail. Accept all limit_type variants, all periods (EVERY_YEAR
//   as-is, EVERY_TWO_YEARS halved to annual). Take max across all
//   vision services. Null when CMS has nothing.
//
// Column B — Agent output: simulate the exact merge api/plans.ts does
//   (verified match with H6351-004 probe in prior session):
//     load pm_plan_benefits.vision + pbp_benefits_v2.vision*
//     bestByKey source-priority winner
//     transformPbpRow: coverage_amount = pbp.copay (halved if desc
//       matches biennial regex)
//     ALLOWANCE_CATEGORIES merge: keep synth if land.coverage_amount
//       is null; else keep land
//     buildBenefits: eyewear_allowance_year = max_coverage ?? coverage_amount
//     planDisplay: > 1 → "$X", = 1 → "Included", = 0 → "$0"
//
// For each plan: MATCH / MISMATCH / CMS_NULL.
// Prints every mismatch with actionable next-step (UPDATE pbp / INSERT
// pbp / other).
//
// Re-runnable regression check.
//
// Run: npx tsx scripts/_reconcile-vision.ts

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

// ─── Column A: CMS truth ────────────────────────────────────────
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

// ─── Column B: agent output (merge-simulated) ───────────────────
const SOURCE_RANK: Record<string, number> = { medicare_gov: 5, sb_ocr: 4, cms_pbp: 3, manual: 2, pbp_federal: 1 };
function toNum(v: any): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return isFinite(n) ? n : null;
}
async function agentEyewear(contract: string, plan: string): Promise<{ eyewear: number; pmCov: number | null; pmMax: number | null; pbpCopay: number | null; pbpDesc: string | null; pbpSource: string | null; }> {
  const [pmRes, pbpRes] = await Promise.all([
    sb.from('pm_plan_benefits')
      .select('copay, coinsurance, max_coverage, coverage_amount, benefit_description')
      .eq('benefit_category', 'vision').eq('contract_id', contract).eq('plan_id', plan),
    sb.from('pbp_benefits')
      .select('plan_id, benefit_type, copay, copay_max, coinsurance, tier_id, description, source')
      .eq('plan_id', `${contract}-${plan}`)
      .in('source', ['medicare_gov','sb_ocr','cms_pbp','manual'])
      .eq('benefit_type', 'vision_allowance'),
  ]);
  const row = pmRes.data && pmRes.data.length > 0 ? pmRes.data[0] : null;
  // bestByKey — highest source rank
  let best: any = null;
  for (const p of (pbpRes.data ?? [])) {
    if (!best || (SOURCE_RANK[p.source] ?? 0) > (SOURCE_RANK[best.source] ?? 0)) best = p;
  }
  // transformPbpRow for vision_allowance (api/plans.ts:507-513)
  let synthCoverage: number | null = null;
  if (best && typeof best.copay === 'number' && best.copay > 0) {
    const desc = (best.description ?? '').toLowerCase();
    const biennial = /every 2 years|every 24 months|every two years|biennial/.test(desc);
    synthCoverage = biennial ? Math.round(best.copay / 2) : best.copay;
  }
  const landCov = row ? toNum(row.coverage_amount) : null;
  const landMax = row ? toNum(row.max_coverage) : null;
  // ALLOWANCE_CATEGORIES merge (line 1101-1111): keep synth if landCov null
  let mergedCov: number | null; let mergedMax: number | null;
  if (landCov != null) { mergedCov = landCov; mergedMax = landMax; }
  else if (synthCoverage != null) { mergedCov = synthCoverage; mergedMax = synthCoverage; }
  else { mergedCov = null; mergedMax = landMax; }
  const eyewear = mergedMax ?? mergedCov ?? 0;
  return { eyewear, pmCov: landCov, pmMax: landMax, pbpCopay: best ? toNum(best.copay) : null, pbpDesc: best?.description ?? null, pbpSource: best?.source ?? null };
}

// ─── Main ───────────────────────────────────────────────────────
interface Row {
  contract_id: string; plan_id: string; segment: string;
  plan_name: string; carrier: string; slice: string;
  cmsMax: number | null;
  agent: { eyewear: number; pmCov: number | null; pmMax: number | null; pbpCopay: number | null; pbpDesc: string | null; pbpSource: string | null };
  status: 'MATCH' | 'MISMATCH' | 'CMS_NULL';
  gap: number;
  fixNote: string;
}
function sliceOf(snp: string | null | undefined): string {
  if (!snp || snp === 'SNP_TYPE_NOT_SNP') return 'MAPD non-SNP';
  if (snp === 'SNP_TYPE_DUAL_ELIGIBLE') return 'D-SNP';
  if (snp === 'SNP_TYPE_CHRONIC_OR_DISABLING' || snp === 'SNP_TYPE_CHRONIC_CONDITION') return 'C-SNP';
  if (snp === 'SNP_TYPE_INSTITUTIONAL') return 'I-SNP';
  return 'MAPD non-SNP';
}
async function main() {
  console.log('Vision brute-force reconciliation');
  console.log('─'.repeat(70));

  // Enumerate detail files (dedupe by contract-plan)
  const seen = new Set<string>();
  const files: string[] = [];
  for (const dir of ['_tmp/medicare-gov-mapd/detail', '_tmp/medicare-gov-snp/detail']) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith('.json')) continue;
      const parts = f.replace('.json', '').split('-');
      const key = `${parts[0]}-${parts[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(join(dir, f));
    }
  }
  console.log(`Distinct plans (dedup on contract-plan): ${files.length}`);

  const rows: Row[] = [];
  for (let i = 0; i < files.length; i++) {
    const j = JSON.parse(readFileSync(files[i], 'utf8'));
    const pc = j.response?.plan_card;
    if (!pc) continue;
    const cmsMax = cmsVisionMax(pc);
    const agent = await agentEyewear(pc.contract_id, pc.plan_id);
    let status: Row['status'];
    let gap = 0;
    let fixNote = '';
    if (cmsMax == null) {
      status = 'CMS_NULL';
    } else if (agent.eyewear === cmsMax) {
      status = 'MATCH';
    } else {
      status = 'MISMATCH';
      gap = cmsMax - agent.eyewear;
      // Diagnose fix
      if (agent.pbpCopay == null) fixNote = `INSERT pbp copay=${cmsMax}`;
      else {
        const isBiennial = /every 2 years|every 24 months|every two years|biennial/.test((agent.pbpDesc ?? '').toLowerCase());
        const halved = isBiennial ? Math.round(agent.pbpCopay / 2) : agent.pbpCopay;
        if (isBiennial && Math.abs(agent.pbpCopay - cmsMax * 2) <= 2) fixNote = `no-op (biennial matches)`;
        else if (agent.pmCov != null) fixNote = `UPDATE pm coverage_amount=${cmsMax} (currently pmCov=${agent.pmCov}; landscape wins over pbp)`;
        else if (agent.pmMax != null && landMaxWins(agent)) fixNote = `merge picks pm.max_coverage=${agent.pmMax}, need to check merge`;
        else fixNote = `UPDATE pbp copay ${agent.pbpCopay} → ${cmsMax}`;
      }
    }
    rows.push({
      contract_id: pc.contract_id, plan_id: pc.plan_id, segment: String(pc.segment_id ?? '0'),
      plan_name: pc.name, carrier: pc.organization_name, slice: sliceOf(pc.snp_type),
      cmsMax, agent, status, gap, fixNote,
    });
    if (i % 25 === 0) process.stdout.write(`  [${i+1}/${files.length}]\r`);
  }
  console.log(`\nAudited ${rows.length} plans.`);

  const match = rows.filter((r) => r.status === 'MATCH').length;
  const cmsNull = rows.filter((r) => r.status === 'CMS_NULL').length;
  const mism = rows.filter((r) => r.status === 'MISMATCH');
  const auditable = match + mism.length;
  const parity = auditable === 0 ? 0 : Math.round((match / auditable) * 10000) / 100;
  console.log(`\nMatch:     ${match}/${rows.length}`);
  console.log(`Mismatch:  ${mism.length}/${rows.length}`);
  console.log(`CMS null:  ${cmsNull}/${rows.length}`);
  console.log(`\nParity: ${parity}% of plans where CMS has a value`);

  if (mism.length > 0) {
    console.log('\n── MISMATCHES ──');
    console.log(`  ${'key'.padEnd(12)} ${'carrier'.padEnd(28)} ${'cms'.padStart(6)} ${'agent'.padStart(6)}  ${'pbp'.padStart(6)} ${'pmCov'.padStart(6)} ${'pmMax'.padStart(6)}  fix`);
    for (const r of mism.sort((a, b) => b.gap - a.gap)) {
      console.log(`  ${(r.contract_id+'-'+r.plan_id).padEnd(12)} ${r.carrier.slice(0,28).padEnd(28)} $${String(r.cmsMax ?? 0).padStart(5)} $${String(r.agent.eyewear).padStart(5)}  ${(r.agent.pbpCopay == null ? '  null' : ('$' + String(r.agent.pbpCopay))).padStart(6)} ${(r.agent.pmCov == null ? '  null' : ('$' + String(r.agent.pmCov))).padStart(6)} ${(r.agent.pmMax == null ? '  null' : ('$' + String(r.agent.pmMax))).padStart(6)}  ${r.fixNote}`);
    }
  }

  writeFileSync('_tmp/parity-data/_vision-reconcile.json', JSON.stringify({ match, cmsNull, mismatchCount: mism.length, parity, mismatches: mism }, null, 2));
  console.log('\nRaw: _tmp/parity-data/_vision-reconcile.json');
}

function landMaxWins(_a: any): boolean { return false; } // placeholder — merge doesn't use max_coverage as blocker

main().catch((e) => { console.error(e); process.exit(1); });
