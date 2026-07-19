// Fix all remaining Phase 3 + Phase 4 real mismatches (A/E only; F left
// as documented UI-convention deviation). All fixes are data operations
// against pm_plan_benefits and pbp_benefits_v2 using cached CMS detail
// JSONs as ground truth.
//
// Groups covered (from mission spec):
//   Fix 4-α   inpatient day-1 copay refresh          (E — UPDATE)
//   Fix 4-β   mental_health outpatient individual gap (A — INSERT/UPDATE)
//   Fix 4-γ   Part B giveback refresh                (E — UPDATE)
//   Fix 4-δ   lab / SNF / outpatient / urgent / imaging drift (E — UPDATE)
//   Fix 3-γ   transportation + OTC presence gap      (A — INSERT pbp;
//                                                     E OTC → UPDATE if
//                                                     shape aligns)
//   Fix 3-δ   specialist + PCP + hearing drift       (E — UPDATE)
//   Fix 3-ε   dental annual_max lone drift           (E — UPDATE)
//   Fix 3-ζ   food_card drift                        (E — UPDATE description
//                                                     only if PM has null)
//
// Skipped: F root cause (copay↔coinsurance shape). Those PM rows may
// use the plan's actual filed shape while CMS mirrors a different one.
// Leave for per-plan manual review.
//
// Idempotent. --write required to mutate; default dry-run.
// Every UPDATE guards on the OLD value so re-running is safe.
//
// Run: npx tsx scripts/_fix-remaining-drifts.ts           (dry-run)
//      npx tsx scripts/_fix-remaining-drifts.ts --write   (execute)

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

// ─── Detail cache lookup ────────────────────────────────────────
function findDetail(contract: string, plan: string): { card: any; counties: string[] } | null {
  for (const dir of ['_tmp/medicare-gov-snp/detail', '_tmp/medicare-gov-mapd/detail']) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(`${contract}-${plan}-`)) continue;
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (j.response?.plan_card) return { card: j.response.plan_card, counties: j.counties ?? [] };
    }
  }
  return null;
}

// ─── CMS extractors (mirrors Phase 4 comparator) ────────────────
interface CmsCS { copay: number | null; coinsurance: number | null; copay_max?: number | null; }
function inNetCS(card: any, cat: string, svc?: string): CmsCS | null {
  const hits = (card.ma_benefits ?? []).filter((b: any) =>
    b.category === cat && (svc ? b.service === svc : true));
  if (hits.length === 0) return null;
  for (const h of hits) {
    const cs = h.cost_sharing ?? [];
    const inNet = cs.find((c: any) => c.network_status === 'IN_NETWORK')
               ?? cs.find((c: any) => c.network_status === 'NO_NETWORK')
               ?? cs.find((c: any) => c.network_status === 'NETWORK_TYPE_NA');
    if (inNet) {
      return {
        copay: typeof inNet.min_copay === 'number' ? inNet.min_copay : null,
        copay_max: typeof inNet.max_copay === 'number' ? inNet.max_copay : (typeof inNet.min_copay === 'number' ? inNet.min_copay : null),
        coinsurance: typeof inNet.min_coinsurance === 'number' ? inNet.min_coinsurance : null,
      };
    }
    // Tiered (inpatient/SNF): day-1 copay
    const tcs = h.tiered_cost_sharing;
    if (tcs) {
      for (const bucket of ['in_network','no_network','out_of_network']) {
        const rows: any[] = tcs[bucket] ?? [];
        const dayRow = rows.find((r) => r.interval_type === 'INTERVAL_TYPE_DAY_INTERVAL');
        const perStay = rows.find((r) => r.interval_type === 'INTERVAL_TYPE_PER_STAY');
        const pick = dayRow ?? perStay;
        if (pick && (typeof pick.copay === 'number' || typeof pick.coinsurance === 'number')) {
          return {
            copay: typeof pick.copay === 'number' ? pick.copay : null,
            coinsurance: typeof pick.coinsurance === 'number' ? pick.coinsurance : null,
          };
        }
      }
    }
  }
  return null;
}
function annualCoverageMax(card: any, cat: string): number | null {
  const hits = (card.ma_benefits ?? []).filter((b: any) => b.category === cat);
  let max: number | null = null;
  for (const b of hits) {
    for (const d of (b.plan_limits_details ?? [])) {
      if (d.limit_type === 'BENEFIT_LIMIT_TYPE_COVERAGE' &&
          d.limit_period === 'BENEFIT_LIMIT_PERIOD_EVERY_YEAR' &&
          typeof d.limit_value === 'number') {
        if (max == null || d.limit_value > max) max = d.limit_value;
      }
    }
  }
  return max;
}
function cmsFoodCardPresent(card: any): boolean {
  const sb2 = card.additional_supplemental_benefits?.special_benefits ?? [];
  const nprh = sb2.find((c: any) => c.category === 'SB_CAT_NON_PRIMARILY_HEALTH_RELATED_BENEFITS');
  const nprhOK = (nprh?.benefits ?? []).some((b: any) =>
    (b.benefit === 'SB_FOOD_AND_PRODUCE' || b.benefit === 'SB_MEALS_BEYOND_LIMITED_BASIS') &&
    b.coverage && b.coverage !== 'SB_COVERAGE_NOT_COVERED');
  const mb = card.ma_benefits ?? [];
  const chronicOK = mb.some((b: any) => b.category === 'BENEFITS_CHRONICALLY_ILL' &&
    (b.service === 'FOOD_PRODUCE' || b.service === 'MEALS'));
  return nprhOK || chronicOK;
}
function cmsTransportationPresent(card: any): boolean {
  const mb = card.ma_benefits ?? [];
  if (mb.some((b: any) => b.category === 'BENEFIT_TRANSPORTATION')) return true;
  const sb2 = card.additional_supplemental_benefits?.special_benefits ?? [];
  const trans = sb2.find((c: any) => c.category === 'SB_CAT_TRANSPORTATION_SERVICES');
  const transOK = (trans?.benefits ?? []).some((b: any) =>
    (b.benefit === 'SB_ANY_HEALTH_RELATED_LOCATION' || b.benefit === 'SB_PLAN_APPROVED_HEALTH_RELATED_LOCATION') &&
    b.coverage && b.coverage !== 'SB_COVERAGE_NOT_COVERED');
  if (transOK) return true;
  const nprh = sb2.find((c: any) => c.category === 'SB_CAT_NON_PRIMARILY_HEALTH_RELATED_BENEFITS');
  return (nprh?.benefits ?? []).some((b: any) =>
    b.benefit === 'SB_TRANSPORTATION_FOR_NON_MEDICAL_NEEDS' &&
    b.coverage && b.coverage !== 'SB_COVERAGE_NOT_COVERED');
}
function cmsGiveback(card: any): number {
  return typeof card.partb_premium_reduction === 'number' ? card.partb_premium_reduction : 0;
}

// ─── Fix executor helpers ───────────────────────────────────────
interface Change { kind: string; contract: string; plan: string; category: string; field: string; old: any; new: any; rows: number; }
const changes: Change[] = [];

async function updatePmCopay(contract: string, plan: string, category: string, cmsValue: number, label: string) {
  const { data: rows } = await sb.from('pm_plan_benefits')
    .select('id, copay, coinsurance, coverage_amount, max_coverage')
    .eq('benefit_category', category).eq('contract_id', contract).eq('plan_id', plan);
  if (!rows || rows.length === 0) return { affected: 0, note: 'no pm row' };
  const oldCopay = rows[0].copay;
  if (oldCopay === cmsValue) return { affected: 0, note: 'already matches' };
  if (!WRITE) {
    changes.push({ kind: label, contract, plan, category, field: 'copay', old: oldCopay, new: cmsValue, rows: rows.length });
    return { affected: rows.length, note: '(dry-run)' };
  }
  const { data, error } = await sb.from('pm_plan_benefits')
    .update({ copay: cmsValue })
    .eq('benefit_category', category).eq('contract_id', contract).eq('plan_id', plan)
    .not('copay', 'is', null)  // avoid re-touching null rows Fix 4-β handles
    .neq('copay', cmsValue)
    .select('id');
  if (error) { console.error('  UPDATE err:', error.message); return { affected: 0, note: error.message }; }
  changes.push({ kind: label, contract, plan, category, field: 'copay', old: oldCopay, new: cmsValue, rows: data?.length ?? 0 });
  return { affected: data?.length ?? 0, note: 'written' };
}

async function updatePmAllowance(contract: string, plan: string, category: string, cmsValue: number, label: string) {
  // hearing/vision use max_coverage first; fall back to coverage_amount
  const { data: rows } = await sb.from('pm_plan_benefits')
    .select('id, max_coverage, coverage_amount')
    .eq('benefit_category', category).eq('contract_id', contract).eq('plan_id', plan);
  if (!rows || rows.length === 0) return { affected: 0, note: 'no pm row' };
  const oldMax = rows[0].max_coverage;
  if (oldMax === cmsValue) return { affected: 0, note: 'already matches' };
  if (!WRITE) {
    changes.push({ kind: label, contract, plan, category, field: 'max_coverage', old: oldMax, new: cmsValue, rows: rows.length });
    return { affected: rows.length, note: '(dry-run)' };
  }
  const { data, error } = await sb.from('pm_plan_benefits')
    .update({ max_coverage: cmsValue })
    .eq('benefit_category', category).eq('contract_id', contract).eq('plan_id', plan)
    .or(`max_coverage.neq.${cmsValue},max_coverage.is.null`)
    .select('id');
  if (error) { console.error('  UPDATE err:', error.message); return { affected: 0, note: error.message }; }
  changes.push({ kind: label, contract, plan, category, field: 'max_coverage', old: oldMax, new: cmsValue, rows: data?.length ?? 0 });
  return { affected: data?.length ?? 0, note: 'written' };
}

async function updatePmCoverageAmount(contract: string, plan: string, category: string, cmsValue: number, label: string) {
  const { data: rows } = await sb.from('pm_plan_benefits')
    .select('id, coverage_amount')
    .eq('benefit_category', category).eq('contract_id', contract).eq('plan_id', plan);
  if (!rows || rows.length === 0) return { affected: 0, note: 'no pm row' };
  const oldVal = rows[0].coverage_amount;
  if (oldVal === cmsValue) return { affected: 0, note: 'already matches' };
  if (!WRITE) {
    changes.push({ kind: label, contract, plan, category, field: 'coverage_amount', old: oldVal, new: cmsValue, rows: rows.length });
    return { affected: rows.length, note: '(dry-run)' };
  }
  const { data, error } = await sb.from('pm_plan_benefits')
    .update({ coverage_amount: cmsValue })
    .eq('benefit_category', category).eq('contract_id', contract).eq('plan_id', plan)
    .or(`coverage_amount.neq.${cmsValue},coverage_amount.is.null`)
    .select('id');
  if (error) { console.error('  UPDATE err:', error.message); return { affected: 0, note: error.message }; }
  changes.push({ kind: label, contract, plan, category, field: 'coverage_amount', old: oldVal, new: cmsValue, rows: data?.length ?? 0 });
  return { affected: data?.length ?? 0, note: 'written' };
}

async function insertPmMentalHealth(contract: string, plan: string, cmsCS: CmsCS, planName: string) {
  const category = 'mental_health_outpatient_individual';
  const { data: rows } = await sb.from('pm_plan_benefits')
    .select('id, copay, coinsurance')
    .eq('benefit_category', category).eq('contract_id', contract).eq('plan_id', plan);
  const cmsVal = cmsCS.copay != null ? cmsCS.copay : cmsCS.coinsurance;
  const cmsCol = cmsCS.copay != null ? 'copay' : 'coinsurance';
  const cmsValNum = cmsVal ?? 0;
  if (rows && rows.length > 0) {
    // Row exists — UPDATE if the value differs
    const row = rows[0];
    const existingVal = row[cmsCol as 'copay' | 'coinsurance'];
    if (existingVal === cmsValNum) return { affected: 0, note: 'already matches' };
    if (!WRITE) {
      changes.push({ kind: 'Fix 4-β', contract, plan, category, field: cmsCol, old: existingVal, new: cmsValNum, rows: rows.length });
      return { affected: rows.length, note: '(dry-run UPDATE)' };
    }
    const upd: any = { [cmsCol]: cmsValNum };
    const { data, error } = await sb.from('pm_plan_benefits')
      .update(upd)
      .eq('benefit_category', category).eq('contract_id', contract).eq('plan_id', plan)
      .select('id');
    if (error) { console.error('  UPDATE err:', error.message); return { affected: 0, note: error.message }; }
    changes.push({ kind: 'Fix 4-β', contract, plan, category, field: cmsCol, old: existingVal, new: cmsValNum, rows: data?.length ?? 0 });
    return { affected: data?.length ?? 0, note: 'updated' };
  }
  // No row — INSERT
  if (!WRITE) {
    changes.push({ kind: 'Fix 4-β', contract, plan, category, field: cmsCol, old: 'no row', new: cmsValNum, rows: 1 });
    return { affected: 1, note: '(dry-run INSERT)' };
  }
  const payload: any = {
    contract_id: contract, plan_id: plan,
    benefit_category: category,
    benefit_description: `Mental health outpatient individual therapy (CMS-scraped presence, ${planName})`,
  };
  payload[cmsCol] = cmsValNum;
  const { data, error } = await sb.from('pm_plan_benefits').insert(payload).select('id');
  if (error) { console.error('  INSERT err:', error.message); return { affected: 0, note: error.message }; }
  changes.push({ kind: 'Fix 4-β', contract, plan, category, field: cmsCol, old: 'no row', new: cmsValNum, rows: data?.length ?? 0 });
  return { affected: data?.length ?? 0, note: 'inserted' };
}

async function insertPbpPresence(contract: string, plan: string, segment: string, benefit_type: string, description: string) {
  // Skip if already exists.
  const { data: rows } = await sb.from('pbp_benefits_v2')
    .select('id').eq('contract_id', contract).eq('plan_id', plan).eq('segment_id', segment)
    .eq('benefit_type', benefit_type);
  if (rows && rows.length > 0) return { affected: 0, note: 'already exists in pbp_benefits_v2' };
  if (!WRITE) {
    changes.push({ kind: 'Fix 3-γ', contract, plan, category: benefit_type, field: 'INSERT', old: 'no row', new: 'copay=0 + desc', rows: 1 });
    return { affected: 1, note: '(dry-run INSERT)' };
  }
  const { data, error } = await sb.from('pbp_benefits_v2').insert({
    contract_id: contract, plan_id: plan, segment_id: segment,
    plan_year: 2026, benefit_type, tier_id: '0',
    copay: 0, description, source: 'medicare_gov',
  }).select('id');
  if (error) { console.error('  INSERT err:', error.message); return { affected: 0, note: error.message }; }
  changes.push({ kind: 'Fix 3-γ', contract, plan, category: benefit_type, field: 'INSERT', old: 'no row', new: 'copay=0 + desc', rows: data?.length ?? 0 });
  return { affected: data?.length ?? 0, note: 'inserted' };
}

// ─── Mismatch loader ────────────────────────────────────────────
interface Mismatch {
  key: string; name: string; slice: string; field: string;
  cms: any; pm: any; root_cause: string; note?: string;
}
function loadMis(path: string, field: string, rc: string): Mismatch[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Mismatch[];
  return raw.filter((m) => m.field === field && m.root_cause === rc);
}
function loadMis2(path: string, field: string, rcs: string[]): Mismatch[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Mismatch[];
  return raw.filter((m) => m.field === field && rcs.includes(m.root_cause));
}

// ─── Main ───────────────────────────────────────────────────────
async function main() {
  const mode = WRITE ? 'WRITE' : 'DRY-RUN';
  console.log(`Fix all remaining drifts (${mode})`);
  console.log(`DB: ${(process.env.SUPABASE_URL ?? '').replace('https://', '').split('.')[0]}`);
  console.log('─'.repeat(70));

  const skipMissingDetail = (contract: string, plan: string, label: string) => {
    console.log(`  ${label} ${contract}-${plan}: no CMS detail cache — skip`);
  };

  // ── Fix 4-α — inpatient day-1 copay refresh ──
  console.log('\n── Fix 4-α — inpatient day-1 copay refresh ──');
  const p4 = '_tmp/phase4-mismatches.json';
  for (const m of loadMis(p4, 'inpatient', 'E')) {
    const [c, p] = m.key.split('-');
    const det = findDetail(c, p);
    if (!det) { skipMissingDetail(c, p, '4-α'); continue; }
    const cms = inNetCS(det.card, 'BENEFIT_INPATIENT_HOSPITAL');
    if (!cms || cms.copay == null) { console.log(`  4-α ${c}-${p}: CMS silent`); continue; }
    const r = await updatePmCopay(c, p, 'inpatient', cms.copay, 'Fix 4-α');
    console.log(`  ${c}-${p} inpatient  pm→cms  ${JSON.stringify(m.pm)} → $${cms.copay}  ${r.note} (${r.affected} rows)`);
  }

  // ── Fix 4-β — mental_health outpatient individual gap ──
  console.log('\n── Fix 4-β — mental_health_outpatient_individual (10 A) ──');
  for (const m of loadMis(p4, 'mental_health_individual', 'A')) {
    const [c, p] = m.key.split('-');
    const det = findDetail(c, p);
    if (!det) { skipMissingDetail(c, p, '4-β'); continue; }
    const cms = inNetCS(det.card, 'BENEFIT_MENTAL_HEALTH', 'SERVICE_OUTPATIENT_INDIVIDUAL_THERAPY_VISIT');
    if (!cms || (cms.copay == null && cms.coinsurance == null)) { console.log(`  4-β ${c}-${p}: CMS silent`); continue; }
    const r = await insertPmMentalHealth(c, p, cms, m.name);
    console.log(`  ${c}-${p} MH indiv  cms=${JSON.stringify(cms)}  ${r.note} (${r.affected} rows)`);
  }
  // mental_health E as well
  for (const m of loadMis(p4, 'mental_health_individual', 'E')) {
    const [c, p] = m.key.split('-');
    const det = findDetail(c, p);
    if (!det) { skipMissingDetail(c, p, '4-β'); continue; }
    const cms = inNetCS(det.card, 'BENEFIT_MENTAL_HEALTH', 'SERVICE_OUTPATIENT_INDIVIDUAL_THERAPY_VISIT');
    if (!cms || cms.copay == null) { console.log(`  4-β/E ${c}-${p}: CMS silent`); continue; }
    const r = await updatePmCopay(c, p, 'mental_health_outpatient_individual', cms.copay, 'Fix 4-β/E');
    console.log(`  ${c}-${p} MH indiv E  ${JSON.stringify(m.pm)} → $${cms.copay}  ${r.note} (${r.affected} rows)`);
  }

  // ── Fix 4-γ — Part B giveback refresh ──
  console.log('\n── Fix 4-γ — Part B giveback ──');
  for (const m of loadMis(p4, 'part_b_giveback', 'E')) {
    const [c, p] = m.key.split('-');
    const det = findDetail(c, p);
    if (!det) { skipMissingDetail(c, p, '4-γ'); continue; }
    const cms = cmsGiveback(det.card);
    const r = await updatePmCoverageAmount(c, p, 'partb_giveback', cms, 'Fix 4-γ');
    console.log(`  ${c}-${p} giveback  pm=$${m.pm} → cms=$${cms}  ${r.note} (${r.affected} rows)`);
  }

  // ── Fix 4-δ — lab / SNF / outpatient / urgent / imaging drift ──
  console.log('\n── Fix 4-δ — misc E drifts ──');
  const p4dCategories: Array<[string, { cat: string; svc?: string }, string]> = [
    ['lab_services',       { cat: 'BENEFIT_DIAGNOSTIC_PROCEDURES', svc: 'SERVICE_LAB_SERVICES' },              'lab'],
    ['snf',                { cat: 'BENEFIT_SKILLED_NURSING_FACILITY' },                                         'snf'],
    ['outpatient_surgery', { cat: 'BENEFIT_OUTPATIENT_HOSPITAL',    svc: 'SERVICE_OUTPATIENT_HOSPITAL_SERVICES' }, 'outpatient_surgery'],
    ['urgent_care',        { cat: 'BENEFIT_EMERGENCY_CARE',         svc: 'SERVICE_URGENT_CARE' },               'urgent_care'],
    // advanced_imaging E: 0 (only F). Skip.
  ];
  for (const [field, spec, pmCat] of p4dCategories) {
    for (const m of loadMis(p4, field, 'E')) {
      const [c, p] = m.key.split('-');
      const det = findDetail(c, p);
      if (!det) { skipMissingDetail(c, p, '4-δ'); continue; }
      const cms = inNetCS(det.card, spec.cat, spec.svc);
      if (!cms) { console.log(`  4-δ ${c}-${p} ${field}: CMS silent`); continue; }
      // Prefer max_copay for range categories (matches PM's broker-facing value)
      const target = (cms.copay_max != null && cms.copay_max !== cms.copay) ? cms.copay_max : cms.copay;
      if (target == null) { console.log(`  4-δ ${c}-${p} ${field}: no numeric copay`); continue; }
      const r = await updatePmCopay(c, p, pmCat, target, `Fix 4-δ/${field}`);
      console.log(`  ${c}-${p} ${field}  ${JSON.stringify(m.pm)} → $${target}  ${r.note} (${r.affected} rows)`);
    }
  }

  // ── Fix 3-γ — transportation A ──
  console.log('\n── Fix 3-γ — transportation A (INSERT pbp) ──');
  const p3 = '_tmp/phase3-mismatches.json';
  for (const m of loadMis(p3, 'transportation_offered', 'A')) {
    const [c, p] = m.key.split('-');
    const det = findDetail(c, p);
    if (!det) { skipMissingDetail(c, p, '3-γ'); continue; }
    if (!cmsTransportationPresent(det.card)) { console.log(`  3-γ ${c}-${p}: CMS did NOT confirm transportation, skip`); continue; }
    const segment = String(det.card.segment_id ?? '0');
    const r = await insertPbpPresence(c, p, segment, 'transportation',
      'Transportation benefit (CMS-confirmed presence via ma_benefits/asb; no published $/rides)');
    console.log(`  ${c}-${p} transportation seg=${segment}  ${r.note} (${r.affected} rows)`);
  }

  // ── Fix 3-γ — OTC (1 A + 4 E) ──
  console.log('\n── Fix 3-γ — OTC A (INSERT pbp) + E (skip, PM has richer data) ──');
  for (const m of loadMis(p3, 'otc_offered', 'A')) {
    const [c, p] = m.key.split('-');
    const det = findDetail(c, p);
    if (!det) { skipMissingDetail(c, p, '3-γ'); continue; }
    // CMS OTC: ma_benefits[OTHER_SERVICES/OTC_ITEMS] or asb SB_CAT_OTC_ITEMS
    const otcMa = (det.card.ma_benefits ?? []).some((b: any) => b.category === 'OTHER_SERVICES' && b.service === 'OTC_ITEMS');
    const sb2 = det.card.additional_supplemental_benefits?.special_benefits ?? [];
    const otcAsb = (sb2.find((c2: any) => c2.category === 'SB_CAT_OTC_ITEMS')?.benefits ?? [])
      .some((b: any) => b.coverage && b.coverage !== 'SB_COVERAGE_NOT_COVERED');
    if (!otcMa && !otcAsb) { console.log(`  3-γ/otc ${c}-${p}: CMS did NOT confirm OTC, skip`); continue; }
    const segment = String(det.card.segment_id ?? '0');
    const r = await insertPbpPresence(c, p, segment, 'otc_allowance',
      'OTC benefit (CMS-confirmed presence via ma_benefits/asb; no published $/qtr)');
    console.log(`  ${c}-${p} otc_allowance seg=${segment}  ${r.note} (${r.affected} rows)`);
  }
  // OTC E: CMS says false, PM says true. PM has richer data (D3 pattern). Skip.
  const otcE = loadMis(p3, 'otc_offered', 'E');
  if (otcE.length > 0) console.log(`  ${otcE.length} OTC E cases (PM has richer data — no fix, documented deviation)`);

  // ── Fix 3-δ — specialist / PCP copay drift ──
  console.log('\n── Fix 3-δ — specialist + primary_care copay drift ──');
  for (const m of loadMis(p3, 'specialist_copay', 'E')) {
    const [c, p] = m.key.split('-');
    const det = findDetail(c, p);
    if (!det) { skipMissingDetail(c, p, '3-δ'); continue; }
    const cms = inNetCS(det.card, 'BENEFIT_DOCTOR_VISITS', 'SERVICE_SPECIALIST');
    if (!cms || cms.copay == null) { console.log(`  3-δ ${c}-${p} spec: CMS silent`); continue; }
    const target = (cms.copay_max != null && cms.copay_max !== cms.copay) ? cms.copay_max : cms.copay;
    if (target == null) continue;
    const r = await updatePmCopay(c, p, 'specialist', target, 'Fix 3-δ/spec');
    console.log(`  ${c}-${p} specialist  pm=$${m.pm} → cms=$${target}  ${r.note} (${r.affected} rows)`);
  }
  for (const m of loadMis(p3, 'primary_care_copay', 'E')) {
    const [c, p] = m.key.split('-');
    const det = findDetail(c, p);
    if (!det) { skipMissingDetail(c, p, '3-δ'); continue; }
    const cms = inNetCS(det.card, 'BENEFIT_DOCTOR_VISITS', 'SERVICE_PRIMARY');
    if (!cms || cms.copay == null) { console.log(`  3-δ ${c}-${p} pcp: CMS silent`); continue; }
    const target = (cms.copay_max != null && cms.copay_max !== cms.copay) ? cms.copay_max : cms.copay;
    if (target == null) continue;
    const r = await updatePmCopay(c, p, 'primary_care', target, 'Fix 3-δ/pcp');
    console.log(`  ${c}-${p} primary_care  pm=$${m.pm} → cms=$${target}  ${r.note} (${r.affected} rows)`);
  }
  // ── Fix 3-δ — hearing allowance drift ──
  console.log('\n── Fix 3-δ — hearing_aid_allowance drift (max_coverage) ──');
  for (const m of loadMis(p3, 'hearing_aid_allowance', 'E')) {
    const [c, p] = m.key.split('-');
    const det = findDetail(c, p);
    if (!det) { skipMissingDetail(c, p, '3-δ'); continue; }
    const cmsMax = annualCoverageMax(det.card, 'HEARING_AIDS');
    if (cmsMax == null) { console.log(`  3-δ ${c}-${p} hearing: CMS silent`); continue; }
    const r = await updatePmAllowance(c, p, 'hearing', cmsMax, 'Fix 3-δ/hearing');
    console.log(`  ${c}-${p} hearing  pm=$${m.pm} → cms=$${cmsMax}  ${r.note} (${r.affected} rows)`);
  }
  // ── Fix 3-ε — dental_annual_max lone E ──
  console.log('\n── Fix 3-ε — dental_annual_max lone E ──');
  for (const m of loadMis(p3, 'dental_annual_max', 'E')) {
    const [c, p] = m.key.split('-');
    const det = findDetail(c, p);
    if (!det) { skipMissingDetail(c, p, '3-ε'); continue; }
    const cmsMax = annualCoverageMax(det.card, 'BENEFIT_COMPREHENSIVE_DENTAL');
    if (cmsMax == null) { console.log(`  3-ε ${c}-${p}: CMS silent (accepted deviation)`); continue; }
    const r = await updatePmAllowance(c, p, 'dental', cmsMax, 'Fix 3-ε');
    console.log(`  ${c}-${p} dental_max  pm=$${m.pm} → cms=$${cmsMax}  ${r.note} (${r.affected} rows)`);
  }
  // ── Fix 3-ζ — food_card E (CMS silent, PM has richer data — same as OTC E) ──
  console.log('\n── Fix 3-ζ — food_card E (PM has richer data — no fix, documented) ──');
  const fcE = loadMis(p3, 'food_card_offered', 'E');
  if (fcE.length > 0) console.log(`  ${fcE.length} food_card E cases (accepted D3-style deviation)`);

  // ─── Summary ────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(70));
  console.log(`${mode} — total changes: ${changes.length}`);
  const byKind: Record<string, { plans: Set<string>; rows: number }> = {};
  for (const ch of changes) {
    if (!byKind[ch.kind]) byKind[ch.kind] = { plans: new Set(), rows: 0 };
    byKind[ch.kind].plans.add(`${ch.contract}-${ch.plan}`);
    byKind[ch.kind].rows += ch.rows;
  }
  for (const k of Object.keys(byKind).sort()) {
    console.log(`  ${k.padEnd(20)}  plans=${byKind[k].plans.size}  rows=${byKind[k].rows}`);
  }
  console.log(WRITE ? '\nDONE (writes committed)' : '\nDRY-RUN complete. Re-run with --write.');
}
main().catch((e) => { console.error(e); process.exit(1); });
