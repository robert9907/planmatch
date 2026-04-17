import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'node:crypto';
import { supabase, type CaptureItem, type CaptureSessionRow } from './_lib/supabase';
import { extractFromImage } from './_lib/vision';
import { storeCaptureImage } from './_lib/blob';
import { badRequest, cors, notFound, sendJson, serverError } from './_lib/http';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '12mb',
    },
  },
};

interface SubmitBody {
  token?: string;
  image_base64?: string;
  mime_type?: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  try {
    const body = req.body as SubmitBody | undefined;
    const token = body?.token?.trim();
    const imageBase64 = stripDataUrl(body?.image_base64 ?? '');
    const mimeType = body?.mime_type ?? 'image/jpeg';

    if (!token) return badRequest(res, 'token is required');
    if (!imageBase64) return badRequest(res, 'image_base64 is required');

    const { data: session, error: findErr } = await supabase()
      .from('capture_sessions')
      .select<'*', CaptureSessionRow>('*')
      .eq('token', token)
      .maybeSingle();
    if (findErr) return serverError(res, findErr);
    if (!session) return notFound(res, 'Capture session not found');

    if (new Date(session.expires_at).getTime() < Date.now()) {
      await supabase().from('capture_sessions').update({ status: 'expired' }).eq('token', token);
      return sendJson(res, 410, { error: 'Session expired' });
    }

    const itemId = `item_${randomUUID()}`;
    const buffer = Buffer.from(imageBase64, 'base64');

    let imageUrl = '';
    try {
      const stored = await storeCaptureImage({ token, itemId, data: buffer, mimeType });
      imageUrl = stored.url;
    } catch (err) {
      imageUrl = '';
      console.error('Blob storage failed', err);
    }

    let extracted: CaptureItem['extracted'] = [];
    let rawResponse: string | undefined;
    let extractError: string | undefined;
    try {
      const result = await extractFromImage(imageBase64, mimeType);
      extracted = result.extracted;
      rawResponse = result.raw;
    } catch (err) {
      extractError = err instanceof Error ? err.message : String(err);
    }

    const item: CaptureItem = {
      id: itemId,
      created_at: new Date().toISOString(),
      image_url: imageUrl,
      extracted,
      raw_response: rawResponse,
      error: extractError,
    };

    const nextPayload = [...(session.payload ?? []), item];

    const { error: updateErr } = await supabase()
      .from('capture_sessions')
      .update({
        payload: nextPayload,
        status: 'has_results',
        last_item_at: item.created_at,
      })
      .eq('token', token);
    if (updateErr) return serverError(res, updateErr);

    sendJson(res, 200, {
      ok: true,
      item_id: itemId,
      extracted: item.extracted,
      image_url: imageUrl,
      error: extractError,
    });
  } catch (err) {
    serverError(res, err);
  }
}

function stripDataUrl(s: string): string {
  const idx = s.indexOf(',');
  if (s.startsWith('data:') && idx > 0) return s.slice(idx + 1);
  return s;
}
