import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'node:crypto';
import { supabase } from './_lib/supabase';
import { sendCaptureSms, normalizePhone } from './_lib/twilio';
import { badRequest, cors, sendJson, serverError } from './_lib/http';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  try {
    const body = req.body as
      | { client_name?: string; client_phone?: string; started_by?: string; send_sms?: boolean }
      | undefined;

    const clientName = (body?.client_name ?? '').trim();
    const clientPhone = (body?.client_phone ?? '').trim();
    const startedBy = (body?.started_by ?? '').trim() || null;
    const sendSms = body?.send_sms !== false;

    if (!clientPhone) return badRequest(res, 'client_phone is required');

    const normalizedPhone = normalizePhone(clientPhone);
    const token = randomUUID();
    const link = `${appUrl(req)}/capture/${token}`;

    const { data, error } = await supabase()
      .from('capture_sessions')
      .insert({
        token,
        status: 'waiting',
        client_name: clientName || null,
        client_phone: normalizedPhone,
        started_by: startedBy,
      })
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
