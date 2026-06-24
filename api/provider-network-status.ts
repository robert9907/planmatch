// GET /api/provider-network-status
//
// Read-only proxy to pm_provider_network_cache + pm_provider_directory
// for browser callers. Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
// (server-side env), so it works regardless of which Supabase project
// the browser publishable key belongs to.
//
// Existed because the browser key on Vercel is provisioned for the
// AgentBase project (where pm_* tables don't live). Routing through
// this endpoint sidesteps that env bind without a key rotation.
//
// Query params:
//   plan_ids — comma-separated combined ids ("H5253-189,H1036-156")
//   npis     — comma-separated NPIs ("1234567890,9876543210")
//   lookup   — optional JSON-encoded array of { name, zip } objects for
//              providers added without an NPI (manual typing). The
//              server resolves each via NPPES (name+postal_code) and
//              merges the resolved NPIs into the cache lookup so a
//              manually-typed "Robin Edwards / 28640" still gets a
//              real network-status check instead of silently falling
//              through to "Call to confirm".
//
// Response:
//   {
//     "byNpi": {
//       "<npi>": {
//         "byPlanId": { "H5253-189": "in_network" | "out_of_network" },
//         "directory": { "npi", "display_name", "credentials",
//                        "specialties", "primary_address",
//                        "primary_city", "primary_state", "primary_zip" } | null
//       }
//     },
//     "summaryByPlanId": {
//       "<plan_id>": { "in_network", "out_of_network", "pending", "total" }
//     },
//     "resolvedLookups": [
//       { "input": "Robin Edwards|28640", "npi": "1093029498" | null }
//     ]
//   }

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  demandLookupNpi,
  loadContractToCarrierMap,
  carrierForContractId,
  NPI_NOT_FOUND_PLAN_ID,
  type CarrierId,
} from './_lib/fhir-provider.js';

// How long a per-(npi, carrier) "FHIR said no_match" sentinel suppresses
// re-querying. Long enough that the live fallback doesn't burn budget on
// confirmed misses; short enough that a newly-credentialed provider
// becomes visible within a week without manual cache invalidation.
const NPI_NOT_FOUND_SENTINEL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheRow {
  plan_id: string;
  segment_id: string;
  npi: string;
  covered: boolean;
}

interface DataUnavailableRow {
  plan_id: string;
}

interface NotFoundSentinelRow {
  npi: string;
  source: string;
  checked_at: string;
}

interface PlanStateRow {
  contract_id: string;
  plan_id: string;
  state: string;
}

interface CoverageRow {
  state: string;
  scrape_completed_at: string | null;
}

interface DirectoryRow {
  npi: string;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  credentials: string | null;
  specialties: string | null;
  primary_address: string | null;
  primary_city: string | null;
  primary_state: string | null;
  primary_zip: string | null;
}

function setCors(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ─── NPPES name+ZIP → NPI resolver ─────────────────────────────────
// Used to close the gap where a consumer adds a provider via manual
// typing (no NPI captured). NPPES is the public CMS registry and
// accepts (first_name, last_name, postal_code) — exactly what we have
// from the typed name + the consumer's intake ZIP. We pick the top
// NPI-1 match; nothing here is fuzzy enough to risk a wrong-person
// hit, since (last name + 5-digit ZIP) is essentially unique in
// practice.

const NPPES_URL = 'https://npiregistry.cms.hhs.gov/api/';
const NPPES_TIMEOUT_MS = 3_000;
const MAX_UNRESOLVED_LOOKUPS = 5;

interface UnresolvedLookup {
  name: string;
  zip: string;
}

interface ResolvedLookup {
  input: string;
  npi: string | null;
}

interface NppesResult {
  number?: string;
  enumeration_type?: string;
  basic?: { first_name?: string; last_name?: string };
}

// Strip "Dr." prefix and ", CREDENTIAL" suffix, then split on
// whitespace. First token → first_name; last token → last_name. The
// middle is dropped because NPPES files first/last only and a middle
// name on the input would otherwise force last_name="Arlene Edwards"
// (no match for the canonical record).
function splitProviderName(full: string): { first: string; last: string } | null {
  const cleaned = full.replace(/^Dr\.?\s+/i, '').replace(/,.*$/, '').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return { first: '', last: parts[0] };
  return { first: parts[0], last: parts[parts.length - 1] };
}

async function resolveNpiByNppes(name: string, zip: string): Promise<string | null> {
  const split = splitProviderName(name);
  if (!split || !split.last) return null;
  const params = new URLSearchParams({
    version: '2.1',
    enumeration_type: 'NPI-1',
    limit: '5',
    postal_code: zip,
  });
  // 3+ char tokens get a wildcard suffix so "Rob" matches "Robin".
  if (split.first) {
    params.set('first_name', split.first.length >= 3 ? `${split.first}*` : split.first);
  }
  params.set('last_name', split.last.length >= 3 ? `${split.last}*` : split.last);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NPPES_TIMEOUT_MS);
  try {
    const resp = await fetch(`${NPPES_URL}?${params.toString()}`, { signal: controller.signal });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { results?: NppesResult[] };
    for (const r of body.results ?? []) {
      if (r.enumeration_type === 'NPI-2') continue; // skip orgs
      const npi = (r.number ?? '').trim();
      if (/^\d{10}$/.test(npi)) return npi;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseLookup(raw: unknown, max: number): UnresolvedLookup[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: UnresolvedLookup[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const name = String((item as { name?: unknown }).name ?? '').trim().slice(0, 80);
    const zip = String((item as { zip?: unknown }).zip ?? '').trim();
    if (!name || !/^\d{5}$/.test(zip)) continue;
    const key = `${name}|${zip}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, zip });
    if (out.length >= max) break;
  }
  return out;
}

function parseList(raw: unknown, max: number): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const out = Array.from(
    new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  );
  return out.slice(0, max);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET required' });

  // Brain audit H2: cap raised from 100 → 1000. The 100 ceiling was
  // dropping plans on counties where the candidate pool exceeded that
  // number (state-wide queries + dense Medicare-Advantage counties);
  // the brain's Gate-1 then ran without coverage for the truncated
  // tail and silently kept plans that should have been eliminated as
  // out-of-network. 1000 covers every CMS county pool today (≤ ~500
  // plans observed) with headroom; the per-NPI FHIR fan-out stays
  // bounded by npis × distinct contract_ids so the upper bound on
  // upstream calls grows linearly, not as plans × npis.
  const planIds = parseList(req.query.plan_ids, 1000);
  const npisInput = parseList(req.query.npis, 50);
  const unresolved = parseLookup(req.query.lookup, MAX_UNRESOLVED_LOOKUPS);

  // Run NPPES resolution in parallel. Each lookup is timeboxed to 3s
  // and silently returns null on failure, so a slow / down NPPES
  // doesn't block the whole endpoint — the consumer simply sees
  // "Call to confirm" for the un-NPI'd provider, same as before.
  const resolvedLookups: ResolvedLookup[] =
    unresolved.length === 0
      ? []
      : await Promise.all(
          unresolved.map(async (l) => ({
            input: `${l.name}|${l.zip}`,
            npi: await resolveNpiByNppes(l.name, l.zip),
          })),
        );

  // Merge resolved NPIs into the set we query the cache + directory
  // with. dedupe via Set so a typed-and-also-NPI'd provider doesn't
  // double-count in the summaries.
  const npis = Array.from(
    new Set([
      ...npisInput,
      ...resolvedLookups.map((r) => r.npi).filter((n): n is string => n !== null),
    ]),
  );

  if (planIds.length === 0 || npis.length === 0) {
    return res.status(200).json({
      byNpi: {},
      summaryByPlanId: {},
      resolvedLookups,
    });
  }

  // Vercel env: SUPABASE_URL must point at plan-match-prod
  // (rpcbrkmvalvdmroqzpaq); SUPABASE_SERVICE_ROLE_KEY must be set so
  // pm_provider_network_cache and pm_fhir_network_map are readable
  // server-side. Wrong URL = silently empty maps + cache reads.
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Supabase env not configured' });
  }
  const supabaseRef = (supabaseUrl.match(/https:\/\/([^.]+)/) ?? [])[1] ?? 'unknown';
  const isProdRef = supabaseRef === 'rpcbrkmvalvdmroqzpaq';
  console.log('[provider-network-status] entry', {
    supabase_ref: supabaseRef,
    is_prod_ref: isProdRef,
    npis: npis.length,
    plans: planIds.length,
    unresolved: unresolved.length,
  });
  if (!isProdRef) {
    // Loud warning — wrong project means every map / cache read returns
    // nothing and every plan stays 'unknown'.
    console.error(`[provider-network-status] WARN: SUPABASE_URL points at "${supabaseRef}" not plan-match-prod`);
  }
  const base = supabaseUrl.replace(/\/$/, '');
  const H = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    Accept: 'application/json',
  };

  let coverage: CacheRow[] = [];
  let directory: DirectoryRow[] = [];
  let planStates: PlanStateRow[] = [];
  let stateCoverage: CoverageRow[] = [];
  let dataUnavailableRows: DataUnavailableRow[] = [];
  let notFoundSentinels: NotFoundSentinelRow[] = [];
  try {
    const q1 = new URLSearchParams();
    q1.set('plan_id', `in.(${planIds.join(',')})`);
    q1.set('npi', `in.(${npis.join(',')})`);
    q1.set('select', 'plan_id,segment_id,npi,covered');
    q1.set('limit', '2000');
    // plan_id in pm_provider_network_cache is the COMBINED form
    // ("H5253-189"); pm_plans stores contract_id + plan_id separately.
    // We need the state for each plan so we can decide whether a
    // cache miss in that state is "out_of_network" (exhaustive
    // scrape complete) or "unknown" (scrape pending). Build a set
    // of distinct contract_ids from the combined plan_ids and look
    // them up — cheap join, ≤100 rows.
    const distinctContracts = Array.from(
      new Set(
        planIds
          .map((id) => id.split('-')[0])
          .filter((c) => c.length > 0),
      ),
    );
    const planStateUrl = distinctContracts.length > 0
      ? `${base}/rest/v1/pm_plans?contract_id=in.(${distinctContracts.join(',')})&select=contract_id,plan_id,state&limit=20000`
      : null;
    // data_unavailable sentinel rows are plan-level — one per (plan,
    // segment, source). Query independently of the NPI list since the
    // sentinel NPI is not in the user's set. The migration may not be
    // applied; tolerate the column-missing case (returns empty).
    const dataUnavailUrl =
      `${base}/rest/v1/pm_provider_network_cache` +
      `?plan_id=in.(${planIds.join(',')})` +
      `&data_unavailable=eq.true&select=plan_id&limit=2000`;
    // Per-(npi, carrier) "FHIR said no_match" sentinels. Read in parallel
    // so the demand-driven fan-out can skip carriers that already failed
    // for an NPI within the TTL window. plan_id is the synthetic
    // NPI_NOT_FOUND_PLAN_ID; source carries the carrier id ('fhir_uhc'
    // etc) so we can derive the carrier set per NPI.
    const sentinelSince = new Date(Date.now() - NPI_NOT_FOUND_SENTINEL_TTL_MS).toISOString();
    const sentinelUrl =
      `${base}/rest/v1/pm_provider_network_cache` +
      `?plan_id=eq.${encodeURIComponent(NPI_NOT_FOUND_PLAN_ID)}` +
      `&npi=in.(${npis.join(',')})` +
      `&checked_at=gte.${encodeURIComponent(sentinelSince)}` +
      `&select=npi,source,checked_at&limit=2000`;
    const [cov, dir, plans, cov2, du, snt] = await Promise.all([
      fetch(`${base}/rest/v1/pm_provider_network_cache?${q1}`, { headers: H }),
      fetch(
        `${base}/rest/v1/pm_provider_directory?npi=in.(${npis.join(',')})&select=npi,display_name,first_name,last_name,credentials,specialties,primary_address,primary_city,primary_state,primary_zip&limit=100`,
        { headers: H },
      ),
      planStateUrl
        ? fetch(planStateUrl, { headers: H })
        : Promise.resolve(null),
      fetch(
        `${base}/rest/v1/pm_provider_cache_coverage?select=state,scrape_completed_at&limit=100`,
        { headers: H },
      ),
      fetch(dataUnavailUrl, { headers: H }),
      fetch(sentinelUrl, { headers: H }),
    ]);
    if (cov.ok) coverage = (await cov.json()) as CacheRow[];
    if (dir.ok) directory = (await dir.json()) as DirectoryRow[];
    if (plans && plans.ok) planStates = (await plans.json()) as PlanStateRow[];
    // Migration may not be applied yet — tolerate the table-missing
    // case (treat as "no states are exhaustive" → all misses become
    // 'unknown'). That's the safer default than the legacy
    // "everything is out_of_network" behavior.
    if (cov2.ok) stateCoverage = (await cov2.json()) as CoverageRow[];
    if (du.ok) dataUnavailableRows = (await du.json()) as DataUnavailableRow[];
    if (snt.ok) notFoundSentinels = (await snt.json()) as NotFoundSentinelRow[];
  } catch (err) {
    console.error('[api/provider-network-status] cache read failed:', err);
    return res.status(500).json({ error: 'cache read failed' });
  }

  // Build the (combined plan_id) → state map and the set of states
  // that have a confirmed exhaustive scrape. A state is "exhaustive"
  // when pm_provider_cache_coverage.scrape_completed_at IS NOT NULL.
  // Until the scrape registry is populated, all states default to
  // non-exhaustive so cache misses surface as 'unknown' instead of
  // a false 'out_of_network' claim.
  const planToState = new Map<string, string>();
  for (const p of planStates) {
    planToState.set(`${p.contract_id}-${p.plan_id}`, p.state);
  }
  const exhaustiveStates = new Set<string>(
    stateCoverage
      .filter((r) => r.scrape_completed_at != null)
      .map((r) => r.state),
  );

  const dirByNpi = new Map<string, DirectoryRow>();
  for (const d of directory) dirByNpi.set(d.npi, d);

  // Demand-driven FHIR fan-out (UHC + Humana + BCBS NC) for NPIs that
  // have any (plan_id, NPI) cache miss on a plan that isn't already
  // flagged data_unavailable. Runs in parallel across NPIs with a
  // total wall-clock budget so this endpoint stays inside Vercel's
  // ~10s function limit even on cold starts. After upserts land,
  // re-query the cache so the response sees the fresh rows.
  const dataUnavailableSet = new Set<string>(
    dataUnavailableRows.map((r) => r.plan_id),
  );

  // Per-plan carrier routing. For every (NPI, plan_id) pair with a cache
  // miss, look up which FHIR-capable carrier owns the contract via
  // pm_fhir_network_map. Only call that carrier for that NPI. Plans
  // owned by carriers without working NC MA FHIR (Cigna, Wellcare,
  // Aetna, Devoted NC) get no FHIR call — they remain cache-miss and
  // fall through to the unknown/out_of_network resolution below, which
  // the brain treats as PASS at Gate 1 (not eliminated).
  const havePlanIds = new Set(coverage.map((c) => `${c.npi}|${c.plan_id}`));
  const expectedPairs = npis.length * planIds.length;
  const cacheHits = havePlanIds.size;
  console.log('[provider-network-status] cache_initial', {
    rows_returned: coverage.length,
    distinct_pairs: cacheHits,
    expected_pairs: expectedPairs,
    miss_count: expectedPairs - cacheHits,
    data_unavailable_plans: dataUnavailableSet.size,
  });

  const carrierMap = await loadContractToCarrierMap(supabaseUrl, serviceKey).catch((err: unknown) => {
    console.warn('[provider-network-status] contract→carrier map load failed:', err);
    return new Map<string, CarrierId>();
  });
  console.log('[provider-network-status] carrier_map', {
    contracts_loaded: carrierMap.size,
  });
  if (carrierMap.size === 0) {
    console.error('[provider-network-status] WARN: pm_fhir_network_map empty — every FHIR-capable cache miss will stay unknown');
  }

  // Per-NPI set of carriers that already returned no_match within the
  // sentinel TTL. Source label is "fhir_<carrier_id>" — strip the prefix
  // to derive the carrier id. Unknown source labels are ignored (forward-
  // compatible with future carriers; we just don't skip them).
  const skipCarriersByNpi = new Map<string, Set<CarrierId>>();
  for (const row of notFoundSentinels) {
    if (!row.source.startsWith('fhir_')) continue;
    const carrierId = row.source.slice('fhir_'.length) as CarrierId;
    let set = skipCarriersByNpi.get(row.npi);
    if (!set) { set = new Set<CarrierId>(); skipCarriersByNpi.set(row.npi, set); }
    set.add(carrierId);
  }

  // Group missing (NPI × plan) pairs into per-NPI carrier sets. An NPI
  // whose ONLY missing plans are non-FHIR carriers makes no FHIR call.
  // Carriers in skipCarriersByNpi[npi] are excluded — a recent sentinel
  // says "we already confirmed this NPI isn't in that carrier's directory."
  const carriersToCallByNpi = new Map<string, Set<CarrierId>>();
  const missByNpi = new Map<string, { fhirable: string[]; nonFhirable: string[] }>();
  for (const npi of npis) {
    const carriers = new Set<CarrierId>();
    const fhirable: string[] = [];
    const nonFhirable: string[] = [];
    const skip = skipCarriersByNpi.get(npi);
    for (const pid of planIds) {
      if (havePlanIds.has(`${npi}|${pid}`)) continue;
      if (dataUnavailableSet.has(pid)) continue;
      const contract = pid.split('-')[0];
      const carrier = carrierForContractId(carrierMap, contract);
      if (carrier && !skip?.has(carrier)) { carriers.add(carrier); fhirable.push(pid); }
      else { nonFhirable.push(pid); }
    }
    missByNpi.set(npi, { fhirable, nonFhirable });
    if (carriers.size > 0) carriersToCallByNpi.set(npi, carriers);
  }
  console.log('[provider-network-status] fhir_routing', {
    npis_needing_fhir: carriersToCallByNpi.size,
    sentinels_loaded: notFoundSentinels.length,
    npis_with_skip: skipCarriersByNpi.size,
    per_npi: Array.from(carriersToCallByNpi.entries()).map(([npi, set]) => ({
      npi, carriers: [...set],
      fhirable_misses: missByNpi.get(npi)?.fhirable.length ?? 0,
      non_fhirable_misses: missByNpi.get(npi)?.nonFhirable.length ?? 0,
      skipped_by_sentinel: skipCarriersByNpi.get(npi) ? [...skipCarriersByNpi.get(npi)!] : [],
    })),
  });

  if (carriersToCallByNpi.size > 0) {
    const TOTAL_BUDGET_MS = 8000;
    const perNpiBudget = Math.max(2000, Math.floor(TOTAL_BUDGET_MS / carriersToCallByNpi.size));
    const fhirStartedAt = Date.now();
    await Promise.allSettled(
      Array.from(carriersToCallByNpi.entries()).map(async ([npi, carriers]) => {
        try {
          const r = await demandLookupNpi({
            supabaseUrl, serviceKey, npi,
            totalBudgetMs: perNpiBudget,
            carrierIds: [...carriers],
          });
          console.log('[provider-network-status] fhir_lookup', {
            npi,
            rows_upserted: r.rows_upserted,
            carriers: r.carriers.map((c: typeof r.carriers[number]) => ({
              carrier: c.carrier_id,
              status: c.status,
              roles: c.role_count,
              rows: c.rows.length,
              message: c.message,
            })),
          });
          return r;
        } catch (err) {
          console.warn(`[provider-network-status] FHIR ${npi} threw:`, err);
          return null;
        }
      }),
    );
    console.log('[provider-network-status] fhir_complete', {
      elapsed_ms: Date.now() - fhirStartedAt,
      budget_ms: TOTAL_BUDGET_MS,
      per_npi_budget_ms: perNpiBudget,
    });
    // Re-read only the NPIs we fanned out for. FHIR upserts may have
    // flipped a missing (plan, npi) row into an in_network row.
    try {
      const npisFanned = [...carriersToCallByNpi.keys()];
      const q2 = new URLSearchParams();
      q2.set('plan_id', `in.(${planIds.join(',')})`);
      q2.set('npi', `in.(${npisFanned.join(',')})`);
      q2.set('select', 'plan_id,segment_id,npi,covered');
      q2.set('limit', '2000');
      const reread = await fetch(`${base}/rest/v1/pm_provider_network_cache?${q2}`, { headers: H });
      let addedCount = 0;
      if (reread.ok) {
        const fresh = (await reread.json()) as CacheRow[];
        const existingKey = new Set(coverage.map((c) => `${c.plan_id}|${c.npi}`));
        for (const r of fresh) {
          if (!existingKey.has(`${r.plan_id}|${r.npi}`)) {
            coverage.push(r);
            addedCount += 1;
          }
        }
        console.log('[provider-network-status] post_fhir_reread', {
          rows_in_reread: fresh.length,
          added_to_coverage: addedCount,
        });
      } else {
        console.warn('[provider-network-status] post-FHIR reread non-200:', reread.status);
      }
    } catch (err) {
      console.warn('[provider-network-status] post-FHIR reread failed:', err);
    }
  } else {
    console.log('[provider-network-status] fhir_skipped', {
      reason: 'every (npi,plan) pair is either cached or non-FHIR-capable',
    });
  }

  const byNpi: Record<
    string,
    {
      byPlanId: Record<string, 'in_network' | 'out_of_network' | 'unknown' | 'data_unavailable'>;
      directory: DirectoryRow | null;
    }
  > = {};
  for (const npi of npis) {
    byNpi[npi] = { byPlanId: {}, directory: dirByNpi.get(npi) ?? null };
  }
  for (const c of coverage) {
    const slot = byNpi[c.npi];
    if (!slot) continue;
    // First-write-wins so a medicare_gov in_network read isn't
    // overwritten by a later FHIR row claiming the same (plan, NPI).
    if (slot.byPlanId[c.plan_id]) continue;
    slot.byPlanId[c.plan_id] = c.covered ? 'in_network' : 'out_of_network';
  }

  // For every (NPI, plan) pair NOT hit in the cache, decide whether
  // absence means out-of-network or unknown:
  //   - exhaustive state (pm_provider_cache_coverage.scrape_completed_at
  //     IS NOT NULL) → absence is meaningful → leave the slot empty
  //     (UI's resolveStatus falls through to 'out_of_network').
  //   - non-exhaustive state (TX/GA today, NC partially-covered) →
  //     absence is uncertain → write 'unknown' so the UI surfaces a
  //     "we're checking" badge instead of a false out-of-network claim.
  // This is the bug-fix that prompted the coverage table: before this
  // change every non-Klein NC provider got told they were
  // out-of-network on every plan because the NC cache only has 1
  // distinct NPI.
  for (const planId of planIds) {
    const planState = planToState.get(planId);
    const isExhaustive = planState && exhaustiveStates.has(planState);
    if (isExhaustive) continue;
    for (const npi of npis) {
      const slot = byNpi[npi];
      if (!slot) continue;
      if (!(planId in slot.byPlanId)) {
        slot.byPlanId[planId] = 'unknown';
      }
    }
  }

  // Plans flagged data_unavailable at the cache layer — sentinel rows
  // upserted by the medicare.gov scrape when CMS returns the plan with
  // has_provider_coverage_data=false (I-SNPs and small regional MAs
  // that have no public provider directory). These plans short-circuit
  // every NPI's status to 'data_unavailable' below so the UI can
  // surface a single "call to verify" message instead of fake dots.
  const dataUnavailablePlans = new Set<string>(
    dataUnavailableRows.map((r) => r.plan_id),
  );

  // Summary tracks the four real outcomes. 'pending' is reserved for
  // client-side fetch-in-flight; the API surfaces 'unknown' (cache
  // miss + non-exhaustive state) by counting it in the unknown column.
  // 'data_unavailable' is plan-level — true when the cache has a
  // sentinel row, in which case per-NPI counts are zeroed out (the UI
  // renders a single banner, not dots).
  const summaryByPlanId: Record<
    string,
    {
      in_network: number;
      out_of_network: number;
      unknown: number;
      pending: number;
      total: number;
      data_unavailable?: boolean;
    }
  > = {};
  for (const planId of planIds) {
    if (dataUnavailablePlans.has(planId)) {
      // Plan-level sentinel only fills in for NPIs that have NO concrete
      // cache row. A real coverage row (medicare_gov or fhir_*) overrides
      // the sentinel — Klein on UHC AARP NC-0015 has 778 covered=true
      // rows that should surface as in_network even though the plan also
      // carries a data_unavailable sentinel from an earlier scrape where
      // CMS returned has_provider_coverage_data=false. The banner only
      // fires when no NPI in the request set has concrete data.
      let inN = 0;
      let outN = 0;
      let sentinel = 0;
      for (const npi of npis) {
        const slot = byNpi[npi];
        if (!slot) continue;
        const existing = slot.byPlanId[planId];
        if (existing === 'in_network') inN += 1;
        else if (existing === 'out_of_network') outN += 1;
        else {
          slot.byPlanId[planId] = 'data_unavailable';
          sentinel += 1;
        }
      }
      summaryByPlanId[planId] = {
        in_network: inN,
        out_of_network: outN,
        unknown: 0,
        pending: 0,
        total: npis.length,
        // Banner only when every NPI fell through to the sentinel.
        data_unavailable: inN === 0 && outN === 0 && sentinel > 0,
      };
      continue;
    }
    let inN = 0;
    let outN = 0;
    let unk = 0;
    for (const npi of npis) {
      const s = byNpi[npi]?.byPlanId[planId];
      if (s === 'in_network') inN += 1;
      else if (s === 'unknown') unk += 1;
      else outN += 1;
    }
    summaryByPlanId[planId] = {
      in_network: inN,
      out_of_network: outN,
      unknown: unk,
      pending: 0,
      total: npis.length,
    };
  }

  // Short cache so a quick revisit doesn't re-hit Supabase, but the
  // user's "doctor flipped from out → in" change still shows up
  // within a minute on a refresh.
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
  // Aggregate exit log: per-NPI status histogram so a Vercel function
  // log line shows exactly what shape the brain will see.
  const exitHistogram: Record<string, Record<string, number>> = {};
  for (const npi of npis) {
    const slot = byNpi[npi];
    const histo: Record<string, number> = { in_network: 0, out_of_network: 0, unknown: 0, data_unavailable: 0, pending: 0 };
    if (slot) {
      for (const planId of planIds) {
        const s = slot.byPlanId[planId];
        if (s) histo[s] = (histo[s] ?? 0) + 1;
        else histo.pending += 1;
      }
    }
    exitHistogram[npi] = histo;
  }
  console.log('[provider-network-status] exit', exitHistogram);
  return res.status(200).json({ byNpi, summaryByPlanId, resolvedLookups });
}
