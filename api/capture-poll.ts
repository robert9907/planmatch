import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase, type CaptureSessionRow, type CaptureItem } from './_lib/supabase';
import { badRequest, cors, notFound, sendJson, serverError } from './_lib/http';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');

  try {
    const token = (req.query.token as string | undefined)?.trim();
    const sinceParam = (req.query.since as string | undefined)?.trim();

    if (!token) return badRequest(res, 'token is required');

    const since = sinceParam ? new Date(sinceParam).getTime() : 0;

    const { data: session, error } = await supabase()
      .from('capture_sessions')
      .select<'*', CaptureSessionRow>('*')
      .eq('token', token)
      .maybeSingle();
    if (error) return serverError(res, error);
    if (!session) return notFound(res, 'Capture session not found');

    const allItems: CaptureItem[] = session.payload ?? [];
    const newItems = Number.isFinite(since) && since > 0
      ? allItems.filter((it) => new Date(it.created_at).getTime() > since)
      : allItems;

    const expired = new Date(session.expires_at).getTime() < Date.now();

    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, {
      token,
      status: expired ? 'expired' : session.status,
      total_items: allItems.length,
      new_items: newItems,
      last_item_at: session.last_item_at,
      expires_at: session.expires_at,
      client_name: session.client_name,
    });
  } catch (err) {
    serverError(res, err);
  }
}
