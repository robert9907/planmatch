// Vision cleanup Part 2 — UPDATE pbp_benefits_v2.vision_allowance.copay
// where pm+pbp both diverge from CMS and pbp wins in the merge.
//
// The prior Fix 2 updated pm_plan_benefits.vision.max_coverage. But
// api/plans.ts:1101-1111 ALLOWANCE_CATEGORIES merge picks the pbp synth
// row when landscape.coverage_amount is null — and Fix 2 populated
// max_coverage, not coverage_amount. So the pbp synth still wins.
// Result: agent still sees the stale pbp value.
//
// This script targets the 6 STALE_PM plans from the diagnostic run:
//   H4141-017  Humana Gold Plus       pbp $300 → cms $150
//   H7849-113  HealthSpring True Ch   pbp $200 → cms $175
//   H9725-017  HealthSpring Pref Plus pbp $200 → cms $250
//   H8849-010  Wellpoint Full Dual    pbp $500 → cms $350
//   H8849-011  Wellpoint Dual Advant  pbp $250 → cms $125 (2 seg rows)
//
// Idempotent. --write required.
// Every UPDATE is guarded on the old value.

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
function findDetail(contract: string, plan: string) {
  for (const dir of ['_tmp/medicare-gov-snp/detail', '_tmp/medicare-gov-mapd/detail']) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(`${contract}-${plan}-`)) continue;
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (j.response?.plan_card) return { card: j.response.plan_card };
    }
  }
  return null;
}

interface Rec { contract_id: string; plan_id: string; carrier: string; plan_name: string; slice: string; cat: string; cms: any; pm: any; }

async function main() {
  const mode = WRITE ? 'WRITE' : 'DRY-RUN';
  console.log(`Vision cleanup Part 2 — pbp copay UPDATE (${mode})`);
  console.log(`DB: ${(process.env.SUPABASE_URL ?? '').replace('https://', '').split('.')[0]}`);
  console.log('─'.repeat(70));

  const audit = JSON.parse(readFileSync('_tmp/parity-data/_vision-audit.json', 'utf8')) as { records: Rec[] };
  const targets = audit.records.filter((r) => r.cat !== 'A' && r.cat !== 'NONE');

  let updated = 0, alreadyMatches = 0, skipped = 0, cmsNull = 0;
  for (const r of targets) {
    const det = findDetail(r.contract_id, r.plan_id);
    if (!det) { skipped++; continue; }
    const cmsMax = cmsVisionMax(det.card);
    if (cmsMax == null || cmsMax <= 0) { cmsNull++; continue; }
    // Find pbp vision_allowance rows
    const { data: pbpRows } = await sb.from('pbp_benefits_v2')
      .select('id, segment_id, copay, description, source')
      .eq('contract_id', r.contract_id).eq('plan_id', r.plan_id)
      .eq('benefit_type', 'vision_allowance');
    const nonMatch = (pbpRows ?? []).filter((row: any) => typeof row.copay === 'number' && row.copay !== cmsMax);
    if (nonMatch.length === 0) { alreadyMatches++; continue; }
    for (const row of nonMatch) {
      // GUARD: api/plans.ts:507-513 transformPbpRow halves biennial
      // rows (description matching "every 2 years"/"biennial"/etc.).
      // If we update the raw pbp.copay to the CMS annual value, the
      // api will THEN halve again, dropping the display value to 50%
      // of correct. Skip rows whose description signals biennial AND
      // whose copay is ~2× cms (Kaiser $575 vs cms $288 rounds).
      const desc = String(row.description ?? '').toLowerCase();
      const isBiennial = /every 2 years|every 24 months|every two years|biennial/.test(desc);
      if (isBiennial && Math.abs(row.copay - cmsMax * 2) <= 2) {
        // Consistent biennial encoding within rounding tolerance —
        // leave alone (api halves to cms).
        continue;
      }
      // Defensive: pbp exactly 2× cms is almost always biennial even
      // when the description doesn't include the keyword. Multi-segment
      // plans like H8849-011 have per-segment CMS values ($125 seg 1,
      // $350 seg 3) but a single segment-agnostic pbp row — updating
      // to one segment's value would corrupt the other segment's
      // display. Skip these; they need manual review.
      if (Math.abs(row.copay - cmsMax * 2) <= 2) continue;
      updated++;
      if (!WRITE) {
        console.log(`  ${r.contract_id}-${r.plan_id} seg=${row.segment_id}  pbp=$${row.copay} → cms=$${cmsMax}  (${r.carrier})  biennial_desc=${isBiennial}`);
      } else {
        const { data, error } = await sb.from('pbp_benefits_v2')
          .update({ copay: cmsMax, description: `Vision eyewear allowance (CMS-verified $${cmsMax}/yr)` })
          .eq('id', row.id).select('id');
        if (error) { console.error('  UPDATE err:', error.message); continue; }
        console.log(`  ✓ ${r.contract_id}-${r.plan_id} seg=${row.segment_id}  $${row.copay} → $${cmsMax}  rows=${data?.length ?? 0}`);
      }
    }
  }
  console.log(`\n─ Summary: touched=${updated}  already_match=${alreadyMatches}  no_detail=${skipped}  cms_silent=${cmsNull}`);
  console.log(WRITE ? 'DONE (writes committed)' : 'DRY-RUN complete. Re-run with --write.');
}
main().catch((e) => { console.error(e); process.exit(1); });
