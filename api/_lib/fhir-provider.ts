// Demand-driven carrier FHIR provider-network lookup.
//
// Mirrors the two-step CARIN-BB pattern from scripts/fhir-provider-lookup.ts
// (Practitioner-by-NPI → PractitionerRole-by-practitioner) but extracted as
// a serverless-callable lib. The expensive InsurancePlan walk that the
// script does inline is here replaced by a Supabase read against
// pm_fhir_network_map (populated offline by `fhir-lookup --save-map`).
//
// Caller pattern:
//   const map = await loadNetworkMap(sb, 'uhc');
//   const result = await lookupNpiForCarrier({
//     carrier: CARRIERS.uhc, npi, map, deadlineMs: Date.now() + 4000,
//   });
//   if (result.rows.length > 0) await upsertCoverageRows(sb, result.rows);
//
// Per-carrier deadline is enforced — Vercel Functions have a hard
// 10–30s budget, so each carrier gets a slice (e.g. 4s) and the rest
// fall back to 'researching'.

export type CarrierId = 'uhc' | 'humana' | 'devoted' | 'bcbsnc';
export type LookupStrategy = 'practitioner-first' | 'role-by-identifier';
export interface CarrierConfig {
  id: CarrierId;
  display: string;
  baseUrl: string;
  acceptHeader: string;
  // 'practitioner-first' (default): Practitioner?identifier=npi-system|NPI
  //   → PractitionerRole?practitioner=Practitioner/{id}. Used by carriers
  //   whose Practitioner resource is searchable by identifier (UHC,
  //   Humana, Devoted).
  // 'role-by-identifier': PractitionerRole?identifier=NPI (bare value,
  //   no system token). Used when Practitioner.identifier search isn't
  //   implemented — BCBS NC's PDEX Plan-Net deployment. Skips the
  //   intermediate Practitioner lookup entirely.
  lookupStrategy?: LookupStrategy;
}

export const CARRIERS: Readonly<Record<CarrierId, CarrierConfig>> = {
  uhc: {
    id: 'uhc',
    display: 'UnitedHealthcare',
    baseUrl: 'https://flex.optum.com/fhirpublic/R4',
    acceptHeader: 'application/fhir+json',
  },
  humana: {
    id: 'humana',
    display: 'Humana',
    baseUrl: 'https://fhir.humana.com/api',
    acceptHeader: 'application/fhir+json',
  },
  devoted: {
    id: 'devoted',
    display: 'Devoted Health',
    baseUrl: 'https://fhir.devoted.com/fhir',
    acceptHeader: 'application/fhir+json',
  },
  bcbsnc: {
    id: 'bcbsnc',
    display: 'Blue Cross NC',
    baseUrl: 'https://apiservices-ext.bcbsnc.com/fhir/prod/R4/providerdirectory',
    acceptHeader: 'application/fhir+json',
    lookupStrategy: 'role-by-identifier',
  },
};

// Demand-driven carriers the API endpoint will fan out to by default.
// Devoted is excluded from the API default — they barely have NC MA
// presence and the offline `--save-map` job is enough. Order is the
// rough priority for budget-bound execution.
export const API_DEFAULT_CARRIERS: ReadonlyArray<CarrierId> = ['uhc', 'humana', 'bcbsnc'];

const NPI_SYSTEM = 'http://hl7.org/fhir/sid/us-npi';
const FHIR_PAGE_COUNT = 200;
const FHIR_MAX_PAGES = 5;
// Sentinel plan_id written when a carrier's FHIR directory definitively
// returns no_match for an NPI. Lets the API route skip the carrier on
// subsequent calls for that NPI within the TTL — see SENTINEL_TTL_MS in
// provider-network-status.ts. Distinct from the data_unavailable
// sentinel ('0000000000' NPI on a real plan_id) because this one keys
// on the NPI, not the plan.
export const NPI_NOT_FOUND_PLAN_ID = '__NPI_NOT_FOUND__';
// Max concurrent in-flight FHIR HTTP requests to any one carrier endpoint
// within a single Vercel Function instance. Keeps a 10-NPI fan-out from
// hammering UHC with 30 parallel hits. Per-carrier so a slow Humana
// doesn't queue UHC calls.
const PER_CARRIER_MAX_CONCURRENT = 5;
const FHIR_RETRY_DELAYS_MS = [250, 750];
const PDEX_NETWORK_EXTENSION_URLS = new Set([
  'http://hl7.org/fhir/us/davinci-pdex-plan-net/StructureDefinition/network-reference',
  'http://hl7.org/fhir/us/davinci-plan-net/StructureDefinition/network-reference',
]);

interface FhirReference { reference?: string; display?: string; }
interface FhirExtension { url: string; valueReference?: FhirReference; extension?: FhirExtension[]; }
interface FhirPractitioner { resourceType: 'Practitioner'; id?: string; }
interface FhirPractitionerRole {
  resourceType: 'PractitionerRole';
  id?: string;
  active?: boolean;
  extension?: FhirExtension[];
}
interface FhirBundleEntry { resource?: FhirPractitioner | FhirPractitionerRole; }
interface FhirBundleLink { relation: string; url: string; }
interface FhirBundle {
  resourceType: 'Bundle';
  total?: number;
  link?: FhirBundleLink[];
  entry?: FhirBundleEntry[];
}

export interface NetworkMapEntry {
  contract_id: string;
  plan_id: string;
  segment_id: string;
}
export type NetworkMap = Map<string, NetworkMapEntry[]>; // fhir_org_id → plan keys

// ─── HTTP ─────────────────────────────────────────────────────────────

// Per-carrier semaphore — caps in-flight fhirGet calls to PER_CARRIER_MAX_CONCURRENT
// per CarrierId within a single Vercel Function instance. Implemented as a counter +
// waiter queue. Released in a finally so a thrown error never leaks the slot.
interface CarrierSlot { inFlight: number; queue: Array<() => void>; }
const __carrierSlots: Map<CarrierId, CarrierSlot> = new Map();

function acquireCarrierSlot(carrierId: CarrierId): Promise<void> {
  let slot = __carrierSlots.get(carrierId);
  if (!slot) { slot = { inFlight: 0, queue: [] }; __carrierSlots.set(carrierId, slot); }
  if (slot.inFlight < PER_CARRIER_MAX_CONCURRENT) {
    slot.inFlight += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    slot!.queue.push(() => { slot!.inFlight += 1; resolve(); });
  });
}

function releaseCarrierSlot(carrierId: CarrierId): void {
  const slot = __carrierSlots.get(carrierId);
  if (!slot) return;
  slot.inFlight = Math.max(0, slot.inFlight - 1);
  const next = slot.queue.shift();
  if (next) next();
}

// Retryable iff the failure is transient: network/abort-by-server (5xx),
// connection reset, or DNS blip. 4xx is deterministic (don't retry —
// e.g. BCBS NC's 400 on system-prefixed identifier). Abort by our own
// timeout is also non-retryable; the caller's deadline budget is already
// burning.
function isTransientFhirError(err: unknown, ownTimeoutFired: boolean): boolean {
  if (ownTimeoutFired) return false;
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  if (/^fhir 5\d\d /.test(msg)) return true;
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i.test(msg)) return true;
  return false;
}

async function fhirGetOnce<T>(url: string, acceptHeader: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Accept: acceptHeader },
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`fhir ${resp.status} ${url}: ${body.slice(0, 200)}`);
    }
    return (await resp.json()) as T;
  } catch (err) {
    // Re-tag aborted-by-us so isTransientFhirError can suppress retry.
    if (timedOut) throw new Error(`fhir timeout ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fhirGet<T>(
  url: string,
  acceptHeader: string,
  timeoutMs: number,
  carrierId: CarrierId,
): Promise<T> {
  await acquireCarrierSlot(carrierId);
  try {
    let lastErr: unknown;
    // attempt 0 = initial; attempts 1..N = retries with backoff.
    for (let attempt = 0; attempt <= FHIR_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return await fhirGetOnce<T>(url, acceptHeader, timeoutMs);
      } catch (err) {
        lastErr = err;
        if (attempt === FHIR_RETRY_DELAYS_MS.length) break;
        const ownTimeoutFired = err instanceof Error && err.message.startsWith('fhir timeout');
        if (!isTransientFhirError(err, ownTimeoutFired)) break;
        await new Promise((r) => setTimeout(r, FHIR_RETRY_DELAYS_MS[attempt]));
      }
    }
    throw lastErr;
  } finally {
    releaseCarrierSlot(carrierId);
  }
}

// ─── Network map (read from Supabase cache) ────────────────────────────

// Module-level cache. Each carrier map can be hundreds-to-thousands of
// rows; building it on every Vercel-Function invocation would dominate
// our budget. Map is keyed by carrier id and lives for the lifetime of
// the function container (typically minutes to ~1 hour). Refresh
// happens implicitly when the container is recycled. Set NETWORK_MAP_TTL_MS
// to force re-fetch within a single container's lifetime.
const NETWORK_MAP_TTL_MS = 30 * 60 * 1000;            // 30 min
interface CachedMap { map: NetworkMap; loadedAt: number; }
const __mapCache: Map<CarrierId, CachedMap> = new Map();

export async function loadNetworkMap(
  supabaseUrl: string,
  serviceKey: string,
  carrierId: CarrierId,
): Promise<NetworkMap> {
  const cached = __mapCache.get(carrierId);
  if (cached && Date.now() - cached.loadedAt < NETWORK_MAP_TTL_MS) {
    return cached.map;
  }
  const base = supabaseUrl.replace(/\/$/, '');
  const map: NetworkMap = new Map();
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const resp = await fetch(
      `${base}/rest/v1/pm_fhir_network_map` +
        `?carrier_id=eq.${carrierId}&select=fhir_org_id,contract_id,plan_id,segment_id`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          Accept: 'application/json',
          Range: `${from}-${from + pageSize - 1}`,
          'Range-Unit': 'items',
        },
      },
    );
    if (!resp.ok) {
      throw new Error(`pm_fhir_network_map read failed: ${resp.status} ${await resp.text().catch(() => '')}`);
    }
    const rows = (await resp.json()) as Array<{
      fhir_org_id: string; contract_id: string; plan_id: string; segment_id: string;
    }>;
    for (const r of rows) {
      const list = map.get(r.fhir_org_id);
      const entry: NetworkMapEntry = { contract_id: r.contract_id, plan_id: r.plan_id, segment_id: r.segment_id };
      if (list) list.push(entry); else map.set(r.fhir_org_id, [entry]);
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  __mapCache.set(carrierId, { map, loadedAt: Date.now() });
  return map;
}

// ─── Contract → carrier reverse lookup ─────────────────────────────────
//
// Built from pm_fhir_network_map data — authoritative because it's the
// same source the demand-driven lookup resolves through. A contract_id
// appears here iff that carrier's offline save-map produced rows for it.
// Scoped to API_DEFAULT_CARRIERS so callers never accidentally route a
// plan to a carrier the hot path doesn't query.
const CARRIER_LOOKUP_TTL_MS = 30 * 60 * 1000;
interface CachedCarrierLookup { map: Map<string, CarrierId>; loadedAt: number; }
let __carrierLookupCache: CachedCarrierLookup | null = null;

export async function loadContractToCarrierMap(
  supabaseUrl: string,
  serviceKey: string,
): Promise<Map<string, CarrierId>> {
  if (__carrierLookupCache && Date.now() - __carrierLookupCache.loadedAt < CARRIER_LOOKUP_TTL_MS) {
    return __carrierLookupCache.map;
  }
  const base = supabaseUrl.replace(/\/$/, '');
  const map = new Map<string, CarrierId>();
  const carriers = API_DEFAULT_CARRIERS.join(',');
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const resp = await fetch(
      `${base}/rest/v1/pm_fhir_network_map?carrier_id=in.(${carriers})&select=carrier_id,contract_id`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          Accept: 'application/json',
          Range: `${from}-${from + pageSize - 1}`,
          'Range-Unit': 'items',
        },
      },
    );
    if (!resp.ok) {
      throw new Error(`pm_fhir_network_map carrier-lookup read failed: ${resp.status}`);
    }
    const rows = (await resp.json()) as Array<{ carrier_id: CarrierId; contract_id: string }>;
    for (const r of rows) {
      // First-write-wins: a contract should belong to one carrier; if two
      // claim it (rare data error) we keep the first and skip the rest.
      if (!map.has(r.contract_id)) map.set(r.contract_id, r.carrier_id);
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  __carrierLookupCache = { map, loadedAt: Date.now() };
  return map;
}

// Synchronous lookup against an already-loaded map. Returns the carrier
// id if the contract is owned by a FHIR-capable carrier, else null.
// Pass the result of loadContractToCarrierMap.
export function carrierForContractId(
  map: Map<string, CarrierId>,
  contractId: string,
): CarrierId | null {
  return map.get(contractId) ?? null;
}

// ─── FHIR lookup ─────────────────────────────────────────────────────

function parseLastPathSegment(ref: string, expectedType: string): string | null {
  const m = ref.match(/(?:^|\/)([A-Za-z]+)\/([^/?#]+)(?:[?#]|$)/);
  if (!m) return null;
  return m[1] === expectedType ? m[2] : null;
}

function extractNetworkOrgIds(role: FhirPractitionerRole): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (exts: FhirExtension[] | undefined): void => {
    if (!exts) return;
    for (const e of exts) {
      if (e.valueReference && PDEX_NETWORK_EXTENSION_URLS.has(e.url)) {
        const raw = (e.valueReference.reference ?? '').trim();
        if (!raw) { walk(e.extension); continue; }
        // Accept both standard Type/Id ("Organization/abc") and bare-id
        // form. BCBS NC ships bare ids in network-reference extensions;
        // their PractitionerRole.extension.valueReference.reference is
        // just "S-10", not "Organization/S-10".
        let orgId = parseLastPathSegment(raw, 'Organization');
        if (!orgId && !raw.includes('/')) orgId = raw;
        if (orgId && !seen.has(orgId)) {
          seen.add(orgId);
          out.push(orgId);
        }
      }
      walk(e.extension);
    }
  };
  walk(role.extension);
  return out;
}

export interface CoverageRow {
  plan_id: string;       // 'H1290-001' (contract-plan, no segment)
  segment_id: string;
  npi: string;
  covered: boolean;
  source: string;        // 'fhir_<carrier_id>'
  state: string | null;  // optional, filled when caller has pm_plans context
  county_fips: null;
  all_locations: never[];
  location_id: null;
}

export interface CarrierLookupResult {
  carrier_id: CarrierConfig['id'];
  status: 'ok' | 'no_match' | 'timeout' | 'error' | 'no_map';
  message?: string;
  role_count: number;
  rows: CoverageRow[];
}

// Sentinel row written when a carrier's FHIR directory has no record
// for this NPI. Keys on NPI_NOT_FOUND_PLAN_ID so it can't collide with
// any real (plan_id, segment_id, npi, source) tuple. The route reads
// these to skip re-querying the same dead-end carrier on every refresh.
function makeNotFoundSentinel(carrierId: CarrierId, npi: string): CoverageRow {
  return {
    plan_id: NPI_NOT_FOUND_PLAN_ID,
    segment_id: '0',
    npi,
    covered: false,
    source: `fhir_${carrierId}`,
    state: null,
    county_fips: null,
    all_locations: [],
    location_id: null,
  };
}

// One full carrier lookup for one NPI. Honors the absolute deadline so the
// caller can budget across carriers within a Vercel Function's window.
export async function lookupNpiForCarrier(args: {
  carrier: CarrierConfig;
  npi: string;
  map: NetworkMap;
  deadlineMs: number;
}): Promise<CarrierLookupResult> {
  const { carrier, npi, map, deadlineMs } = args;
  const result: CarrierLookupResult = {
    carrier_id: carrier.id, status: 'ok', role_count: 0, rows: [],
  };
  if (map.size === 0) {
    result.status = 'no_map';
    result.message = `pm_fhir_network_map empty for ${carrier.id}`;
    return result;
  }

  const roles: FhirPractitionerRole[] = [];
  const strategy: LookupStrategy = carrier.lookupStrategy ?? 'practitioner-first';

  if (strategy === 'role-by-identifier') {
    // Single-step path: PractitionerRole?identifier=<bare NPI>. BCBS NC's
    // CapabilityStatement omits identifier on Practitioner but accepts
    // bare-value identifier on PractitionerRole. The system-prefixed form
    // returns 0 — bare value is required.
    const budget = Math.max(1500, deadlineMs - Date.now());
    try {
      let url: string | undefined =
        `${carrier.baseUrl}/PractitionerRole?identifier=${encodeURIComponent(npi)}` +
        `&_count=${FHIR_PAGE_COUNT}`;
      let pages = 0;
      while (url && pages < FHIR_MAX_PAGES) {
        const remaining = Math.max(1500, deadlineMs - Date.now());
        if (remaining <= 0) break;
        const bundle: FhirBundle = await fhirGet<FhirBundle>(url, carrier.acceptHeader, Math.min(budget, remaining), carrier.id);
        for (const e of bundle.entry ?? []) {
          const r = e.resource;
          if (r?.resourceType === 'PractitionerRole') roles.push(r);
        }
        pages += 1;
        const nextLink: FhirBundleLink | undefined = bundle.link?.find((l: FhirBundleLink) => l.relation === 'next');
        const nextUrl: string | undefined = nextLink?.url;
        url = nextUrl && nextUrl !== url && Date.now() < deadlineMs ? nextUrl : undefined;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.status = msg.includes('aborted') || msg.includes('timeout') ? 'timeout' : 'error';
      result.message = msg;
      return result;
    }
  } else {
    // Step 1: NPI → Practitioner.id(s).
    let practitionerIds: string[];
    try {
      const budget = Math.max(1500, Math.min(3000, deadlineMs - Date.now()));
      const url =
        `${carrier.baseUrl}/Practitioner` +
        `?identifier=${encodeURIComponent(`${NPI_SYSTEM}|${npi}`)}` +
        `&_count=10`;
      const bundle = await fhirGet<FhirBundle>(url, carrier.acceptHeader, budget, carrier.id);
      practitionerIds = (bundle.entry ?? [])
        .map((e) => e.resource)
        .filter((r): r is FhirPractitioner => r?.resourceType === 'Practitioner' && !!r.id)
        .map((r) => r.id as string);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.status = msg.includes('aborted') || msg.includes('timeout') ? 'timeout' : 'error';
      result.message = msg;
      return result;
    }
    if (practitionerIds.length === 0) {
      result.status = 'no_match';
      result.rows.push(makeNotFoundSentinel(carrier.id, npi));
      return result;
    }

    // Step 2: Practitioner.id(s) → PractitionerRole bundle(s).
    for (const pid of practitionerIds) {
      if (Date.now() >= deadlineMs) break;
      let url: string | undefined =
        `${carrier.baseUrl}/PractitionerRole` +
        `?practitioner=${encodeURIComponent(`Practitioner/${pid}`)}` +
        `&_count=${FHIR_PAGE_COUNT}`;
      let pages = 0;
      while (url && pages < FHIR_MAX_PAGES) {
        const budget = Math.max(1500, deadlineMs - Date.now());
        if (budget <= 0) break;
        let bundle: FhirBundle;
        try {
          bundle = await fhirGet<FhirBundle>(url, carrier.acceptHeader, budget, carrier.id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.status = msg.includes('aborted') ? 'timeout' : 'error';
          result.message = msg;
          return result;
        }
        for (const e of bundle.entry ?? []) {
          const r = e.resource;
          if (r?.resourceType === 'PractitionerRole') roles.push(r);
        }
        pages += 1;
        const next = bundle.link?.find((l) => l.relation === 'next')?.url;
        url = next && next !== url && Date.now() < deadlineMs ? next : undefined;
      }
    }
  }
  result.role_count = roles.length;
  if (roles.length === 0) {
    result.status = 'no_match';
    result.rows.push(makeNotFoundSentinel(carrier.id, npi));
    return result;
  }

  // Resolve org refs → plan keys via the cached map.
  const anyActive = roles.some((r) => r.active !== false);
  const planByKey = new Map<string, NetworkMapEntry>();
  for (const role of roles) {
    for (const orgId of extractNetworkOrgIds(role)) {
      const hits = map.get(orgId);
      if (!hits) continue;
      for (const h of hits) {
        const k = `${h.contract_id}-${h.plan_id}-${h.segment_id}`;
        if (!planByKey.has(k)) planByKey.set(k, h);
      }
    }
  }
  for (const entry of planByKey.values()) {
    result.rows.push({
      plan_id: `${entry.contract_id}-${entry.plan_id}`,
      segment_id: entry.segment_id,
      npi,
      covered: anyActive,
      source: `fhir_${carrier.id}`,
      state: null,
      county_fips: null,
      all_locations: [],
      location_id: null,
    });
  }
  return result;
}

// ─── Cache upsert ────────────────────────────────────────────────────

export async function upsertFhirCoverageRows(
  supabaseUrl: string,
  serviceKey: string,
  rows: CoverageRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const base = supabaseUrl.replace(/\/$/, '');
  const payload = rows.map((r) => ({
    plan_id: r.plan_id,
    segment_id: r.segment_id,
    npi: r.npi,
    covered: r.covered,
    location_id: null,
    all_locations: [],
    state: r.state,
    county_fips: null,
    source: r.source,
    checked_at: new Date().toISOString(),
  }));
  const resp = await fetch(
    `${base}/rest/v1/pm_provider_network_cache?on_conflict=plan_id,segment_id,npi,source`,
    {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(payload),
    },
  );
  if (!resp.ok) {
    throw new Error(`pm_provider_network_cache upsert failed: ${resp.status} ${await resp.text().catch(() => '')}`);
  }
  return payload.length;
}

// Convenience: do the full demand-driven lookup for one NPI across all
// three FHIR-capable carriers, with a total wall-clock budget. Returns the
// rows that were upserted plus a per-carrier status summary so the caller
// can mark uncovered carriers as 'researching' for the medicare.gov queue.
export interface DemandLookupResult {
  npi: string;
  carriers: CarrierLookupResult[];
  rows_upserted: number;
}
export async function demandLookupNpi(args: {
  supabaseUrl: string;
  serviceKey: string;
  npi: string;
  totalBudgetMs?: number;
  carrierIds?: ReadonlyArray<CarrierConfig['id']>;
}): Promise<DemandLookupResult> {
  const totalBudget = args.totalBudgetMs ?? 6000;
  const startedAt = Date.now();
  const deadline = startedAt + totalBudget;
  const ids = args.carrierIds ?? API_DEFAULT_CARRIERS;
  const carrierBudget = Math.floor(totalBudget / ids.length);

  const results: CarrierLookupResult[] = [];
  const allRows: CoverageRow[] = [];
  for (const cid of ids) {
    const carrierDeadline = Math.min(deadline, Date.now() + carrierBudget);
    if (Date.now() >= deadline) {
      results.push({ carrier_id: cid, status: 'timeout', role_count: 0, rows: [] });
      continue;
    }
    let map: NetworkMap;
    try {
      map = await loadNetworkMap(args.supabaseUrl, args.serviceKey, cid);
    } catch (err) {
      results.push({
        carrier_id: cid, status: 'error', role_count: 0, rows: [],
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const r = await lookupNpiForCarrier({
      carrier: CARRIERS[cid], npi: args.npi, map, deadlineMs: carrierDeadline,
    });
    results.push(r);
    allRows.push(...r.rows);
  }

  let upserted = 0;
  if (allRows.length > 0) {
    try {
      upserted = await upsertFhirCoverageRows(args.supabaseUrl, args.serviceKey, allRows);
    } catch (err) {
      console.error('[fhir-provider] upsert failed:', err);
    }
  }
  return { npi: args.npi, carriers: results, rows_upserted: upserted };
}
