import { put } from '@vercel/blob';

export async function storeCaptureImage(params: {
  token: string;
  itemId: string;
  data: Buffer;
  mimeType: string;
}): Promise<{ url: string }> {
  const ext = mimeToExt(params.mimeType);
  const key = `captures/${params.token}/${params.itemId}${ext}`;
  const blob = await put(key, params.data, {
    access: 'public',
    contentType: params.mimeType,
    addRandomSuffix: false,
    allowOverwrite: false,
  });
  return { url: blob.url };
}

function mimeToExt(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower === 'image/jpeg' || lower === 'image/jpg') return '.jpg';
  if (lower === 'image/png') return '.png';
  if (lower === 'image/webp') return '.webp';
  if (lower === 'image/gif') return '.gif';
  return '.bin';
}
