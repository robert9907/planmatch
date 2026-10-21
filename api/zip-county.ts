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
      return sendJson(res, 200, { zip: zipRaw, county: null, state: null, counties: [] });
    }

    // Every county the ZIP touches (pm_zip_county_all). A ZIP can span
    // several counties (30530 → Banks, Jackson, Madison, Franklin); the
    // single `county` above is only the default. Callers keep a county the
    // broker already set when it is one of these instead of overwriting it.
    let counties: string[] = [data.county];
    const all = await sb
      .from('pm_zip_county_all')
      .select('county, is_dominant')
      .eq('zip', zipRaw);
    if (!all.error && Array.isArray(all.data) && all.data.length > 0) {
      const rows = all.data as Array<{ county: string; is_dominant: boolean | null }>;
      counties = [
        ...rows.filter((r) => r.is_dominant).map((r) => r.county),
        ...rows.filter((r) => !r.is_dominant).map((r) => r.county),
      ].filter((c, i, arr) => c && arr.indexOf(c) === i);
      if (!counties.includes(data.county)) counties.unshift(data.county);
    }

    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    return sendJson(res, 200, {
      zip: zipRaw,
      county: data.county,
      state: data.state,
      counties,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
