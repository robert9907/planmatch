// scripts/audit-h2h-field-coverage.ts
//
// Full coverage audit of every benefit field the agent H2H compare
// screen renders, across all NC / TX / GA plans.
//
// Sources (mirrors /api/plans.ts merge):
//   • pm_plan_benefits     — landscape rows, benefit_category
//   • pbp_benefits         — carrier + medicare_gov + sb_ocr rows,
//                            benefit_type (fallback / first-class for
//                            MH / PT / dental_max / OTC / food_card /
//                            transportation / vision / hearing / rx tiers)
//
// A plan is counted as "populated" for a field when EITHER source has a
// row with a non-null copay / coinsurance / coverage_amount for the
// mapped category / type. Presence-only for pbp allowances (where the
// dollar lives on copay per PBP_ALLOWANCE_TYPES in /api/plans.ts).
//
// Output (stdout):
//   1. Sorted coverage table   — carrier | state | field | pct_populated ASC
//   2. Carriers with >10% gap  — one line per (carrier, state, field)
//   3. Liberty + Alignment     — per-plan list of NULL fields
//
// Run:  npx tsx scripts/audit-h2h-field-coverage.ts
//       npx tsx scripts/audit-h2h-field-coverage.ts > _tmp/h2h-audit.md

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

// ─── env ──────────────────────────────────────────────────────────────
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const SUPA_URL = process.env.SUPABASE_URL ?? '';
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
if (!SUPA_URL || !SUPA_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY / ANON_KEY');
  process.exit(1);
}
const sb = createClient(SUPA_URL, SUPA_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── pagination ───────────────────────────────────────────────────────
const PAGE = 1000;
const MAX_PAGES = 100;
async function fetchAllRows<T>(
  pageFn: (from: number, to: number) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE;
    const to = from + PAGE - 1;
    const rows = await pageFn(from, to);
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// ─── H2H field map ────────────────────────────────────────────────────
// Each entry: what the UI labels the field, plus which
// pm_plan_benefits.benefit_category and/or pbp_benefits.benefit_type
// value(s) the /api/plans merge reads. A plan is populated for a
// field when EITHER source has a matching row with usable data.
interface H2HField {
  label: string;
  pm?: string[];   // pm_plan_benefits.benefit_category candidates
  pbp?: string[];  // pbp_benefits.benefit_type candidates
}
const FIELDS: H2HField[] = [
  { label: 'PCP copay',                pm: ['primary_care'],                      pbp: ['primary_care_visit'] },
  { label: 'Specialist copay',         pm: ['specialist'],                        pbp: ['specialist_visit'] },
  { label: 'Urgent care',              pm: ['urgent_care'],                       pbp: ['urgent_care'] },
  { label: 'ER',                       pm: ['emergency'],                         pbp: ['emergency_room'] },
  { label: 'Inpatient (per day)',      pm: ['inpatient'],                         pbp: ['inpatient_hospital'] },
  { label: 'Diagnostic procedures',    pm: ['diagnostic_procedures'] },
  { label: 'Lab',                      pm: ['lab'],                               pbp: ['lab_diagnostic'] },
  { label: 'X-ray',                    pm: ['xray'] },
  { label: 'Advanced imaging (MRI/CT)',pm: ['advanced_imaging'],                  pbp: ['imaging'] },
  { label: 'Mental health (individual)', pm: ['mental_health_outpatient_individual'], pbp: ['mental_health_individual'] },
  { label: 'Mental health (group)',    pm: ['mental_health_outpatient_group'],    pbp: ['mental_health_group'] },
  { label: 'Mental health inpatient',  pm: ['mental_health_inpatient'],           pbp: ['inpatient_psych'] },
  { label: 'Physical / speech therapy',pm: ['physical_speech_therapy'],           pbp: ['physical_therapy'] },
  { label: 'Occupational therapy',     pm: ['occupational_therapy'],              pbp: ['occupational_therapy'] },
  { label: 'Telehealth',               pm: ['telehealth'],                        pbp: ['telehealth'] },
  { label: 'Ambulance (ground)',       pm: ['ambulance'],                         pbp: ['ambulance'] },
  { label: 'Air ambulance',            pm: ['air_transportation'] },
  { label: 'Chiropractic',             pm: ['chiropractic'],                      pbp: ['chiropractic'] },
  { label: 'Acupuncture',              pm: ['acupuncture'] },
  { label: 'Podiatry',                 pm: ['podiatry'],                          pbp: ['podiatry'] },
  { label: 'Substance abuse',          pm: ['substance_abuse'] },
  { label: 'DME / Prosthetics',        pm: ['dme_prosthetics'] },
  { label: 'Part B drugs',             pm: ['partb_drugs'] },
  { label: 'Diabetic supplies',        pm: ['diabetic_supplies', 'insulin'],      pbp: ['diabetic_supplies'] },
  { label: 'Part B insulin',           pm: ['insulin'] },
  { label: 'Home health',              pm: ['home_health'] },
  { label: 'Renal dialysis',           pm: ['renal_dialysis'] },
  { label: 'SNF (day-1 copay)',        pm: ['snf'] },
  { label: 'Outpatient surgery ASC',   pm: ['asc'],                               pbp: ['outpatient_surgery_asc'] },
  { label: 'Outpatient surgery hosp',  pm: ['outpatient_surgery'],                pbp: ['outpatient_surgery_hospital', 'outpatient_surgery'] },
  { label: 'Rx Tier 1',                pm: ['rx_tier_1'],                         pbp: ['rx_tier_1'] },
  { label: 'Rx Tier 2',                pm: ['rx_tier_2'],                         pbp: ['rx_tier_2'] },
  { label: 'Rx Tier 3',                pm: ['rx_tier_3'],                         pbp: ['rx_tier_3'] },
  { label: 'Rx Tier 4',                pm: ['rx_tier_4'],                         pbp: ['rx_tier_4'] },
  { label: 'Rx Tier 5',                pm: ['rx_tier_5'],                         pbp: ['rx_tier_5'] },
  { label: 'Rx Tier 6',                pm: ['rx_tier_6'],                         pbp: ['rx_tier_6'] },
  { label: 'Transportation',           pm: ['transportation'],                    pbp: ['transportation'] },
  { label: 'Food card',                pm: ['food_card'],                         pbp: ['food_card'] },
  { label: 'Hearing',                  pm: ['hearing'],                           pbp: ['hearing_aid_allowance'] },
  { label: 'Dental (comprehensive)',   pm: ['dental'],                            pbp: ['dental_comprehensive', 'dental_annual_max'] },
  { label: 'Dental (preventive)',      pm: ['dental_preventive'],                 pbp: ['dental_preventive'] },
  { label: 'Vision (exam)',            pm: ['vision_exam'],                       pbp: ['vision_exam'] },
  { label: 'Vision (allowance)',       pm: ['vision'],                            pbp: ['vision_allowance'] },
  { label: 'OTC allowance',            pm: ['otc'],                               pbp: ['otc_allowance'] },
  { label: 'Fitness',                  pm: ['fitness'],                           pbp: ['fitness'] },
];

// ─── Row types ────────────────────────────────────────────────────────
interface PlanRow {
  contract_id: string;
  plan_id: string;
  segment_id: string | null;
  carrier: string | null;
  parent_organization: string | null;
  state: string | null;
}
interface PmBenefitRow {
  contract_id: string;
  plan_id: string;
  segment_id: string | null;
  benefit_category: string;
  copay: number | null;
  coinsurance: number | null;
  coverage_amount: number | null;
  max_coverage: number | null;
}
interface PbpBenefitRow {
  plan_id: string;                       // "H1234-005" or "H1234-005-0"
  benefit_type: string;
  copay: number | null;
  coinsurance: number | null;
  source: string | null;
  tier_id: number | null;
}

// pbp_benefits keys plans in short forms; produce all the variants
// /api/plans.ts probes so we index every row we might reach.
function pbpKeyVariants(contract: string, plan: string, seg: string | null): string[] {
  const s = (seg ?? '000').replace(/^0+/, '') || '0';
  const canonical = `${contract}-${plan}`;
  return [
    canonical,
    `${canonical}-${s}`,
    `${canonical}-${seg ?? '000'}`,
  ];
}

function pmRowUseful(r: PmBenefitRow): boolean {
  // Any of copay / coinsurance / coverage_amount / max_coverage non-null
  // means the row contributes something the H2H screen can render.
  return (
    r.copay != null ||
    r.coinsurance != null ||
    r.coverage_amount != null ||
    r.max_coverage != null
  );
}
function pbpRowUseful(r: PbpBenefitRow): boolean {
  // pbp allowance types store the dollar on `copay`; cost-share types
  // use copay OR coinsurance. Either non-null counts.
  return r.copay != null || r.coinsurance != null;
}

// Normalize carrier name — parent_organization when available, else
// carrier. Missing/blank collapses to "(unknown)" so those plans don't
// disappear silently in the group-by.
function normalizeCarrier(p: PlanRow): string {
  const raw = (p.parent_organization ?? p.carrier ?? '').trim();
  if (!raw) return '(unknown)';
  return raw;
}

// ─── Per-state audit ──────────────────────────────────────────────────
type Coverage = {
  state: string;
  carrier: string;
  field: string;
  populated: number;
  total: number;
};
type PlanKey = string;   // `${carrier}|${state}|${contract}-${plan}-${segment}`
type PlanGap = { carrier: string; state: string; contract_id: string; plan_id: string; segment_id: string; nullFields: string[] };

async function auditState(state: string): Promise<{ coverage: Coverage[]; planGaps: PlanGap[] }> {
  process.stderr.write(`\n[${state}] loading pm_plans…\n`);
  const rawPlans = await fetchAllRows<PlanRow>(async (from, to) => {
    const { data, error } = await sb
      .from('pm_plans')
      .select('contract_id, plan_id, segment_id, carrier, parent_organization, state')
      .eq('state', state)
      .eq('sanctioned', false)
      .order('contract_id', { ascending: true })
      .order('plan_id', { ascending: true })
      .order('segment_id', { ascending: true })
      .range(from, to);
    if (error) throw error;
    return (data ?? []) as PlanRow[];
  });
  // pm_plans is one row per (contract, plan, segment, county_fips).
  // Dedupe to (contract, plan, segment) so each PLAN counts once.
  const dedup = new Map<string, PlanRow>();
  for (const r of rawPlans) {
    const key = `${r.contract_id}-${r.plan_id}-${r.segment_id ?? '000'}`;
    if (!dedup.has(key)) dedup.set(key, r);
  }
  const plans = [...dedup.values()];
  process.stderr.write(`  ${rawPlans.length} rows → ${plans.length} unique (contract,plan,segment)\n`);
  if (plans.length === 0) return { coverage: [], planGaps: [] };

  // Distinct contract + plan ids for the pm_plan_benefits IN() filters.
  const contractIds = [...new Set(plans.map(p => p.contract_id))];
  const planIds = [...new Set(plans.map(p => p.plan_id))];

  process.stderr.write(`  loading pm_plan_benefits (${contractIds.length} contracts × ${planIds.length} plan_ids)…\n`);
  const pmRows = await fetchAllRows<PmBenefitRow>(async (from, to) => {
    const { data, error } = await sb
      .from('pm_plan_benefits')
      .select('contract_id, plan_id, segment_id, benefit_category, copay, coinsurance, coverage_amount, max_coverage')
      .in('contract_id', contractIds)
      .in('plan_id', planIds)
      .order('id', { ascending: true })
      .range(from, to);
    if (error) throw error;
    return (data ?? []) as PmBenefitRow[];
  });
  process.stderr.write(`  ${pmRows.length} pm_plan_benefits rows\n`);

  // pbp key variants → set for IN() lookup.
  const pbpKeys = new Set<string>();
  for (const p of plans) {
    for (const k of pbpKeyVariants(p.contract_id, p.plan_id, p.segment_id)) {
      pbpKeys.add(k);
    }
  }
  process.stderr.write(`  loading pbp_benefits (${pbpKeys.size} key variants)…\n`);
  const pbpRows = await fetchAllRows<PbpBenefitRow>(async (from, to) => {
    const { data, error } = await sb
      .from('pbp_benefits')
      .select('plan_id, benefit_type, copay, coinsurance, source, tier_id')
      .in('plan_id', [...pbpKeys])
      .in('source', ['medicare_gov', 'sb_ocr', 'cms_pbp', 'manual', 'pbp_federal'])
      .order('plan_id', { ascending: true })
      .range(from, to);
    if (error) throw error;
    return (data ?? []) as PbpBenefitRow[];
  });
  process.stderr.write(`  ${pbpRows.length} pbp_benefits rows\n`);

  // Index pm rows by (triple, category); pbp rows by (short plan_id, benefit_type).
  const pmIdx = new Map<string, PmBenefitRow[]>();
  for (const r of pmRows) {
    const seg = r.segment_id ?? '000';
    const k = `${r.contract_id}-${r.plan_id}-${seg}|${r.benefit_category}`;
    (pmIdx.get(k) ?? pmIdx.set(k, []).get(k)!).push(r);
  }
  const pbpIdx = new Map<string, PbpBenefitRow[]>();
  for (const r of pbpRows) {
    const k = `${r.plan_id}|${r.benefit_type}`;
    (pbpIdx.get(k) ?? pbpIdx.set(k, []).get(k)!).push(r);
  }

  // Count populated / total per (carrier, field).
  const counts = new Map<string, { populated: number; total: number }>();
  const planGaps: PlanGap[] = [];
  const wantsLibertyOrAlignment = (c: string) =>
    /liberty|alignment/i.test(c);

  for (const plan of plans) {
    const carrier = normalizeCarrier(plan);
    const triple = `${plan.contract_id}-${plan.plan_id}-${plan.segment_id ?? '000'}`;
    const shortKeys = pbpKeyVariants(plan.contract_id, plan.plan_id, plan.segment_id);
    const nullFieldsForThisPlan: string[] = [];

    for (const field of FIELDS) {
      let populated = false;

      // pm path
      if (field.pm) {
        for (const cat of field.pm) {
          const rows = pmIdx.get(`${triple}|${cat}`);
          if (rows && rows.some(pmRowUseful)) { populated = true; break; }
        }
      }
      // pbp path (checked only if pm didn't populate)
      if (!populated && field.pbp) {
        outer: for (const bt of field.pbp) {
          for (const key of shortKeys) {
            const rows = pbpIdx.get(`${key}|${bt}`);
            if (rows && rows.some(pbpRowUseful)) { populated = true; break outer; }
          }
        }
      }

      const bucketKey = `${carrier}|${field.label}`;
      const bucket = counts.get(bucketKey) ?? { populated: 0, total: 0 };
      bucket.total += 1;
      if (populated) bucket.populated += 1;
      counts.set(bucketKey, bucket);

      if (!populated && wantsLibertyOrAlignment(carrier)) {
        nullFieldsForThisPlan.push(field.label);
      }
    }

    if (nullFieldsForThisPlan.length > 0) {
      planGaps.push({
        carrier,
        state,
        contract_id: plan.contract_id,
        plan_id: plan.plan_id,
        segment_id: plan.segment_id ?? '000',
        nullFields: nullFieldsForThisPlan,
      });
    }
  }

  const coverage: Coverage[] = [];
  for (const [bucketKey, c] of counts) {
    const [carrier, field] = bucketKey.split('|');
    coverage.push({ state, carrier, field, populated: c.populated, total: c.total });
  }
  return { coverage, planGaps };
}

// ─── Output ───────────────────────────────────────────────────────────
function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}
function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

async function main() {
  const all: Coverage[] = [];
  const allGaps: PlanGap[] = [];
  for (const state of ['NC', 'TX', 'GA']) {
    const { coverage, planGaps } = await auditState(state);
    all.push(...coverage);
    allGaps.push(...planGaps);
  }

  // Filter out (carrier, state) combos with < 3 plans — noise from
  // one-off filings that would dominate the "worst" list. Uses each
  // carrier's plan count in each state.
  const carrierStatePlanCount = new Map<string, number>();
  for (const c of all) {
    const k = `${c.carrier}|${c.state}`;
    // Every field has the same total; take the max we see.
    const prior = carrierStatePlanCount.get(k) ?? 0;
    if (c.total > prior) carrierStatePlanCount.set(k, c.total);
  }
  const relevant = all.filter(c => (carrierStatePlanCount.get(`${c.carrier}|${c.state}`) ?? 0) >= 3);

  // ── Sorted coverage table ────────────────────────────────────────
  console.log('# H2H benefit-field coverage — NC / TX / GA');
  console.log('');
  console.log('Coverage rank per (carrier × state × field), sorted by % populated ASC.');
  console.log('Only (carrier, state) combos with ≥ 3 plans included.');
  console.log('');
  console.log('| carrier | state | total | field | pop | null | pct |');
  console.log('|---|---|---|---|---|---|---|');

  const sorted = [...relevant].sort((a, b) => {
    const pa = pct(a.populated, a.total);
    const pb = pct(b.populated, b.total);
    if (pa !== pb) return pa - pb;
    return a.carrier.localeCompare(b.carrier);
  });
  for (const c of sorted) {
    const p = pct(c.populated, c.total);
    console.log(`| ${c.carrier} | ${c.state} | ${c.total} | ${c.field} | ${c.populated} | ${c.total - c.populated} | ${p.toFixed(1)}% |`);
  }

  // ── >10% gap flags ────────────────────────────────────────────────
  console.log('');
  console.log('## Carriers with >10% missing (any state, any field)');
  console.log('');
  console.log('| carrier | state | field | pct_populated | missing / total |');
  console.log('|---|---|---|---|---|');
  const gapFlags = sorted.filter(c => pct(c.populated, c.total) < 90);
  for (const c of gapFlags) {
    const p = pct(c.populated, c.total);
    console.log(`| ${c.carrier} | ${c.state} | ${c.field} | ${p.toFixed(1)}% | ${c.total - c.populated} / ${c.total} |`);
  }
  console.log('');
  console.log(`(${gapFlags.length} carrier×state×field combos with < 90% coverage)`);

  // ── Liberty + Alignment per-plan gap ──────────────────────────────
  console.log('');
  console.log('## Liberty + Alignment — per-plan NULL fields');
  console.log('');
  const grouped = new Map<string, PlanGap[]>();
  for (const g of allGaps) {
    (grouped.get(g.carrier) ?? grouped.set(g.carrier, []).get(g.carrier)!).push(g);
  }
  for (const [carrier, gaps] of grouped) {
    console.log(`### ${carrier}`);
    console.log('');
    console.log(`${gaps.length} plans with at least one missing H2H field.`);
    console.log('');
    for (const g of gaps.sort((a, b) => (b.nullFields.length - a.nullFields.length))) {
      const id = `${g.contract_id}-${g.plan_id}-${g.segment_id}`;
      console.log(`- **${id}** (${g.state}) — ${g.nullFields.length} null: ${g.nullFields.join(', ')}`);
    }
    console.log('');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
