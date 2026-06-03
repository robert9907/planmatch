// Plan Match Library API client — thin HTTP wrapper around the shared
// library endpoints living at planmatch.generationhealth.me. Lets the
// agent drop its local pm_drugs query + bulk of the provider-network
// scrape and read the answers from one source of truth.
//
// What's wired this session:
//   • searchDrugs           → /api/library/drug-search  (✓ live)
//   • checkProviderNetwork  → /api/library/provider-network (✓ live)
//
// What's NOT wired yet:
//   • rankPlans             → /api/library/rank-plans  — the consumer's
//     endpoint crashes at Vercel module-load time (cross-workspace
//     brain import doesn't bundle). Tracked separately; the agent keeps
//     its local plan-brain.ts pipeline until that's resolved.
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
