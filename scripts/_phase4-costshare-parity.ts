// Phase 4 — cost-share + drug tier + Part B giveback parity audit.
//
// 14 fields × 279 plans (146 MAPD non-SNP + 133 SNP).
// Reuses cached CMS plan-detail responses from Phase 2/3 scrapes.
// Read-only against pm_plan_benefits + pm_plans. No writes.
//
// ── PM lookup (Step 1) ──────────────────────────────────────────
// All via costShareFor(rows, category) at api/plans.ts:1282, which
// reads r.copay / r.coinsurance from the first pm_plan_benefits
// row where benefit_category === (CATEGORY_ALIAS[cat] ?? cat).
//
//   1  inpatient                       cat='inpatient'
//   2  outpatient_surgery_hospital     cat='outpatient_surgery_hospital'
//                                       → alias → 'outpatient_surgery'
//   3  emergency                       cat='emergency'
//   4  urgent_care                     cat='urgent_care'
//   5  lab_services                    cat='lab_services' → alias → 'lab'
//   6  advanced_imaging                cat='advanced_imaging'
//   7  mental_health_individual        cat='mental_health_individual'
//                                       → alias → 'mental_health_outpatient_individual'
//   8  snf                             cat='snf'
//
//   9-13 rx_tier_1..rx_tier_5          cat='rx_tier_N'  (direct, no alias)
//
//   14 part_b_giveback                 pickBenefitNumber(rows,
//                                       'partb_giveback', 'coverage_amount')
//                                       → surfaced as top-level Plan.
//                                       part_b_giveback (int dollars)
//
// ── CMS lookup (Step 2) ─────────────────────────────────────────
// Medical (1-8): plan_card.ma_benefits[].{category, service,
//    cost_sharing[network_status='IN_NETWORK'].min_copay|min_coinsurance}
//
//   1  BENEFIT_INPATIENT_HOSPITAL / INPATIENT_HOSPITAL
//   2  BENEFIT_OUTPATIENT_HOSPITAL / SERVICE_OUTPATIENT_HOSPITAL_SERVICES
//   3  BENEFIT_EMERGENCY_CARE / SERVICE_EMERGENCY
//   4  BENEFIT_EMERGENCY_CARE / SERVICE_URGENT_CARE
//   5  BENEFIT_DIAGNOSTIC_PROCEDURES / SERVICE_LAB_SERVICES
//   6  BENEFIT_DIAGNOSTIC_PROCEDURES / SERVICE_DIAGNOSTIC_RADIOLOGY_SERVICES
//   7  BENEFIT_MENTAL_HEALTH / SERVICE_OUTPATIENT_INDIVIDUAL_THERAPY_VISIT
//   8  BENEFIT_SKILLED_NURSING_FACILITY / SKILLED_NURSING_FACILITY
//
// Drug tiers (9-13): plan_card.abstract_benefits.initial_coverage
//    .tiers[].label + .preferred_retail.days_30
//    Format: "$18.00 copay" or "20% coinsurance" or "" (unavailable)
//   9  COST_SHARE_TIER_PREFERRED_GENERIC → rx_tier_1
//  10  COST_SHARE_TIER_GENERIC          → rx_tier_2
//  11  COST_SHARE_TIER_PREFERRED_BRAND  → rx_tier_3
//  12  COST_SHARE_TIER_NON_PREFERRED_DRUG → rx_tier_4
//  13  COST_SHARE_TIER_SPECIALTY         → rx_tier_5
//
// Giveback: plan_card.partb_premium_reduction (int dollars/mo)
//
// Root causes: A/B/C/D/E from Phase 3, plus:
//   F = format mismatch (copay↔coinsurance representation, same rate)
//
// Run: npx tsx scripts/_phase4-costshare-parity.ts

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
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

// ─── Field spec ──────────────────────────────────────────────────
type FieldKey =
  | 'inpatient' | 'outpatient_surgery' | 'emergency' | 'urgent_care'
  | 'lab_services' | 'advanced_imaging' | 'mental_health_individual' | 'snf'
  | 'rx_tier_1' | 'rx_tier_2' | 'rx_tier_3' | 'rx_tier_4' | 'rx_tier_5'
  | 'part_b_giveback';
const FIELDS: FieldKey[] = [
  'inpatient','outpatient_surgery','emergency','urgent_care',
  'lab_services','advanced_imaging','mental_health_individual','snf',
  'rx_tier_1','rx_tier_2','rx_tier_3','rx_tier_4','rx_tier_5',
  'part_b_giveback',
];

// PM: category to look up in pm_plan_benefits (after alias)
const PM_CATEGORY: Record<FieldKey, string> = {
  inpatient: 'inpatient',
  outpatient_surgery: 'outpatient_surgery',
  emergency: 'emergency',
  urgent_care: 'urgent_care',
  lab_services: 'lab',
  advanced_imaging: 'advanced_imaging',
  mental_health_individual: 'mental_health_outpatient_individual',
  snf: 'snf',
  rx_tier_1: 'rx_tier_1',
  rx_tier_2: 'rx_tier_2',
  rx_tier_3: 'rx_tier_3',
  rx_tier_4: 'rx_tier_4',
  rx_tier_5: 'rx_tier_5',
  part_b_giveback: 'partb_giveback',
};

// CMS: ma_benefits category + service
const CMS_MA_SPEC: Partial<Record<FieldKey, { cat: string; svc?: string }>> = {
  inpatient:                { cat: 'BENEFIT_INPATIENT_HOSPITAL' },
  outpatient_surgery:       { cat: 'BENEFIT_OUTPATIENT_HOSPITAL',   svc: 'SERVICE_OUTPATIENT_HOSPITAL_SERVICES' },
  emergency:                { cat: 'BENEFIT_EMERGENCY_CARE',        svc: 'SERVICE_EMERGENCY' },
  urgent_care:              { cat: 'BENEFIT_EMERGENCY_CARE',        svc: 'SERVICE_URGENT_CARE' },
  lab_services:             { cat: 'BENEFIT_DIAGNOSTIC_PROCEDURES', svc: 'SERVICE_LAB_SERVICES' },
  advanced_imaging:         { cat: 'BENEFIT_DIAGNOSTIC_PROCEDURES', svc: 'SERVICE_DIAGNOSTIC_RADIOLOGY_SERVICES' },
  mental_health_individual: { cat: 'BENEFIT_MENTAL_HEALTH',         svc: 'SERVICE_OUTPATIENT_INDIVIDUAL_THERAPY_VISIT' },
  snf:                      { cat: 'BENEFIT_SKILLED_NURSING_FACILITY' },
};

// CMS: drug tier label
const CMS_TIER_LABEL: Partial<Record<FieldKey, string>> = {
  rx_tier_1: 'COST_SHARE_TIER_PREFERRED_GENERIC',
  rx_tier_2: 'COST_SHARE_TIER_GENERIC',
  rx_tier_3: 'COST_SHARE_TIER_PREFERRED_BRAND',
  rx_tier_4: 'COST_SHARE_TIER_NON_PREFERRED_DRUG',
  rx_tier_5: 'COST_SHARE_TIER_SPECIALTY',
};

// ─── CMS extractors ──────────────────────────────────────────────
interface CostShare {
  copay: number | null;
  coinsurance: number | null;
  // Range shape — CMS often emits min/max for categories with multiple
  // services (imaging, outpatient surgery, mental_health). PM stores
  // a single quoted value that's usually the MAX (broker-facing "up
  // to $X"). Comparator accepts PM values in [min, max].
  copay_max?: number | null;
  coinsurance_max?: number | null;
}
function inNetCostShareFromMa(planCard: any, spec: { cat: string; svc?: string }): CostShare | null {
  const hits = (planCard.ma_benefits ?? []).filter((b: any) =>
    b.category === spec.cat && (spec.svc ? b.service === spec.svc : true));
  if (hits.length === 0) return null;
  // HMO plans emit network_status='NO_NETWORK' (they have no OON
  // distinction). PPOs and D-SNPs emit both IN_NETWORK and
  // OUT_OF_NETWORK. Prefer IN_NETWORK when present; fall back to
  // NO_NETWORK for HMO-shaped plans. Then NA as last resort.
  for (const h of hits) {
    const cs = h.cost_sharing ?? [];
    const inNet = cs.find((c: any) => c.network_status === 'IN_NETWORK')
               ?? cs.find((c: any) => c.network_status === 'NO_NETWORK')
               ?? cs.find((c: any) => c.network_status === 'NETWORK_TYPE_NA');
    if (inNet) {
      const copayMin = inNet.min_copay;
      const copayMax = inNet.max_copay;
      const coinsMin = inNet.min_coinsurance;
      const coinsMax = inNet.max_coinsurance;
      return {
        copay: typeof copayMin === 'number' ? copayMin : null,
        copay_max: typeof copayMax === 'number' ? copayMax : (typeof copayMin === 'number' ? copayMin : null),
        coinsurance: typeof coinsMin === 'number' ? coinsMin : null,
        coinsurance_max: typeof coinsMax === 'number' ? coinsMax : (typeof coinsMin === 'number' ? coinsMin : null),
      };
    }
    // Some categories (inpatient, SNF) use tiered_cost_sharing
    // instead of cost_sharing. Return the FIRST day-interval tier's
    // copay — matches pm_plan_benefits.copay which stores day-1
    // copay per api/plans.ts:1570 comment. Prefer in_network → no_network.
    const tcs = h.tiered_cost_sharing;
    if (tcs) {
      const buckets = ['in_network', 'no_network', 'out_of_network'];
      for (const bucket of buckets) {
        const rows: any[] = tcs[bucket] ?? [];
        // Take the first DAY_INTERVAL tier's copay (day-1 or lowest
        // interval like "1-5"). Skip PER_STAY unless it's the only shape.
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
// Parse CMS drug tier string "$18.00 copay" or "20% coinsurance"
function parseTierString(s: string): CostShare | null {
  if (!s || s.trim() === '') return null;
  const copayMatch = s.match(/\$?([\d.,]+)\s*copay/i);
  if (copayMatch) return { copay: Number(copayMatch[1].replace(/,/g, '')), coinsurance: null };
  const coinsMatch = s.match(/([\d.]+)\s*%\s*coinsurance/i);
  if (coinsMatch) return { copay: null, coinsurance: Number(coinsMatch[1]) };
  // Sometimes CMS emits "$X.XX copay after deductible" — still copay
  const numMatch = s.match(/\$?([\d.,]+)/);
  if (numMatch) return { copay: Number(numMatch[1].replace(/,/g, '')), coinsurance: null };
  return null;
}
function cmsDrugTier(planCard: any, label: string): CostShare | null {
  const tiers = planCard.abstract_benefits?.initial_coverage?.tiers ?? [];
  const t = tiers.find((x: any) => x.label === label);
  if (!t) return null;
  // Fall through pharmacy shapes: preferred_retail is null on many
  // HMO plans that only file standard_retail or mail_order. Take the
  // 30-day preferred value where available; otherwise standard.
  const paths = [
    t.preferred_retail?.days_30,
    t.standard_retail?.days_30,
    t.preferred_mail_order?.days_30,
    t.standard_mail_order?.days_30,
    // 90-day paths as last resort — some plans only file 90-day.
    t.preferred_retail?.days_90,
    t.standard_retail?.days_90,
    t.preferred_mail_order?.days_90,
    t.standard_mail_order?.days_90,
  ];
  for (const s of paths) {
    if (!s || String(s).trim() === '') continue;
    const parsed = parseTierString(String(s));
    if (parsed) return parsed;
  }
  return null;
}
function cmsGiveback(planCard: any): number {
  return typeof planCard.partb_premium_reduction === 'number' ? planCard.partb_premium_reduction : 0;
}

function extractCmsField(planCard: any, f: FieldKey): CostShare | number | null {
  if (f === 'part_b_giveback') return cmsGiveback(planCard);
  if (CMS_TIER_LABEL[f]) return cmsDrugTier(planCard, CMS_TIER_LABEL[f]!);
  const spec = CMS_MA_SPEC[f];
  if (!spec) return null;
  return inNetCostShareFromMa(planCard, spec);
}

// ─── PM loader ───────────────────────────────────────────────────
async function loadPmRows(contract_id: string, plan_id: string): Promise<any[]> {
  const { data } = await sb.from('pm_plan_benefits')
    .select('benefit_category, copay, coinsurance, coverage_amount, benefit_description')
    .eq('contract_id', contract_id).eq('plan_id', plan_id);
  return data ?? [];
}
function toNum(v: any): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return isFinite(n) ? n : null;
}
function extractPmField(rows: any[], f: FieldKey): CostShare | number | null {
  const cat = PM_CATEGORY[f];
  const row = rows.find((r) => r.benefit_category === cat);
  if (!row) return null;
  if (f === 'part_b_giveback') return toNum(row.coverage_amount) ?? 0;
  return { copay: toNum(row.copay), coinsurance: toNum(row.coinsurance) };
}

// ─── Compare / classify ─────────────────────────────────────────
type Rc = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'NONE';
interface Diff { field: FieldKey; cms: any; pm: any; root_cause: Rc; note?: string; }

// Range-inclusive comparison. CMS emits min/max for categories with
// multi-service ranges (imaging, outpatient_surgery); PM stores the
// broker-facing single value (usually max). A match holds when PM's
// value falls within CMS's [min, max] window. Exact-value equality
// is the special case where min===max.
function inRange(pmVal: number | null, min: number | null | undefined, max: number | null | undefined): boolean {
  if (pmVal == null) return false;
  const lo = typeof min === 'number' ? min : null;
  const hi = typeof max === 'number' ? max : null;
  if (lo == null && hi == null) return false;
  if (lo != null && pmVal < lo) return false;
  if (hi != null && pmVal > hi) return false;
  return true;
}
function costShareEqual(a: CostShare | null, b: CostShare | null): 'match' | 'null-vs-value' | 'format' | 'drift' | 'both-null' {
  if (!a && !b) return 'both-null';
  if (!a || !b) return 'null-vs-value';
  const ac = a.copay, aco = a.coinsurance;
  const acM = a.copay_max ?? a.copay;
  const acoM = a.coinsurance_max ?? a.coinsurance;
  const bc = b.copay, bco = b.coinsurance;
  // Copay range-inclusive: PM copay falls in CMS [min, max]
  if (bc != null && (ac != null || acM != null) && inRange(bc, ac, acM)) return 'match';
  // Coinsurance range-inclusive
  if (bco != null && (aco != null || acoM != null) && inRange(bco, aco, acoM)) return 'match';
  // Format mismatch (copay↔coinsurance) — one has copay, other coins
  const aOnlyCopay = ac != null && aco == null;
  const bOnlyCoins = bc == null && bco != null;
  if (aOnlyCopay && bOnlyCoins) return 'format';
  const aOnlyCoins = aco != null && ac == null;
  const bOnlyCopay = bc != null && bco == null;
  if (aOnlyCoins && bOnlyCopay) return 'format';
  // Both same shape, out of range → drift
  return 'drift';
}

function classify(f: FieldKey, cms: any, pm: any, pmRows: any[]): Diff | null {
  if (f === 'part_b_giveback') {
    const cmsN = typeof cms === 'number' ? cms : 0;
    const pmN  = typeof pm === 'number' ? pm : 0;
    if (cmsN === pmN) return null;
    // If PM row missing and CMS says 0 → both effectively 0 → match
    if (cmsN === 0 && pm === null) return null;
    const row = pmRows.find((r) => r.benefit_category === 'partb_giveback');
    if (cmsN > 0 && pm === null) return { field: f, cms: cmsN, pm, root_cause: row ? 'C' : 'A' };
    return { field: f, cms: cmsN, pm: pmN, root_cause: 'E' };
  }
  // CostShare fields
  const a = cms as CostShare | null;
  const b = pm as CostShare | null;
  const res = costShareEqual(a, b);
  if (res === 'match' || res === 'both-null') return null;
  if (res === 'null-vs-value') {
    if (a && !b) {
      // CMS has value, PM missing
      const cat = PM_CATEGORY[f];
      const row = pmRows.find((r) => r.benefit_category === cat);
      if (!row) return { field: f, cms: a, pm: null, root_cause: 'A' };
      // Row exists, both copay & coinsurance null → data-column gap = A
      return { field: f, cms: a, pm: b, root_cause: 'A' };
    }
    if (!a && b) {
      // CMS didn't publish; PM has value. CMS-silent → NONE
      return { field: f, cms: null, pm: b, root_cause: 'NONE', note: 'CMS JSON silent; PM has value from richer source' };
    }
  }
  if (res === 'format') {
    return { field: f, cms: a, pm: b, root_cause: 'F', note: 'copay↔coinsurance format mismatch (B8b pattern)' };
  }
  return { field: f, cms: a, pm: b, root_cause: 'E' };
}

// ─── Main ───────────────────────────────────────────────────────
interface PlanRecord {
  key: string; contract_id: string; plan_id: string; segment_id: string;
  plan_name: string; slice: 'MAPD non-SNP' | 'D-SNP' | 'C-SNP' | 'I-SNP';
  cms: Record<FieldKey, any>; pm: Record<FieldKey, any>; diffs: Diff[];
}
function sliceFromSnp(snp: string | null | undefined): PlanRecord['slice'] {
  if (!snp || snp === 'SNP_TYPE_NOT_SNP') return 'MAPD non-SNP';
  if (snp === 'SNP_TYPE_DUAL_ELIGIBLE') return 'D-SNP';
  if (snp === 'SNP_TYPE_CHRONIC_OR_DISABLING' || snp === 'SNP_TYPE_CHRONIC_CONDITION') return 'C-SNP';
  if (snp === 'SNP_TYPE_INSTITUTIONAL') return 'I-SNP';
  return 'MAPD non-SNP';
}

// D-SNP LIS-context reclassifier — CMS returns min_copay=0 at
// LIS_NO_HELP context because the beneficiary pays $0 via Medicaid
// wraparound. PM stores raw filed copay. Same as Phase 3 D2.
function reclassifyDsnpLisZero(records: PlanRecord[]) {
  const applies = new Set<FieldKey>([
    'inpatient','outpatient_surgery','emergency','urgent_care',
    'lab_services','advanced_imaging','mental_health_individual','snf',
  ]);
  for (const r of records) {
    // I-SNP institutional beneficiaries typically have Medicaid so the
    // same LIS-wraparound $0 pattern applies. C-SNP is not routinely
    // dual-eligible so we leave that slice alone.
    if (r.slice !== 'D-SNP' && r.slice !== 'I-SNP') continue;
    for (const d of r.diffs) {
      if (!applies.has(d.field)) continue;
      // Accept E (both have data, differ), F (format mismatch), and
      // A-shaped where PM has an empty CostShare {copay:null,coinsurance:null}
      const isRelevant = d.root_cause === 'E' || d.root_cause === 'F';
      if (!isRelevant) continue;
      const cms = d.cms as CostShare | null;
      const pm  = d.pm  as CostShare | null;
      const cmsZero = cms && cms.copay === 0 && (cms.copay_max == null || cms.copay_max === 0);
      // PM either has any value (raw filing) OR is a stub {null,null}
      // (D-SNP plans that don't file specific copays because Medicaid
      // wraparound zeroes them out).
      const pmSomething = pm && (pm.copay != null || pm.coinsurance != null || (pm.copay === null && pm.coinsurance === null));
      if (cmsZero && pmSomething) {
        d.root_cause = 'NONE';
        d.note = 'D-SNP: CMS returns $0 at LIS_NO_HELP context (LIS-adjusted); PM stores raw filing (Phase 3 D2)';
      }
    }
  }
}

async function main() {
  console.log('Phase 4 — cost-share + drug tier + Part B giveback parity');
  console.log('─'.repeat(70));

  const detailFiles: string[] = [];
  for (const dir of ['_tmp/medicare-gov-mapd/detail', '_tmp/medicare-gov-snp/detail']) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith('.json')) detailFiles.push(join(dir, f));
  }
  console.log(`CMS detail files: ${detailFiles.length}`);

  const records: PlanRecord[] = [];
  for (let i = 0; i < detailFiles.length; i++) {
    const f = detailFiles[i];
    const j = JSON.parse(readFileSync(f, 'utf8'));
    const pc = j.response?.plan_card;
    if (!pc) continue;
    const rows = await loadPmRows(pc.contract_id, pc.plan_id);
    const cms: any = {}, pm: any = {};
    const diffs: Diff[] = [];
    for (const fld of FIELDS) {
      cms[fld] = extractCmsField(pc, fld);
      pm[fld]  = extractPmField(rows, fld);
      const d = classify(fld, cms[fld], pm[fld], rows);
      if (d) diffs.push(d);
    }
    records.push({
      key: `${pc.contract_id}-${pc.plan_id}`,
      contract_id: pc.contract_id, plan_id: pc.plan_id,
      segment_id: String(pc.segment_id ?? '0'),
      plan_name: pc.name,
      slice: sliceFromSnp(pc.snp_type),
      cms, pm, diffs,
    });
    if (i % 25 === 0) process.stdout.write(`  [${i+1}/${detailFiles.length}]\r`);
  }
  console.log(`\nAudited ${records.length} plans.`);
  reclassifyDsnpLisZero(records);

  // Aggregate
  const fieldStats: Record<FieldKey, { match: number; accepted: number; mismatch: number; A: number; B: number; C: number; D: number; E: number; F: number }> = {} as any;
  const sliceStats: Record<string, { plans: number; match: number; mismatch: number }> = {
    'MAPD non-SNP': { plans: 0, match: 0, mismatch: 0 },
    'D-SNP': { plans: 0, match: 0, mismatch: 0 },
    'C-SNP': { plans: 0, match: 0, mismatch: 0 },
    'I-SNP': { plans: 0, match: 0, mismatch: 0 },
  };
  for (const f of FIELDS) fieldStats[f] = { match: 0, accepted: 0, mismatch: 0, A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
  for (const r of records) {
    sliceStats[r.slice].plans += 1;
    for (const f of FIELDS) {
      const bad = r.diffs.find((d) => d.field === f);
      if (bad) {
        if (bad.root_cause === 'NONE') {
          fieldStats[f].accepted += 1;
          fieldStats[f].match += 1;
          sliceStats[r.slice].match += 1;
        } else {
          fieldStats[f].mismatch += 1;
          (fieldStats[f] as any)[bad.root_cause] += 1;
          sliceStats[r.slice].mismatch += 1;
        }
      } else {
        fieldStats[f].match += 1;
        sliceStats[r.slice].match += 1;
      }
    }
  }
  console.log('\nPER FIELD  (match includes accepted deviations)');
  console.log(`  ${'field'.padEnd(26)} ${'match'.padStart(6)} ${'acpt'.padStart(5)} ${'mis'.padStart(5)} ${'acc'.padStart(8)}   A   B   C   D   E   F`);
  for (const f of FIELDS) {
    const s = fieldStats[f];
    const total = s.match + s.mismatch;
    const pct = total === 0 ? 0 : Math.round((s.match / total) * 10000) / 100;
    console.log(`  ${f.padEnd(26)} ${String(s.match).padStart(6)} ${String(s.accepted).padStart(5)} ${String(s.mismatch).padStart(5)} ${(pct+'%').padStart(8)}  ${String(s.A).padStart(3)} ${String(s.B).padStart(3)} ${String(s.C).padStart(3)} ${String(s.D).padStart(3)} ${String(s.E).padStart(3)} ${String(s.F).padStart(3)}`);
  }
  const totalMatch = FIELDS.reduce((s, f) => s + fieldStats[f].match, 0);
  const totalMis   = FIELDS.reduce((s, f) => s + fieldStats[f].mismatch, 0);
  const totalAcpt  = FIELDS.reduce((s, f) => s + fieldStats[f].accepted, 0);
  const total = totalMatch + totalMis;
  console.log(`\n  TOTAL match=${totalMatch}/${total} = ${(totalMatch/total*100).toFixed(2)}%  (accepted=${totalAcpt})  real_mismatches=${totalMis}`);

  console.log('\nPER SLICE:');
  for (const s of Object.keys(sliceStats)) {
    const st = sliceStats[s];
    const t = st.match + st.mismatch;
    if (t === 0) continue;
    console.log(`  ${s.padEnd(15)} plans=${st.plans}  fields ${st.match}/${t} = ${(st.match/t*100).toFixed(2)}%`);
  }

  writeFileSync('_tmp/parity-data/_costshare-aggregate.json', JSON.stringify({ records, fieldStats, sliceStats, totalMatch, total }, null, 2));

  const COUNTIES_INFO = [
    { state: 'NC', county: 'Durham',    fips: '37063' },
    { state: 'TX', county: 'Harris',    fips: '48201' },
    { state: 'TX', county: 'Bexar',     fips: '48029' },
    { state: 'GA', county: 'Fulton',    fips: '13121' },
    { state: 'NC', county: 'Alleghany', fips: '37005' },
  ];
  const countyByKey = new Map<string, string[]>();
  for (const dir of ['_tmp/medicare-gov-mapd/detail', '_tmp/medicare-gov-snp/detail']) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const key = f.replace('.json', '').split('-').slice(0, 2).join('-');
      countyByKey.set(key, j.counties ?? []);
    }
  }
  for (const c of COUNTIES_INFO) {
    const inCounty = records.filter((r) => (countyByKey.get(r.key) ?? []).some((cn) => cn === c.county || cn.startsWith(`${c.county} `)));
    const out = { county: c.county, state: c.state, fips: c.fips, plan_count: inCounty.length, records: inCounty };
    writeFileSync(`_tmp/parity-data/costshare-${c.state}-${c.county.toLowerCase()}-${c.fips}.json`, JSON.stringify(out, null, 2));
  }
  // Real mismatches only
  const realMis = records.flatMap((r) => r.diffs
    .filter((d) => d.root_cause !== 'NONE')
    .map((d) => ({ key: r.key, name: r.plan_name, slice: r.slice, ...d }))
  );
  writeFileSync('_tmp/phase4-mismatches.json', JSON.stringify(realMis, null, 2));
  console.log(`\nRaw: _tmp/parity-data/_costshare-aggregate.json + per-county + _tmp/phase4-mismatches.json (${realMis.length} entries)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
