// POST /api/screen-share-stop
//
// Body: { roomId: string }
//
// Completes the Twilio Video room so viewers drop instantly instead of
// seeing a frozen last-frame for ~30s while Twilio's UnusedRoomTimeout
// runs down. Broker's browser can also end cleanly by disconnecting
// the local Room handle, but this server-side completion is the belt-
// and-suspenders path — useful when the broker's tab crashes or they
// close the window without clicking Stop Sharing.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';
import { twilioClient } from './_lib/twilio.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  const body = (req.body ?? {}) as { roomId?: unknown };
  const roomId = typeof body.roomId === 'string' ? body.roomId.trim() : '';
  if (!roomId) return badRequest(res, 'roomId required');

  try {
    const client = twilioClient();
    try {
      await client.video.v1.rooms(roomId).update({ status: 'completed' });
    } catch (err) {
      const code = (err as { status?: number }).status;
      // Already-completed rooms (or 404) aren't failures — the intent
      // was "make sure this room is done," and it is.
      if (code === 404 || code === 400) return sendJson(res, 200, { ok: true, alreadyEnded: true });
      throw err;
    }
    return sendJson(res, 200, { ok: true, alreadyEnded: false });
  } catch (err) {
    return serverError(res, err);
  }
}
