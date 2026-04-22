// GET /api/zip-county?zip=27707 — ZIP → { county, state } via pm_zip_county.
//
// Replaces the 13-prefix ZIP_MAP cheat-table hardcoded in
// Step2Intake.tsx. pm_zip_county carries 3,597 NC/GA/TX rows
// populated by scripts/import-zip-county.ts.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';
import { supabase } from './_lib/supabase.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');

  const zipRaw = typeof req.query.zip === 'string' ? req.query.zip.trim() : '';
  if (!/^\d{5}$/.test(zipRaw)) {
    return badRequest(res, 'zip must be exactly 5 digits');
  }

  try {
    const sb = supabase();
    const { data, error } = await sb
      .from('pm_zip_county')
      .select('county, state')
      .eq('zip', zipRaw)
      .limit(1)
      .maybeSingle();
    if (error) throw error;

    // ZIPs unique in the importer, but Supabase sometimes returns null
    // on a miss. Treat as "no hit" so callers can keep the user typing
    // instead of blowing up.
    if (!data) {
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
      return sendJson(res, 200, { zip: zipRaw, county: null, state: null });
    }

    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    return sendJson(res, 200, {
      zip: zipRaw,
      county: data.county,
      state: data.state,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
