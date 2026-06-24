// Plan Match Library API client — thin HTTP wrapper around the shared
// library endpoints living at planmatch.generationhealth.me. Lets the
// agent drop its local pm_drugs query + bulk of the provider-network
// scrape and read the answers from one source of truth.
//
// What's wired this session:
//   • searchDrugs           → /api/library/drug-search  (✓ live)
//   • checkProviderNetwork  → /api/library/provider-network (✓ live)
//
//   • rankPlans             → /api/library/rank-plans  (✓ live)
//
// Configure via VITE_PLANMATCH_LIBRARY_URL on the agent's Vercel
// project. Defaults to the consumer's custom domain so dev / preview
// builds work without env-var setup.

const LIBRARY_URL: string =
  ((import.meta.env as { VITE_PLANMATCH_LIBRARY_URL?: string })
    .VITE_PLANMATCH_LIBRARY_URL ??
    'https://planmatch.generationhealth.me') as string;

// Canonicalize a plan-id triple so library output and the agent's
// /api/plans output compare cleanly. The library emits the raw
// pm_plans.segment_id ("H1234-005-0") while /api/plans pads empty
// segments to "000" ("H1234-005-000"). Both are valid pointers to the
// same plan — we normalize by stripping leading zeros from the
// segment ("H1234-005-0"). A 2-part id ("H1234-005") gets a "-0"
// appended so combined and triple forms collide on the same key.
export function normalizePlanId(id: string): string {
  if (!id) return id;
  const parts = id.split('-');
  if (parts.length < 2) return id;
  const segment = parts[2] ?? '0';
  const segNormalized = segment.replace(/^0+/, '') || '0';
  return `${parts[0]}-${parts[1]}-${segNormalized}`;
}

// ─── drug-search ─────────────────────────────────────────────────

export interface LibraryDrug {
  rxcui: string;
  /** RxNorm canonical name — "levothyroxine sodium 0.025 MG Oral Tablet [Synthroid]". */
  name: string;
  generic_name: string;
  brand_name: string;
  strength: string;
  dose_form: string;
  is_brand: boolean;
}

export async function searchDrugs(
  query: string,
  limit: number = 10,
  signal?: AbortSignal,
): Promise<LibraryDrug[]> {
  const res = await fetch(`${LIBRARY_URL}/api/library/drug-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`library/drug-search ${res.status} ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { drugs?: LibraryDrug[] };
  return data.drugs ?? [];
}

// ─── provider-network ────────────────────────────────────────────

export interface LibraryProviderPlan {
  plan_id: string; // triple "<contract>-<plan>-<segment>"
  plan_name: string;
  carrier: string;
  status: 'in_network' | 'out_of_network' | 'unknown';
  source: 'fhir_live' | 'cache' | 'medicare_gov' | 'unknown';
  last_verified: string | null;
}

export interface LibraryProviderResult {
  name: string;
  specialty: string;
  plans: LibraryProviderPlan[];
}

export interface LibraryProviderNetworkResponse {
  by_npi: Record<string, LibraryProviderResult>;
}

export async function checkProviderNetwork(args: {
  npis: string[];
  county: string;
  state: string;
  plan_ids?: string[];
  signal?: AbortSignal;
}): Promise<LibraryProviderNetworkResponse> {
  const { npis, county, state, plan_ids, signal } = args;
  const res = await fetch(`${LIBRARY_URL}/api/library/provider-network`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ npis, county, state, plan_ids }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `library/provider-network ${res.status} ${body.slice(0, 200)}`,
    );
  }
  const parsed = (await res.json()) as LibraryProviderNetworkResponse;
  // [AUDIT 1] Raw library response, BEFORE any client-side processing.
  // First 300 chars of the JSON keeps the line scannable while still
  // showing the by_npi keys + first NPI block's plans array.
  try {
    const npiKeys = Object.keys(parsed.by_npi ?? {});
    const firstNpi = npiKeys[0];
    const firstPlans = firstNpi ? parsed.by_npi[firstNpi]?.plans ?? [] : [];
    const inCount = firstPlans.filter((p) => p.status === 'in_network').length;
    console.log(
      `[AUDIT 1] library raw response: npis=${npiKeys.length} firstNpi=${firstNpi ?? '—'} ` +
        `plans=${firstPlans.length} in_network=${inCount} | ` +
        JSON.stringify(parsed).slice(0, 300),
    );
  } catch {
    // Defensive — shouldn't happen, but never let a log break the fetch.
  }
  return parsed;
}

// ─── rank-plans ──────────────────────────────────────────────────

export interface LibraryRankMedication {
  rxcui: string;
  name: string;
  covered: boolean;
  /** Formulary tier (1–5/6) when covered; null when not on formulary. */
  tier: number | null;
  /** Monthly copay (dollars) — null when coinsurance or unknown. */
  copay: number | null;
  /** Yearly out-of-pocket estimate for this drug on this plan. */
  annual_cost: number;
}

export interface LibraryRankProvider {
  npi: string;
  name: string;
  /** true=in-network, false=out, null=unknown/unverified. */
  in_network: boolean | null;
  /** Provenance of the network determination. */
  source: 'fhir_live' | 'cache' | 'unknown';
}

/** All 17 supplemental-benefit fields the library normalizes from
 *  pm_plan_benefits + pbp_benefits. Each is a free-text display string
 *  or null when the plan doesn't file the category. */
export interface LibraryRankBenefits {
  dental: string | null;
  vision: string | null;
  hearing: string | null;
  otc: string | null;
  fitness: string | null;
  transportation: string | null;
  meals: string | null;
  telehealth: string | null;
  part_b_giveback: string | null;
  pcp_copay: string | null;
  specialist: string | null;
  part_d_deductible: string | null;
  urgent_care: string | null;
  emergency: string | null;
  inpatient: string | null;
  inpatient_mental: string | null;
  skilled_nursing: string | null;
}

export interface LibraryRankPlan {
  /** "<contract>-<plan>-<segment>" triple. */
  plan_id: string;
  plan_name: string;
  carrier: string | null;
  plan_type: string | null;
  premium: number;
  moop: number;
  star_rating: number | null;
  medications: LibraryRankMedication[];
  total_annual_drug_cost: number;
  meds_covered: number;
  meds_total: number;
  providers: LibraryRankProvider[];
  docs_in_network: number;
  docs_total: number;
  benefits: LibraryRankBenefits;
  total_annual_cost: number;
  /** 1–4 for Top picks, null for bench. */
  slot: number | null;
  ribbon: string | null;
  gate_results: {
    gate1_passed: boolean;
    gate2_passed: boolean;
    gate3_passed: boolean;
  };
}

export interface LibraryRankResult {
  top_plans: LibraryRankPlan[];
  bench_plans: LibraryRankPlan[];
  total_plans_in_county: number;
  gate1_survivors: number;
  gate2_survivors: number;
  gate3_survivors: number;
  detected_conditions: string[];
  csnp_eligible: boolean;
  dsnp_eligible: boolean;
}

/** The 4 CMS-recognized C-SNP qualifying conditions the brain
 *  accepts as a self-report. Anything outside this enum is dropped
 *  server-side before reaching the brain. */
export type CsnpConditionKey = 'diabetes' | 'cardio' | 'copd' | 'esrd';

export interface LibraryRankInput {
  county: string;
  zip: string;
  state: string;
  medications: { rxcui: string; name: string; strength?: string }[];
  providers: { npi: string; name: string }[];
  extras: { type: string; enabled: boolean; threshold?: number }[];
  /** Self-reported chronic conditions the broker captured. Routes the
   *  brain's C-SNP eligibility + reserved-slot path so users with no
   *  qualifying meds still surface chronic-condition plans (the May 23
   *  diabetes-without-Ozempic break). Optional — empty means
   *  "med-detection only". */
  csnpConditions?: CsnpConditionKey[];
  current_plan_id?: string | null;
  /** Self-reported dual-eligibility (Medicaid + Medicare). When true,
   *  the library brain's population gate keeps D-SNP plans in the
   *  Top-4 candidate pool; when false / undefined, D-SNPs are stripped
   *  for the standard recommendation flow. Maps to UserProfile
   *  .dsnpEligible on the server side. */
  dsnp_eligible?: boolean;
}

export async function rankPlans(
  input: LibraryRankInput,
  signal?: AbortSignal,
): Promise<LibraryRankResult> {
  const res = await fetch(`${LIBRARY_URL}/api/library/rank-plans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`library/rank-plans ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as LibraryRankResult;
}

// ─── broker-verify-provider ───────────────────────────────────────
//
// Persists a "Mark In-Network" click to pm_provider_network_cache as
// a source='broker_verified' row. Next rank-plans response picks it
// up via the cache's freshest-checked_at resolution. FHIR-source rows
// (fhir_uhc / fhir_humana / fhir_devoted / fhir_bcbsnc) are
// authoritative — the server returns
// overwritten='skipped_fhir_authoritative' rather than overwriting.

export interface BrokerVerifyProviderResult {
  success: true;
  overwritten: 'inserted' | 'skipped_fhir_authoritative';
  checked_at?: string;
  fhir_source?: string;
  fhir_covered?: boolean;
}

export async function brokerVerifyProvider(args: {
  npi: string;
  /** Triple plan id — "H5253-189-000" form (matches the plan.id the
   *  agent threads everywhere). The endpoint splits it into combined
   *  contract+plan and segment internally. */
  planId: string;
  signal?: AbortSignal;
}): Promise<BrokerVerifyProviderResult> {
  const { npi, planId, signal } = args;
  const res = await fetch(
    `${LIBRARY_URL}/api/library/broker-verify-provider`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ npi, planId }),
      signal,
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `library/broker-verify-provider ${res.status} ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as BrokerVerifyProviderResult;
}
