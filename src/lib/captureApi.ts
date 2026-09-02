import type {
  CaptureItem,
  CapturePollResponse,
  CaptureStartResponse,
  CaptureSubmitResponse,
} from '@/types/capture';

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()) as T;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()) as T;
}

export function startCapture(input: {
  client_name?: string;
  client_phone: string;
  started_by?: string;
  send_sms?: boolean;
  /** Agent-v3 session id — opt-in so the row in capture_sessions can
   *  be reconciled back to the quoting session that asked for it. */
  agent_session_id?: string;
  /** Pick the SMS body copy: 'capture' is the original async flow,
   *  'snap' is the mid-call Snap-to-Session variant. Defaults to
   *  'capture' on the server when omitted. */
  sms_variant?: 'capture' | 'snap';
}): Promise<CaptureStartResponse> {
  return postJson('/api/capture-start', input);
}

export function pollCapture(token: string, since?: string): Promise<CapturePollResponse> {
  const params = new URLSearchParams({ token });
  if (since) params.set('since', since);
  return getJson(`/api/capture-poll?${params.toString()}`);
}

export function submitCapture(input: {
  token: string;
  image_base64: string;
  mime_type: string;
}): Promise<CaptureSubmitResponse> {
  return postJson('/api/capture-submit', input);
}

export async function fileToBase64(file: File): Promise<{ base64: string; mimeType: string }> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return { base64: btoa(binary), mimeType: file.type || 'image/jpeg' };
}

/** Long edge cap for uploads. A current phone shoots 4000px+; past ~1600
 *  the vision model gains nothing and the base64 payload triples. */
const MAX_UPLOAD_EDGE = 1600;

/** Re-encode whatever the phone handed over as a JPEG the vision API can
 *  actually read.
 *
 *  Two problems. iPhones set to High Efficiency hand back image/heic, and
 *  the server's normalizeMimeType() relabels any unknown type as
 *  image/jpeg — so HEIC bytes went up claiming to be a JPEG and the model
 *  could not decode them. Separately, a full-resolution photo is several
 *  megabytes of base64 over cellular for no accuracy gain.
 *
 *  Safari decodes HEIC natively, which is where these files come from. If
 *  anything in the decode fails, fall back to the raw bytes — no worse
 *  than the previous behaviour. */
export async function fileToJpegBase64(
  file: File,
): Promise<{ base64: string; mimeType: string }> {
  try {
    const bitmap = await createImageBitmap(file);
    const longEdge = Math.max(bitmap.width, bitmap.height);
    if (!longEdge) throw new Error('empty image');
    const scale = Math.min(1, MAX_UPLOAD_EDGE / longEdge);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const base64 = canvas.toDataURL('image/jpeg', 0.82).split(',')[1] ?? '';
    if (!base64) throw new Error('encode produced nothing');
    return { base64, mimeType: 'image/jpeg' };
  } catch {
    return fileToBase64(file);
  }
}

export function itemLabel(item: CaptureItem): string {
  if (item.extracted.length === 0) return 'Unreadable label';
  const first = item.extracted[0];
  if (first.type === 'medication') return first.drug_name || 'Medication';
  if (first.type === 'provider') return first.provider_name || 'Provider';
  return 'Unknown';
}
