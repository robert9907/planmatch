// POST /api/capture-confirm — the Snap Link page's last step: the client
// answers "Is this your pharmacy?" and "Is this your doctor?".
//
// Body: {
//   token,
//   med_names: string[],                  // the bottles read this visit
//   pharmacy: { npi?, name, address1?, city?, state?, zip?, phone?, mailOrder? } | null,
//   declined_prescribers: string[],       // "Not my doctor"
// }
//
// AgentBase session (sent from a client card):
//   • pharmacy → AgentBase providers directory → pharmacy_id on this
//     client's medications from this visit. Unverified (snap) rows take the
//     client's answer; a broker-verified row only fills a blank.
//   • declined prescriber → removes ONLY the Linked Provider link that this
//     same Snap Link visit created moments earlier (unverified, created
//     after the link went out, matching last name). Nothing the broker
//     filed or verified is ever touched.
// Agent-v3 session (quoting): the answers are written onto the pending
//   scanned items so the inbox carries the pharmacy and skips a declined
//   prescriber.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase, type CaptureItem, type CaptureSessionRow } from './_lib/supabase.js';
import { badRequest, cors, notFound, sendJson, serverError } from './_lib/http.js';
import { agentbaseSupabase } from './_lib/agentbaseSupabase.js';
import { resolvePharmacyId } from './_lib/snapPharmacy.js';
import { parsePrescriber, sameLast } from './_lib/snapPrescriber.js';

interface ConfirmBody {
  token?: string;
  med_names?: unknown;
  pharmacy?: {
    npi?: string | null;
    name?: string;
    address1?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    phone?: string | null;
    mailOrder?: boolean;
  } | null;
  declined_prescribers?: unknown;
}

function strList(v: unknown, max = 20): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim().slice(0, 160))
    .filter(Boolean)
    .slice(0, max);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  try {
    const body = (req.body ?? {}) as ConfirmBody;
    const token = body.token?.trim();
    if (!token) return badRequest(res, 'token is required');
    const medNames = strList(body.med_names, 40);
    const declined = strList(body.declined_prescribers, 10);
    const ph = body.pharmacy && typeof body.pharmacy.name === 'string' && body.pharmacy.name.trim()
      ? { ...body.pharmacy, name: body.pharmacy.name.trim().slice(0, 160) }
      : null;

    const { data: session, error: findErr } = await supabase()
      .from('capture_sessions')
      .select<'*', CaptureSessionRow>('*')
      .eq('token', token)
      .maybeSingle();
    if (findErr) return serverError(res, findErr);
    if (!session) return notFound(res, 'Capture session not found');
    if (new Date(session.expires_at).getTime() < Date.now()) {
      return sendJson(res, 410, { error: 'Session expired' });
    }

    const ab = agentbaseSupabase();
    const pharmacyId = ph ? await resolvePharmacyId(ab, ph) : null;
    const result = { pharmacy_meds_updated: 0, prescriber_links_removed: 0 };

    if (session.agentbase_client_id) {
      const clientId = session.agentbase_client_id;

      if (pharmacyId != null && medNames.length > 0) {
        for (const name of medNames) {
          const { data: rows } = await ab
            .from('client_medications')
            .select('id, verified_at, pharmacy_id')
            .eq('client_id', clientId)
            .is('deleted_at', null)
            .ilike('name', name);
          for (const r of (rows ?? []) as Array<{ id: number; verified_at: string | null; pharmacy_id: number | null }>) {
            // A broker-verified row only fills a blank.
            if (r.verified_at != null && r.pharmacy_id != null) continue;
            if (r.pharmacy_id === pharmacyId) continue;
            const { error } = await ab.from('client_medications').update({ pharmacy_id: pharmacyId }).eq('id', r.id);
            if (!error) result.pharmacy_meds_updated += 1;
          }
        }
      }

      if (declined.length > 0) {
        const { data: links } = await ab
          .from('client_providers')
          .select('id, verified_at, created_at, provider:providers(name)')
          .eq('client_id', clientId)
          .is('verified_at', null)
          .gte('created_at', session.created_at);
        for (const raw of declined) {
          const want = parsePrescriber(raw);
          if (!want) continue;
          for (const l of (links ?? []) as unknown as Array<{ id: number; provider: { name: string | null } | null }>) {
            const have = parsePrescriber(l.provider?.name ?? '');
            if (!have || !sameLast(have, want)) continue;
            const { error } = await ab.from('client_providers').delete().eq('id', l.id).is('verified_at', null);
            if (!error) result.prescriber_links_removed += 1;
          }
        }
      }
    } else {
      // Agent-v3 quoting session: write the answers onto the scanned items
      // still waiting in the broker's inbox.
      const lowerNames = new Set(medNames.map((n) => n.toLowerCase()));
      const declinedParsed = declined.map((d) => parsePrescriber(d)).filter((p): p is NonNullable<typeof p> => p != null);
      const payload: CaptureItem[] = (session.payload ?? []).map((item) => ({
        ...item,
        extracted: (item.extracted ?? []).map((e) => {
          if (e.type !== 'medication') return e;
          const next = { ...e };
          if (ph && (lowerNames.size === 0 || lowerNames.has((e.drug_name ?? '').toLowerCase()))) {
            next.pharmacy_name = ph.name;
            next.pharmacy_npi = ph.npi ?? null;
            next.pharmacy_id = pharmacyId;
            next.pharmacy_address = [ph.address1, ph.city, ph.state].filter(Boolean).join(', ') || null;
            next.pharmacy_confirmed = true;
          }
          const presc = parsePrescriber(e.prescribing_physician ?? '');
          if (presc && declinedParsed.some((d) => sameLast(d, presc))) next.prescriber_declined = true;
          return next;
        }),
      }));
      const { error: updErr } = await supabase().from('capture_sessions').update({ payload }).eq('token', token);
      if (updErr) return serverError(res, updErr);
    }

    sendJson(res, 200, { ok: true, pharmacy_id: pharmacyId, ...result });
  } catch (err) {
    serverError(res, err);
  }
}
