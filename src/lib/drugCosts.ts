// drugCosts — browser-side client for /api/drug-ndcs and /api/drug-costs.
//
// Two calls chained:
//   1. /api/drug-ndcs  →  resolve rxcuis to representative NDCs
//   2. /api/drug-costs →  Medicare.gov drug-cost call (Playwright server
//                         side) for a list of plans + NDCs
//
// The Quote page fires both once per (plans × rxcuis × pharmacy mode)
// tuple; the server caches 24h so toggling retail↔mail within a session
// only hits upstream twice.

export interface PlanDrugCost {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  monthly_cost: number | null;
  annual_cost: number | null;
}

export interface DrugCostResponse {
  source: string;
  costs: PlanDrugCost[];
}

export interface DrugCostPlanInput {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  contract_year: string;
}

export type PharmacyMode = 'retail' | 'mail';

export async function resolveRxcuisToNdcs(
  rxcuis: string[],
): Promise<Record<string, string[]>> {
  if (rxcuis.length === 0) return {};
  const res = await fetch('/api/drug-ndcs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rxcuis }),
  });
  if (!res.ok) throw new Error(`drug-ndcs ${res.status}`);
  const body = (await res.json()) as { ndcs?: Record<string, string[]> };
  return body.ndcs ?? {};
}

export async function fetchDrugCosts(params: {
  plans: DrugCostPlanInput[];
  ndcs: string[];               // one representative NDC per prescription
  mode: PharmacyMode;
}): Promise<DrugCostResponse> {
  const { plans, ndcs, mode } = params;
  if (plans.length === 0 || ndcs.length === 0) {
    return { source: 'skipped', costs: [] };
  }
  const frequency = mode === 'mail' ? 'FREQUENCY_90_DAYS' : 'FREQUENCY_30_DAYS';
  const quantity = mode === 'mail' ? '90' : '30';
  const prescriptions = ndcs.map((ndc) => ({ ndc, frequency, quantity }));
  const res = await fetch('/api/drug-costs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      plans,
      prescriptions,
      retail_only: mode === 'retail',
      lis: 'LIS_NO_HELP',
      npis: [],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`drug-costs ${res.status} — ${text.slice(0, 200)}`);
  }
  return (await res.json()) as DrugCostResponse;
}
