// POST /api/agentbase-create-client
//
// Inline client creation from agent-v3's IntakeScreen. Lets the broker
// take a live caller through the full quote without tabbing out to the
// AgentBase CRM to create the row first. Writes one minimal `clients`
// record and returns the numeric id so IntakeScreen can pin
// ?clientId=<id> to the URL — every downstream sync (med upserts,
// provider links, recommend) then resolves straight to this row.
//
// Match strategy: lightweight phone-digit dedup so two clicks of the
// "Create" button (or a re-creation after refresh) don't fan out
// dupes. When a row is found, we surface its id back as `created:false`
// so the caller can decide whether to merge or accept the existing
// row.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';
import { agentbaseSupabase } from './_lib/agentbaseSupabase.js';

interface CreateBody {
  firstName: string;
  lastName: string;
  phone?: string;
  email?: string;
  dob?: string;
  zip: string;
  county?: string;
  state?: string;
  medicareId?: string;
  currentCarrier?: string;
  currentPlanName?: string;
  currentPlanId?: string;
}

function digitsOnly(phone: string | undefined): string {
  return (phone ?? '').replace(/\D/g, '');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  const body = (req.body ?? {}) as Partial<CreateBody>;
  const firstName = (body.firstName ?? '').trim();
  const lastName = (body.lastName ?? '').trim();
  const zip = (body.zip ?? '').trim();
  if (!firstName) return badRequest(res, 'firstName required');
  if (!lastName) return badRequest(res, 'lastName required');
  if (!/^\d{5}$/.test(zip)) return badRequest(res, 'zip must be 5 digits');

  res.setHeader('Cache-Control', 'no-store');

  try {
    const sb = agentbaseSupabase();
    const phoneDigits = digitsOnly(body.phone);

    // Phone-based dedup. A 10+ digit phone is enough to identify a
    // repeat call; we use the last 10 digits to absorb country-code
    // variation. Matches the legacy match strategy in
    // /api/agentbase-recommend so the two endpoints can't disagree on
    // which row is "the same client".
    if (phoneDigits.length >= 10) {
      const { data: existing, error: lookupErr } = await sb
        .from('clients')
        .select('id, first_name, last_name')
        .ilike('phone', `%${phoneDigits.slice(-10)}%`)
        .order('updated_at', { ascending: false, nullsFirst: false })
        .limit(1);
      if (lookupErr) throw lookupErr;
      const row = existing?.[0] as { id: number } | undefined;
      if (row) {
        return sendJson(res, 200, {
          clientId: row.id,
          created: false,
        });
      }
    }

    const nowIso = new Date().toISOString();
    const insert = {
      first_name: firstName,
      last_name: lastName,
      name: `${firstName} ${lastName}`.trim(),
      phone: body.phone?.trim() || null,
      email: body.email?.trim() || null,
      dob: body.dob?.trim() || null,
      zip,
      county: body.county?.trim() || null,
      state: body.state?.trim() || null,
      medicare_id: body.medicareId?.trim() || null,
      carrier: body.currentCarrier?.trim() || null,
      plan_name: body.currentPlanName?.trim() || null,
      plan_id: body.currentPlanId?.trim() || null,
      year: 2026,
      source: 'plan-match-agent',
      // Triggers AgentBase's "🚨 New Leads" popup (filter in
      // agentbase-crm/components/AgentBaseCRM.jsx:2291 is
      //   clients.status === "New Lead" && !c.newLeadAlertDismissedAt
      // ). Was 'active' — which silently suppressed the bell for every
      // client Rob created from the agent-v3 IntakeScreen. Insert-only
      // (this whole function only runs when no existing row matched
      // the phone-dedup above, so we never overwrite a categorized
      // client's status).
      status: 'New Lead',
      // Belt-and-suspenders against a future change to the AgentBase
      // clients column default for new_lead_alert_dismissed_at
      // (migration 029_clients_new_lead_alert_dismissed). NULL = bell
      // pops; any timestamp = already-dismissed.
      new_lead_alert_dismissed_at: null,
      lead_source: 'planmatch',
      created_at: nowIso,
      updated_at: nowIso,
    };

    const { data, error } = await sb
      .from('clients')
      .insert(insert)
      .select('id')
      .single();
    if (error) throw error;

    const id = (data as { id: number }).id;
    console.log('[create-client] inserted', { id, zip, hasPhone: phoneDigits.length >= 10 });
    return sendJson(res, 200, { clientId: id, created: true });
  } catch (err) {
    return serverError(res, err);
  }
}
