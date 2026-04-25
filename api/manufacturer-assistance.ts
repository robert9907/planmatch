// GET /api/manufacturer-assistance
//
// Returns rows from pm_manufacturer_assistance. The seed table is
// small (~20 brand drugs) so the default response sends the whole
// thing in one round trip — the client caches it for the session.
//
// Query string:
//   brands=Mounjaro,Eliquis     (optional, case-insensitive)
//   medicare_only=1             (optional — covers_medicare = true)

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';
import { supabase } from './_lib/supabase.js';

interface AssistanceRow {
  id: number;
  drug_name: string;
  brand_name: string;
  manufacturer: string;
  program_name: string;
  program_type: 'PAP' | 'copay_card' | 'foundation';
  eligibility_summary: string | null;
  income_limit_individual: number | null;
  income_limit_couple: number | null;
  requires_m3p_enrollment: boolean | null;
  application_url: string | null;
  phone_number: string | null;
  covers_medicare: boolean | null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');

  const brandsParam = typeof req.query.brands === 'string' ? req.query.brands : '';
  const brandFilter = brandsParam
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const medicareOnly = req.query.medicare_only === '1';

  try {
    const sb = supabase();
    let q = sb
      .from('pm_manufacturer_assistance')
      .select(
        'id, drug_name, brand_name, manufacturer, program_name, program_type, ' +
          'eligibility_summary, income_limit_individual, income_limit_couple, ' +
          'requires_m3p_enrollment, application_url, phone_number, covers_medicare',
      );
    if (medicareOnly) q = q.eq('covers_medicare', true);
    const { data, error } = await q.order('brand_name', { ascending: true });
    if (error) throw error;

    let rows = (data ?? []) as unknown as AssistanceRow[];
    if (brandFilter.length > 0) {
      rows = rows.filter((r) => brandFilter.includes(r.brand_name.toLowerCase()));
    }

    res.setHeader('Cache-Control', 'public, max-age=600, stale-while-revalidate=3600');
    return sendJson(res, 200, { rows });
  } catch (err) {
    return serverError(res, err);
  }
}
