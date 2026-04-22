// GET /api/formulary — per-(plan, rxcui) formulary lookup.
//
// Used by Step 3 Medications to render tier / copay / coinsurance for
// every added drug against every eligible plan, and by Step 5 to cut
// plans whose formulary lacks any of the client's medications.
//
// Query shapes:
//   /api/formulary?contract_plan_id=H1234_005&rxcui=105028
//       → { tier, copay, coinsurance, drug_name } | { tier: 'not_covered' }
//
//   /api/formulary?rxcuis=105028,6809,36567&contract_ids=H1234,H5253
//       → { rows: [{ contract_plan_id, rxcui, tier, copay, coinsurance }] }
//     Bulk lookup for the Step 5 funnel; the server does one query per
//     call instead of N calls from the browser.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';
import { supabase } from './_lib/supabase.js';

interface FormularyRow {
  contract_id: string;
  plan_id: string;
  rxcui: string;
  drug_name: string | null;
  tier: number | null;
  copay: number | null;
  coinsurance: number | null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');

  const contractPlanId =
    typeof req.query.contract_plan_id === 'string' ? req.query.contract_plan_id.trim() : '';
  const rxcui = typeof req.query.rxcui === 'string' ? req.query.rxcui.trim() : '';

  const rxcuisCsv = typeof req.query.rxcuis === 'string' ? req.query.rxcuis : '';
  const contractIdsCsv = typeof req.query.contract_ids === 'string' ? req.query.contract_ids : '';

  try {
    const sb = supabase();

    // ─── Bulk mode ──────────────────────────────────────────────────
    if (rxcuisCsv) {
      const rxcuis = rxcuisCsv.split(',').map((s) => s.trim()).filter(Boolean);
      if (rxcuis.length === 0) return sendJson(res, 200, { rows: [] });
      let q = sb
        .from('pm_formulary')
        .select('contract_id, plan_id, rxcui, drug_name, tier, copay, coinsurance')
        .in('rxcui', rxcuis)
        .limit(50_000);
      if (contractIdsCsv) {
        const contractIds = contractIdsCsv.split(',').map((s) => s.trim()).filter(Boolean);
        if (contractIds.length > 0) q = q.in('contract_id', contractIds);
      }
      const { data, error } = await q;
      if (error) throw error;
      const rows = ((data ?? []) as FormularyRow[]).map((r) => ({
        contract_plan_id: `${r.contract_id}_${r.plan_id}`,
        rxcui: r.rxcui,
        tier: r.tier,
        copay: r.copay,
        coinsurance: r.coinsurance,
        drug_name: r.drug_name,
      }));
      res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=120');
      return sendJson(res, 200, { rows });
    }

    // ─── Single lookup ──────────────────────────────────────────────
    if (!contractPlanId) return badRequest(res, 'contract_plan_id or rxcuis required');
    if (!rxcui) return badRequest(res, 'rxcui required');

    const [contractId, planId] = contractPlanId.split('_');
    if (!contractId || !planId) {
      return badRequest(res, 'contract_plan_id must be "<contract_id>_<plan_id>"');
    }

    const { data, error } = await sb
      .from('pm_formulary')
      .select('drug_name, tier, copay, coinsurance')
      .eq('contract_id', contractId)
      .eq('plan_id', planId)
      .eq('rxcui', rxcui)
      .limit(1)
      .maybeSingle();
    if (error) throw error;

    if (!data) {
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
      return sendJson(res, 200, { tier: 'not_covered' });
    }

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    return sendJson(res, 200, {
      tier: data.tier ?? 'not_covered',
      copay: data.copay,
      coinsurance: data.coinsurance,
      drug_name: data.drug_name,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
