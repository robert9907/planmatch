// POST /api/scan-label — Claude Vision OCR for pill-bottle labels.
//
// Consumer-oriented alias over the existing vision pipeline, using the
// flat "prescription label" schema Rob specified:
//
// Body:    { image_base64: string, mime_type?: string }
// Success: { ok: true, label: { drugName, strength, directions, quantity,
//                               prescriber, prescriberNpi, pharmacy,
//                               refills, confidence } }
// Fallback:{ ok: false, error, fallback: true }
//
// Mirrors apps/plan-match/api/scan-label.ts in the consumer repo so both
// widgets talk to an identical contract. Existing /api/vision-extract
// (multi-item, provider-or-medication schema) is retained for the
// agent-side capture-session flow.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';
import { badRequest, cors, sendJson } from './_lib/http.js';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '12mb',
    },
  },
};

const VISION_MODEL = 'claude-sonnet-4-6';

const PROMPT = `Read this prescription label. Return JSON with:
- drugName: the medication name
- strength: dosage strength (e.g. 300mg)
- directions: sig/directions (e.g. Take 1 capsule by mouth 3 times daily)
- quantity: pill count
- prescriber: prescribing doctor's full name
- prescriberNpi: if visible
- pharmacy: pharmacy name
- refills: number of refills remaining
Also include "confidence": "high" | "medium" | "low" reflecting how legible the label is.
Use null for any field you can't read. Return only the JSON, no other text.`;

type SupportedMimeType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

interface LabelResult {
  drugName: string | null;
  strength: string | null;
  directions: string | null;
  quantity: string | null;
  prescriber: string | null;
  prescriberNpi: string | null;
  pharmacy: string | null;
  refills: string | null;
  confidence: 'high' | 'medium' | 'low';
}

function normalizeMimeType(mime: string): SupportedMimeType {
  const lower = (mime || '').toLowerCase();
  if (lower === 'image/jpg') return 'image/jpeg';
  if (lower === 'image/jpeg' || lower === 'image/png' || lower === 'image/webp' || lower === 'image/gif') {
    return lower;
  }
  return 'image/jpeg';
}

function stripDataUrl(s: string): string {
  const idx = s.indexOf(',');
  if (s.startsWith('data:') && idx > 0) return s.slice(idx + 1);
  return s;
}

function nullable(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'null' || s.toLowerCase() === 'none') return null;
  return s;
}

function parseJsonish(text: string): Record<string, unknown> | null {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}

function normalizeLabel(raw: Record<string, unknown>): LabelResult {
  const confRaw = String(raw.confidence ?? '').toLowerCase();
  const confidence: LabelResult['confidence'] =
    confRaw === 'high' || confRaw === 'medium' || confRaw === 'low' ? confRaw : 'medium';
  return {
    drugName: nullable(raw.drugName),
    strength: nullable(raw.strength),
    directions: nullable(raw.directions),
    quantity: nullable(raw.quantity),
    prescriber: nullable(raw.prescriber),
    prescriberNpi: nullable(raw.prescriberNpi),
    pharmacy: nullable(raw.pharmacy),
    refills: nullable(raw.refills),
    confidence,
  };
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY must be set');
  client = new Anthropic({ apiKey });
  return client;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  const body = (req.body ?? {}) as { image_base64?: string; mime_type?: string };
  const raw = body.image_base64 ?? '';
  const imageBase64 = stripDataUrl(raw);
  const mimeType = normalizeMimeType(body.mime_type ?? 'image/jpeg');

  if (!imageBase64) {
    return sendJson(res, 400, { ok: false, error: 'image_base64 is required', fallback: true });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[scan-label] ANTHROPIC_API_KEY missing');
    return sendJson(res, 503, {
      ok: false,
      error: 'Vision OCR not configured',
      fallback: true,
    });
  }

  try {
    const message = await anthropic().messages.create({
      model: VISION_MODEL,
      max_tokens: 1024,
      system: PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: imageBase64,
              },
            },
            { type: 'text', text: 'Extract the fields per the schema.' },
          ],
        },
      ],
    });

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    const parsed = parseJsonish(text);
    if (!parsed) {
      console.warn('[scan-label] vision returned non-JSON:', text.slice(0, 200));
      return sendJson(res, 200, {
        ok: false,
        error: 'Could not read the label clearly',
        fallback: true,
        raw: text.slice(0, 500),
      });
    }

    const label = normalizeLabel(parsed);
    const unreadable = !label.drugName || label.confidence === 'low';

    return sendJson(res, 200, {
      ok: !unreadable,
      label,
      ...(unreadable ? { fallback: true } : {}),
    });
  } catch (err) {
    console.error('[scan-label] vision error:', err);
    return sendJson(res, 200, {
      ok: false,
      error: err instanceof Error ? err.message : 'Vision request failed',
      fallback: true,
    });
  }
}
