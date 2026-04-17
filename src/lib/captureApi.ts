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

export function itemLabel(item: CaptureItem): string {
  if (item.extracted.length === 0) return 'Unreadable label';
  const first = item.extracted[0];
  if (first.type === 'medication') return first.drug_name || 'Medication';
  if (first.type === 'provider') return first.provider_name || 'Provider';
  return 'Unknown';
}
