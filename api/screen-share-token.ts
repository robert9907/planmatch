// GET /api/screen-share-token?room=<roomId>
//
// Mints a read-only viewer access token for the client's browser when
// they open the /watch/{roomId} link. No auth — the roomId is the
// secret (unguessable base36 per share-start); treat it like a capture
// link token. Room must exist and still be in-progress; expired rooms
// return 410 so the /watch page can show a helpful "share ended"
// message instead of silently failing.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, notFound, sendJson, serverError } from './_lib/http.js';
import { mintVideoToken, twilioClient } from './_lib/twilio.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');

  const roomId = typeof req.query.room === 'string' ? req.query.room.trim() : '';
  if (!roomId) return badRequest(res, 'room required');
  if (!/^pm-[a-z0-9-]+$/i.test(roomId)) return badRequest(res, 'invalid room id');

  try {
    const client = twilioClient();
    let room;
    try {
      room = await client.video.v1.rooms(roomId).fetch();
    } catch (err) {
      const code = (err as { status?: number }).status;
      if (code === 404) return notFound(res, 'room not found');
      throw err;
    }
    if (room.status !== 'in-progress') {
      res.status(410).setHeader('Content-Type', 'application/json').send(
        JSON.stringify({ error: 'share ended', status: room.status }),
      );
      return;
    }
    // Viewer identity gets a small random suffix so Twilio doesn't
    // collapse two concurrent viewers into one participant entry.
    const identity = `viewer-${Math.random().toString(36).slice(2, 8)}`;
    const token = mintVideoToken({
      identity,
      roomName: roomId,
      ttlSeconds: 60 * 60,
    });
    return sendJson(res, 200, { token, identity, roomId });
  } catch (err) {
    return serverError(res, err);
  }
}
