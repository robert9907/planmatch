// networkCheck — provider network status per plan.
//
// Today this stays on the deterministic hash mock that fhir.ts used.
// The new thing is the `source` discriminator: every result is now
// stamped 'unverified_mock' instead of the hopeful 'fhir_mock' /
// 'seed_data' labels the old module used. The UI can (and should)
// surface "Verify with carrier" alongside the mock status so Rob
// never enrolls someone on a provider we haven't actually confirmed.
//
// When a real carrier directory proxy lands (Humana / UHC / Aetna
// PDEX FHIR endpoints each need their own auth + response shape),
// wire it in as a new branch before the mock — everything behind
// `source === 'directory'` is the truth, everything else is a
// placeholder.

import type { Plan } from '@/types/plans';

export type NetworkStatus = 'in' | 'out' | 'unknown';
export type NetworkSource = 'directory' | 'unverified_mock';

export interface NetworkCheckResult {
  plan_id: string;
  carrier: string;
  status: NetworkStatus;
  source: NetworkSource;
  checked_at: number;
  /** Human-readable explanation — shown in the UI tooltip next to the
   *  status pill so the agent always knows if a value is trustable. */
  note: string;
}

export async function checkNetwork(npi: string, plan: Plan): Promise<NetworkCheckResult> {
  // Simulated latency so the UI doesn't flicker through 12 instant
  // status changes — matches the prior mock's behavior.
  await sleep(220 + (hash(npi + plan.id) % 380));

  const bucket = hash(npi + plan.id) % 10;
  const status: NetworkStatus = bucket < 2 ? 'out' : bucket < 8 ? 'unknown' : 'in';
  return {
    plan_id: plan.id,
    carrier: plan.carrier,
    status,
    source: 'unverified_mock',
    checked_at: Date.now(),
    note:
      'Unverified — mock network status until the carrier FHIR directory proxy ships. Confirm in-network with the carrier before enrolling.',
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
