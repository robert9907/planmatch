// POST /api/drug-phases — per-drug per-plan cost sharing broken out by
// Part D coverage phase.
//
// Body:
//   {
//     plans:            [{ contract_id, plan_id, segment_id? }],  // 1..20
//     rxcuis:           string[],                                  // 1..50
//     pharmacy_type?:   'pref' | 'nonpref' | 'mail_pref' | 'mail_nonpref',
//                       // default 'pref' — 30-day preferred retail
//     days_supply_code?: 1 | 2 | 3 | 4,   // 1=30, 2=90, 3=other, 4=60
//                                          // default 1 (30-day)
//     plan_year?:       number,           // default: current year
//   }
//
// Response:
//   {
//     pharmacy_type, days_supply_code, plan_year,
//     results: [{
//       contract_id, plan_id, segment_id, rxcui,
//       tier,
//       drug_type,             // 'generic' | 'brand' | 'specialty' | null
//       tier_specialty,        // per-plan-tier CMS flag
//       deductible_applies,    // whether the tier gets the Part D deductible
//       phases: {
//         deductible?:   { cost_type, cost_amount, cost_min, cost_max },
//         initial?:      { cost_type, cost_amount, cost_min, cost_max },
//         catastrophic?: { cost_type, cost_amount, cost_min, cost_max },
//       },
//     }],
//     missing: [{ contract_id, plan_id, segment_id, rxcui }],
//     count: number,
//   }
//
// cost_type semantics (from CMS SPUF beneficiary_cost):
//   0 = not applicable
//   1 = flat copay      → cost_amount is dollars
//   2 = coinsurance     → cost_amount is fraction 0..1
//
// Coverage phase semantics (pm_beneficiary_cost_v2.coverage_level):
//   0 = deductible phase (annual Part D deductible not yet met)
//   1 = initial coverage (deductible met, below Part D OOP threshold)
//   3 = catastrophic (above Part D OOP threshold — $0/$0 for everyone
//                     under IRA §11201 for 2026+)
//   The coverage gap (level 2) was eliminated by IRA §11404 in 2025+.
//
// Data source: pm_formulary_v2 (tier + drug_type) + pm_beneficiary_cost_v2
// (per-phase cost sharing). Both tables are populated by the SPUF
// promote pipeline; the drug_type column is filled by the promote path
// on new imports and by scripts/backfill-formulary-drug-type.ts for
// pre-existing rows.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';
import { supabase } from './_lib/supabase.js';

const MAX_PLANS = 20;
const MAX_RXCUIS = 50;
const SUPABASE_PAGE = 1000;
const MAX_PAGES = 20;

type PharmacyType = 'pref' | 'nonpref' | 'mail_pref' | 'mail_nonpref';
type DrugType = 'generic' | 'brand' | 'specialty';
type PhaseKey = 'deductible' | 'initial' | 'catastrophic';

const PHASE_BY_COVERAGE_LEVEL: Record<number, PhaseKey> = {
  0: 'deductible',
  1: 'initial',
  3: 'catastrophic',
};

interface PlanInput {
  contract_id: string;
  plan_id: string;
  segment_id: string;
}

interface RequestBody {
  plans: PlanInput[];
  rxcuis: string[];
  pharmacy_type: PharmacyType;
  days_supply_code: number;
  plan_year: number;
}

interface FormularyRow {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_year: number;
  rxcui: string;
  tier: number | null;
  drug_type: string | null;
}

interface BeneficiaryCostRow {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  plan_year: number;
  tier: number;
  coverage_level: number;
  cost_type: number;
  cost_amount: number | null;
  cost_min: number | null;
  cost_max: number | null;
  tier_specialty: boolean;
  deductible_applies: boolean;
}

interface PhaseCell {
  cost_type: number;
  cost_amount: number | null;
  cost_min: number | null;
  cost_max: number | null;
}

interface ResultRow {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  rxcui: string;
  tier: number | null;
  drug_type: DrugType | null;
  tier_specialty: boolean;
  deductible_applies: boolean;
  phases: Partial<Record<PhaseKey, PhaseCell>>;
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalizeDrugType(v: string | null): DrugType | null {
  return v === 'generic' || v === 'brand' || v === 'specialty' ? v : null;
}

function validateBody(raw: unknown): RequestBody | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'body required' };
  const body = raw as Record<string, unknown>;

  const plansRaw = body.plans;
  if (!Array.isArray(plansRaw) || plansRaw.length === 0) {
    return { error: 'plans[] required (1..' + MAX_PLANS + ')' };
  }
  if (plansRaw.length > MAX_PLANS) {
    return { error: `plans[] capped at ${MAX_PLANS}` };
  }
  const plans: PlanInput[] = [];
  for (const p of plansRaw) {
    if (!p || typeof p !== 'object') return { error: 'plans[] entry must be object' };
    const rec = p as Record<string, unknown>;
    const contract_id = String(rec.contract_id ?? '').trim().toUpperCase();
    const plan_id = String(rec.plan_id ?? '').trim();
    const segment_id = String(rec.segment_id ?? '0').trim();
    if (!contract_id || !plan_id) return { error: 'plans[] needs contract_id + plan_id' };
    if (contract_id.length > 10 || plan_id.length > 10 || segment_id.length > 10) {
      return { error: 'plans[] id fields too long' };
    }
    plans.push({ contract_id, plan_id, segment_id });
  }

  const rxcuisRaw = body.rxcuis;
  if (!Array.isArray(rxcuisRaw) || rxcuisRaw.length === 0) {
    return { error: 'rxcuis[] required (1..' + MAX_RXCUIS + ')' };
  }
  const rxcuis = Array.from(
    new Set(
      rxcuisRaw
        .filter((v): v is string => typeof v === 'string')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ).slice(0, MAX_RXCUIS);
  if (rxcuis.length === 0) return { error: 'rxcuis[] required' };
  if (rxcuis.some((r) => !/^\d{1,12}$/.test(r))) {
    return { error: 'rxcuis[] values must be numeric' };
  }

  const rawPh = body.pharmacy_type;
  const pharmacy_type: PharmacyType =
    rawPh === 'nonpref' || rawPh === 'mail_pref' || rawPh === 'mail_nonpref'
      ? rawPh
      : 'pref';

  const rawDs = Number(body.days_supply_code);
  const days_supply_code =
    rawDs === 2 || rawDs === 3 || rawDs === 4 ? rawDs : 1;

  const rawYear = Number(body.plan_year);
  const plan_year = Number.isInteger(rawYear) && rawYear >= 2020 && rawYear <= 2100
    ? rawYear
    : new Date().getFullYear();

  return { plans, rxcuis, pharmacy_type, days_supply_code, plan_year };
}

async function fetchAllRows<T>(
  pageFn: (from: number, to: number) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * SUPABASE_PAGE;
    const to = from + SUPABASE_PAGE - 1;
    const rows = await pageFn(from, to);
    out.push(...rows);
    if (rows.length < SUPABASE_PAGE) break;
  }
  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  const rawBody = typeof req.body === 'string' ? safeJsonParse(req.body) : req.body;
  const validated = validateBody(rawBody);
  if ('error' in validated) return badRequest(res, validated.error);
  const { plans, rxcuis, pharmacy_type, days_supply_code, plan_year } = validated;

  try {
    const sb = supabase();

    // ── Bulk fetch pm_formulary_v2 for the plans × rxcuis grid ─────────
    //
    // PostgREST doesn't support composite IN over (contract, plan, seg,
    // rxcui), so we widen: filter by contract_id.in() ∩ plan_id.in() ∩
    // segment_id.in() ∩ rxcui.in() ∩ plan_year.eq() and post-filter in
    // memory by the exact tuple set. Overfetch is bounded because plan
    // count ≤ 20 and rxcui count ≤ 50.
    const contractIds = Array.from(new Set(plans.map((p) => p.contract_id)));
    const planIds = Array.from(new Set(plans.map((p) => p.plan_id)));
    const segmentIds = Array.from(new Set(plans.map((p) => p.segment_id)));
    const planTupleSet = new Set(
      plans.map((p) => `${p.contract_id}::${p.plan_id}::${p.segment_id}`),
    );

    const formularyRows = await fetchAllRows<FormularyRow>(async (from, to) => {
      const { data, error } = await sb
        .from('pm_formulary_v2')
        .select('contract_id, plan_id, segment_id, plan_year, rxcui, tier, drug_type')
        .in('contract_id', contractIds)
        .in('plan_id', planIds)
        .in('segment_id', segmentIds)
        .in('rxcui', rxcuis)
        .eq('plan_year', plan_year)
        .range(from, to);
      if (error) throw new Error(`pm_formulary_v2: ${error.message}`);
      return (data ?? []) as FormularyRow[];
    });

    // Post-filter to exact plan tuples and index by (plan_tuple, rxcui).
    const formularyByKey = new Map<string, FormularyRow>();
    const tiersByPlanTuple = new Map<string, Set<number>>();
    for (const r of formularyRows) {
      const planKey = `${r.contract_id}::${r.plan_id}::${r.segment_id}`;
      if (!planTupleSet.has(planKey)) continue;
      formularyByKey.set(`${planKey}::${r.rxcui}`, r);
      if (r.tier != null) {
        let s = tiersByPlanTuple.get(planKey);
        if (!s) {
          s = new Set<number>();
          tiersByPlanTuple.set(planKey, s);
        }
        s.add(r.tier);
      }
    }

    // ── Bulk fetch pm_beneficiary_cost_v2 for matched tiers ────────────
    //
    // Union of every (plan_tuple, tier) that appeared in the formulary
    // hits above, at (pharmacy_type, days_supply_code, coverage_level ∈
    // {0,1,3}). Same widen-then-post-filter pattern.
    const allTiers = new Set<number>();
    for (const s of tiersByPlanTuple.values()) for (const t of s) allTiers.add(t);

    const bcRowsByKey = new Map<string, Partial<Record<PhaseKey, BeneficiaryCostRow>>>();
    let anyDeductibleApplies = new Map<string, boolean>();
    let anyTierSpecialty = new Map<string, boolean>();

    if (allTiers.size > 0) {
      const tiers = Array.from(allTiers);
      const bcRows = await fetchAllRows<BeneficiaryCostRow>(async (from, to) => {
        const { data, error } = await sb
          .from('pm_beneficiary_cost_v2')
          .select(
            'contract_id, plan_id, segment_id, plan_year, tier, coverage_level, cost_type, cost_amount, cost_min, cost_max, tier_specialty, deductible_applies',
          )
          .in('contract_id', contractIds)
          .in('plan_id', planIds)
          .in('segment_id', segmentIds)
          .in('tier', tiers)
          .in('coverage_level', [0, 1, 3])
          .eq('plan_year', plan_year)
          .eq('days_supply_code', days_supply_code)
          .eq('pharmacy_type', pharmacy_type)
          .range(from, to);
        if (error) throw new Error(`pm_beneficiary_cost_v2: ${error.message}`);
        return (data ?? []) as BeneficiaryCostRow[];
      });

      for (const r of bcRows) {
        const planKey = `${r.contract_id}::${r.plan_id}::${r.segment_id}`;
        if (!planTupleSet.has(planKey)) continue;
        const validTiers = tiersByPlanTuple.get(planKey);
        if (!validTiers || !validTiers.has(r.tier)) continue;
        const phase = PHASE_BY_COVERAGE_LEVEL[r.coverage_level];
        if (!phase) continue;
        const key = `${planKey}::${r.tier}`;
        let cell = bcRowsByKey.get(key);
        if (!cell) {
          cell = {};
          bcRowsByKey.set(key, cell);
        }
        cell[phase] = r;
        if (r.deductible_applies) anyDeductibleApplies.set(key, true);
        if (r.tier_specialty) anyTierSpecialty.set(key, true);
      }
    }

    // ── Assemble results + missing list ───────────────────────────────
    const results: ResultRow[] = [];
    const missing: {
      contract_id: string;
      plan_id: string;
      segment_id: string;
      rxcui: string;
    }[] = [];

    for (const plan of plans) {
      const planKey = `${plan.contract_id}::${plan.plan_id}::${plan.segment_id}`;
      for (const rxcui of rxcuis) {
        const fr = formularyByKey.get(`${planKey}::${rxcui}`);
        if (!fr) {
          missing.push({ ...plan, rxcui });
          continue;
        }
        const bcKey = fr.tier != null ? `${planKey}::${fr.tier}` : null;
        const cell = bcKey ? bcRowsByKey.get(bcKey) : undefined;
        const phases: Partial<Record<PhaseKey, PhaseCell>> = {};
        if (cell) {
          for (const phase of ['deductible', 'initial', 'catastrophic'] as const) {
            const row = cell[phase];
            if (!row) continue;
            phases[phase] = {
              cost_type: row.cost_type,
              cost_amount: row.cost_amount,
              cost_min: row.cost_min,
              cost_max: row.cost_max,
            };
          }
        }
        results.push({
          contract_id: plan.contract_id,
          plan_id: plan.plan_id,
          segment_id: plan.segment_id,
          rxcui,
          tier: fr.tier,
          drug_type: normalizeDrugType(fr.drug_type),
          tier_specialty: bcKey ? anyTierSpecialty.get(bcKey) === true : false,
          deductible_applies: bcKey ? anyDeductibleApplies.get(bcKey) === true : false,
          phases,
        });
      }
    }

    return sendJson(res, 200, {
      pharmacy_type,
      days_supply_code,
      plan_year,
      results,
      missing,
      count: results.length,
    });
  } catch (err) {
    console.error('[api/drug-phases] fatal:', err);
    return serverError(res, err);
  }
}
