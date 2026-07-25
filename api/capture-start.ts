import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'node:crypto';
import { supabase } from './_lib/supabase.js';
import { sendCaptureSms, normalizePhone } from './_lib/twilio.js';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';

// AgentBase-initiated sessions get a longer link TTL because the broker
// hands the phone off to a consumer who may not act until later that
// evening. Agent-v3 quoting sessions are attended live, so the shorter
// default TTL from migration 001 still applies there.
const AGENTBASE_TTL_HOURS = 48;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  try {
    const body = req.body as
      | {
          client_name?: string;
          client_phone?: string;
          started_by?: string;
          send_sms?: boolean;
          agent_session_id?: string;
          agentbase_client_id?: number | string;
          sms_variant?: 'capture' | 'snap';
        }
      | undefined;

    const clientName = (body?.client_name ?? '').trim();
    const clientPhone = (body?.client_phone ?? '').trim();
    const startedBy = (body?.started_by ?? '').trim() || null;
    const agentSessionId = (body?.agent_session_id ?? '').trim() || null;
    const agentbaseClientId = parseAgentbaseClientId(body?.agentbase_client_id);
    const sendSms = body?.send_sms !== false;
    const smsVariant = body?.sms_variant === 'snap' ? 'snap' : 'capture';

    if (!clientPhone) return badRequest(res, 'client_phone is required');
    if (!agentSessionId && agentbaseClientId === null) {
      return badRequest(res, 'agent_session_id or agentbase_client_id is required');
    }

    const normalizedPhone = normalizePhone(clientPhone);
    const sb = supabase();

    // Anti-stacking guard for AgentBase-initiated sessions: reject if
    // there's already an open (waiting|has_results) unexpired capture
    // for this client. The broker resends by letting the current link
    // expire, not by racing a second SMS at the consumer.
    if (agentbaseClientId !== null) {
      const { data: openSessions, error: openErr } = await sb
        .from('capture_sessions')
        .select('id, token, expires_at')
        .eq('agentbase_client_id', agentbaseClientId)
        .in('status', ['waiting', 'has_results'])
        .gt('expires_at', new Date().toISOString())
        .limit(1);
      if (openErr) return serverError(res, openErr);
      if (openSessions && openSessions.length > 0) {
        return sendJson(res, 409, {
          error: 'open_capture_session_exists',
          existing_token: openSessions[0].token,
          expires_at: openSessions[0].expires_at,
        });
      }
    }

    const token = randomUUID();
    const link = `${appUrl(req)}/capture/${token}`;

    const insertRow: Record<string, unknown> = {
      token,
      status: 'waiting',
      client_name: clientName || null,
      client_phone: normalizedPhone,
      started_by: startedBy,
      agent_session_id: agentSessionId,
    };
    if (agentbaseClientId !== null) {
      insertRow.agentbase_client_id = agentbaseClientId;
      insertRow.expires_at = new Date(Date.now() + AGENTBASE_TTL_HOURS * 3600 * 1000).toISOString();
    }

    const { data, error } = await sb
      .from('capture_sessions')
      .insert(insertRow)
      .select('id, token, status, created_at, expires_at')
      .single();

    if (error) return serverError(res, error);

    let smsResult: { sid: string } | { error: string } | null = null;
    if (sendSms) {
      try {
        smsResult = await sendCaptureSms({
          to: normalizedPhone,
          clientFirstName: firstName(clientName),
          link,
          variant: smsVariant,
        });
      } catch (err) {
        smsResult = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    sendJson(res, 200, {
      token,
      link,
      status: data.status,
      created_at: data.created_at,
      expires_at: data.expires_at,
      sms: smsResult,
    });
  } catch (err) {
    serverError(res, err);
  }
}

function parseAgentbaseClientId(raw: number | string | undefined): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function appUrl(req: VercelRequest): string {
  const fromEnv = process.env.VITE_APP_URL ?? process.env.APP_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  const proto = req.headers['x-forwarded-proto'] ?? 'https';
  return `${proto}://${host}`;
}

function firstName(full: string): string {
  const trimmed = full.trim();
  if (!trimmed) return '';
  return trimmed.split(/\s+/)[0];
}
