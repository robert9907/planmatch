// Enrollment provider-network proof.
//
// At the moment the broker hits Enroll, record — per doctor — what the
// plan's network answer was for the EXACT plan and plan year, where that
// answer came from, and when that source last checked. Read server-side
// from pm_provider_network_cache (plan-match-prod), never trusted from the
// browser: the browser's view is stored alongside as `shown_to_broker` so a
// mismatch is visible later, but the status of record is the database's.
//
// Broker enrollments get no Plan Finder directory SEP, so this append-only
// row is the proof of what the directory said on enrollment day.

import { supabase } from './supabase.js';
import { outranks } from './network-row-precedence.js';

export type EvidenceStatus = 'in_network' | 'out_of_network' | 'not_confirmed';

export interface CacheRowLite {
  plan_id: string;        // combined 'H5253-189'
  segment_id: string;
  npi: string;
  covered: boolean;
  source: string;
  checked_at: string | null;
}

export interface EvidenceProviderInput {
  npi: string;
  name: string;
  network_status: 'in' | 'out' | 'unknown';
}

export interface EvidenceRow {
  session_id: string;
  agentbase_client_id: number | null;
  client_name: string | null;
  plan_year: number;
  contract_id: string;
  plan_id: string;
  segment_id: string;
  npi: string;
  provider_name: string | null;
  status: EvidenceStatus;
  source: string | null;
  source_checked_at: string | null;
  shown_to_broker: string;
}

const NPI_RE = /^\d{10}$/;

// Pick the row of record for one doctor on one plan: exact segment first,
// then the most recently checked. No row → not_confirmed (never assumed).
export function pickRowOfRecord(
  rows: ReadonlyArray<CacheRowLite>,
  segmentId: string,
): CacheRowLite | null {
  if (rows.length === 0) return null;
  const norm = (s: string) => (s === '000' ? '0' : s);
  const seg = norm(segmentId);
  const sameSeg = rows.filter((r) => norm(r.segment_id) === seg);
  const pool = sameSeg.length > 0 ? sameSeg : rows;
  // Plan Finder wins every time; same source → newest check.
  return pool.reduce((best, r) => (outranks(r, best) ? r : best));
}

export function buildEvidenceRows(args: {
  sessionId: string;
  agentbaseClientId: number | null;
  clientName: string | null;
  planYear: number;
  contractId: string;
  planId: string;
  segmentId: string;
  providers: ReadonlyArray<EvidenceProviderInput>;
  cacheRows: ReadonlyArray<CacheRowLite>;
}): EvidenceRow[] {
  const combined = `${args.contractId}-${args.planId}`;
  const seen = new Set<string>();
  const out: EvidenceRow[] = [];
  for (const p of args.providers) {
    const npi = (p.npi ?? '').trim();
    const key = npi || `name:${p.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = NPI_RE.test(npi)
      ? args.cacheRows.filter((r) => r.npi === npi && r.plan_id === combined)
      : [];
    const row = pickRowOfRecord(rows, args.segmentId);
    out.push({
      session_id: args.sessionId,
      agentbase_client_id: args.agentbaseClientId,
      client_name: args.clientName,
      plan_year: args.planYear,
      contract_id: args.contractId,
      plan_id: args.planId,
      segment_id: args.segmentId,
      npi: npi || '',
      provider_name: p.name || null,
      status: row ? (row.covered ? 'in_network' : 'out_of_network') : 'not_confirmed',
      source: row?.source ?? null,
      source_checked_at: row?.checked_at ?? null,
      shown_to_broker: p.network_status,
    });
  }
  return out;
}

// Reads the cache for the plan + year and appends one evidence row per
// doctor. Returns the rows written. Throws on DB failure so the caller can
// report it — the enrollment write itself must not depend on this.
export async function recordEnrollmentEvidence(args: {
  sessionId: string;
  agentbaseClientId: number | null;
  clientName: string | null;
  planYear: number;
  contractId: string;
  planId: string;
  segmentId: string;
  providers: ReadonlyArray<EvidenceProviderInput>;
}): Promise<EvidenceRow[]> {
  if (args.providers.length === 0) return [];
  const sb = supabase();
  const npis = [...new Set(args.providers.map((p) => (p.npi ?? '').trim()).filter((n) => NPI_RE.test(n)))];
  let cacheRows: CacheRowLite[] = [];
  if (npis.length > 0) {
    const { data, error } = await sb
      .from('pm_provider_network_cache')
      .select('plan_id,segment_id,npi,covered,source,checked_at')
      .eq('plan_id', `${args.contractId}-${args.planId}`)
      .eq('plan_year', args.planYear)
      .in('npi', npis)
      .limit(500);
    if (error) throw new Error(`evidence cache read: ${error.message}`);
    cacheRows = (data ?? []) as CacheRowLite[];
  }
  const rows = buildEvidenceRows({ ...args, cacheRows });
  const { error: insErr } = await sb.from('pm_enrollment_provider_evidence').insert(rows);
  if (insErr) throw new Error(`evidence insert: ${insErr.message}`);
  return rows;
}
