import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'node:crypto';
import {
  supabase,
  type CaptureItem,
  type CaptureSessionRow,
  type ExtractedItem,
  type ExtractedMedicareCard,
} from './_lib/supabase.js';
import { extractFromImages } from './_lib/vision.js';
import { badRequest, cors, notFound, sendJson, serverError } from './_lib/http.js';
import { agentbaseSupabase } from './_lib/agentbaseSupabase.js';
import {
  upsertMedicationsForClient,
  upsertProvidersForClient,
  type IncomingMedication,
  type IncomingProvider,
} from './_lib/agentbaseDedup.js';
import { resolveSnapRxcui } from './_lib/snapRxcui.js';
import { daysSupply, nextRefillDate, quantityText } from './_lib/snapRefill.js';
import { lookupTier } from './_lib/snapTier.js';

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
  /** Up to 3 photos of the same bottle, read together as one. When
   *  present it replaces image_base64/mime_type. */
  images?: { image_base64?: string; mime_type?: string }[];
}

const MAX_IMAGES = 3;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  try {
    const body = req.body as SubmitBody | undefined;
    const token = body?.token?.trim();
    const images = (
      Array.isArray(body?.images) && body.images.length > 0
        ? body.images
        : [{ image_base64: body?.image_base64, mime_type: body?.mime_type }]
    )
      .slice(0, MAX_IMAGES)
      .map((img) => ({
        base64: stripDataUrl(img?.image_base64 ?? ''),
        mimeType: img?.mime_type ?? 'image/jpeg',
      }));

    if (!token) return badRequest(res, 'token is required');
    if (images.some((img) => !img.base64)) return badRequest(res, 'image_base64 is required');

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
      const result = await extractFromImages(images);
      extracted = result.extracted;
      rawResponse = result.raw;
    } catch (err) {
      extractError = err instanceof Error ? err.message : String(err);
    }

    // AgentBase write-back — only when the session was launched by an
    // AgentBase-side "Send Snap Link" click. Runs per submitted item
    // rather than at final "Done" so the meds/providers show up on
    // the client card as each photo lands. Idempotent across resubmits
    // via the dedup key logic in agentbaseDedup.
    let writeback:
      | { meds?: unknown; providers?: unknown; medicare_card?: string; error?: string }
      | undefined;
    let medsWritten = 0;
    let providersWritten = 0;
    if (session.agentbase_client_id && extracted.length > 0) {
      try {
        const { meds, providers } = mapExtractedToUpsertInputs(extracted);
        // Attach an RxCUI when the label maps to exactly one drug, so the
        // client card doesn't land on "NO CODE · PICK DRUG". Uncertain
        // labels stay null for the broker to pick; rows stay UNVERIFIED.
        const ab = agentbaseSupabase();
        // Client's current plan, for the Tier column.
        const { data: clientRow } = await ab
          .from('clients')
          .select('plan_id, deleted_at')
          .eq('id', session.agentbase_client_id)
          .maybeSingle();
        // A client deleted after the link went out gets nothing written.
        if (!clientRow || clientRow.deleted_at) throw new Error('client_deleted');
        const planId = (clientRow.plan_id as string | null | undefined) ?? null;
        // The client's current plan is the one in force this calendar year, so
        // pin the tier lookup to that year — not the AEP selling year. Keeps a
        // later year's formulary (once loaded) from bleeding onto this plan.
        const currentPlanYear = new Date().getUTCFullYear();
        await Promise.all(
          meds.map(async (m) => {
            m.rxcui = await resolveSnapRxcui(supabase(), {
              name: m.name,
              dose: m.dose ?? null,
              form: m.form ?? null,
            });
            // Tier on the client's current plan (blank without a code or plan).
            m.tier_on_recommended_plan = await lookupTier(supabase(), planId, m.rxcui, currentPlanYear);
          }),
        );
        const card = extracted.find((e): e is ExtractedMedicareCard => e.type === 'medicare_card');
        const [medRes, provRes, cardRes] = await Promise.all([
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
          card ? sendMedicareCard(session.agentbase_client_id, card) : Promise.resolve(undefined),
        ]);
        writeback = { meds: medRes, providers: provRes, medicare_card: cardRes };
        medsWritten = medRes ? medRes.inserted + medRes.updated : 0;
        providersWritten = provRes ? provRes.links_inserted + provRes.links_skipped_dup : 0;
        const failed =
          (medRes?.failed ?? 0) > 0 ||
          (provRes?.failed ?? 0) > 0 ||
          (card != null && !CARD_STORED.has(cardRes ?? ''));
        if (failed) writeback.error = 'partial';
      } catch (err) {
        writeback = { error: err instanceof Error ? err.message : String(err) };
        console.error('[capture-submit] agentbase writeback failed', {
          token,
          agentbase_client_id: session.agentbase_client_id,
          message: writeback.error,
        });
      }
    }

    // What Plan Match keeps. For an AgentBase session that synced cleanly
    // the CRM is the only copy: no extracted details, no raw model text.
    // If anything failed the details stay (minus the MBI, which is never
    // stored) so the broker can recover them; the 24h purge removes them.
    const isAgentbase = session.agentbase_client_id != null;
    const syncedCleanly = isAgentbase && extracted.length > 0 && writeback != null && !writeback.error;
    const maskedExtracted = extracted.map(maskCard);
    const item: CaptureItem = syncedCleanly
      ? {
          id: itemId,
          created_at: new Date().toISOString(),
          extracted: [],
          synced: {
            medications: medsWritten,
            providers: providersWritten,
            medicare_card: writeback?.medicare_card ?? null,
          },
        }
      : {
          id: itemId,
          created_at: new Date().toISOString(),
          extracted: maskedExtracted,
          raw_response: isAgentbase ? undefined : rawResponse,
          error: extractError ?? (writeback?.error ? `writeback: ${writeback.error}` : undefined),
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

    // The phone that took the photo gets its own reading back for the
    // "What Rob will see" preview — with the MBI masked.
    // Guidance for the photo page. One bottle read from a single photo
    // but missing the quantity or fill date → ask for one more picture of
    // the same bottle (only ever once: a multi-photo read never asks).
    const meds = extracted.filter((e) => e.type === 'medication');
    const bottleCount = meds.length;
    const needsMore =
      images.length === 1 &&
      bottleCount === 1 &&
      meds[0].type === 'medication' &&
      (meds[0].quantity == null || meds[0].last_filled == null);
    const readable = extracted.some((e) => e.type !== 'unknown');

    sendJson(res, 200, {
      ok: true,
      item_id: itemId,
      extracted: maskedExtracted,
      error: extractError,
      writeback,
      guidance: {
        bottle_count: bottleCount,
        needs_more: needsMore,
        readable,
      },
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
// {meds, providers} shape agentbaseDedup expects. rxcui and tier are
// filled in afterwards (resolveSnapRxcui / lookupTier, only when
// certain); quantity, days' supply and next refill come off the label.
function mapExtractedToUpsertInputs(items: ExtractedItem[]): {
  meds: IncomingMedication[];
  providers: IncomingProvider[];
} {
  const meds: IncomingMedication[] = [];
  const providers: IncomingProvider[] = [];
  for (const it of items) {
    if (it.type === 'medication' && it.drug_name) {
      // Quantity, days' supply and next refill come straight off the
      // label; anything the label doesn't make certain stays null.
      const days = daysSupply({
        printedDaysSupply: it.days_supply,
        quantity: it.quantity,
        instructions: it.dosage_instructions,
        form: it.form,
        ndc: it.ndc_code,
      });
      meds.push({
        name: it.drug_name,
        dose: it.strength,
        form: it.form,
        frequency: it.dosage_instructions,
        quantity: quantityText(it.quantity),
        refill_days: days != null ? String(days) : null,
        refill_date: nextRefillDate(it.last_filled, days),
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

// AgentBase outcomes that mean the card's data is safely in the CRM (or
// already was). Anything else keeps the masked reading for the broker.
const CARD_STORED = new Set(['written', 'already_on_file']);

function maskCard(e: ExtractedItem): ExtractedItem {
  if (e.type !== 'medicare_card' || !e.medicare_number) return e;
  const clean = e.medicare_number.replace(/[^A-Za-z0-9]/g, '');
  return { ...e, medicare_number: clean.length > 4 ? `•••• ${clean.slice(-4)}` : '••••' };
}

// Hand the card to AgentBase, which validates the MBI, checks the name
// against the client, encrypts and stores it. Plan Match never stores it.
async function sendMedicareCard(clientId: number, card: ExtractedMedicareCard): Promise<string> {
  const baseUrl = process.env.AGENTBASE_API_URL;
  const secret = process.env.PLANMATCH_WEBHOOK_SECRET;
  if (!baseUrl || !secret) return 'not_configured';
  if (!card.medicare_number) return 'no_number_read';
  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/planmatch-session/medicare-card`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        clientId,
        memberName: card.member_name,
        mbi: card.medicare_number,
        partA: card.part_a_effective,
        partB: card.part_b_effective,
      }),
    });
    const body = (await resp.json().catch(() => ({}))) as { outcome?: string; error?: string };
    return body.outcome ?? body.error ?? `http_${resp.status}`;
  } catch (err) {
    console.error('[capture-submit] medicare card forward failed', {
      clientId,
      message: err instanceof Error ? err.message : String(err),
    });
    return 'network_error';
  }
}
