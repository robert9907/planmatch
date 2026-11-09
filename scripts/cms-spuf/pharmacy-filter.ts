// scripts/cms-spuf/pharmacy-filter.ts
//
// Default row filter for the pharmacy_networks file. The national file is
// ~307.7M rows / ~170 GB in Postgres after indexes and nothing reads the whole
// thing, so by default we keep only the rows we actually use: a row survives
// iff its PLAN serves one of the target states AND the pharmacy is either
// located in one of those states (by ZIP3 prefix) OR is a mail-order pharmacy
// (PHARMACY_MAIL='Y', which serves members regardless of where it sits). This
// bounds the load to ~6.2M rows / ~2.8 GB without ever landing the full file.
//
// Pass --pharmacy-allow-national to bypass this and load the entire national
// file instead.
import type { PoolClient } from 'pg';

// ZIP3 prefixes + CMS statename for each supported state. Only states listed
// here can be filtered; anything else throws, so a typo can never silently
// fall through to a national load.
const STATES: Record<string, { name: string; zip3: string[] }> = {
  NC: { name: 'North Carolina', zip3: range(270, 289) },
  GA: { name: 'Georgia', zip3: [...range(300, 319), '398', '399'] },
  TX: { name: 'Texas', zip3: [...range(750, 799), '733', '885'] },
};

function range(a: number, b: number): string[] {
  const out: string[] = [];
  for (let i = a; i <= b; i++) out.push(String(i).padStart(3, '0'));
  return out;
}

// 0-based field indices in the pharmacy_network pipe-delimited row.
const F_CONTRACT = 0;
const F_PLAN = 1;
const F_SEGMENT = 2;
const F_ZIP = 4;
const F_MAIL = 8; // PHARMACY_MAIL (Y/N)

export const DEFAULT_PHARMACY_STATES = ['NC', 'TX', 'GA'];

/**
 * Build the pharmacy row predicate for a release. Queries plan_information +
 * geographic_locator (so region codes are release-robust) to find the plans
 * serving the target states, then returns a predicate over a raw split row.
 */
export async function buildPharmacyRowFilter(
  client: PoolClient,
  releaseId: number,
  stateCodes: string[],
): Promise<{ filter: (record: string[]) => boolean; planCount: number; states: string[] }> {
  const codes = stateCodes.map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (codes.length === 0) {
    throw new Error('--pharmacy-states is empty — refusing to build an unbounded (national) pharmacy load. Pass states, or --pharmacy-allow-national.');
  }
  const unknown = codes.filter((s) => !(s in STATES));
  if (unknown.length) {
    throw new Error(
      `--pharmacy-states: unsupported state(s) ${unknown.join(',')}. ` +
        `Add a ZIP3/statename mapping in pharmacy-filter.ts (supported: ${Object.keys(STATES).join(',')}).`,
    );
  }
  const names = codes.map((s) => STATES[s].name);

  // Plans whose service area includes any target state: by county-level state,
  // or by single-state PDP / MA region (region codes read from the geo locator).
  const { rows } = await client.query(
    `WITH regions AS (
       SELECT DISTINCT pdp_region_code, ma_region_code
       FROM cms_spuf_geographic_locator
       WHERE release_id = $1 AND statename = ANY($2::text[])
     )
     SELECT DISTINCT contract_id, plan_id, segment_id
     FROM cms_spuf_plan_information
     WHERE release_id = $1 AND (
       state = ANY($3::text[])
       OR pdp_region_code IN (SELECT pdp_region_code FROM regions WHERE pdp_region_code IS NOT NULL AND pdp_region_code <> '')
       OR ma_region_code  IN (SELECT ma_region_code  FROM regions WHERE ma_region_code  IS NOT NULL AND ma_region_code  <> '')
     )`,
    [releaseId, names, codes],
  );
  const planSet = new Set(rows.map((r) => `${r.contract_id}|${r.plan_id}|${r.segment_id}`));
  const zip3 = new Set(codes.flatMap((s) => STATES[s].zip3));

  const filter = (rec: string[]): boolean => {
    if (!planSet.has(`${rec[F_CONTRACT]}|${rec[F_PLAN]}|${rec[F_SEGMENT]}`)) return false;
    return zip3.has((rec[F_ZIP] ?? '').slice(0, 3)) || rec[F_MAIL] === 'Y';
  };
  return { filter, planCount: planSet.size, states: codes };
}
