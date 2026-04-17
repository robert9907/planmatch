import Anthropic from '@anthropic-ai/sdk';
import type { ExtractedItem } from './supabase.js';

const PROMPT = `You are reading a medication bottle label or prescription printout.
Extract the following fields and return ONLY valid JSON, no markdown, no explanation.

{
  "type": "medication",
  "drug_name": "exact name from label",
  "strength": "e.g. 500mg",
  "form": "tablet|capsule|liquid|injection",
  "dosage_instructions": "exact instructions from label",
  "prescribing_physician": "full name and credentials if present",
  "pharmacy_name": "pharmacy name if present",
  "pharmacy_phone": "pharmacy phone if present",
  "refills_remaining": "number or null",
  "last_filled": "date string or null",
  "ndc_code": "NDC code if present or null",
  "confidence": "high|medium|low"
}

If multiple labels are visible, return an array of these objects.
If this is a provider business card instead of a medication label, return:
{
  "type": "provider",
  "provider_name": "full name",
  "credentials": "MD|DO|NP|PA etc",
  "specialty": "specialty if present",
  "practice_name": "practice name if present",
  "phone": "phone if present",
  "address": "address if present",
  "accepting_new_patients": true|false|null
}`;

const VISION_MODEL = 'claude-sonnet-4-6';

type SupportedMimeType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

function normalizeMimeType(mime: string): SupportedMimeType {
  const lower = mime.toLowerCase();
  if (lower === 'image/jpg') return 'image/jpeg';
  if (lower === 'image/jpeg' || lower === 'image/png' || lower === 'image/webp' || lower === 'image/gif') {
    return lower;
  }
  return 'image/jpeg';
}

export interface VisionResult {
  extracted: ExtractedItem[];
  raw: string;
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY must be set');
  client = new Anthropic({ apiKey });
  return client;
}

export async function extractFromImage(
  imageBase64: string,
  mimeType: string,
): Promise<VisionResult> {
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
              media_type: normalizeMimeType(mimeType),
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

  return { extracted: parseVisionJson(text), raw: text };
}

export function parseVisionJson(text: string): ExtractedItem[] {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/[\[{][\s\S]*[\]}]/);
    if (!match) {
      return [{ type: 'unknown', note: `Vision returned non-JSON: ${cleaned.slice(0, 200)}` }];
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch (err) {
      return [{ type: 'unknown', note: `Failed to parse vision JSON: ${(err as Error).message}` }];
    }
  }

  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr.map((item) => normalizeItem(item));
}

function normalizeItem(raw: unknown): ExtractedItem {
  if (!raw || typeof raw !== 'object') {
    return { type: 'unknown', note: 'Non-object item from vision' };
  }
  const obj = raw as Record<string, unknown>;
  const t = obj.type;
  if (t === 'medication') {
    return {
      type: 'medication',
      drug_name: String(obj.drug_name ?? ''),
      strength: nullable(obj.strength),
      form: nullable(obj.form),
      dosage_instructions: nullable(obj.dosage_instructions),
      prescribing_physician: nullable(obj.prescribing_physician),
      pharmacy_name: nullable(obj.pharmacy_name),
      pharmacy_phone: nullable(obj.pharmacy_phone),
      refills_remaining: obj.refills_remaining == null ? null : (obj.refills_remaining as number | string),
      last_filled: nullable(obj.last_filled),
      ndc_code: nullable(obj.ndc_code),
      confidence: (obj.confidence as 'high' | 'medium' | 'low') ?? 'medium',
    };
  }
  if (t === 'provider') {
    return {
      type: 'provider',
      provider_name: String(obj.provider_name ?? ''),
      credentials: nullable(obj.credentials),
      specialty: nullable(obj.specialty),
      practice_name: nullable(obj.practice_name),
      phone: nullable(obj.phone),
      address: nullable(obj.address),
      accepting_new_patients: obj.accepting_new_patients == null ? null : Boolean(obj.accepting_new_patients),
    };
  }
  return { type: 'unknown', note: JSON.stringify(raw).slice(0, 200) };
}

function nullable(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'null') return null;
  return s;
}
