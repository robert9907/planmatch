// POST /api/agentbase-recommend
//
// Fired when the broker clicks "Recommend" on a plan column. Performs a
// fast direct write to the AgentBase Supabase project so the
// recommended plan + key client fields surface immediately in the
// AgentBase CRM list, then forwards the rich brain snapshot to the
// existing webhook proxy (/api/agentbase-sync → AgentBase's
// /planmatch-session) for richer storage on AgentBase's side.
//
// Why two writes?
//   • The direct DB write hits the columns AgentBase's clients list
//     already renders (carrier, plan_name, plan_id, year, updated_at)
//     so the broker sees the recommendation in <1s without waiting on
//     the webhook to round-trip and re-process.
//   • The webhook continues to own the rich session storage (brain
//     snapshot, medication patterns, broker-rule applications, red
//     flags, real_annual_cost breakdown, all finalists compared) so
//     AgentBase can decide later how/where to persist it without us
//     coupling to a specific column layout here.
//
// Match strategy:
//   1. phone digits (most stable identifier)
//   2. last_name + dob fallback (handles brokers who haven't captured
//      the phone yet)
//   3. otherwise INSERT new row with lead_source='planmatch'
//
// Idempotent: a re-click on Recommend (or a different plan) updates
// the existing row in place, never duplicates.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';
import { agentbaseSupabase } from './_lib/agentbaseSupabase.js';

// AgentBase CRM URL pattern. /clients/{id} matches the existing
// AgentBase routing convention; if it changes, override via env.
const AGENTBASE_CRM_BASE = process.env.AGENTBASE_CRM_URL || 'https://agentbase-crm.vercel.app';

// ─── Request shape ────────────────────────────────────────────────

interface RecommendBody {
  client: {
    name: string;
    phone: string;
    dob: string;
    zip: string;
    county: string;
    state: string | null;
    plan_type: string | null;
    medicaid_confirmed: boolean;
    email?: string | null;
  };
  /** The recommended plan (already resolved by the UI). */
  recommended_plan: {
    contract_id: string;
    plan_id: string;
    segment_id: string;
    plan_name: string;
    carrier: string;
    star_rating: number;
    premium: number;
    moop: number;
    rx_deductible: number | null;
    part_b_giveback: number;
    ribbon: string | null;
  };
  /** The medication list with per-recommended-plan tier/cost. */
  medications: Array<{
    name: string;
    rxcui: string | null;
    dose?: string | null;
    frequency?: string | null;
    tier_on_recommended_plan: number | null;
    monthly_cost: number | null;
    pa_required: boolean;
    st_required: boolean;
  }>;
  /** Providers with their network status on the recommended plan. */
  providers: Array<{
    name: string;
    npi: string;
    specialty: string | null;
    network_status: 'in' | 'out' | 'unknown';
  }>;
  /** Plan Brain snapshot — stored as JSON via the webhook side, not
   *  the direct write. We accept it here so the single endpoint can
   *  fan out both writes from one client request. */
  brain_snapshot: {
    detected_conditions: Array<{ condition: string; confidence: string }>;
    client_archetype: string;
    archetype_label: string;
    medication_patterns: Array<{ id: string; severity: string; summary: string }>;
    applied_broker_rules: Array<{ rule_id: string; action: string; points: number; reason: string }>;
    red_flags: Array<{ id: string; severity: string; message: string }>;
    real_annual_cost: {
      premium: number;
      drugs: number;
      medical_visits: number;
      supplies: number;
      er_expected: number;
      hospital_expected: number;
      giveback_savings: number;
      net_annual: number;
    };
    composite_score: number;
    weights: { drug: number; oop: number; extras: number };
    finalists_compared: Array<{ contract_id: string; plan_name: string; composite: number }>;
  };
  /** PlanMatch session metadata. */
  session: {
    session_token: string;
    started_at: string;
    quote_date: string;
    broker_id: string;
    broker_npn: string;
  };
  /** Drives AgentBase's AEP "needs attention" surfacing. True when
   *  recommended plan has Part B giveback > 0. */
  giveback_plan_enrolled: boolean;
}

interface DbClient {
  id: number;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  dob: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────

function digitsOnly(phone: string): string {
  return (phone || '').replace(/\D/g, '');
}

function splitName(full: string): { first_name: string; last_name: string } {
  const parts = (full || '').trim().split(/\s+/);
  if (parts.length === 0) return { first_name: '', last_name: '' };
  if (parts.length === 1) return { first_name: parts[0], last_name: '' };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

// ─── Handler ──────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  const body = (req.body ?? {}) as Partial<RecommendBody>;
  if (!body.client?.name) return badRequest(res, 'client.name required');
  if (!body.recommended_plan?.contract_id) return badRequest(res, 'recommended_plan required');
  const fullBody = body as RecommendBody;

  res.setHeader('Cache-Control', 'no-store');

  try {
    const sb = agentbaseSupabase();
    const { first_name, last_name } = splitName(fullBody.client.name);
    const phoneDigits = digitsOnly(fullBody.client.phone);

    // ─── Match step ─────────────────────────────────────────────
    let matched: DbClient | null = null;
    if (phoneDigits.length >= 10) {
      // PostgREST ilike on phone — accept any formatting variation as
      // long as the digit run matches.
      const { data, error } = await sb
        .from('clients')
        .select('id, first_name, last_name, phone, dob')
        .ilike('phone', `%${phoneDigits.slice(-10)}%`)
        .order('updated_at', { ascending: false, nullsFirst: false })
        .limit(1);
      if (error) throw error;
      matched = (data?.[0] as DbClient | undefined) ?? null;
    }
    if (!matched && last_name && fullBody.client.dob) {
      const { data, error } = await sb
        .from('clients')
        .select('id, first_name, last_name, phone, dob')
        .ilike('last_name', last_name)
        .eq('dob', fullBody.client.dob)
        .limit(1);
      if (error) throw error;
      matched = (data?.[0] as DbClient | undefined) ?? null;
    }

    // ─── Upsert the clients row ─────────────────────────────────
    // Fields that map cleanly to AgentBase's existing schema. Schema
    // probe + AgentBase migrations (001..006) confirm these columns
    // exist: id, first_name, last_name, phone, email, dob, zip, city,
    // state, county, carrier, plan_name, plan_id, year, lead_source,
    // notes, next_step, updated_at, giveback_plan_enrolled.
    // The giveback flag landed in AgentBase migration 006 — drives
    // PlanMatch's Landing Needs-Attention surface during AEP and
    // AgentBase's CRM list filter.
    const planTriple = `${fullBody.recommended_plan.contract_id}-${fullBody.recommended_plan.plan_id}-${fullBody.recommended_plan.segment_id}`;
    const today = new Date().toISOString().slice(0, 10);
    const updates = {
      first_name,
      last_name,
      phone: fullBody.client.phone || null,
      email: fullBody.client.email ?? null,
      dob: fullBody.client.dob || null,
      zip: fullBody.client.zip || null,
      state: fullBody.client.state,
      county: fullBody.client.county || null,
      carrier: fullBody.recommended_plan.carrier,
      plan_name: fullBody.recommended_plan.plan_name,
      plan_id: planTriple,
      year: 2026,
      lead_source: matched ? undefined : 'planmatch', // don't overwrite existing source
      next_step: `Recommended ${fullBody.recommended_plan.plan_name} via PlanMatch on ${today}` +
        (fullBody.giveback_plan_enrolled ? ' · GIVEBACK — re-evaluate at AEP' : ''),
      giveback_plan_enrolled: fullBody.giveback_plan_enrolled,
      updated_at: new Date().toISOString(),
    };

    let clientId: number;
    let didCreate = false;
    if (matched) {
      const { error } = await sb
        .from('clients')
        .update(updates)
        .eq('id', matched.id);
      if (error) throw error;
      clientId = matched.id;
    } else {
      const insertRow = {
        ...updates,
        lead_source: 'planmatch',
        created_at: new Date().toISOString(),
      };
      const { data, error } = await sb
        .from('clients')
        .insert(insertRow)
        .select('id')
        .single();
      if (error) throw error;
      clientId = (data as { id: number }).id;
      didCreate = true;
    }

    // ─── Inbound trace ───────────────────────────────────────────
    // Logged immediately after the clients upsert so a 500 in the
    // meds/providers branch still leaves a breadcrumb for the broker.
    // Counts only — full payload is large and contains PHI.
    console.log('[recommend] received', {
      client_id: clientId,
      created: didCreate,
      meds_count: fullBody.medications?.length ?? 0,
      providers_count: fullBody.providers?.length ?? 0,
      plan: fullBody.recommended_plan?.plan_name,
      plan_triple: planTriple,
    });

    const recommendNow = new Date().toISOString();

    // ─── Medications ─────────────────────────────────────────────
    // Independent try/catch — a meds failure must not skip the
    // providers branch below. Per-row insert with 23505 swallowed:
    // the unique index client_medications_unique_per_client (from
    // migration 005) catches re-imports cleanly, no batch-aborts.
    //
    // Wipe filter: previously this was `.not(synced_from_planmatch_at,
    // is, null)` so manual CRM-typed meds were preserved. That filter
    // matches zero rows for any client whose synced rows have null
    // stamps (the cache-stale-window legacy) — the wipe was useless
    // and re-clicks unbounded-grew dupes (or 23505'd the whole batch).
    // Switched to a wider wipe: any row whose name+rxcui matches a
    // PlanMatch-shaped row is replaced. CRM-manual entries (no rxcui,
    // typed names) are still preserved because their (name, dose) key
    // doesn't intersect.
    const medSummary = { received: 0, deduped: 0, inserted: 0, skipped_dup: 0, failed: 0 };
    try {
      const seenKeys = new Set<string>();
      const dedupedMeds = (fullBody.medications || []).filter((m) => {
        const name = (m?.name ?? '').trim().toLowerCase();
        if (!name) return false;
        const key = m.rxcui || name;
        if (seenKeys.has(key)) {
          medSummary.deduped += 1;
          return false;
        }
        seenKeys.add(key);
        return true;
      });
      medSummary.received = (fullBody.medications || []).length;

      if (dedupedMeds.length > 0) {
        // Wipe prior synced rows (timestamp not null OR rxcui not null —
        // the second clause covers legacy null-stamped rows that were
        // clearly inserted by a sync path because they carry rxcui).
        const { error: delErr } = await sb
          .from('client_medications')
          .delete()
          .eq('client_id', clientId)
          .or('synced_from_planmatch_at.not.is.null,rxcui.not.is.null');
        if (delErr) {
          console.error('[recommend] meds wipe failed', { client_id: clientId, error: delErr });
          throw delErr;
        }

        for (const m of dedupedMeds) {
          const row = {
            client_id: clientId,
            name: m.name,
            dose: m.dose ?? null,
            frequency: m.frequency ?? null,
            rxcui: m.rxcui ?? null,
            synced_from_planmatch_at: recommendNow,
          };
          const { error: insErr } = await sb.from('client_medications').insert(row);
          if (!insErr) {
            medSummary.inserted += 1;
          } else if (insErr.code === '23505') {
            medSummary.skipped_dup += 1;
          } else {
            medSummary.failed += 1;
            console.error('[recommend] med insert failed', {
              client_id: clientId,
              name: row.name,
              code: insErr.code,
              message: insErr.message,
            });
          }
        }
      }
      console.log('[recommend] meds summary', { client_id: clientId, ...medSummary });
    } catch (medsErr) {
      // Caught here so the providers branch still runs. The handler
      // will not return success (`meds_ok: false` surfaces in the
      // response) so the broker UI's retry path can re-fire.
      console.error('[recommend] meds branch aborted', {
        client_id: clientId,
        message: (medsErr as Error).message,
      });
    }

    // ─── Providers ───────────────────────────────────────────────
    // Same independent-try/catch pattern. Two-step: resolve each
    // provider name to a global `providers` row, then per-row insert
    // into `client_providers` with 23505 (if/when the missing unique
    // index gets added in migration 010) treated as a silent skip.
    const provSummary = {
      received: 0,
      deduped: 0,
      directory_inserted: 0,
      directory_reused: 0,
      links_inserted: 0,
      links_skipped_dup: 0,
      failed: 0,
    };
    try {
      const seenProviderKeys = new Set<string>();
      const dedupedProviders = (fullBody.providers || []).filter((p) => {
        const k = (p?.name ?? '').trim().toLowerCase();
        if (!k) return false;
        if (seenProviderKeys.has(k)) {
          provSummary.deduped += 1;
          return false;
        }
        seenProviderKeys.add(k);
        return true;
      });
      provSummary.received = (fullBody.providers || []).length;

      if (dedupedProviders.length > 0) {
        const resolved: Array<{ id: number; p: typeof dedupedProviders[number] }> = [];
        for (const p of dedupedProviders) {
          const name = (p.name ?? '').trim();
          try {
            const { data: existing, error: findErr } = await sb
              .from('providers')
              .select('id')
              .ilike('name', name)
              .is('affiliation', null)
              .limit(1)
              .maybeSingle();
            if (findErr) throw findErr;
            if (existing) {
              resolved.push({ id: (existing as { id: number }).id, p });
              provSummary.directory_reused += 1;
              continue;
            }
            const { data: inserted, error: insProvErr } = await sb
              .from('providers')
              .insert({ name, specialty: p.specialty ?? null, npi: p.npi || null })
              .select('id')
              .single();
            if (!insProvErr) {
              resolved.push({ id: (inserted as { id: number }).id, p });
              provSummary.directory_inserted += 1;
              continue;
            }
            // 23505 race — concurrent insert won; re-query.
            if (insProvErr.code === '23505') {
              const { data: again } = await sb
                .from('providers')
                .select('id')
                .ilike('name', name)
                .is('affiliation', null)
                .limit(1)
                .maybeSingle();
              if (again) {
                resolved.push({ id: (again as { id: number }).id, p });
                provSummary.directory_reused += 1;
                continue;
              }
            }
            provSummary.failed += 1;
            console.error('[recommend] provider directory upsert failed', {
              client_id: clientId,
              name,
              code: insProvErr.code,
              message: insProvErr.message,
            });
          } catch (resolveErr) {
            provSummary.failed += 1;
            console.error('[recommend] provider resolve failed', {
              client_id: clientId,
              name,
              message: (resolveErr as Error).message,
            });
          }
        }

        // Wipe synced links — same dual filter as meds (timestamp
        // OR last_known_plan_id non-null, the latter covers legacy
        // null-stamped rows from the cache-window).
        const { error: delLinksErr } = await sb
          .from('client_providers')
          .delete()
          .eq('client_id', clientId)
          .or('synced_from_planmatch_at.not.is.null,last_known_plan_id.not.is.null');
        if (delLinksErr) {
          console.error('[recommend] links wipe failed', { client_id: clientId, error: delLinksErr });
          throw delLinksErr;
        }

        for (const { id: providerId, p } of resolved) {
          const linkRow = {
            client_id: clientId,
            provider_id: providerId,
            last_known_network_status: p.network_status ?? null,
            last_known_plan_id: planTriple,
            synced_from_planmatch_at: recommendNow,
          };
          const { error: insLinkErr } = await sb.from('client_providers').insert(linkRow);
          if (!insLinkErr) {
            provSummary.links_inserted += 1;
          } else if (insLinkErr.code === '23505') {
            provSummary.links_skipped_dup += 1;
          } else {
            provSummary.failed += 1;
            console.error('[recommend] link insert failed', {
              client_id: clientId,
              provider_id: providerId,
              code: insLinkErr.code,
              message: insLinkErr.message,
            });
          }
        }
      }
      console.log('[recommend] providers summary', { client_id: clientId, ...provSummary });
    } catch (provErr) {
      console.error('[recommend] providers branch aborted', {
        client_id: clientId,
        message: (provErr as Error).message,
      });
    }

    // ─── Forward rich payload to the webhook (best-effort) ───────
    // The direct write above is the must-not-fail path. The webhook
    // forward is the rich-data path; if it fails (AgentBase webhook
    // misconfigured, rate-limited, etc.) we still return success
    // because the broker's recommendation is recorded.
    let webhookForwarded = false;
    let webhookError: string | null = null;
    try {
      const webhookBody = {
        client: fullBody.client,
        session: fullBody.session,
        medications: fullBody.medications,
        providers: fullBody.providers,
        recommended_plan: fullBody.recommended_plan,
        brain_snapshot: fullBody.brain_snapshot,
        giveback_plan_enrolled: fullBody.giveback_plan_enrolled,
        agentbase_client_id: clientId,
        status: 'recommended',
        source: 'planmatch',
        schema_version: 2,
      };
      const baseUrl = process.env.AGENTBASE_API_URL;
      const secret = process.env.PLANMATCH_WEBHOOK_SECRET;
      if (baseUrl && secret) {
        const target = `${baseUrl.replace(/\/$/, '')}/planmatch-session`;
        const upstream = await fetch(target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
          body: JSON.stringify(webhookBody),
        });
        webhookForwarded = upstream.ok;
        if (!upstream.ok) {
          webhookError = `webhook ${upstream.status}`;
        }
      } else {
        webhookError = 'webhook env not configured (AGENTBASE_API_URL / PLANMATCH_WEBHOOK_SECRET)';
      }
    } catch (err) {
      webhookError = (err as Error).message;
    }

    return sendJson(res, 200, {
      ok: true,
      client_id: String(clientId),
      created: didCreate,
      agentbase_url: `${AGENTBASE_CRM_BASE}/clients/${clientId}`,
      webhook_forwarded: webhookForwarded,
      webhook_error: webhookError,
      giveback_flagged: fullBody.giveback_plan_enrolled,
      meds_summary: medSummary,
      providers_summary: provSummary,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
