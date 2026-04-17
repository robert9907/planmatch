import type { VercelRequest, VercelResponse } from '@vercel/node';

export function cors(req: VercelRequest, res: VercelResponse): boolean {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

export function sendJson(res: VercelResponse, status: number, body: unknown): void {
  res.status(status).setHeader('Content-Type', 'application/json').send(JSON.stringify(body));
}

export function badRequest(res: VercelResponse, message: string): void {
  sendJson(res, 400, { error: message });
}

export function notFound(res: VercelResponse, message = 'Not found'): void {
  sendJson(res, 404, { error: message });
}

export function serverError(res: VercelResponse, err: unknown): void {
  console.error('[api] error:', err);
  const obj = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
  const message =
    err instanceof Error
      ? err.message
      : typeof obj.message === 'string'
        ? obj.message
        : typeof err === 'string'
          ? err
          : 'Unknown error';
  const body: Record<string, unknown> = { error: message };
  if (typeof obj.code === 'string') body.code = obj.code;
  if (typeof obj.details === 'string') body.details = obj.details;
  if (typeof obj.hint === 'string') body.hint = obj.hint;
  sendJson(res, 500, body);
}
