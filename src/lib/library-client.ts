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
  return (await res.json()) as LibraryProviderNetworkResponse;
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

export interface LibraryRankInput {
  county: string;
  zip: string;
  state: string;
  medications: { rxcui: string; name: string; strength?: string }[];
  providers: { npi: string; name: string }[];
  extras: { type: string; enabled: boolean; threshold?: number }[];
  current_plan_id?: string | null;
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
