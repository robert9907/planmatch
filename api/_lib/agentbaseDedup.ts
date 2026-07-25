// Shared upsert helpers for the AgentBase Supabase project's
// client_medications and client_providers tables.
//
// Two call sites share this logic:
//   • api/agentbase-recommend.ts — broker-triggered "Recommend" flow.
//     Rows land as source='planmatch', verified_at=now() (broker
//     attestation via the quoting UI). Also stamps
//     synced_from_planmatch_at + tier + planTriple on the link.
//   • api/capture-submit.ts       — CRM-initiated Snap Link flow.
//     Rows land as source='snap', verified_at=null so they show the
//     amber UNVERIFIED badge on the AgentBase client card until a
//     broker taps to confirm.
//
// The dedup key logic (rxcui > lower(name) for meds; NPI > normalized
// name for providers) is identical across both flows — this file is
// the single source of truth.

import type { SupabaseClient } from '@supabase/supabase-js';
import { parseDrugName, normalizeProviderName } from './normalize.js';

export interface IncomingMedication {
  name: string;
  dose?: string | null;
  form?: string | null;
  frequency?: string | null;
  rxcui?: string | null;
  refill_days?: number | string | null;
  tier_on_recommended_plan?: number | null;
}

export interface IncomingProvider {
  name: string;
  npi?: string | null;
  specialty?: string | null;
  network_status?: string | null;
}

export interface MedUpsertSummary {
  received: number;
  deduped: number;
  updated: number;
  inserted: number;
  skipped_dup: number;
  failed: number;
}

export interface ProviderUpsertSummary {
  received: number;
  deduped: number;
  directory_inserted: number;
  directory_reused: number;
  links_inserted: number;
  links_skipped_dup: number;
  failed: number;
}

export interface MedUpsertOpts {
  source: 'planmatch' | 'snap';
  /** ISO timestamp or null. Snap flow leaves this null. */
  verifiedAt: string | null;
  /** When set, stamps client_medications.synced_from_planmatch_at. */
  syncedFromPlanmatchAt?: string;
}

export interface ProviderUpsertOpts {
  source: 'planmatch' | 'snap';
  verifiedAt: string | null;
  /** contract|plan|segment triple, planmatch flow only. */
  planTriple?: string | null;
  syncedFromPlanmatchAt?: string;
}

export async function upsertMedicationsForClient(
  sb: SupabaseClient,
  clientId: number,
  meds: IncomingMedication[],
  opts: MedUpsertOpts,
): Promise<MedUpsertSummary> {
  const summary: MedUpsertSummary = {
    received: 0, deduped: 0, updated: 0, inserted: 0, skipped_dup: 0, failed: 0,
  };

  const parsed = (meds || [])
    .filter((m) => (m?.name ?? '').trim().length > 0)
    .map((m) => {
      const p = parseDrugName(m.name);
      return {
        ...m,
        name: p.name || m.name,
        dose: m.dose ?? p.dose ?? null,
      };
    });

  const seen = new Set<string>();
  const deduped = parsed.filter((m) => {
    const name = (m.name ?? '').trim().toLowerCase();
    if (!name) return false;
    const dose = (m.dose ?? '').trim().toLowerCase();
    const key = m.rxcui ? `${m.rxcui}|${dose}` : `${name}|${dose}`;
    if (seen.has(key)) {
      summary.deduped += 1;
      return false;
    }
    seen.add(key);
    return true;
  });
  summary.received = (meds || []).length;

  // Fields the helper is authorized to write on client_medications.
  // Snap-on-verified rows only allow the subset whose existing value
  // is null (see MED_MATCH branch below).
  const MED_WRITE_COLS = ['name', 'dose', 'form', 'frequency', 'rxcui', 'refill_days', 'tier'] as const;
  const MED_SELECT = `id, verified_at, ${MED_WRITE_COLS.join(', ')}`;
  type ExistingMed = {
    id: number;
    verified_at: string | null;
  } & Partial<Record<(typeof MED_WRITE_COLS)[number], unknown>>;

  for (const m of deduped) {
    try {
      let existing: ExistingMed | null = null;
      if (m.rxcui) {
        const { data, error } = await sb
          .from('client_medications')
          .select(MED_SELECT)
          .eq('client_id', clientId)
          .eq('rxcui', m.rxcui)
          .limit(1)
          .maybeSingle();
        if (error) throw error;
        existing = (data ?? null) as unknown as ExistingMed | null;
      }
      if (!existing && m.name) {
        const { data, error } = await sb
          .from('client_medications')
          .select(MED_SELECT)
          .eq('client_id', clientId)
          .ilike('name', m.name)
          .limit(1)
          .maybeSingle();
        if (error) throw error;
        existing = (data ?? null) as unknown as ExistingMed | null;
      }

      const tierStr = typeof m.tier_on_recommended_plan === 'number'
        ? `Tier ${m.tier_on_recommended_plan}`
        : null;
      // The full set of values this incoming row proposes to write.
      // The per-branch logic below decides how many of them actually
      // land on the row.
      const proposed: Record<string, unknown> = {
        name: m.name,
        dose: m.dose ?? null,
        form: m.form ?? null,
        frequency: m.frequency ?? null,
        rxcui: m.rxcui ?? null,
        refill_days: m.refill_days ?? null,
        tier: tierStr,
      };

      if (existing) {
        // MATCH: never touch `source` — insert-only. `verified_at`
        // moves forward only, and only for the planmatch flow.
        //
        // Field-level protection: if this is a snap-flow update and
        // the row is already broker-verified, only fill columns that
        // are currently null. A snap extraction can't overwrite dose,
        // tier, frequency, etc. once a broker has endorsed the row —
        // the snap layer is second-class evidence next to attestation.
        // Snap on an unverified row still overwrites freely (previous
        // snap extractions have no more authority than a new one).
        const patch: Record<string, unknown> = {};
        const snapProtect = opts.source === 'snap' && existing.verified_at != null;
        for (const col of MED_WRITE_COLS) {
          const v = proposed[col];
          if (snapProtect) {
            if (v != null && existing[col] == null) patch[col] = v;
          } else {
            patch[col] = v;
          }
        }
        if (opts.syncedFromPlanmatchAt) patch.synced_from_planmatch_at = opts.syncedFromPlanmatchAt;
        if (opts.source === 'planmatch') patch.verified_at = opts.verifiedAt;

        if (Object.keys(patch).length > 0) {
          const { error: updErr } = await sb
            .from('client_medications')
            .update(patch)
            .eq('id', existing.id);
          if (updErr) throw updErr;
        }
        summary.updated += 1;
      } else {
        // INSERT: first-write is authoritative for both source and
        // verified_at. null verified_at is the intended snap-flow
        // signal for the UNVERIFIED badge on the client card.
        const insertRow: Record<string, unknown> = { ...proposed };
        if (opts.syncedFromPlanmatchAt) insertRow.synced_from_planmatch_at = opts.syncedFromPlanmatchAt;
        insertRow.source = opts.source;
        insertRow.verified_at = opts.verifiedAt;
        const { error: insErr } = await sb
          .from('client_medications')
          .insert({ client_id: clientId, ...insertRow });
        if (!insErr) {
          summary.inserted += 1;
        } else if (insErr.code === '23505') {
          summary.skipped_dup += 1;
        } else {
          throw insErr;
        }
      }
    } catch (perRowErr) {
      summary.failed += 1;
      console.error('[agentbaseDedup] med upsert failed', {
        client_id: clientId,
        name: m.name,
        rxcui: m.rxcui,
        source: opts.source,
        message: (perRowErr as Error).message,
      });
    }
  }

  return summary;
}

export async function upsertProvidersForClient(
  sb: SupabaseClient,
  clientId: number,
  providers: IncomingProvider[],
  opts: ProviderUpsertOpts,
): Promise<ProviderUpsertSummary> {
  const summary: ProviderUpsertSummary = {
    received: 0,
    deduped: 0,
    directory_inserted: 0,
    directory_reused: 0,
    links_inserted: 0,
    links_skipped_dup: 0,
    failed: 0,
  };

  const seen = new Set<string>();
  const deduped = (providers || []).filter((p) => {
    const npi = (p?.npi ?? '').trim();
    const norm = normalizeProviderName(p?.name);
    if (!npi && !norm) return false;
    const key = npi ? `npi:${npi}` : `name:${norm}`;
    if (seen.has(key)) {
      summary.deduped += 1;
      return false;
    }
    seen.add(key);
    return true;
  });
  summary.received = (providers || []).length;

  if (deduped.length === 0) return summary;

  const resolved: Array<{ id: number; p: IncomingProvider }> = [];
  for (const p of deduped) {
    const name = (p.name ?? '').trim();
    const npi = (p.npi ?? '').trim();
    const norm = normalizeProviderName(name);
    try {
      let existing: { id: number; npi: string | null } | null = null;
      if (npi) {
        const { data, error } = await sb
          .from('providers')
          .select('id, npi')
          .eq('npi', npi)
          .limit(1)
          .maybeSingle();
        if (error) throw error;
        existing = data as { id: number; npi: string | null } | null;
      }
      if (!existing && norm) {
        const { data, error } = await sb
          .from('providers')
          .select('id, name, npi')
          .ilike('name', `%${norm.split(' ').slice(-1)[0]}%`)
          .limit(20);
        if (error) throw error;
        const hit = (data as Array<{ id: number; name: string; npi: string | null }> | null ?? [])
          .find((r) => normalizeProviderName(r.name) === norm);
        if (hit) existing = { id: hit.id, npi: hit.npi };
      }

      if (existing) {
        if (npi && !existing.npi) {
          const { error: updErr } = await sb
            .from('providers')
            .update({ npi, specialty: p.specialty ?? null })
            .eq('id', existing.id);
          if (updErr) {
            console.warn('[agentbaseDedup] provider NPI backfill failed', {
              provider_id: existing.id, npi, message: updErr.message,
            });
          }
        }
        resolved.push({ id: existing.id, p });
        summary.directory_reused += 1;
        continue;
      }

      const { data: inserted, error: insProvErr } = await sb
        .from('providers')
        .insert({ name, specialty: p.specialty ?? null, npi: npi || null })
        .select('id')
        .single();
      if (!insProvErr) {
        resolved.push({ id: (inserted as { id: number }).id, p });
        summary.directory_inserted += 1;
        continue;
      }
      if (insProvErr.code === '23505' && npi) {
        const { data: again } = await sb
          .from('providers')
          .select('id')
          .eq('npi', npi)
          .limit(1)
          .maybeSingle();
        if (again) {
          resolved.push({ id: (again as { id: number }).id, p });
          summary.directory_reused += 1;
          continue;
        }
      }
      summary.failed += 1;
      console.error('[agentbaseDedup] provider directory upsert failed', {
        client_id: clientId,
        name,
        code: insProvErr.code,
        message: insProvErr.message,
      });
    } catch (resolveErr) {
      summary.failed += 1;
      console.error('[agentbaseDedup] provider resolve failed', {
        client_id: clientId,
        name,
        message: (resolveErr as Error).message,
      });
    }
  }

  // Fields the helper writes on the client_providers link. Same
  // null-fill protection as meds when snap matches a verified row.
  const LINK_WRITE_COLS = ['last_known_network_status'] as const;

  for (const { id: providerId, p } of resolved) {
    const proposed: Record<string, unknown> = {
      last_known_network_status: p.network_status ?? null,
    };

    const { data: existingLink, error: findLinkErr } = await sb
      .from('client_providers')
      .select('id, verified_at, last_known_network_status')
      .eq('client_id', clientId)
      .eq('provider_id', providerId)
      .limit(1)
      .maybeSingle();
    if (findLinkErr) {
      summary.failed += 1;
      console.error('[agentbaseDedup] link lookup failed', {
        client_id: clientId, provider_id: providerId, message: findLinkErr.message,
      });
      continue;
    }
    if (existingLink) {
      // MATCH: never touch `source`. `verified_at` moves forward
      // only on the planmatch flow. Snap-on-verified links only
      // fill columns whose existing value is null; snap-on-unverified
      // and planmatch flows overwrite freely (per prior behavior).
      const linkPatch: Record<string, unknown> = {};
      const existingRow = existingLink as Record<string, unknown> & { id: number; verified_at: string | null };
      const snapProtect = opts.source === 'snap' && existingRow.verified_at != null;
      for (const col of LINK_WRITE_COLS) {
        const v = proposed[col];
        if (snapProtect) {
          if (v != null && existingRow[col] == null) linkPatch[col] = v;
        } else {
          linkPatch[col] = v;
        }
      }
      if (opts.planTriple) linkPatch.last_known_plan_id = opts.planTriple;
      if (opts.syncedFromPlanmatchAt) linkPatch.synced_from_planmatch_at = opts.syncedFromPlanmatchAt;
      if (opts.source === 'planmatch') linkPatch.verified_at = opts.verifiedAt;

      if (Object.keys(linkPatch).length === 0) {
        summary.links_skipped_dup += 1;
        continue;
      }
      const { error: updErr } = await sb
        .from('client_providers')
        .update(linkPatch)
        .eq('id', existingRow.id);
      if (updErr) {
        summary.failed += 1;
        console.error('[agentbaseDedup] link update failed', {
          client_id: clientId, provider_id: providerId, message: updErr.message,
        });
      } else {
        summary.links_skipped_dup += 1;
      }
      continue;
    }
    // INSERT: first-write is authoritative for source + verified_at.
    const insertLink: Record<string, unknown> = { ...proposed };
    if (opts.planTriple) insertLink.last_known_plan_id = opts.planTriple;
    if (opts.syncedFromPlanmatchAt) insertLink.synced_from_planmatch_at = opts.syncedFromPlanmatchAt;
    insertLink.source = opts.source;
    insertLink.verified_at = opts.verifiedAt;
    const { error: insLinkErr } = await sb
      .from('client_providers')
      .insert({ client_id: clientId, provider_id: providerId, ...insertLink });
    if (!insLinkErr) {
      summary.links_inserted += 1;
    } else if (insLinkErr.code === '23505') {
      summary.links_skipped_dup += 1;
    } else {
      summary.failed += 1;
      console.error('[agentbaseDedup] link insert failed', {
        client_id: clientId,
        provider_id: providerId,
        code: insLinkErr.code,
        message: insLinkErr.message,
      });
    }
  }

  return summary;
}
