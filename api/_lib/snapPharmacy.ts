// Pharmacy on a pill-bottle label → a real pharmacy.
//
// 1. matchPharmacy(): the label's pharmacy name / phone / place → the CMS
//    NPPES registry (NPI-2, taxonomy Pharmacy). Phone match is the
//    strongest signal, then name tokens, then ZIP / city. Returns null
//    unless the score clears a floor, so a vague read never picks a
//    stranger's pharmacy. Only the pharmacy's own details go to NPPES.
// 2. resolvePharmacyId(): find-or-create that pharmacy in AgentBase's
//    providers directory (pharmacies live there — specialty
//    'Retail Pharmacy' / 'Mail Order Pharmacy') and return its id for
//    client_medications.pharmacy_id. Mirrors resolvePharmacyId in
//    agentbase-crm/lib/planmatch-sync.js.

import type { agentbaseSupabase } from './agentbaseSupabase.js';

const NPPES_URL = 'https://npiregistry.cms.hhs.gov/api/';
const NPPES_TIMEOUT_MS = 6000;
const MATCH_FLOOR = 30;

export interface SnapPharmacy {
  npi: string | null;
  name: string;
  address1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  mailOrder: boolean;
}

export interface LabelPharmacy {
  name: string | null;
  phone: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

interface NppesResult {
  number?: number | string;
  basic?: { organization_name?: string };
  other_names?: Array<{ organization_name?: string; code?: string; type?: string }>;
  addresses?: Array<{
    address_purpose?: string;
    address_1?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    telephone_number?: string;
  }>;
  taxonomies?: Array<{ desc?: string }>;
}

const STOP = new Set(['pharmacy', 'pharmacies', 'drug', 'drugs', 'store', 'inc', 'llc', 'the', 'rx', 'of', 'and', 'co', 'corp', 'corporation']);

function digits(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '').slice(-10);
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t) && !/^\d+$/.test(t));
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
    .replace(/\bCvs\b/g, 'CVS');
}

function toRow(r: NppesResult): (SnapPharmacy & { legal: string | null }) | null {
  const npi = r.number != null ? String(r.number) : '';
  const dba = r.other_names?.find((o) => o.code === '3' || /doing business/i.test(o.type ?? ''));
  const raw = dba?.organization_name ?? r.basic?.organization_name ?? '';
  if (!npi || !raw) return null;
  const loc = r.addresses?.find((a) => (a.address_purpose ?? '').toUpperCase() === 'LOCATION') ?? r.addresses?.[0];
  return {
    npi,
    name: titleCase(raw),
    legal: r.basic?.organization_name ? titleCase(r.basic.organization_name) : null,
    address1: loc?.address_1 ? titleCase(loc.address_1) : null,
    city: loc?.city ? titleCase(loc.city) : null,
    state: loc?.state ?? null,
    zip: loc?.postal_code ? loc.postal_code.slice(0, 5) : null,
    phone: loc?.telephone_number ?? null,
    mailOrder: (r.taxonomies ?? []).some((t) => /mail order/i.test(t.desc ?? '')),
  };
}

async function nppes(params: URLSearchParams, fetchImpl: typeof fetch): Promise<Array<SnapPharmacy & { legal: string | null }>> {
  params.set('version', '2.1');
  params.set('enumeration_type', 'NPI-2');
  params.set('taxonomy_description', 'Pharmacy');
  params.set('limit', '50');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NPPES_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(`${NPPES_URL}?${params.toString()}`, { signal: ctrl.signal });
    if (!resp.ok) return [];
    const body = (await resp.json()) as { results?: NppesResult[] };
    return (body.results ?? []).map(toRow).filter((r): r is SnapPharmacy & { legal: string | null } => r != null);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function matchPharmacy(
  label: LabelPharmacy,
  fetchImpl: typeof fetch = fetch,
): Promise<SnapPharmacy | null> {
  const name = (label.name ?? '').trim();
  const phone = digits(label.phone);
  if (!name && !phone) return null;
  const state = (label.state ?? '').toUpperCase().slice(0, 2);
  const zip = (label.zip ?? '').replace(/\D/g, '').slice(0, 5);
  const nameTokens = tokens(name);

  const searches: Array<Promise<Array<SnapPharmacy & { legal: string | null }>>> = [];
  if (nameTokens.length) {
    const p = new URLSearchParams({ organization_name: `${nameTokens[0]}*` });
    if (state) p.set('state', state);
    if (label.city) p.set('city', label.city);
    searches.push(nppes(p, fetchImpl));
    if (label.city || zip) {
      const p2 = new URLSearchParams({ organization_name: `${nameTokens[0]}*` });
      if (state) p2.set('state', state);
      if (zip) p2.set('postal_code', zip);
      searches.push(nppes(p2, fetchImpl));
    }
  }
  if (zip.length === 5) searches.push(nppes(new URLSearchParams({ postal_code: zip }), fetchImpl));

  const seen = new Map<string, SnapPharmacy & { legal: string | null }>();
  for (const rows of await Promise.all(searches)) for (const r of rows) if (r.npi && !seen.has(r.npi)) seen.set(r.npi, r);

  let best: (SnapPharmacy & { legal: string | null }) | null = null;
  let bestScore = 0;
  for (const r of seen.values()) {
    let s = 0;
    if (phone && digits(r.phone) === phone) s += 60;
    if (nameTokens.length) {
      const have = new Set([...tokens(r.name), ...tokens(r.legal ?? '')]);
      s += Math.round((nameTokens.filter((t) => have.has(t)).length / nameTokens.length) * 30);
    }
    if (zip && r.zip === zip) s += 10;
    else if (label.city && r.city && r.city.toLowerCase() === label.city.toLowerCase()) s += 6;
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }
  if (!best || bestScore < MATCH_FLOOR) return null;
  const { legal: _legal, ...out } = best;
  return out;
}

type AgentBaseClient = ReturnType<typeof agentbaseSupabase>;

/** Find-or-create the pharmacy in AgentBase's providers directory. */
export async function resolvePharmacyId(
  ab: AgentBaseClient,
  ph: { npi?: string | null; name: string; address1?: string | null; city?: string | null; state?: string | null; zip?: string | null; phone?: string | null; mailOrder?: boolean },
): Promise<number | null> {
  if (!ph?.name?.trim()) return null;
  const npi = ph.npi && /^\d{10}$/.test(ph.npi) ? ph.npi : null;
  const affiliation = [ph.city, ph.state].filter(Boolean).join(', ') || null;
  try {
    if (npi) {
      const { data } = await ab.from('providers').select('id').eq('npi', npi).limit(1).maybeSingle();
      if (data) return (data as { id: number }).id;
    }
    const address = [ph.address1, ph.city, [ph.state, ph.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const { data, error } = await ab
      .from('providers')
      .insert({
        name: ph.name.trim(),
        specialty: ph.mailOrder ? 'Mail Order Pharmacy' : 'Retail Pharmacy',
        affiliation,
        phone: ph.phone ?? null,
        address: address || null,
        npi,
      })
      .select('id')
      .single();
    if (!error) return (data as { id: number }).id;
    if (error.code === '23505') {
      let q = ab.from('providers').select('id').ilike('name', ph.name.trim());
      q = affiliation ? q.ilike('affiliation', affiliation) : q.is('affiliation', null);
      const { data: hit } = await q.limit(1).maybeSingle();
      return hit ? (hit as { id: number }).id : null;
    }
    throw error;
  } catch (err) {
    console.warn('[snapPharmacy] resolve failed', { name: ph.name, message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
