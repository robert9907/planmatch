// GET /api/plans-with-extras?ids=H5253-189-000,H1036-308-000,...
//
// Merged benefit data for a plan-id list. Reads two sources:
//
//   pm_plan_benefits  — base layer, federal PBP structured extract
//                       (keyed by contract_id + plan_id + segment_id)
//   pbp_benefits      — overlay, richer sources keyed on the triple id
//                       "<contract>-<plan>-<segment>" with a source
//                       column: 'medicare_gov' | 'sb_ocr' | 'manual' |
//                       'pbp_federal'
//
// Merge rule per (plan_id, benefit_type, tier_id):
//
//   medicare_gov  >  sb_ocr  >  manual  >  pbp_federal
//
// The highest-priority row with any non-null cost field wins the whole
// cell. If the overlay has no row for that key, the pm_plan_benefits
// federal row is kept as-is — so the endpoint degrades gracefully to
// federal-only output until pbp_benefits is populated.
//
// Response shape:
//   {
//     source: "merged",
//     plans: {
//       "H5253-189-000": {
//         benefits: [
//           { benefit_type, tier_id, copay, coinsurance, description, source },
//           ...
//         ]
//       }, ...
//     },
//     stats: { overlay_hits, federal_fallbacks, plans_missing }
//   }

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';
import { supabase } from './_lib/supabase.js';

type Source = 'medicare_gov' | 'sb_ocr' | 'manual' | 'pbp_federal';

// Priority chain — lower index wins a conflict.
const PRIORITY: Source[] = ['medicare_gov', 'sb_ocr', 'manual', 'pbp_federal'];

interface MergedBenefit {
  benefit_type: string;
  tier_id: string | null;
  copay: number | null;
  coinsurance: number | null;
  description: string | null;
  source: Source;
}

interface PmBenefitRow {
  contract_id: string;
  plan_id: string;
  segment_id: string | null;
  benefit_category: string;
  benefit_description: string | null;
  copay: number | null;
  coinsurance: number | null;
}

interface PbpBenefitRow {
  plan_id: string;
  benefit_type: string;
  tier_id: string | null;
  copay: number | null;
  coinsurance: number | null;
  description: string | null;
  source: Source;
}

// Triple id like "H5253-189-000" back to its parts — used to pull
// pm_plan_benefits rows via three in(...) filters since PostgREST
// doesn't do composite IN.
function parseTripleId(id: string): { contract_id: string; plan_id: string; segment_id: string } | null {
  const parts = id.split('-');
  if (parts.length < 2) return null;
  return {
    contract_id: parts[0],
    plan_id: parts[1],
    segment_id: parts[2] ?? '000',
  };
}

function tripleToId(r: Pick<PmBenefitRow, 'contract_id' | 'plan_id' | 'segment_id'>): string {
  return `${r.contract_id}-${r.plan_id}-${r.segment_id || '000'}`;
}

function priorityRank(source: Source): number {
  const i = PRIORITY.indexOf(source);
  return i === -1 ? 999 : i;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');

  const idsParam = typeof req.query.ids === 'string' ? req.query.ids : '';
  const ids = idsParam
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return badRequest(res, 'ids required (comma-separated triple ids)');

  const triples = ids.map(parseTripleId).filter(
    (t): t is { contract_id: string; plan_id: string; segment_id: string } => !!t,
  );
  if (triples.length === 0) return badRequest(res, 'no valid ids parsed');

  try {
    const sb = supabase();

    // ─── Federal PBP base layer ────────────────────────────────────
    const contractIds = [...new Set(triples.map((t) => t.contract_id))];
    const planIds = [...new Set(triples.map((t) => t.plan_id))];
    const segIds = [...new Set(triples.map((t) => t.segment_id))];
    const { data: pmRows, error: pmErr } = await sb
      .from('pm_plan_benefits')
      .select('contract_id, plan_id, segment_id, benefit_category, benefit_description, copay, coinsurance')
      .in('contract_id', contractIds)
      .in('plan_id', planIds)
      .in('segment_id', segIds);
    if (pmErr) throw pmErr;

    // ─── Overlay layer — pbp_benefits ──────────────────────────────
    //
    // The table might not exist yet (DDL is a one-shot migration that
    // Rob runs in the Supabase SQL Editor). PostgREST returns 404 on
    // "table not found" and the supabase-js client surfaces that as
    // an error with code 'PGRST205'. Treat it as "overlay is empty"
    // so the endpoint keeps working in federal-only mode.
    let pbpRows: PbpBenefitRow[] = [];
    let overlayMissing = false;
    const { data: pbpData, error: pbpErr } = await sb
      .from('pbp_benefits')
      .select('plan_id, benefit_type, tier_id, copay, coinsurance, description, source')
      .in('plan_id', ids);
    if (pbpErr) {
      const code = (pbpErr as { code?: string }).code;
      if (code === 'PGRST205' || code === '42P01') {
        overlayMissing = true;
      } else {
        throw pbpErr;
      }
    } else if (pbpData) {
      pbpRows = pbpData as PbpBenefitRow[];
    }

    // ─── Merge ─────────────────────────────────────────────────────
    //
    // Build a per-plan map of (benefit_type, tier_id) → best row. The
    // PBP federal rows are seeded first (rank 3); then overlay rows
    // shove their way in if rank is lower. tier_id is coalesced to
    // '' for the key so null tier_ids from pm_plan_benefits and
    // pbp_benefits hash to the same bucket.
    type CellKey = string; // `${plan_id}::${benefit_type}::${tier_id ?? ''}`
    const best = new Map<CellKey, MergedBenefit & { plan_id: string }>();
    const federalHits = new Set<CellKey>();
    const overlayHits = new Set<CellKey>();

    function considerRow(
      planId: string,
      type: string,
      tier: string | null,
      copay: number | null,
      coinsurance: number | null,
      desc: string | null,
      source: Source,
    ) {
      const key = `${planId}::${type}::${tier ?? ''}`;
      const incoming: MergedBenefit & { plan_id: string } = {
        plan_id: planId,
        benefit_type: type,
        tier_id: tier,
        copay,
        coinsurance,
        description: desc,
        source,
      };
      const existing = best.get(key);
      if (!existing || priorityRank(source) < priorityRank(existing.source)) {
        best.set(key, incoming);
      }
      if (source === 'pbp_federal') federalHits.add(key);
      else overlayHits.add(key);
    }

    for (const r of (pmRows ?? []) as PmBenefitRow[]) {
      const planTripleId = tripleToId(r);
      considerRow(
        planTripleId,
        r.benefit_category,
        null,
        r.copay,
        r.coinsurance,
        r.benefit_description,
        'pbp_federal',
      );
    }
    for (const r of pbpRows) {
      considerRow(
        r.plan_id,
        r.benefit_type,
        r.tier_id,
        r.copay,
        r.coinsurance,
        r.description,
        r.source,
      );
    }

    // ─── Shape the response ────────────────────────────────────────
    const plans: Record<string, { benefits: MergedBenefit[] }> = {};
    for (const id of ids) plans[id] = { benefits: [] };
    for (const row of best.values()) {
      if (!plans[row.plan_id]) plans[row.plan_id] = { benefits: [] };
      const { plan_id, ...rest } = row;
      void plan_id;
      plans[row.plan_id].benefits.push(rest);
    }

    // Stable ordering inside each plan so callers diffing responses
    // don't see false churn.
    for (const id of Object.keys(plans)) {
      plans[id].benefits.sort((a, b) => {
        if (a.benefit_type !== b.benefit_type) return a.benefit_type < b.benefit_type ? -1 : 1;
        return (a.tier_id ?? '').localeCompare(b.tier_id ?? '');
      });
    }

    const plansMissing = ids.filter((id) => plans[id].benefits.length === 0).length;
    const wonByOverlay = [...best.values()].filter((r) => r.source !== 'pbp_federal').length;
    const wonByFederal = best.size - wonByOverlay;

    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=120');
    return sendJson(res, 200, {
      source: 'merged',
      overlay_missing: overlayMissing,
      plans,
      stats: {
        plans_requested: ids.length,
        plans_missing: plansMissing,
        cells_federal: wonByFederal,
        cells_overlay: wonByOverlay,
        cells_total: best.size,
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
}
