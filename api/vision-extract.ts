import type { VercelRequest, VercelResponse } from '@vercel/node';
import { extractFromImage } from './_lib/vision';
import { badRequest, cors, sendJson, serverError } from './_lib/http';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '12mb',
    },
  },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  try {
    const body = req.body as { image_base64?: string; mime_type?: string } | undefined;
    const raw = body?.image_base64 ?? '';
    const idx = raw.indexOf(',');
    const imageBase64 = raw.startsWith('data:') && idx > 0 ? raw.slice(idx + 1) : raw;
    const mimeType = body?.mime_type ?? 'image/jpeg';

    if (!imageBase64) return badRequest(res, 'image_base64 is required');

    const result = await extractFromImage(imageBase64, mimeType);
    sendJson(res, 200, { extracted: result.extracted, raw: result.raw });
  } catch (err) {
    serverError(res, err);
  }
}
