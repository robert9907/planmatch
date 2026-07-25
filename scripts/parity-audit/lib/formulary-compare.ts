// CMS formulary ground truth for MPF-side drug coverage.
//
// Per Rob's Task 1 directive (SPEC.md + audit-fix-2): rather than reverse-
// engineer medicare.gov's /formulary endpoint, use the CMS Standard
// Prescription User File (SPUF) as the MPF ground truth. MPF's plan-detail
// UI reads from the same CMS files that Plan Match imports into
// pm_formulary_v2 (via scripts/import-cms-spuf.ts). So:
//
//   • The CMS file IS the MPF ground truth.
//   • pm_formulary_v2 = the imported CMS data.
//   • If PM's runtime formulary lookup matches pm_formulary_v2, PM proves
//     it would match MPF's drug-detail display.
//
// This module populates the MPF-side drugCoverage on parity-audit
// PlanSnapshots directly from pm_formulary (the view over pm_formulary_v2
// + pm_rxcui_meta). run.ts calls enrichMpfSnapshotsWithCms() after loading
// MPF plan-detail data (which stubs drugCoverage to []).
//
// Segment-agnostic: CMS files formulary at contract+plan level (typically
// segment '001' only). Query aggregates across all segments per plan since
// the formulary is the same for all segments of a given (contract, plan).

import { createClient, type SupabaseClient, type PostgrestSingleResponse } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import type { BeneficiaryProfile, Drug, DrugCoverage, PlanSnapshot, Tier } from '../types.js';

// ─── Env / client (mirrors _template-probe pattern) ───────────────────

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

let _client: SupabaseClient | null = null;
function sb(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
  if (!url || !key) {
    throw new Error('formulary-compare: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  }
  _client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _client;
}

// Same 1000-row-cap defeater used across parity-audit modules.
async function paginate<T>(
  pageFn: (from: number, to: number) => PromiseLike<PostgrestSingleResponse<T[]>>,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  const MAX_PAGES = 40;
  for (let p = 0; p < MAX_PAGES; p += 1) {
    const from = p * PAGE;
    const { data, error } = await pageFn(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

// ─── Row shape (matches pm_formulary view projection) ─────────────────

interface CmsFormularyViewRow {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  rxcui: string;
  tier: number;
  copay: number | null;
  coinsurance: number | null;
  prior_auth: boolean;
  step_therapy: boolean;
  quantity_limit: boolean;
  quantity_limit_amount: number | null;
  quantity_limit_days: number | null;
  drug_type: string | null;
  drug_name: string | null;
}

// ─── Drug matching (mirrors pm-snapshot behavior) ─────────────────────

function firstBrandKeyword(name: string): string {
  return name.split('(')[0].trim();
}

function isPartBOnly(drug: Drug): boolean {
  return drug.part === 'part-b';
}

function findMatchingRow(rows: CmsFormularyViewRow[], drug: Drug): CmsFormularyViewRow | null {
  const target = firstBrandKeyword(drug.name).toLowerCase();
  const exact = rows.find((r) => (r.drug_name ?? '').toLowerCase() === target);
  if (exact) return exact;
  const contains = rows.filter((r) => {
    const dn = (r.drug_name ?? '').toLowerCase();
    return dn.includes(target) || target.includes(dn);
  });
  if (contains.length === 0) return null;
  // Prefer the shortest matching drug_name (tightest match).
  contains.sort((a, b) => (a.drug_name?.length ?? 999) - (b.drug_name?.length ?? 999));
  return contains[0];
}

function tierNumberToUnion(n: number | null): Tier | null {
  if (n == null) return null;
  if (n >= 1 && n <= 6) return n as Tier;
  return null;
}

// ─── Public API ───────────────────────────────────────────────────────

export interface PlanKey {
  contractId: string;
  planId: string;
  segmentId: string;
}

/**
 * Fetch CMS formulary rows for a set of plans + drugs and build the
 * canonical DrugCoverage[] the MPF side of parity comparison should
 * report (since MPF reads the same CMS SPUF).
 *
 * Returns Map keyed by `${contractId}-${planId}-${segmentId}` (matching
 * the padSeg convention used by pm-snapshot + run.ts).
 */
export async function cmsDrugCoverageByPlan(
  profile: BeneficiaryProfile,
  planKeys: PlanKey[],
): Promise<Map<string, DrugCoverage[]>> {
  const result = new Map<string, DrugCoverage[]>();
  if (planKeys.length === 0) return result;

  const partDDrugs = profile.drugs.filter((d) => !isPartBOnly(d));
  const contractIds = [...new Set(planKeys.map((k) => k.contractId))];
  const planIds = [...new Set(planKeys.map((k) => k.planId))];

  // Segment-agnostic: pm_formulary_v2 files at contract+plan level (usually
  // segment='001' only). Aggregate all segments per (contract, plan).
  const rows = await paginate<CmsFormularyViewRow>((from, to) =>
    sb()
      .from('pm_formulary')
      .select(
        'contract_id, plan_id, segment_id, rxcui, tier, copay, coinsurance, prior_auth, step_therapy, quantity_limit, quantity_limit_amount, quantity_limit_days, drug_type, drug_name',
      )
      .in('contract_id', contractIds)
      .in('plan_id', planIds)
      .not('drug_name', 'is', null)
      .range(from, to) as unknown as PromiseLike<PostgrestSingleResponse<CmsFormularyViewRow[]>>,
  );

  // Index by contract-plan (dropping segment); apply drug-name pre-filter
  // client-side to avoid PostgREST query-length limits.
  const wanted = partDDrugs.map((d) => firstBrandKeyword(d.name).toLowerCase());
  const rowsByPlan = new Map<string, CmsFormularyViewRow[]>();
  for (const r of rows) {
    if (!r.drug_name) continue;
    const nameLc = r.drug_name.toLowerCase();
    const match = wanted.some((w) => nameLc.includes(w) || w.includes(nameLc));
    if (!match) continue;
    const key = `${r.contract_id}-${r.plan_id}`;
    const list = rowsByPlan.get(key) ?? [];
    list.push(r);
    rowsByPlan.set(key, list);
  }

  // Build per-plan DrugCoverage[] matching the requested planKeys.
  for (const key of planKeys) {
    const planRows = rowsByPlan.get(`${key.contractId}-${key.planId}`) ?? [];
    const coverage: DrugCoverage[] = [];
    for (const drug of profile.drugs) {
      // Part-B drugs are not on Part D formulary — leave onFormulary false.
      if (isPartBOnly(drug)) {
        coverage.push({
          drug,
          onFormulary: false,
          tier: null,
          priorAuth: false,
          quantityLimit: false,
          quantityLimitAmount: null,
          quantityLimitDays: null,
          stepTherapy: false,
          specialtyPharmacy: false,
          preferredCopay: null,
          standardCopay: null,
          isCoinsurance: false,
        });
        continue;
      }
      const hit = findMatchingRow(planRows, drug);
      if (!hit) {
        coverage.push({
          drug,
          onFormulary: false,
          tier: null,
          priorAuth: false,
          quantityLimit: false,
          quantityLimitAmount: null,
          quantityLimitDays: null,
          stepTherapy: false,
          specialtyPharmacy: false,
          preferredCopay: null,
          standardCopay: null,
          isCoinsurance: false,
        });
        continue;
      }
      const isCoins = hit.copay == null && hit.coinsurance != null;
      coverage.push({
        drug,
        onFormulary: true,
        tier: tierNumberToUnion(hit.tier),
        priorAuth: !!hit.prior_auth,
        quantityLimit: !!hit.quantity_limit,
        quantityLimitAmount: hit.quantity_limit_amount,
        quantityLimitDays: hit.quantity_limit_days,
        stepTherapy: !!hit.step_therapy,
        // Not in schema — pm_formulary_v2 doesn't file per-drug specialty-pharmacy flag.
        specialtyPharmacy: false,
        preferredCopay: isCoins ? hit.coinsurance : hit.copay,
        // Standard-pharmacy copay isn't split in pm_formulary_v2. Mirror
        // preferred so the diff engine at least has a value on both sides.
        standardCopay: isCoins ? hit.coinsurance : hit.copay,
        isCoinsurance: isCoins,
      });
    }
    const cacheKey = `${key.contractId}-${key.planId}-${key.segmentId.padStart(3, '0')}`;
    result.set(cacheKey, coverage);
  }
  return result;
}

/**
 * Enrich MPF PlanSnapshots (loaded from cache or fresh scrape) by
 * populating the currently-stubbed drugCoverage[] from CMS ground truth.
 * Mutates in place and returns the same array for chaining.
 */
export async function enrichMpfSnapshotsWithCms(
  snapshots: PlanSnapshot[],
  profile: BeneficiaryProfile,
): Promise<PlanSnapshot[]> {
  if (snapshots.length === 0) return snapshots;
  const planKeys: PlanKey[] = snapshots.map((s) => ({
    contractId: s.ident.contractId,
    planId: s.ident.planId,
    segmentId: s.ident.segmentId,
  }));
  const coverageByKey = await cmsDrugCoverageByPlan(profile, planKeys);
  for (const snap of snapshots) {
    const key = `${snap.ident.contractId}-${snap.ident.planId}-${snap.ident.segmentId.padStart(3, '0')}`;
    const cov = coverageByKey.get(key);
    if (cov && cov.length > 0) {
      snap.drugCoverage = cov;
    }
  }
  return snapshots;
}
