import type { Plan } from '@/types/plans';

export type NetworkStatus = 'in' | 'out' | 'unknown';

export interface NetworkCheckResult {
  plan_id: string;
  carrier: string;
  status: NetworkStatus;
  source: 'seed_data' | 'fhir_mock' | 'unknown';
  checked_at: number;
}

/**
 * Phase 4 uses a deterministic mock. Real FHIR carrier-directory calls
 * (UHC, Humana, Aetna) would go here — they require per-carrier auth
 * and per-carrier response shapes; we proxy them server-side later.
 *
 * Logic: if plan.in_network_npis lists the NPI, status is "in". Otherwise
 * we hash (npi + plan_id) to get a stable unknown/out split so the UI
 * shows realistic mixed states instead of everything unknown.
 */
export async function checkNetwork(npi: string, plan: Plan): Promise<NetworkCheckResult> {
  await sleep(220 + (hash(npi + plan.id) % 380));

  if (plan.in_network_npis.includes(npi)) {
    return {
      plan_id: plan.id,
      carrier: plan.carrier,
      status: 'in',
      source: 'seed_data',
      checked_at: Date.now(),
    };
  }

  const bucket = hash(npi + plan.id) % 10;
  const status: NetworkStatus = bucket < 2 ? 'out' : 'unknown';
  return {
    plan_id: plan.id,
    carrier: plan.carrier,
    status,
    source: 'fhir_mock',
    checked_at: Date.now(),
  };
}

export async function checkNetworkAcross(
  npi: string,
  plans: Plan[],
): Promise<NetworkCheckResult[]> {
  return Promise.all(plans.map((plan) => checkNetwork(npi, plan)));
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
