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

    // ─── Upsert medications ──────────────────────────────────────
    // AgentBase's webhook side enforces a unique index on
    // (client_id, lower(trim(name))) — do the same dedup here so
    // a re-click on Recommend doesn't double-insert.
    const seenNames = new Set<string>();
    const medRows = fullBody.medications
      .filter((m) => {
        const k = (m.name ?? '').trim().toLowerCase();
        if (!k || seenNames.has(k)) return false;
        seenNames.add(k);
        return true;
      })
      .map((m) => ({
        client_id: clientId,
        name: m.name,
        dose: m.dose ?? null,
        frequency: m.frequency ?? null,
        rxcui: m.rxcui ?? null,
      }));

    if (medRows.length > 0) {
      // Wipe-and-replace so removed meds don't linger from a prior
      // recommendation on the same client. Cheaper than diff-based
      // upsert and the broker's intent is "this is the current med
      // list as of this recommendation".
      const { error: delErr } = await sb
        .from('client_medications')
        .delete()
        .eq('client_id', clientId);
      if (delErr) throw delErr;
      const { error: insErr } = await sb.from('client_medications').insert(medRows);
      if (insErr) throw insErr;
    }

    // ─── Upsert providers (direct write, two-step) ───────────────
    // Providers live in a global directory (`providers`) with a join
    // table (`client_providers`) carrying a per-client snapshot of
    // network_status + the plan triple it was captured under (see
    // AgentBase migration 007). Wipe-and-replace the join rows so a
    // re-Recommend on the same client doesn't accumulate stale links.
    const seenProviderKeys = new Set<string>();
    const dedupedProviders = (fullBody.providers || []).filter((p) => {
      const k = (p?.name ?? '').trim().toLowerCase();
      if (!k || seenProviderKeys.has(k)) return false;
      seenProviderKeys.add(k);
      return true;
    });

    if (dedupedProviders.length > 0) {
      // Step 1: resolve each provider to a row in the global directory.
      // The unique index providers_name_affiliation_unique dedupes on
      // (lower(name), lower(coalesce(affiliation,''))). PlanMatch
      // payload doesn't carry affiliation, so all our writes share the
      // null-affiliation slot per name.
      const resolvedIds: number[] = [];
      for (const p of dedupedProviders) {
        const name = (p.name ?? '').trim();
        const { data: existing, error: findErr } = await sb
          .from('providers')
          .select('id')
          .ilike('name', name)
          .is('affiliation', null)
          .limit(1)
          .maybeSingle();
        if (findErr) throw findErr;

        if (existing) {
          resolvedIds.push((existing as { id: number }).id);
          continue;
        }

        const { data: inserted, error: insProvErr } = await sb
          .from('providers')
          .insert({ name, specialty: p.specialty ?? null, npi: p.npi || null })
          .select('id')
          .single();
        if (insProvErr) {
          // Race fallback — concurrent insert won, re-query.
          const { data: again } = await sb
            .from('providers')
            .select('id')
            .ilike('name', name)
            .is('affiliation', null)
            .limit(1)
            .maybeSingle();
          if (again) {
            resolvedIds.push((again as { id: number }).id);
            continue;
          }
          throw insProvErr;
        }
        resolvedIds.push((inserted as { id: number }).id);
      }

      // Step 2: wipe + insert the join rows with the network_status
      // snapshot and the plan triple recommended in this call.
      const { error: delLinksErr } = await sb
        .from('client_providers')
        .delete()
        .eq('client_id', clientId);
      if (delLinksErr) throw delLinksErr;

      const linkRows = resolvedIds.map((providerId, i) => ({
        client_id: clientId,
        provider_id: providerId,
        last_known_network_status: dedupedProviders[i].network_status ?? null,
        last_known_plan_id: planTriple,
      }));
      if (linkRows.length > 0) {
        const { error: insLinksErr } = await sb.from('client_providers').insert(linkRows);
        if (insLinksErr) throw insLinksErr;
      }
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
    });
  } catch (err) {
    return serverError(res, err);
  }
}
