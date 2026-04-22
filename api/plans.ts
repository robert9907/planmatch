// GET /api/plans — plan catalog backed by pm_plans + pm_plan_benefits.
//
// Query params:
//   state?       2-letter state code (NC / GA / TX).
//   county?      free-text county name, normalized and matched against
//                pm_plans.county_name plus "All Counties" (PDPs).
//   planType?    app's PlanType enum ('MA' | 'MAPD' | 'DSNP' | 'PDP' |
//                'MEDSUPP'). Filters by a translation from the
//                landscape plan_type + SNP flags.
//   ids?         comma-separated list of Plan ids (contract-plan-segment)
//                for the Step 6 finalist refetch path. When provided,
//                state/county/planType filters are ignored — the client
//                already committed to these ids upstream.
//   limit?       default 500, max 2000.
//
// Response: { plans: Plan[], source: 'pm_plans' }
// Errors: { error, detail? } on 4xx/5xx.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';
import { supabase } from './_lib/supabase.js';

type AppPlanType = 'MA' | 'MAPD' | 'DSNP' | 'PDP' | 'MEDSUPP';

// Keep aligned with src/types/plans.ts — the API is the single source
// of truth for Plan shape as far as the UI is concerned.
interface Plan {
  id: string;
  contract_id: string;
  plan_number: string;
  segment_id: string;
  carrier: string;
  plan_name: string;
  state: string;
  counties: string[];
  plan_type: AppPlanType;
  premium: number;
  moop_in_network: number;
  part_b_giveback: number;
  star_rating: number;
  benefits: PlanBenefits;
  formulary: Record<string, never>; // populated lazily via /api/formulary
  in_network_npis: string[]; // empty — networkCheck.ts stamps its own
}

interface PlanBenefits {
  dental: { preventive: boolean; comprehensive: boolean; annual_max: number };
  vision: { exam: boolean; eyewear_allowance_year: number };
  hearing: { aid_allowance_year: number; exam: boolean };
  transportation: { rides_per_year: number; distance_miles: number };
  otc: { allowance_per_quarter: number };
  food_card: { allowance_per_month: number; restricted_to_medicaid_eligible: boolean };
  diabetic: { covered: boolean; preferred_brands: string[] };
  fitness: { enabled: boolean; program: string | null };
}

interface PlanRow {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_name: string;
  carrier: string | null;
  parent_organization: string | null;
  plan_type: string | null;
  state: string;
  county_name: string;
  monthly_premium: number | null;
  moop: number | null;
  drug_deductible: number | null;
  star_rating: number | null;
  snp: boolean;
  snp_type: string | null;
  sanctioned: boolean;
}

interface BenefitRow {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  benefit_category: string;
  coverage_amount: number | null;
  copay: number | null;
  coinsurance: number | null;
  max_coverage: number | null;
}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

function normalizeCounty(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+co\.?$/i, '')
    .replace(/\s+county$/i, '')
    .replace(/\s+parish$/i, '')
    .trim();
}

function mapPlanType(raw: string | null, snp: boolean, snpType: string | null): AppPlanType {
  const t = (raw ?? '').toUpperCase().trim();
  // SNP takes priority — D-SNP plans ride HMO/PPO structures in the
  // source file but the app treats them as their own bucket.
  if (snp) {
    const s = (snpType ?? '').toUpperCase();
    if (s.includes('D-SNP') || s.includes('DSNP')) return 'DSNP';
  }
  if (t === 'PDP') return 'PDP';
  // Everything else in the source (HMO, Local PPO, Regional PPO,
  // HMOPOS, PFFS, MSA, Cost) ships with Part D → MAPD in our enum.
  return 'MAPD';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');

  const state =
    typeof req.query.state === 'string' && /^[A-Za-z]{2}$/.test(req.query.state)
      ? req.query.state.toUpperCase()
      : null;
  const county =
    typeof req.query.county === 'string' ? req.query.county.trim() : '';
  const planType = (typeof req.query.planType === 'string'
    ? req.query.planType
    : null) as AppPlanType | null;
  const idsParam = typeof req.query.ids === 'string' ? req.query.ids : '';
  const limit = Math.min(
    Math.max(
      Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : DEFAULT_LIMIT,
      1,
    ),
    MAX_LIMIT,
  );

  const wantedCounty = normalizeCounty(county);

  try {
    const sb = supabase();

    // ─── Step 1: fetch matching pm_plans rows ───────────────────────
    // When ids are passed we ignore the geo filters and just load those
    // triples (finalist refetch path). Otherwise filter by state +
    // (county OR "All Counties" for PDPs).
    let plansQuery = sb
      .from('pm_plans')
      .select(
        'contract_id, plan_id, segment_id, plan_name, carrier, parent_organization, plan_type, state, county_name, monthly_premium, moop, drug_deductible, star_rating, snp, snp_type, sanctioned',
      )
      .eq('sanctioned', false)
      .limit(limit);

    if (idsParam) {
      const ids = idsParam
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length === 0) return sendJson(res, 200, { plans: [], source: 'pm_plans' });
      // Parse ids: "H1234-005-000" → { contract_id: 'H1234', plan_id: '005', segment_id: '000' }
      const triples = ids
        .map((id) => {
          const parts = id.split('-');
          if (parts.length < 2) return null;
          return {
            contract_id: parts[0],
            plan_id: parts[1],
            segment_id: parts[2] ?? '000',
          };
        })
        .filter((t): t is { contract_id: string; plan_id: string; segment_id: string } => !!t);
      if (triples.length === 0) return sendJson(res, 200, { plans: [], source: 'pm_plans' });
      // Postgrest doesn't do composite IN() — union on the three cols.
      const contractIds = [...new Set(triples.map((t) => t.contract_id))];
      const planIds = [...new Set(triples.map((t) => t.plan_id))];
      plansQuery = plansQuery.in('contract_id', contractIds).in('plan_id', planIds);
    } else {
      if (state) plansQuery = plansQuery.eq('state', state);
    }

    const { data: rawRows, error: planErr } = await plansQuery;
    if (planErr) throw planErr;

    let rows = (rawRows ?? []) as PlanRow[];

    // County filter applied in JS so we can match on the normalized
    // form + "All Counties" PDP wildcard in one pass.
    if (wantedCounty) {
      rows = rows.filter((r) => {
        const c = normalizeCounty(r.county_name);
        return c === wantedCounty || c === 'all counties';
      });
    }

    if (idsParam) {
      // Restrict to the exact triples (in-DB `in()` is a superset).
      const idSet = new Set(
        idsParam.split(',').map((s) => s.trim()).filter(Boolean),
      );
      rows = rows.filter((r) => {
        const id = `${r.contract_id}-${r.plan_id}-${r.segment_id || '000'}`;
        return idSet.has(id);
      });
    }

    if (planType) {
      rows = rows.filter((r) => mapPlanType(r.plan_type, r.snp, r.snp_type) === planType);
    }

    // ─── Step 2: aggregate by (contract_id, plan_id, segment_id) ────
    // Landscape rows are one-per-county; the app wants one plan per
    // triple with an array of counties.
    const byTriple = new Map<string, { row: PlanRow; counties: Set<string> }>();
    for (const r of rows) {
      const key = `${r.contract_id}-${r.plan_id}-${r.segment_id || '000'}`;
      const hit = byTriple.get(key);
      if (hit) {
        hit.counties.add(r.county_name);
      } else {
        byTriple.set(key, { row: r, counties: new Set([r.county_name]) });
      }
    }

    if (byTriple.size === 0) {
      return sendJson(res, 200, { plans: [], source: 'pm_plans' });
    }

    // ─── Step 3: fetch pm_plan_benefits for these triples ───────────
    const contractIds = [...new Set([...byTriple.values()].map((v) => v.row.contract_id))];
    const planIds = [...new Set([...byTriple.values()].map((v) => v.row.plan_id))];
    const { data: benefitRows, error: benefitErr } = await sb
      .from('pm_plan_benefits')
      .select(
        'contract_id, plan_id, segment_id, benefit_category, coverage_amount, copay, coinsurance, max_coverage',
      )
      .in('contract_id', contractIds)
      .in('plan_id', planIds);
    if (benefitErr) throw benefitErr;

    const benefitsByTriple = new Map<string, BenefitRow[]>();
    for (const b of (benefitRows ?? []) as BenefitRow[]) {
      const key = `${b.contract_id}-${b.plan_id}-${b.segment_id || '000'}`;
      const list = benefitsByTriple.get(key) ?? [];
      list.push(b);
      benefitsByTriple.set(key, list);
    }

    // ─── Step 4: shape into Plan[] ──────────────────────────────────
    const plans: Plan[] = [];
    for (const [key, { row, counties }] of byTriple) {
      const benefits = buildBenefits(benefitsByTriple.get(key) ?? []);
      const partBGiveback = pickBenefitNumber(
        benefitsByTriple.get(key) ?? [],
        'partb_giveback',
        'coverage_amount',
      );
      plans.push({
        id: key,
        contract_id: row.contract_id,
        plan_number: row.plan_id,
        segment_id: row.segment_id || '000',
        carrier: row.carrier ?? row.parent_organization ?? '—',
        plan_name: row.plan_name,
        state: row.state,
        counties: [...counties].sort(),
        plan_type: mapPlanType(row.plan_type, row.snp, row.snp_type),
        premium: row.monthly_premium ?? 0,
        moop_in_network: row.moop ?? 0,
        part_b_giveback: partBGiveback ?? 0,
        star_rating: row.star_rating ?? 0,
        benefits,
        formulary: {},
        in_network_npis: [],
      });
    }

    // Stable-ish ordering: star desc, then premium asc.
    plans.sort((a, b) => {
      if (a.star_rating !== b.star_rating) return b.star_rating - a.star_rating;
      return a.premium - b.premium;
    });

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    return sendJson(res, 200, { plans, source: 'pm_plans' });
  } catch (err) {
    return serverError(res, err);
  }
}

function pickBenefitNumber(
  rows: BenefitRow[],
  category: string,
  field: 'coverage_amount' | 'copay' | 'coinsurance' | 'max_coverage',
): number | null {
  const hit = rows.find((r) => r.benefit_category === category);
  if (!hit) return null;
  const v = hit[field];
  return typeof v === 'number' ? v : v != null ? Number(v) : null;
}

function buildBenefits(rows: BenefitRow[]): PlanBenefits {
  // Dental — pm_plan_benefits carries one "dental" row with
  // max_coverage = annual benefit maximum. Preventive vs comprehensive
  // isn't split out in the PBP sections we imported; treat presence of
  // a dental row with max_coverage > 0 as comprehensive.
  const dental = rows.find((r) => r.benefit_category === 'dental');
  const dentalMax = dental?.max_coverage ?? dental?.coverage_amount ?? 0;

  const vision = rows.find((r) => r.benefit_category === 'vision');
  const visionEyewear = vision?.max_coverage ?? vision?.coverage_amount ?? 0;

  const hearing = rows.find((r) => r.benefit_category === 'hearing');
  const hearingAllowance = hearing?.max_coverage ?? hearing?.coverage_amount ?? 0;

  // OTC, transportation, food_card, diabetic, fitness — not yet
  // imported by the PBP importer. Emit zeros so the benefit filter
  // tiers reading them don't crash; Rob's tooling will mark these
  // plans as "data pending" until a follow-up importer covers
  // pbp_b13_other_services.txt.
  return {
    dental: {
      preventive: Boolean(dental),
      comprehensive: Number(dentalMax) > 0,
      annual_max: Number(dentalMax) || 0,
    },
    vision: {
      exam: Boolean(vision),
      eyewear_allowance_year: Number(visionEyewear) || 0,
    },
    hearing: {
      aid_allowance_year: Number(hearingAllowance) || 0,
      exam: Boolean(hearing),
    },
    transportation: { rides_per_year: 0, distance_miles: 0 },
    otc: { allowance_per_quarter: 0 },
    food_card: { allowance_per_month: 0, restricted_to_medicaid_eligible: false },
    diabetic: { covered: false, preferred_brands: [] },
    fitness: { enabled: false, program: null },
  };
}
