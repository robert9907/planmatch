// scripts/audit-plan-completeness.ts
//
// End-to-end completeness audit for every NC / TX / GA plan in the
// agent-v3 catalog. For each (contract, plan, segment) triple it checks:
//
//   • 7 core fields  (monthly_premium, moop, star_rating, carrier,
//                     plan_name, plan_type, drug_deductible)        25%
//   • 31 medical copay categories — full MedicalCopays surface       35%
//   • 5 Part D tiers (rx_tier_1..5)                                  20%
//   • 8 extras categories (dental, vision, hearing, transportation,
//                          otc, food_card, diabetic, fitness)        20%
//
// A field counts as "present" when EITHER pm_plan_benefits has a row
// with a non-null copay/coinsurance/coverage_amount/max_coverage/desc
// for the canonical category, OR pbp_benefits has a row for the same
// category (mapped through PBP_TYPE_TO_CATEGORY) with any non-null
// signal. This mirrors /api/plans' merge so the score reflects what the
// UI actually shows.
//
// CLI:
//   --state    NC|TX|GA  (default: all three)
//   --county   Durham    (case-insensitive substring match)
//   --carrier  "UnitedHealthcare"
//
// Outputs:
//   • console summary (by-state, by-carrier, worst 20 plans, most
//     common missing categories)
//   • JSON report at scripts/audit-plan-completeness.<state>.json
//     (one entry per triple, with per-field presence flags)
//
// Read-only.

import { createClient, type PostgrestSingleResponse } from '@supabase/supabase-js';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

// ── Env loading (same pattern as scripts/verify-4-gate-funnel.ts) ────
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
const SB_URL = process.env.SUPABASE_URL ?? '';
const SB_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
if (!SB_URL || !SB_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/ANON_KEY');
  process.exit(1);
}
const sb = createClient(SB_URL, SB_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── CLI args ─────────────────────────────────────────────────────────
function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}
const stateArg = (arg('state') ?? '').toUpperCase() || null;
const countyArg = arg('county');
const carrierArg = arg('carrier');
const STATES_DEFAULT = ['NC', 'TX', 'GA'];
const STATES = stateArg ? [stateArg] : STATES_DEFAULT;

// ── PostgREST pagination (1000-row cap, see [[feedback_postgrest_row_cap]]) ──
async function paginate<T>(
  fn: (f: number, t: number) => PromiseLike<PostgrestSingleResponse<T[]>>,
  maxPages = 100,
): Promise<T[]> {
  const out: T[] = [];
  for (let n = 0; n < maxPages; n += 1) {
    const { data, error } = await fn(n * 1000, n * 1000 + 999);
    if (error) throw error;
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

// ── Field taxonomy ───────────────────────────────────────────────────
// Core scalars on pm_plans. carrier/parent_organization rolls up to a
// single "carrier" check via the same OR the API uses.
const CORE_FIELDS = [
  'monthly_premium',
  'moop',
  'star_rating',
  'carrier',
  'plan_name',
  'plan_type',
  'drug_deductible',
] as const;

// 31 medical categories — full MedicalCopays interface. Lookup uses the
// canonical pm_plan_benefits.benefit_category names; categories whose
// plan-field name diverges from the DB get an alias entry below.
const MEDICAL_CATEGORIES = [
  'primary_care',
  'specialist',
  'urgent_care',
  'emergency',
  'inpatient',
  'mental_health_inpatient',
  'snf',
  'outpatient_surgery_hospital',
  'outpatient_surgery_asc',
  'outpatient_observation',
  'lab_services',
  'diagnostic_procedures',
  'xray',
  'advanced_imaging',
  'mental_health_individual',
  'mental_health_group',
  'physical_speech_therapy',
  'occupational_therapy',
  'telehealth',
  'ambulance',
  'air_transportation',
  'chiropractic',
  'acupuncture',
  'podiatry',
  'substance_abuse',
  'dme_prosthetics',
  'partb_drugs',
  'diabetic_supplies',
  'insulin',
  'home_health',
  'renal_dialysis',
] as const;
const RX_TIERS = ['rx_tier_1', 'rx_tier_2', 'rx_tier_3', 'rx_tier_4', 'rx_tier_5'] as const;
const EXTRAS = [
  'dental',
  'vision',
  'hearing',
  'transportation',
  'otc',
  'food_card',
  'diabetic',
  'fitness',
] as const;

// pm_plan_benefits canonical names — must match the alias map in
// api/plans.ts so this audit reflects the same merge the UI sees.
const CATEGORY_ALIAS: Record<string, string> = {
  lab_services: 'lab',
  outpatient_surgery_hospital: 'outpatient_surgery',
  outpatient_surgery_asc: 'asc',
  mental_health_individual: 'mental_health_outpatient_individual',
  mental_health_group: 'mental_health_outpatient_group',
};

// pbp_benefits.benefit_type → canonical category. Mirrors api/plans.ts
// PBP_TYPE_TO_CATEGORY, with the plan-field names normalized so the
// audit can look up by the same key the score iterates over.
const PBP_TYPE_TO_FIELD: Record<string, string> = {
  primary_care_visit: 'primary_care',
  inpatient_hospital: 'inpatient',
  inpatient_psych: 'mental_health_inpatient',
  emergency_room: 'emergency',
  urgent_care: 'urgent_care',
  specialist_visit: 'specialist',
  lab_diagnostic: 'lab_services',
  outpatient_surgery: 'outpatient_surgery_hospital',
  outpatient_surgery_asc: 'outpatient_surgery_asc',
  outpatient_observation: 'outpatient_observation',
  ambulance: 'ambulance',
  mental_health_individual: 'mental_health_individual',
  mental_health_group: 'mental_health_group',
  physical_therapy: 'physical_speech_therapy',
  occupational_therapy: 'occupational_therapy',
  chiropractic: 'chiropractic',
  podiatry: 'podiatry',
  telehealth: 'telehealth',
  diabetic_supplies: 'insulin',
  dental_comprehensive: 'dental',
  dental_annual_max: 'dental',
  vision_exam: 'vision',
  vision_allowance: 'vision',
  hearing_exam: 'hearing',
  hearing_aid_allowance: 'hearing',
  otc_allowance: 'otc',
  food_card: 'food_card',
  transportation: 'transportation',
  fitness: 'fitness',
  rx_tier_1: 'rx_tier_1',
  rx_tier_2: 'rx_tier_2',
  rx_tier_3: 'rx_tier_3',
  rx_tier_4: 'rx_tier_4',
  rx_tier_5: 'rx_tier_5',
};

// ── Types ────────────────────────────────────────────────────────────
interface PmPlanRow {
  contract_id: string;
  plan_id: string;
  segment_id: string | null;
  plan_name: string | null;
  carrier: string | null;
  parent_organization: string | null;
  plan_type: string | null;
  state: string;
  county_name: string;
  monthly_premium: number | null;
  annual_deductible: number | null;
  moop: number | null;
  drug_deductible: number | null;
  star_rating: number | null;
  snp: boolean;
  snp_type: string | null;
}
interface PmBenefitRow {
  contract_id: string;
  plan_id: string;
  segment_id: string | null;
  benefit_category: string;
  benefit_description: string | null;
  coverage_amount: number | null;
  copay: number | null;
  coinsurance: number | null;
  max_coverage: number | null;
}
interface PbpRow {
  plan_id: string;
  benefit_type: string;
  copay: number | null;
  copay_max: number | null;
  coinsurance: number | null;
  description: string | null;
  source: string | null;
}

interface PlanReport {
  id: string;
  contract_id: string;
  plan_id: string;
  segment_id: string;
  state: string;
  carrier: string;
  plan_name: string;
  plan_type: string;
  county_count: number;
  score: number;
  core_pct: number;
  medical_pct: number;
  rx_pct: number;
  extras_pct: number;
  missing_core: string[];
  missing_medical: string[];
  missing_rx: string[];
  missing_extras: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────
function normalizePbpKey(planId: string): string {
  const parts = planId.split('-');
  if (parts.length < 2) return planId;
  return `${parts[0]}-${parts[1]}`;
}

function pbpKeyVariants(triple: string): string[] {
  const parts = triple.split('-');
  const out = new Set<string>([triple, `${parts[0]}-${parts[1]}`]);
  if (parts.length >= 3) {
    const seg1 = parts[2].replace(/^0+/, '') || '0';
    out.add(`${parts[0]}-${parts[1]}-${seg1}`);
  }
  return [...out];
}

function pmBenefitHasSignal(rows: PmBenefitRow[]): boolean {
  return rows.some(
    (r) =>
      r.copay != null ||
      r.coinsurance != null ||
      r.coverage_amount != null ||
      r.max_coverage != null ||
      (typeof r.benefit_description === 'string' && r.benefit_description.trim() !== ''),
  );
}
function pbpHasSignal(rows: PbpRow[]): boolean {
  return rows.some(
    (r) =>
      r.copay != null ||
      r.copay_max != null ||
      r.coinsurance != null ||
      (typeof r.description === 'string' && r.description.trim() !== ''),
  );
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log(
    `\n→ audit-plan-completeness · states=${STATES.join(',')}` +
      (countyArg ? ` · county=${countyArg}` : '') +
      (carrierArg ? ` · carrier=${carrierArg}` : ''),
  );

  // Step 1 — pm_plans rows. Single .in('state', ...) so the
  // multi-state default needs only one round trip.
  const allPlans = await paginate<PmPlanRow>((f, t) => {
    let q = sb
      .from('pm_plans')
      .select(
        'contract_id, plan_id, segment_id, plan_name, carrier, parent_organization, plan_type, state, county_name, monthly_premium, annual_deductible, moop, drug_deductible, star_rating, snp, snp_type',
      )
      .in('state', STATES)
      .eq('sanctioned', false);
    if (countyArg) q = q.ilike('county_name', `%${countyArg}%`);
    if (carrierArg) {
      // Match against either the carrier column or the parent_org
      // rollup — the agent UI displays whichever is non-null.
      q = q.or(`carrier.ilike.%${carrierArg}%,parent_organization.ilike.%${carrierArg}%`);
    }
    return q.order('contract_id', { ascending: true }).range(f, t);
  });

  // Group landscape rows to one entry per (contract_id, plan_id,
  // segment_id) — pm_plans is per-county and would otherwise score the
  // same plan once per county it serves.
  const byTriple = new Map<string, { head: PmPlanRow; counties: Set<string> }>();
  for (const r of allPlans) {
    const seg = (r.segment_id ?? '000');
    const key = `${r.contract_id}-${r.plan_id}-${seg}`;
    const hit = byTriple.get(key);
    if (hit) hit.counties.add(r.county_name);
    else byTriple.set(key, { head: r, counties: new Set([r.county_name]) });
  }

  console.log(
    `  pm_plans  → ${allPlans.length} rows · ${byTriple.size} distinct triples`,
  );
  if (byTriple.size === 0) {
    console.log('No plans matched the filter — nothing to audit.');
    return;
  }

  // Step 2 — pm_plan_benefits for the contract/plan set.
  const contractIds = [...new Set([...byTriple.values()].map((v) => v.head.contract_id))];
  const planIds = [...new Set([...byTriple.values()].map((v) => v.head.plan_id))];

  const pmBenefits = await paginate<PmBenefitRow>((f, t) =>
    sb
      .from('pm_plan_benefits')
      .select(
        'contract_id, plan_id, segment_id, benefit_category, benefit_description, coverage_amount, copay, coinsurance, max_coverage',
      )
      .in('contract_id', contractIds)
      .in('plan_id', planIds)
      .order('contract_id', { ascending: true })
      .order('plan_id', { ascending: true })
      .range(f, t),
  );
  console.log(`  pm_plan_benefits → ${pmBenefits.length} rows`);

  const pmByTriple = new Map<string, PmBenefitRow[]>();
  for (const b of pmBenefits) {
    const seg = b.segment_id ?? '000';
    const key = `${b.contract_id}-${b.plan_id}-${seg}`;
    const list = pmByTriple.get(key) ?? [];
    list.push(b);
    pmByTriple.set(key, list);
  }

  // Step 3 — pbp_benefits with all key variants the scrapers may have
  // written under. Source filter mirrors the broad merge in /api/plans.
  const allPbpKeys = new Set<string>();
  for (const key of byTriple.keys()) {
    for (const v of pbpKeyVariants(key)) allPbpKeys.add(v);
  }
  const pbpRows = await paginate<PbpRow>((f, t) =>
    sb
      .from('pbp_benefits')
      .select('plan_id, benefit_type, copay, copay_max, coinsurance, description, source')
      .in('plan_id', [...allPbpKeys])
      .in('source', ['medicare_gov', 'sb_ocr', 'cms_pbp', 'manual', 'pbp_federal'])
      .order('plan_id', { ascending: true })
      .range(f, t),
  );
  console.log(`  pbp_benefits     → ${pbpRows.length} rows`);

  // Index pbp by canonical 2-part key + the API's per-field key so
  // category-presence lookups are O(1).
  const pbpByPlanField = new Map<string, PbpRow[]>();
  for (const r of pbpRows) {
    const canonical = normalizePbpKey(r.plan_id);
    const field = PBP_TYPE_TO_FIELD[r.benefit_type];
    if (!field) continue;
    const key = `${canonical}|${field}`;
    const list = pbpByPlanField.get(key) ?? [];
    list.push(r);
    pbpByPlanField.set(key, list);
  }

  // ── Step 4 — score each plan ─────────────────────────────────────
  const reports: PlanReport[] = [];
  for (const [tripleKey, { head, counties }] of byTriple) {
    const canonical = normalizePbpKey(tripleKey);
    const pm = pmByTriple.get(tripleKey) ?? [];

    // Core scalars on pm_plans.
    const missingCore: string[] = [];
    if (head.monthly_premium == null) missingCore.push('monthly_premium');
    if (head.moop == null) missingCore.push('moop');
    if (head.star_rating == null) missingCore.push('star_rating');
    if (!(head.carrier ?? head.parent_organization)) missingCore.push('carrier');
    if (!head.plan_name) missingCore.push('plan_name');
    if (!head.plan_type) missingCore.push('plan_type');
    // drug_deductible is intentionally NULL for MA-only plans — but for
    // an MA-PD or PDP a missing value is a real gap.
    const expectsDrugDed = (head.plan_type ?? '').toUpperCase() !== 'MA';
    if (head.drug_deductible == null && expectsDrugDed) missingCore.push('drug_deductible');

    // Build a presence helper that consults pm_plan_benefits first
    // (via CATEGORY_ALIAS) and falls back to the pbp index.
    const hasCategory = (field: string): boolean => {
      const aliased = CATEGORY_ALIAS[field] ?? field;
      const pmHits = pm.filter(
        (r) => r.benefit_category === aliased || r.benefit_category === field,
      );
      if (pmHits.length > 0 && pmBenefitHasSignal(pmHits)) return true;
      const pbpHits = pbpByPlanField.get(`${canonical}|${field}`) ?? [];
      return pbpHasSignal(pbpHits);
    };

    const missingMedical = MEDICAL_CATEGORIES.filter((c) => !hasCategory(c));
    const missingRx = RX_TIERS.filter((c) => !hasCategory(c));
    const missingExtras = EXTRAS.filter((c) => {
      // diabetic + fitness are defaulted-true in buildBenefits because
      // they're near-universal on MA plans; only flag missing when
      // neither pm_plan_benefits nor pbp_benefits has anything. We
      // still check explicitly because the audit is about filed data,
      // not the UI default.
      return !hasCategory(c);
    });

    const corePct = ((CORE_FIELDS.length - missingCore.length) / CORE_FIELDS.length) * 100;
    const medPct =
      ((MEDICAL_CATEGORIES.length - missingMedical.length) / MEDICAL_CATEGORIES.length) * 100;
    const rxPct = ((RX_TIERS.length - missingRx.length) / RX_TIERS.length) * 100;
    const extrasPct = ((EXTRAS.length - missingExtras.length) / EXTRAS.length) * 100;
    const score = corePct * 0.25 + medPct * 0.35 + rxPct * 0.2 + extrasPct * 0.2;

    reports.push({
      id: tripleKey,
      contract_id: head.contract_id,
      plan_id: head.plan_id,
      segment_id: head.segment_id ?? '000',
      state: head.state,
      carrier: head.carrier ?? head.parent_organization ?? '—',
      plan_name: head.plan_name ?? '—',
      plan_type: head.plan_type ?? '—',
      county_count: counties.size,
      score: Math.round(score * 10) / 10,
      core_pct: Math.round(corePct * 10) / 10,
      medical_pct: Math.round(medPct * 10) / 10,
      rx_pct: Math.round(rxPct * 10) / 10,
      extras_pct: Math.round(extrasPct * 10) / 10,
      missing_core: missingCore,
      missing_medical: missingMedical as unknown as string[],
      missing_rx: missingRx as unknown as string[],
      missing_extras: missingExtras as unknown as string[],
    });
  }

  // ── Step 5 — summaries ────────────────────────────────────────────
  reports.sort((a, b) => a.score - b.score);

  const overall = reports.reduce((s, r) => s + r.score, 0) / reports.length;
  console.log(`\n── overall ─────────────────────────────────────────`);
  console.log(`  plans audited : ${reports.length}`);
  console.log(`  mean score    : ${overall.toFixed(1)}%`);
  console.log(
    `  ≥90% complete : ${reports.filter((r) => r.score >= 90).length}  ` +
      `(${((reports.filter((r) => r.score >= 90).length / reports.length) * 100).toFixed(0)}%)`,
  );
  console.log(
    `  <60% complete : ${reports.filter((r) => r.score < 60).length}  ` +
      `(${((reports.filter((r) => r.score < 60).length / reports.length) * 100).toFixed(0)}%)`,
  );

  // By state
  console.log(`\n── by state ────────────────────────────────────────`);
  const byState = new Map<string, PlanReport[]>();
  for (const r of reports) {
    const list = byState.get(r.state) ?? [];
    list.push(r);
    byState.set(r.state, list);
  }
  for (const [st, list] of [...byState.entries()].sort()) {
    const mean = list.reduce((s, r) => s + r.score, 0) / list.length;
    console.log(`  ${st}  n=${list.length.toString().padStart(4)}  mean=${mean.toFixed(1)}%`);
  }

  // By carrier (top 15 by count)
  console.log(`\n── by carrier (top 15 by plan count) ───────────────`);
  const byCarrier = new Map<string, PlanReport[]>();
  for (const r of reports) {
    const list = byCarrier.get(r.carrier) ?? [];
    list.push(r);
    byCarrier.set(r.carrier, list);
  }
  const carriersSorted = [...byCarrier.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 15);
  for (const [carrier, list] of carriersSorted) {
    const mean = list.reduce((s, r) => s + r.score, 0) / list.length;
    const worst = Math.min(...list.map((r) => r.score));
    console.log(
      `  ${carrier.padEnd(36)}  n=${list.length.toString().padStart(4)}  ` +
        `mean=${mean.toFixed(1)}%  worst=${worst.toFixed(1)}%`,
    );
  }

  // Worst 20
  console.log(`\n── worst 20 plans ──────────────────────────────────`);
  for (const r of reports.slice(0, 20)) {
    const missing = [
      ...r.missing_core,
      ...r.missing_medical.slice(0, 3),
      ...r.missing_rx.slice(0, 2),
      ...r.missing_extras.slice(0, 2),
    ];
    console.log(
      `  ${r.score.toFixed(1)}%  ${r.state}  ${r.id.padEnd(15)}  ` +
        `${r.carrier.slice(0, 22).padEnd(22)}  ${r.plan_name.slice(0, 38).padEnd(38)}  ` +
        `missing: ${missing.slice(0, 6).join(', ') || '—'}${missing.length > 6 ? '…' : ''}`,
    );
  }

  // Most-common missing categories
  console.log(`\n── most common missing categories ──────────────────`);
  const missTally = new Map<string, number>();
  for (const r of reports) {
    for (const c of [
      ...r.missing_core,
      ...r.missing_medical,
      ...r.missing_rx,
      ...r.missing_extras,
    ]) {
      missTally.set(c, (missTally.get(c) ?? 0) + 1);
    }
  }
  const tallySorted = [...missTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  for (const [cat, n] of tallySorted) {
    const pct = ((n / reports.length) * 100).toFixed(0);
    console.log(`  ${cat.padEnd(34)}  missing on ${n.toString().padStart(4)} / ${reports.length}  (${pct}%)`);
  }

  // JSON dump
  const stateTag = stateArg ?? 'all';
  const outPath = `scripts/audit-plan-completeness.${stateTag.toLowerCase()}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        filter: { state: stateArg, county: countyArg, carrier: carrierArg },
        totals: {
          plans: reports.length,
          mean_score: Math.round(overall * 10) / 10,
        },
        plans: reports,
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
