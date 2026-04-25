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
//
// ─── DIAGNOSTIC LOGGING ──────────────────────────────────────────────
// Every call emits a console line under the `[network-check]` tag so
// Rob can see what the directory "actually returned" for any (NPI,
// carrier, contract) pair. Because we're on a mock, those logs are
// brutally honest: they include `source: unverified_mock` and the hash
// bucket that produced the result, so a confusing "out-of-network for
// UHC" is immediately traceable to the mock instead of an imaginary
// FHIR endpoint bug. UHC contracts (H5521, H4513, H2001…) get an extra
// warning line because Rob hits those most.

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

// One-time startup banner so anyone watching the console knows the
// mock is in play before they see the first per-plan log line.
let bannerShown = false;
function showBannerOnce(): void {
  if (bannerShown) return;
  bannerShown = true;
  if (typeof console === 'undefined') return;
  console.warn(
    '[network-check] No real FHIR carrier-directory proxy is wired up. ' +
      'All status values returned by checkNetwork() are deterministic mock ' +
      'results derived from hash(NPI + plan_id). Treat in/out/unknown as ' +
      'unverified — the manual override on the Providers page is the ' +
      'authoritative signal until carrier proxies (UHC PDEX, Humana, Aetna) ' +
      'are implemented.',
  );
}

// Plan year is currently inferred from the Plan record (which the
// CMS landscape import stamps). Logged verbatim so a 2026 vs 2027
// mismatch would be obvious; today we always show '2026' from
// pm_plans.
function planYearFor(_plan: Plan): string {
  // pm_plans rows in this build are 2026 landscape data. When the
  // 2027 import lands, plumb plan.contract_year through here.
  return '2026';
}

// UHC contract IDs Rob is most likely to look at. Not used for any
// logic — only to escalate the diagnostic log line so a UHC mismatch
// shows up clearly when scanning the console.
const UHC_CONTRACT_PREFIXES = ['H5521', 'H4513', 'H2001', 'H0271', 'H0294'];

function isUhcContract(plan: Plan): boolean {
  if (plan.carrier?.toLowerCase().includes('united')) return true;
  if (plan.carrier?.toLowerCase().includes('aarp')) return true;
  return UHC_CONTRACT_PREFIXES.some((pfx) => plan.contract_id?.startsWith(pfx));
}

export async function checkNetwork(npi: string, plan: Plan): Promise<NetworkCheckResult> {
  showBannerOnce();

  // Simulated latency so the UI doesn't flicker through 12 instant
  // status changes — matches the prior mock's behavior.
  const hashed = hash(npi + plan.id);
  await sleep(220 + (hashed % 380));

  const bucket = hashed % 10;
  const status: NetworkStatus = bucket < 2 ? 'out' : bucket < 8 ? 'unknown' : 'in';
  const result: NetworkCheckResult = {
    plan_id: plan.id,
    carrier: plan.carrier,
    status,
    source: 'unverified_mock',
    checked_at: Date.now(),
    note:
      'Unverified — mock network status until the carrier FHIR directory proxy ships. Confirm in-network with the carrier before enrolling.',
  };

  logCheck(npi, plan, result, { hash: hashed, bucket });
  return result;
}

export async function checkNetworkAcross(
  npi: string,
  plans: Plan[],
): Promise<NetworkCheckResult[]> {
  return Promise.all(plans.map((plan) => checkNetwork(npi, plan)));
}

function logCheck(
  npi: string,
  plan: Plan,
  result: NetworkCheckResult,
  diag: { hash: number; bucket: number },
): void {
  if (typeof console === 'undefined') return;
  const tag = '[network-check]';
  const line = {
    npi,
    carrier: plan.carrier,
    contract: plan.contract_id,
    plan_number: plan.plan_number,
    plan_id: plan.id,
    plan_year: planYearFor(plan),
    status: result.status,
    source: result.source,
    mock_hash: diag.hash,
    mock_bucket: diag.bucket, // 0–1 → out, 2–7 → unknown, 8–9 → in
    checked_at: new Date(result.checked_at).toISOString(),
  };
  console.info(tag, line);
  if (isUhcContract(plan)) {
    console.warn(
      `${tag} UHC directory call would have happened here: ` +
        `endpoint=https://public.fhir.uhc.com/PublicAndProtected/api/PractitionerRole?practitioner.identifier=${npi}&plan-network=${plan.contract_id}-${plan.plan_number} ` +
        `(NOT CALLED — mock returned status=${result.status}). ` +
        `If the agent verified Dr.${npi} is in-network for this carrier, use the per-carrier "I verified this is wrong" override on the Providers page.`,
    );
  }
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
