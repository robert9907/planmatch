// GET /api/planmatch-carriers?state=NC&county=Durham
//
// Returns the distinct carriers (grouped by contract_id) for a county
// from plan-match-prod.pm_plans. Powers the carrier checklist in the
// verification drawer — Rob ticks the contracts where SunFire confirms
// each provider in-network, and the checked contract IDs get written
// back via the PATCH on planmatch-verifications.
//
// Contract-level (not carrier-name-level) because a single carrier
// often splits its network across multiple contracts (Humana HMO vs.
// Humana PPO are distinct contract IDs with different provider lists).
// Storing contract IDs lets the consumer widget's ranking match the
// exact network scope on the plan row.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from './_lib/supabase.js';

interface CarrierGroup {
  contract_id: string;
  carriers: Map<string, number>;
  parents: Map<string, number>;
  plan_types: Set<string>;
  plan_count: number;
}

function setCors(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET required' });

  const stateAbbr = String(req.query.state ?? '').trim().toUpperCase();
  const county = String(req.query.county ?? '').trim();

  if (!stateAbbr || stateAbbr.length !== 2) {
    return res.status(400).json({ error: 'state (2-letter) required' });
  }
  if (!county) {
    return res.status(400).json({ error: 'county required' });
  }

  try {
    const { data, error } = await supabase()
      .from('pm_plans')
      .select('contract_id, carrier, parent_organization, plan_type')
      .eq('state', stateAbbr)
      .eq('county_name', county)
      .eq('sanctioned', false)
      .limit(2000);

    if (error) {
      console.error('[planmatch-carriers]', error);
      return res.status(500).json({ error: error.message });
    }

    // Group by contract_id. Carrier display name: most common non-null
    // `carrier` for the contract, else fall back to `parent_organization`.
    const byContract = new Map<string, CarrierGroup>();
    for (const row of (data ?? []) as Array<{
      contract_id: string | null;
      carrier: string | null;
      parent_organization: string | null;
      plan_type: string | null;
    }>) {
      const cid = row.contract_id;
      if (!cid) continue;
      const g = byContract.get(cid) ?? {
        contract_id: cid,
        carriers: new Map(),
        parents: new Map(),
        plan_types: new Set(),
        plan_count: 0,
      };
      if (row.carrier) {
        g.carriers.set(row.carrier, (g.carriers.get(row.carrier) ?? 0) + 1);
      }
      if (row.parent_organization) {
        g.parents.set(
          row.parent_organization,
          (g.parents.get(row.parent_organization) ?? 0) + 1,
        );
      }
      if (row.plan_type) g.plan_types.add(row.plan_type);
      g.plan_count += 1;
      byContract.set(cid, g);
    }

    const pickTop = (m: Map<string, number>): string | null =>
      [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    const carriers = Array.from(byContract.values())
      .map((g) => ({
        contract_id: g.contract_id,
        carrier: pickTop(g.carriers) ?? pickTop(g.parents) ?? 'Carrier',
        plan_types: [...g.plan_types].sort(),
        plan_count: g.plan_count,
      }))
      .sort(
        (a, b) =>
          a.carrier.localeCompare(b.carrier) ||
          a.contract_id.localeCompare(b.contract_id),
      );

    return res.status(200).json({
      state: stateAbbr,
      county,
      count: carriers.length,
      carriers,
    });
  } catch (err) {
    console.error('[planmatch-carriers] fatal:', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}
