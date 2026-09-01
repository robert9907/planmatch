import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'node:crypto';
import { supabase, type CaptureItem, type CaptureSessionRow, type ExtractedItem } from './_lib/supabase.js';
import { extractFromImage } from './_lib/vision.js';
import { badRequest, cors, notFound, sendJson, serverError } from './_lib/http.js';
import { agentbaseSupabase } from './_lib/agentbaseSupabase.js';
import {
  upsertMedicationsForClient,
  upsertProvidersForClient,
  type IncomingMedication,
  type IncomingProvider,
} from './_lib/agentbaseDedup.js';

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

    // The photo is never persisted. It is a picture of a prescription label —
    // patient name, drug, prescriber, Rx number — and once the vision call has
    // read it there is nothing left we need it for. It lives in this request's
    // memory, goes to the model, and is dropped when the request ends. The
    // client keeps its own local preview, so nobody loses anything visible.

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

    // AgentBase write-back — only when the session was launched by an
    // AgentBase-side "Send Snap Link" click. Runs per submitted item
    // rather than at final "Done" so the meds/providers show up on
    // the client card as each photo lands. Idempotent across resubmits
    // via the dedup key logic in agentbaseDedup.
    let writeback: { meds?: unknown; providers?: unknown; error?: string } | undefined;
    if (session.agentbase_client_id && item.extracted.length > 0) {
      try {
        const { meds, providers } = mapExtractedToUpsertInputs(item.extracted);
        const ab = agentbaseSupabase();
        const [medRes, provRes] = await Promise.all([
          meds.length
            ? upsertMedicationsForClient(ab, session.agentbase_client_id, meds, {
                source: 'snap',
                verifiedAt: null,
              })
            : Promise.resolve(null),
          providers.length
            ? upsertProvidersForClient(ab, session.agentbase_client_id, providers, {
                source: 'snap',
                verifiedAt: null,
              })
            : Promise.resolve(null),
        ]);
        writeback = { meds: medRes, providers: provRes };
      } catch (err) {
        writeback = { error: err instanceof Error ? err.message : String(err) };
        console.error('[capture-submit] agentbase writeback failed', {
          token,
          agentbase_client_id: session.agentbase_client_id,
          message: writeback.error,
        });
      }
    }

    sendJson(res, 200, {
      ok: true,
      item_id: itemId,
      extracted: item.extracted,
      error: extractError,
      writeback,
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

// Translate Claude Vision's ExtractedItem shape to the neutral
// {meds, providers} shape agentbaseDedup expects. Fields that are
// specific to the quoting flow (rxcui, tier_on_recommended_plan,
// refill_days as a supply-days number) are left off — Snap captures
// only give us the free-text label surface, so the broker will
// enrich those during the tap-to-confirm step.
function mapExtractedToUpsertInputs(items: ExtractedItem[]): {
  meds: IncomingMedication[];
  providers: IncomingProvider[];
} {
  const meds: IncomingMedication[] = [];
  const providers: IncomingProvider[] = [];
  for (const it of items) {
    if (it.type === 'medication' && it.drug_name) {
      meds.push({
        name: it.drug_name,
        dose: it.strength,
        form: it.form,
        frequency: it.dosage_instructions,
      });
    } else if (it.type === 'provider' && it.provider_name) {
      providers.push({
        name: it.provider_name,
        specialty: it.specialty,
      });
    }
  }
  return { meds, providers };
}
