import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase, type CaptureSessionRow, type CaptureItem } from './_lib/supabase.js';
import { badRequest, cors, notFound, sendJson, serverError } from './_lib/http.js';
import { agentbaseSupabase } from './_lib/agentbaseSupabase.js';

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
      ? allItems.filter(
          (it) =>
            new Date(it.created_at).getTime() > since ||
            (it.updated_at != null && new Date(it.updated_at).getTime() > since),
        )
      : allItems;

    const expired = new Date(session.expires_at).getTime() < Date.now();

    // ACA plans cover the whole household, so an ACA client's Snap Link
    // asks whose bottle each one is (me / spouse / child).
    let household = false;
    if (session.agentbase_client_id) {
      try {
        const { data: c } = await agentbaseSupabase()
          .from('clients')
          .select('line')
          .eq('id', session.agentbase_client_id)
          .maybeSingle();
        household = String((c as { line?: string | null } | null)?.line ?? '').trim().toUpperCase() === 'ACA';
      } catch {
        household = false;
      }
    }

    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, {
      token,
      status: expired ? 'expired' : session.status,
      total_items: allItems.length,
      new_items: newItems,
      last_item_at: session.last_item_at,
      expires_at: session.expires_at,
      client_name: session.client_name,
      household,
    });
  } catch (err) {
    serverError(res, err);
  }
}
