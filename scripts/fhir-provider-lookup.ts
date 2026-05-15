// scripts/fhir-provider-lookup.ts
//
// Aggregates FHIR Provider Directory data across MA carriers for a
// single NPI and upserts in-network rows into pm_provider_network_cache.
//
// Public (no-auth) carriers wired now:
//   - UHC      https://flex.optum.com/fhirpublic/R4
//   - Humana   https://fhir.humana.com/api
//   - Devoted  https://fhir.devoted.com/fhir
//   - Cigna    https://fhir.cigna.com/ProviderDirectory/v1
//
// Gated carriers stubbed (enabled=false until creds arrive):
//   - Aetna     OAuth client_credentials at apif1.aetna.com
//   - Wellcare  partners.centene.com registration
//   - Alignment Azure B2C registration
//
// Per-carrier flow:
//   1. Find PractitionerRole records that reference the NPI.
//      - Strategy A (most carriers):   Practitioner?identifier=...us-npi|NPI
//                                      → PractitionerRole?practitioner=PRAC_ID
//      - Strategy B (Cigna):           PractitionerRole?identifier=NPI
//                                      (Cigna's CapabilityStatement omits
//                                      identifier on Practitioner, so go
//                                      direct on PractitionerRole)
//   2. Extract Organization references from the
//      `network-reference` PDEX extension on each role.
//   3. Build network → contract_plan map by paginating the carrier's
//      InsurancePlan resources (cached in-memory per run).
//   4. Emit { npi, carrier, plan_contract_id, network_name, in_network: true }
//   5. Upsert into pm_provider_network_cache with covered=true,
//      segment_id='0' (FHIR doesn't expose CMS segments; '0' is the
//      conventional default — segmented plans need separate handling).
//
// Run:
//   npx tsx scripts/fhir-provider-lookup.ts --npi=1619976297 --dry-run
//   npx tsx scripts/fhir-provider-lookup.ts --npi=1619976297              (writes)
//   npx tsx scripts/fhir-provider-lookup.ts --npi=1619976297 --carrier=uhc
//   npx tsx scripts/fhir-provider-lookup.ts --npi=1619976297 --state=NC
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in env (or .env.local).

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { resolveWellcareNetworks } from './wellcare-network-map.js';
import { resolveBcbsncNetworks } from './bcbsnc-network-map.js';

// ─── Env ──────────────────────────────────────────────────────────
function loadEnv() {
  if (!existsSync('.env.local')) return;
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}
loadEnv();

// ─── CLI ──────────────────────────────────────────────────────────
function getArg(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return undefined;
}
const NPI = getArg('npi');
const STATE = getArg('state')?.toUpperCase();
const ONLY_CARRIER = getArg('carrier')?.toLowerCase();
const NAME_ARG = getArg('name'); // "Family,Given" — required for carriers like Wellcare
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

if (!NPI || !/^\d{10}$/.test(NPI)) {
  console.error('Usage: npx tsx scripts/fhir-provider-lookup.ts --npi=<10-digit NPI> [--name=Family,Given] [--state=NC] [--carrier=uhc|humana|devoted|cigna|wellcare] [--dry-run] [--verbose]');
  process.exit(1);
}

const NAME_PARTS = (() => {
  if (!NAME_ARG) return null;
  const [family, given] = NAME_ARG.split(',').map((s) => s.trim());
  if (!family || !given) {
    console.error('--name must be "Family,Given" (e.g. --name=Klein,Kombiz)');
    process.exit(1);
  }
  return { family, given };
})();

// ─── Carrier config ───────────────────────────────────────────────
type LookupStrategy =
  | 'practitioner-then-role'
  | 'role-by-identifier'
  | 'role-by-chained-practitioner-identifier'
  // Centene/Wellcare: Practitioner has no identifier search and chained
  // search is rejected. Search by name → filter response client-side by
  // NPI → query PractitionerRole with prefixed reference (Practitioner/<id>).
  | 'name-then-role-with-prefixed-ref';

interface CarrierConfig {
  name: string;
  baseUrl: string;
  enabled: boolean;
  strategy: LookupStrategy;
  // Encode identifier as `system|value` (Humana/UHC/Devoted) or just the value (some servers strict).
  npiSystem: string;
  notes?: string;
}

const CARRIERS: CarrierConfig[] = [
  {
    name: 'uhc',
    baseUrl: 'https://flex.optum.com/fhirpublic/R4',
    enabled: true,
    strategy: 'practitioner-then-role',
    npiSystem: 'http://hl7.org/fhir/sid/us-npi',
  },
  {
    name: 'humana',
    baseUrl: 'https://fhir.humana.com/api',
    enabled: true,
    strategy: 'practitioner-then-role',
    npiSystem: 'http://hl7.org/fhir/sid/us-npi',
  },
  {
    name: 'devoted',
    baseUrl: 'https://fhir.devoted.com/fhir',
    enabled: true,
    strategy: 'practitioner-then-role',
    npiSystem: 'http://hl7.org/fhir/sid/us-npi',
  },
  {
    name: 'cigna',
    baseUrl: 'https://fhir.cigna.com/ProviderDirectory/v1',
    enabled: true,
    strategy: 'role-by-chained-practitioner-identifier',
    npiSystem: 'http://hl7.org/fhir/sid/us-npi',
    notes: 'CapabilityStatement omits identifier on Practitioner AND PractitionerRole. Chained search PractitionerRole?practitioner.identifier=… works in practice. Commercial only — no Medicare/HealthSpring data on this endpoint.',
  },
  {
    name: 'bcbs-tn',
    baseUrl: 'https://api.bcbst.com/r4/providerdirectory/BCBST',
    enabled: true,
    strategy: 'practitioner-then-role',
    npiSystem: 'http://hl7.org/fhir/sid/us-npi',
    notes: 'HAPI FHIR 5.4.1, full PDEX Plan-Net resources, Open Access (no auth). Discovered after the unrelated /fhir/metadata path on api.bcbst.com 401d — directory lives under /r4/providerdirectory/BCBST.',
  },
  {
    name: 'bcbs-nc',
    baseUrl: 'https://apiservices-ext.bcbsnc.com/fhir/prod/R4/providerdirectory',
    enabled: true,
    strategy: 'role-by-identifier',
    npiSystem: 'http://hl7.org/fhir/sid/us-npi',
    notes:
      'PDEX Plan-Net v1.0.0 (2021), no auth. CapabilityStatement omits identifier on Practitioner (only family/given/name/_id are searchable) AND lists identifier only on InsurancePlan — but PractitionerRole?identifier=<NPI> (bare value, no system) works in practice. ' +
      'PractitionerRole.extension carries network-reference (standard PDEX URL) so the regular extractNetworkRefs path captures network memberships. ' +
      'InsurancePlan resource is empty (0 results on any filter); MA networks live as Organization resources (S-10 "Medicare Advantage HMO", S-11 "Medicare Advantage PPO", S-37 "Healthy Blue + Medicare", S-36 "Experience Health Medicare Advantage HMO") with no H-contract identifiers. ' +
      'Plan resolution goes through scripts/bcbsnc-network-map.ts — each FHIR network display name maps 1:1 to a CMS contract (HMO→H3449, PPO→H3404, Healthy Blue+Medicare→H9147 D-SNP, Experience Health→H3777).',
  },
  {
    name: 'clover',
    baseUrl: 'https://public-api.cloverhealth.com/providerdirectory/api',
    enabled: true,
    strategy: 'practitioner-then-role',
    npiSystem: 'http://hl7.org/fhir/sid/us-npi',
    notes: 'Custom server (Clover Health FHIR R4). All PDEX Plan-Net resources. GA/TX MA market.',
  },
  {
    name: 'kaiser',
    baseUrl: 'https://kpx-service-bus.kp.org/service/hp/mhpo/healthplanproviderv1rc',
    enabled: true,
    strategy: 'practitioner-then-role',
    npiSystem: 'http://hl7.org/fhir/sid/us-npi',
    notes: 'Smile CDR-powered. ~405k PractitionerRoles total — closed-system Kaiser network. Hostname is non-obvious (fhir.kp.org / api.kp.org / developer.kp.org all 404); the kpx-service-bus path is what the CapabilityStatement.implementation.url points to.',
  },
  {
    name: 'molina',
    baseUrl: 'https://api.interop.molinahealthcare.com/ProviderDirectory',
    enabled: true,
    strategy: 'practitioner-then-role',
    npiSystem: 'http://hl7.org/fhir/sid/us-npi',
    notes: 'Sapphire/HealthEdge backend (data fronted by molina.sapphirethreesixtyfive.com). 17M+ PractitionerRoles total. Returns content-type application/json (not application/fhir+json) — body is still FHIR, parser doesn\'t care.',
  },
  {
    name: 'scan',
    baseUrl: 'https://providerdirectory.scanhealthplan.com',
    enabled: true,
    strategy: 'practitioner-then-role',
    npiSystem: 'http://hl7.org/fhir/sid/us-npi',
    notes: 'InterSystems FHIR Server. Rejects unfiltered Practitioner / Organization searches with HTTP 413 (Payload Too Large) — our identifier-bounded queries always pass a filter so this isn\'t hit in normal flow.',
  },
  {
    name: 'amerihealth-caritas',
    baseUrl: 'https://api-ext.amerihealthcaritas.com/NCEX/provider-api',
    enabled: true,
    strategy: 'practitioner-then-role',
    npiSystem: 'http://hl7.org/fhir/sid/us-npi',
    notes: 'Smile CDR-powered. Path includes a market code (NCEX = NC, other states use different codes — wire one carrier-config per market when we expand beyond NC).',
  },
  {
    name: 'christus',
    baseUrl: 'https://chp.healthtrioconnect.com/fhirprovdir',
    enabled: true,
    strategy: 'role-by-chained-practitioner-identifier',
    npiSystem: 'http://hl7.org/fhir/sid/us-npi',
    notes: 'HealthTrio vendor. CapabilityStatement omits identifier on Practitioner AND PractitionerRole — only chained search works. Server returns 406 on plain `application/fhir+json` Accept; the FHIR_ACCEPT constant sends both forms so this carrier negotiates to its preferred `application/json+fhir`.',
  },
  // ─── Gated carriers — enable when creds land ────────────────
  {
    name: 'aetna',
    baseUrl: 'https://apif1.aetna.com/fhir/v1/providerdirectory',
    enabled: false,
    strategy: 'practitioner-then-role',
    npiSystem: 'http://hl7.org/fhir/sid/us-npi',
    notes: 'OAuth2 client_credentials required. Token: https://apif1.aetna.com/fhir/v1/fhirserver_auth/oauth2/token',
  },
  {
    // Discovered via the partner-portal SPA: the Angular bundle at
    // partners.centene.com/main.<hash>.esm.js leaks
    // `https://external-api.my.centene.com/partner-portal`, whose `/apis`
    // endpoint is unauthenticated and lists every Centene FHIR API host.
    // The "FHIR - Provider Directory" entry (no auth, no scopes) points
    // to `https://prod.api.centene.com/fhir/providerdirectory`.
    // Verified Klein (NPI 1619976297) findable here. Two complications:
    //   (1) Their CapabilityStatement omits `identifier` on Practitioner
    //       AND PractitionerRole, AND chained
    //       `PractitionerRole?practitioner.identifier=…` returns 400.
    //       The only path is name-search → fan out — so this strategy
    //       requires a `--name=family,given` CLI flag (not implemented
    //       yet; left disabled to avoid silent zeroes).
    //   (2) Their network Organizations are named like "Exchange NC" or
    //       "Do Not Use - WCG National HMO" — these don't carry CMS
    //       H-format identifiers, so plan_contract_id resolution will
    //       need a separate Centene network → CMS contract mapping.
    name: 'wellcare',
    baseUrl: 'https://prod.api.centene.com/fhir/providerdirectory',
    enabled: true,
    strategy: 'name-then-role-with-prefixed-ref',
    npiSystem: 'http://hl7.org/fhir/sid/us-npi',
    notes: 'Server has no NPI search; uses name search (auto-fetched from NPPES if --name omitted). Their FHIR InsurancePlan resource is empty, so plan resolution goes through scripts/wellcare-network-map.ts — broad-tier rules over pm_plans (national HMO/PPO + state-specific overlays). State filter inherits from --state or NPPES location.',
  },
  {
    name: 'alignment',
    baseUrl: '',
    enabled: false,
    strategy: 'practitioner-then-role',
    npiSystem: 'http://hl7.org/fhir/sid/us-npi',
    notes: 'No public FHIR base URL discovered. Interop page (alignmenthealth.com/interoperability-apis) only links to a B2C-blob doc with HL7 spec references; provider-search SPA (providersearch.alignmenthealthplan.com) is React with a self-contained backend (/api/* returns SPA shell, not FHIR); DNS sweep of fhir.*/api.* alignmenthealth.com|alignmenthealthplan.com|alignmenthealthcare.com all NXDOMAIN; B2C tenant guesses (alignmenthealth/ahcb2c/ahcprod/etc.) all 404. Likely behind Azure B2C with a non-discoverable tenant name — registration via the developer portal still required.',
  },
];

// ─── FHIR types we care about ─────────────────────────────────────
interface Reference { reference?: string; display?: string }
interface Identifier { system?: string; value?: string }
interface Extension {
  url: string;
  valueReference?: Reference;
  valueCodeableConcept?: unknown;
  extension?: Extension[];
}
interface PractitionerRole {
  resourceType: 'PractitionerRole';
  id: string;
  identifier?: Identifier[];
  extension?: Extension[];
  practitioner?: Reference;
  organization?: Reference;
  location?: Reference[];
}
interface Practitioner {
  resourceType: 'Practitioner';
  id: string;
  identifier?: Identifier[];
  name?: Array<{ text?: string; family?: string; given?: string[] }>;
}
interface InsurancePlan {
  resourceType: 'InsurancePlan';
  id: string;
  identifier?: Identifier[];
  name?: string;
  network?: Reference[];
}
interface Bundle<T = unknown> {
  resourceType: 'Bundle';
  type?: string;
  total?: number;
  link?: Array<{ relation: string; url: string }>;
  entry?: Array<{ fullUrl?: string; resource: T }>;
}

// ─── HTTP ─────────────────────────────────────────────────────────
const NETWORK_REF_URL = 'http://hl7.org/fhir/us/davinci-pdex-plan-net/StructureDefinition/network-reference';
const REQUEST_TIMEOUT_MS = 30_000;

// HealthTrio (CHRISTUS) returns 406 on the standard `application/fhir+json`
// and only honors the legacy `application/json+fhir` form. Sending both as a
// comma-separated Accept lets every carrier we've wired pick the one it
// understands — verified against UHC/Humana/Devoted/Cigna/Wellcare/BCBS-TN/
// Clover/Kaiser/Molina/SCAN/AmeriHealth/CHRISTUS, all 200.
const FHIR_ACCEPT = 'application/fhir+json, application/json+fhir';

async function fhirGet<T = unknown>(url: string): Promise<T | null> {
  const ctl = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetch(url, {
    headers: { Accept: FHIR_ACCEPT },
    signal: ctl,
  });
  if (!res.ok) {
    if (VERBOSE) console.warn(`  [http ${res.status}] ${url}`);
    return null;
  }
  return (await res.json()) as T;
}

function buildSearchUrl(base: string, resource: string, params: Record<string, string>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.append(k, v);
  return `${base.replace(/\/$/, '')}/${resource}?${q.toString()}`;
}

async function* paginateBundle<T>(initialUrl: string, maxPages = 50): AsyncGenerator<Bundle<T>> {
  let url: string | null = initialUrl;
  for (let page = 0; page < maxPages && url; page++) {
    const bundle = await fhirGet<Bundle<T>>(url);
    if (!bundle) return;
    yield bundle;
    url = bundle.link?.find((l) => l.relation === 'next')?.url ?? null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

// Strip the resource prefix and any base URL to isolate the id.
//   "Organization/abc"                          → "abc"
//   "https://x.com/api/Organization/abc"        → "abc"
function refToId(ref: string | undefined): string | null {
  if (!ref) return null;
  const slash = ref.lastIndexOf('/');
  return slash >= 0 ? ref.slice(slash + 1) : ref;
}

// Pull every network-reference Organization id off a PractitionerRole.
function extractNetworkRefs(role: PractitionerRole): Array<{ id: string; display?: string }> {
  const out: Array<{ id: string; display?: string }> = [];
  for (const ext of role.extension ?? []) {
    if (ext.url !== NETWORK_REF_URL) continue;
    const id = refToId(ext.valueReference?.reference);
    if (!id) continue;
    out.push({ id, display: ext.valueReference?.display });
  }
  return out;
}

// CMS MA contract-plan from a freeform plan identifier.
//   "H1290-001-000"        → "H1290-001"   (Devoted)
//   "H7617-109-000-2026"   → "H7617-109"   (Humana)
//   "H5420016000"          → "H5420-016"   (UHC: dashes stripped, contract+plan+segment concatenated)
// Returns null when the value isn't a CMS H-style id (e.g. UHC commercial PPO/EPO).
function extractContractPlan(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const dashed = raw.match(/^(H\d{4}-\d{3})\b/i);
  if (dashed) return dashed[1].toUpperCase();
  const concat = raw.match(/^(H\d{4})(\d{3})(?:\d{3})?$/i);
  if (concat) return `${concat[1]}-${concat[2]}`.toUpperCase();
  return null;
}

// Public NPPES lookup — used to auto-populate family/given for
// strategies like Centene that can't be searched by NPI, plus to infer
// the practitioner's state when the user didn't pass --state. Free, no auth.
interface NppesInfo { family: string; given: string; state?: string }
let nppesCache: NppesInfo | null | undefined;
async function nppesLookup(npi: string): Promise<NppesInfo | null> {
  if (nppesCache !== undefined) return nppesCache;
  try {
    const r = await fetch(
      `https://npiregistry.cms.hhs.gov/api/?number=${npi}&version=2.1`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    if (!r.ok) { nppesCache = null; return null; }
    const j = await r.json() as {
      results?: Array<{
        basic?: { first_name?: string; last_name?: string };
        addresses?: Array<{ address_purpose?: string; state?: string }>;
      }>;
    };
    const rec = j.results?.[0];
    const b = rec?.basic;
    if (!b?.first_name || !b?.last_name) { nppesCache = null; return null; }
    const loc = rec?.addresses?.find((a) => a.address_purpose === 'LOCATION') ?? rec?.addresses?.[0];
    nppesCache = { family: b.last_name, given: b.first_name, state: loc?.state };
    return nppesCache;
  } catch {
    nppesCache = null;
    return null;
  }
}
async function nppesName(npi: string): Promise<{ family: string; given: string } | null> {
  const i = await nppesLookup(npi);
  return i ? { family: i.family, given: i.given } : null;
}

// ─── Per-carrier lookup ───────────────────────────────────────────

interface LookupResult {
  carrier: string;
  enabled: boolean;
  found_practitioner: boolean;
  practitioner_ids: string[];
  practitioner_names: string[];
  roles: number;
  networks: Array<{ org_id: string; display?: string }>;
  plans: Array<{
    plan_contract_id: string;
    plan_full_id: string;
    plan_name?: string;
    network_org_id: string;
    network_display?: string;
  }>;
  notes: string[];
  error?: string;
}

async function findRolesForNpi(c: CarrierConfig, npi: string): Promise<{
  practitionerIds: string[];
  practitionerNames: string[];
  roles: PractitionerRole[];
  notes: string[];
}> {
  const notes: string[] = [];
  const tokenValue = `${c.npiSystem}|${npi}`;

  if (c.strategy === 'role-by-chained-practitioner-identifier') {
    // Cigna: chained search. PractitionerRole?practitioner.identifier=… traverses
    // the reference and matches Practitioner.identifier server-side, even though
    // their CapabilityStatement doesn't list identifier as a direct search param.
    const url = buildSearchUrl(c.baseUrl, 'PractitionerRole', {
      'practitioner.identifier': tokenValue,
      _count: '100',
    });
    const roles: PractitionerRole[] = [];
    for await (const bundle of paginateBundle<PractitionerRole>(url, 5)) {
      for (const e of bundle.entry ?? []) if (e.resource) roles.push(e.resource);
    }
    notes.push(`PractitionerRole?practitioner.identifier=… (chained) → ${roles.length} role(s)`);
    const pracIds = Array.from(new Set(
      roles.map((r) => refToId(r.practitioner?.reference)).filter((x): x is string => !!x),
    ));
    return { practitionerIds: pracIds, practitionerNames: [], roles, notes };
  }

  if (c.strategy === 'name-then-role-with-prefixed-ref') {
    // Centene/Wellcare. NPI search not supported anywhere; chained also rejected.
    // Search Practitioner by family/given → keep only the records whose
    // Practitioner.identifier carries our target NPI → for each match, query
    // PractitionerRole using the FULL "Practitioner/<id>" reference (Centene
    // returns 0 if you pass the bare id).
    let nameParts: { family: string; given: string } | null = NAME_PARTS;
    if (!nameParts) {
      nameParts = await nppesName(npi);
      if (nameParts) notes.push(`auto-fetched name from NPPES: ${nameParts.given} ${nameParts.family}`);
    }
    if (!nameParts) {
      notes.push('SKIPPED: --name=Family,Given required and NPPES lookup failed');
      return { practitionerIds: [], practitionerNames: [], roles: [], notes };
    }
    const url = buildSearchUrl(c.baseUrl, 'Practitioner', {
      family: nameParts.family,
      given: nameParts.given,
      _count: '50',
    });
    const bundle = await fhirGet<Bundle<Practitioner>>(url);
    const candidates = (bundle?.entry ?? []).map((e) => e.resource).filter(Boolean);
    notes.push(`Practitioner?family=${nameParts.family}&given=${nameParts.given} → ${candidates.length} candidate(s)`);
    const matches = candidates.filter((p) =>
      (p.identifier ?? []).some((i) => i.system?.endsWith('us-npi') && i.value === npi),
    );
    if (matches.length === 0) {
      notes.push('No candidates matched the target NPI');
      return { practitionerIds: [], practitionerNames: [], roles: [], notes };
    }
    notes.push(`NPI-matched practitioners: ${matches.map((p) => p.id).join(', ')}`);
    const practitionerIds = matches.map((p) => p.id);
    const practitionerNames = Array.from(new Set(
      matches.flatMap((p) => p.name?.map((n) => (n.text || `${(n.given ?? []).join(' ')} ${n.family ?? ''}`).trim()) ?? []),
    )).filter(Boolean);

    const roles: PractitionerRole[] = [];
    for (const pid of practitionerIds) {
      const roleUrl = buildSearchUrl(c.baseUrl, 'PractitionerRole', {
        practitioner: `Practitioner/${pid}`, // CRITICAL: prefixed ref, bare id returns 0
        _count: '100',
      });
      for await (const rb of paginateBundle<PractitionerRole>(roleUrl, 5)) {
        for (const e of rb.entry ?? []) if (e.resource) roles.push(e.resource);
      }
    }
    notes.push(`PractitionerRole?practitioner=Practitioner/<id> → ${roles.length} role(s)`);
    return { practitionerIds, practitionerNames, roles, notes };
  }

  if (c.strategy === 'role-by-identifier') {
    // PractitionerRole.identifier carries NPI directly. Try token form, then bare value.
    let roles: PractitionerRole[] = [];
    for (const ident of [tokenValue, npi]) {
      const url = buildSearchUrl(c.baseUrl, 'PractitionerRole', { identifier: ident });
      const bundle = await fhirGet<Bundle<PractitionerRole>>(url);
      if (!bundle) continue;
      const found = (bundle.entry ?? []).map((e) => e.resource).filter(Boolean);
      if (found.length > 0) {
        roles = found;
        notes.push(`PractitionerRole?identifier=${ident.includes('|') ? 'system|value' : 'value'} → ${found.length} role(s)`);
        break;
      }
    }
    const pracIds = Array.from(new Set(
      roles.map((r) => refToId(r.practitioner?.reference)).filter((x): x is string => !!x),
    ));
    return { practitionerIds: pracIds, practitionerNames: [], roles, notes };
  }

  // Default: Practitioner?identifier= → fan out to PractitionerRole?practitioner=
  const pracUrl = buildSearchUrl(c.baseUrl, 'Practitioner', { identifier: tokenValue });
  const pracBundle = await fhirGet<Bundle<Practitioner>>(pracUrl);
  const practitioners = (pracBundle?.entry ?? []).map((e) => e.resource).filter(Boolean);
  if (practitioners.length === 0) {
    notes.push('Practitioner search returned 0 results');
    return { practitionerIds: [], practitionerNames: [], roles: [], notes };
  }
  const practitionerIds = practitioners.map((p) => p.id);
  const practitionerNames = Array.from(new Set(
    practitioners.flatMap((p) => p.name?.map((n) => n.text || `${(n.given ?? []).join(' ')} ${n.family ?? ''}`.trim()) ?? []),
  )).filter(Boolean);
  notes.push(`Practitioner search → ${practitioners.length} record(s): ${practitionerIds.join(', ')}`);

  // Pull roles per Practitioner.id (carriers vary on whether they accept comma-OR).
  const roles: PractitionerRole[] = [];
  for (const pid of practitionerIds) {
    const roleUrl = buildSearchUrl(c.baseUrl, 'PractitionerRole', { practitioner: pid, _count: '50' });
    for await (const bundle of paginateBundle<PractitionerRole>(roleUrl, 5)) {
      for (const e of bundle.entry ?? []) if (e.resource) roles.push(e.resource);
    }
  }
  notes.push(`PractitionerRole?practitioner=… → ${roles.length} role(s)`);
  return { practitionerIds, practitionerNames, roles, notes };
}

interface PlanIndex {
  byNetworkOrgId: Map<string, Array<{ plan_full_id: string; plan_contract_id: string; plan_name?: string }>>;
  byNameLower: Map<string, Array<{ plan_full_id: string; plan_contract_id: string; plan_name?: string }>>;
  totalPlans: number;
}

// Fetch every InsurancePlan from a carrier, building two indexes:
//   1) network Organization id → plans (for direct-match carriers)
//   2) lowercase plan name → plans  (fallback when PR.network refs are sub-networks
//                                   whose Organization.name carries the plan name —
//                                   UHC stores it this way)
// Cached per-process per-carrier — first call pays the pagination cost, subsequent
// NPI lookups in the same run reuse it.
const PLAN_INDEX_CACHE = new Map<string, Promise<PlanIndex>>();

async function buildPlanIndex(c: CarrierConfig): Promise<PlanIndex> {
  const cached = PLAN_INDEX_CACHE.get(c.name);
  if (cached) return cached;
  const work = (async () => {
    const byNetworkOrgId = new Map<string, Array<{ plan_full_id: string; plan_contract_id: string; plan_name?: string }>>();
    const byNameLower = new Map<string, Array<{ plan_full_id: string; plan_contract_id: string; plan_name?: string }>>();
    const initial = buildSearchUrl(c.baseUrl, 'InsurancePlan', { _count: '200' });
    let totalPlans = 0;
    for await (const bundle of paginateBundle<InsurancePlan>(initial, 100)) {
      for (const e of bundle.entry ?? []) {
        const ip = e.resource;
        if (!ip) continue;
        totalPlans++;
        const planFullId = ip.identifier?.[0]?.value ?? ip.id;
        const planContract = extractContractPlan(planFullId) ?? extractContractPlan(ip.id);
        if (!planContract) continue;
        const entry = { plan_full_id: planFullId, plan_contract_id: planContract, plan_name: ip.name };
        for (const net of ip.network ?? []) {
          const orgId = refToId(net.reference);
          if (!orgId) continue;
          const arr = byNetworkOrgId.get(orgId) ?? [];
          arr.push(entry);
          byNetworkOrgId.set(orgId, arr);
        }
        if (ip.name) {
          const key = ip.name.toLowerCase().trim();
          const arr = byNameLower.get(key) ?? [];
          arr.push(entry);
          byNameLower.set(key, arr);
        }
      }
    }
    if (VERBOSE) console.warn(`  [${c.name}] InsurancePlan index: ${totalPlans} plans → ${byNetworkOrgId.size} networks / ${byNameLower.size} names`);
    return { byNetworkOrgId, byNameLower, totalPlans };
  })();
  PLAN_INDEX_CACHE.set(c.name, work);
  return work;
}

// Fetch Organization resources for the given ids with bounded concurrency, returning
// a Map<id, {name, partOf}>. Used to resolve PractitionerRole.network sub-orgs to
// their human-readable plan names when the id-level join misses (UHC).
async function fetchOrganizations(
  c: CarrierConfig,
  ids: string[],
  concurrency = 8,
  cap = 200,
): Promise<Map<string, { name?: string; partOf?: string }>> {
  const out = new Map<string, { name?: string; partOf?: string }>();
  const trimmed = ids.slice(0, cap);
  let i = 0;
  async function worker() {
    while (i < trimmed.length) {
      const idx = i++;
      const id = trimmed[idx];
      try {
        const org = await fhirGet<{ id: string; name?: string; partOf?: { reference?: string } }>(
          `${c.baseUrl.replace(/\/$/, '')}/Organization/${encodeURIComponent(id)}`,
        );
        if (org) {
          out.set(id, { name: org.name, partOf: refToId(org.partOf?.reference) ?? undefined });
        }
      } catch {
        // ignore individual fetch failures
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

async function lookupCarrier(c: CarrierConfig, npi: string, sb: SupabaseClient | null): Promise<LookupResult> {
  const result: LookupResult = {
    carrier: c.name,
    enabled: c.enabled,
    found_practitioner: false,
    practitioner_ids: [],
    practitioner_names: [],
    roles: 0,
    networks: [],
    plans: [],
    notes: c.notes ? [c.notes] : [],
  };
  if (!c.enabled) {
    result.notes.push('SKIPPED: carrier not yet enabled (credentials pending)');
    return result;
  }
  try {
    const { practitionerIds, practitionerNames, roles, notes } = await findRolesForNpi(c, npi);
    result.notes.push(...notes);
    result.practitioner_ids = practitionerIds;
    result.practitioner_names = practitionerNames;
    result.roles = roles.length;
    result.found_practitioner = practitionerIds.length > 0 || roles.length > 0;
    if (roles.length === 0) return result;

    // Collect distinct network org ids from all roles.
    const networkMap = new Map<string, string | undefined>();
    for (const r of roles) {
      for (const n of extractNetworkRefs(r)) {
        if (!networkMap.has(n.id)) networkMap.set(n.id, n.display);
      }
    }
    result.networks = Array.from(networkMap, ([org_id, display]) => ({ org_id, display }));
    if (networkMap.size === 0) {
      result.notes.push('No network-reference extensions on the returned roles');
      return result;
    }

    // ─── BCBS NC: pm_plans-based mapping ───────────────────────────
    // Their FHIR InsurancePlan resource is empty, but each network
    // display name lines up with exactly one CMS contract (BCBS NC is
    // NC-only, so no state inference needed).
    if (c.name === 'bcbs-nc' && sb) {
      const { hits, rulesFired, unmatched } = await resolveBcbsncNetworks(
        sb,
        Array.from(networkMap, ([org_id, display]) => ({ org_id, display })),
      );
      for (const h of hits) result.plans.push(h);
      if (rulesFired.size) {
        result.notes.push('rules fired: ' + Array.from(rulesFired, ([k, n]) => `${k} (${n})`).join(', '));
      }
      if (unmatched.length) {
        result.notes.push(`unmatched networks (no rule): ${Array.from(new Set(unmatched)).join(', ')}`);
      }
      return result;
    }

    // ─── Wellcare/Centene: pm_plans-based mapping ──────────────────
    // Their FHIR InsurancePlan resource is empty, so the regular index
    // path produces zero hits. Instead, translate the network display
    // names into pm_plans rows via the broad-tier rules in
    // wellcare-network-map.ts.
    if (c.name === 'wellcare' && sb) {
      const stateOverride = STATE ?? (await nppesLookup(npi))?.state;
      if (!stateOverride) {
        result.notes.push('No state available (--state not set, NPPES has no LOCATION address); national networks will match every Wellcare state — likely overbroad');
      } else {
        result.notes.push(`Wellcare network → pm_plans mapping in state=${stateOverride}`);
      }
      const { hits, rulesFired, unmatched } = await resolveWellcareNetworks(
        sb,
        Array.from(networkMap, ([org_id, display]) => ({ org_id, display })),
        { practitionerState: stateOverride },
      );
      for (const h of hits) result.plans.push(h);
      if (rulesFired.size) {
        result.notes.push('rules fired: ' + Array.from(rulesFired, ([k, n]) => `${k} (${n})`).join(', '));
      }
      if (unmatched.length) {
        result.notes.push(`unmatched networks (no rule): ${Array.from(new Set(unmatched)).join(', ')}`);
      }
      return result;
    }

    // Resolve networks → plans via the carrier's full InsurancePlan index.
    const index = await buildPlanIndex(c);
    const seen = new Set<string>(); // dedupe (plan_contract_id|orgId)
    function addHit(orgId: string, display: string | undefined, plan: { plan_full_id: string; plan_contract_id: string; plan_name?: string }) {
      const k = `${plan.plan_contract_id}|${orgId}`;
      if (seen.has(k)) return;
      seen.add(k);
      result.plans.push({
        plan_contract_id: plan.plan_contract_id,
        plan_full_id: plan.plan_full_id,
        plan_name: plan.plan_name,
        network_org_id: orgId,
        network_display: display,
      });
    }

    // Pass 1: direct id-level join (Devoted, Humana, Cigna).
    for (const [orgId, display] of networkMap) {
      for (const p of index.byNetworkOrgId.get(orgId) ?? []) addHit(orgId, display, p);
    }

    // Pass 2: name-level fallback (UHC stores plan names on the Network sub-org).
    // Only fire when pass 1 came up empty AND we haven't blown the network budget.
    if (result.plans.length === 0 && networkMap.size > 0 && networkMap.size <= 1000) {
      const idsNeedingNames = Array.from(networkMap.keys()).filter((id) => !networkMap.get(id));
      if (idsNeedingNames.length > 0) {
        const orgs = await fetchOrganizations(c, idsNeedingNames);
        for (const [id, info] of orgs) {
          if (info.name) networkMap.set(id, info.name); // promote display
        }
      }
      for (const [orgId, display] of networkMap) {
        if (!display) continue;
        const key = display.toLowerCase().trim();
        for (const p of index.byNameLower.get(key) ?? []) addHit(orgId, display, p);
      }
      if (result.plans.length > 0) {
        result.notes.push('Resolved plans via Organization.name → InsurancePlan.name fallback');
      }
    }

    if (result.plans.length === 0) {
      result.notes.push(`Found ${networkMap.size} network ref(s) but no InsurancePlan rows reference them (id or name)`);
    }
  } catch (err) {
    result.error = (err as Error).message;
  }
  return result;
}

// ─── Cache write ──────────────────────────────────────────────────

interface CacheRow {
  plan_id: string;
  segment_id: string;
  npi: string;
  covered: boolean;
}

async function upsertCache(sb: SupabaseClient, rows: CacheRow[]) {
  if (rows.length === 0) return { wrote: 0 };
  // De-dupe on (plan_id, segment_id, npi).
  const dedup = new Map<string, CacheRow>();
  for (const r of rows) dedup.set(`${r.plan_id}|${r.segment_id}|${r.npi}`, r);
  const final = Array.from(dedup.values());
  const { error } = await sb
    .from('pm_provider_network_cache')
    .upsert(final, { onConflict: 'plan_id,segment_id,npi' });
  if (error) throw error;
  return { wrote: final.length };
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  const target = ONLY_CARRIER ? CARRIERS.filter((c) => c.name === ONLY_CARRIER) : CARRIERS;
  if (target.length === 0) {
    console.error(`No carrier matches --carrier=${ONLY_CARRIER}`);
    process.exit(1);
  }

  console.log(`# fhir-provider-lookup  npi=${NPI}${STATE ? `  state=${STATE}` : ''}  dry-run=${DRY_RUN}`);
  if (STATE) console.log(`# (--state filter parsed but not yet wired through; PractitionerRole.location addresses are heterogeneous across carriers)`);
  console.log(`# carriers: ${target.map((c) => `${c.name}${c.enabled ? '' : '(disabled)'}`).join(', ')}`);
  console.log();

  // Build a Supabase client up front so Wellcare's pm_plans-based mapping
  // can run during lookup (not just at write time). If env vars aren't
  // present we still proceed — Wellcare resolution will be skipped with a
  // note, and the rest of the carriers don't touch the DB during lookup.
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sb = url && key
    ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;

  const t0 = Date.now();
  const results = await Promise.all(target.map((c) => lookupCarrier(c, NPI!, sb)));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // ─── Print raw mapped results ──────────────────────────────
  for (const r of results) {
    console.log(`── ${r.carrier} ────────────────────────────────────────`);
    if (!r.enabled) {
      console.log(`  [disabled] ${r.notes.join('; ')}`);
      continue;
    }
    if (r.error) {
      console.log(`  [error] ${r.error}`);
      continue;
    }
    console.log(`  practitioner_ids:   ${r.practitioner_ids.join(', ') || '—'}`);
    if (r.practitioner_names.length) console.log(`  practitioner_names: ${r.practitioner_names.join(' / ')}`);
    console.log(`  roles:              ${r.roles}`);
    console.log(`  networks:           ${r.networks.length}`);
    for (const n of r.networks) console.log(`    • ${n.org_id}${n.display ? `  "${n.display}"` : ''}`);
    console.log(`  plans:              ${r.plans.length}`);
    for (const p of r.plans) {
      console.log(`    • ${p.plan_contract_id}  (${p.plan_full_id})  ${p.plan_name ?? ''}  via ${p.network_display ?? p.network_org_id}`);
    }
    if (r.notes.length) console.log(`  notes:              ${r.notes.join(' | ')}`);
  }

  // ─── Build cache rows ─────────────────────────────────────
  const cacheRows: CacheRow[] = [];
  for (const r of results) {
    if (!r.enabled || r.error) continue;
    for (const p of r.plans) {
      cacheRows.push({ plan_id: p.plan_contract_id, segment_id: '0', npi: NPI!, covered: true });
    }
  }

  console.log();
  console.log(`# elapsed ${elapsed}s  candidate cache rows: ${cacheRows.length}`);
  if (cacheRows.length === 0) {
    console.log('# nothing to write.');
    return;
  }

  // Show the unique upsert payload before committing.
  const uniq = new Map<string, CacheRow>();
  for (const r of cacheRows) uniq.set(`${r.plan_id}|${r.segment_id}|${r.npi}`, r);
  console.log(`# unique upsert payload (${uniq.size} rows):`);
  for (const r of uniq.values()) {
    console.log(`    ${JSON.stringify(r)}`);
  }

  if (DRY_RUN) {
    console.log();
    console.log('# --dry-run set — skipping pm_provider_network_cache write.');
    return;
  }

  if (!sb) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — cannot write. Use --dry-run to skip.');
    process.exit(1);
  }
  const { wrote } = await upsertCache(sb, cacheRows);
  console.log(`# wrote ${wrote} row(s) to pm_provider_network_cache.`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
