// POST /api/screen-share-start
//
// Body: { clientPhone: string, clientFirstName?: string, brokerName?: string }
//
// Creates a short-lived Twilio Video group room, texts the client a
// /watch/{roomId} link, and returns { roomId, roomSid, brokerToken }
// so the broker's browser can join and publish its getDisplayMedia
// track.
//
// The room is created with EmptyRoomTimeout=5 and
// UnusedRoomTimeout=5 so Twilio garbage-collects it within 5 minutes
// of the last participant dropping — prevents abandoned rooms from
// accumulating. The front-end also owns a 30-minute idle kill-switch.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';
import { mintVideoToken, sendSms, twilioClient, normalizePhone } from './_lib/twilio.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return badRequest(res, 'POST required');

  const body = (req.body ?? {}) as {
    clientPhone?: unknown;
    clientFirstName?: unknown;
    brokerName?: unknown;
  };
  const clientPhone = typeof body.clientPhone === 'string' ? body.clientPhone.trim() : '';
  const clientFirstName =
    typeof body.clientFirstName === 'string' ? body.clientFirstName.trim() : '';
  const brokerName = typeof body.brokerName === 'string' ? body.brokerName.trim() : 'your broker';
  if (!clientPhone) return badRequest(res, 'clientPhone required');

  try {
    // Unique room id — short and URL-safe; the client pastes it via the
    // /watch/{roomId} link so readability matters more than entropy.
    const roomId = `pm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const client = twilioClient();
    const room = await client.video.v1.rooms.create({
      uniqueName: roomId,
      type: 'go', // free WebRTC Go tier — 1:1 + 1 publisher + N viewers fits within
      // Go tier allows up to 2 participants per room. That's broker + one
      // client on their phone — the exact shape of this flow. If a
      // household wants multiple viewers, switch to type: 'group' once
      // the account plan supports it.
      emptyRoomTimeout: 5,
      unusedRoomTimeout: 5,
    });

    const brokerToken = mintVideoToken({
      identity: 'broker',
      roomName: roomId,
      ttlSeconds: 60 * 60,
    });

    // SMS the client with the viewer link. Origin is derived from the
    // request so preview deploys text their own preview URL, not prod.
    const origin =
      typeof req.headers['x-forwarded-host'] === 'string'
        ? `https://${req.headers['x-forwarded-host']}`
        : typeof req.headers.host === 'string'
          ? `https://${req.headers.host}`
          : 'https://planmatch.vercel.app';
    const link = `${origin}/watch/${roomId}`;
    const greeting = clientFirstName ? `Hi ${clientFirstName}! ` : 'Hi! ';
    const smsBody =
      `${greeting}${brokerName} is sharing their screen so you can follow along. ` +
      `Tap to view: ${link}\n\nThis link works for the next hour. Reply STOP to opt out.`;
    try {
      await sendSms({ to: normalizePhone(clientPhone), body: smsBody });
    } catch (smsErr) {
      // SMS failure shouldn't block the share — the broker can read the
      // link aloud. Tag the response so the UI can surface a warning.
      return sendJson(res, 200, {
        roomId,
        roomSid: room.sid,
        brokerToken,
        smsFailed: true,
        smsError: (smsErr as Error).message,
        link,
      });
    }

    return sendJson(res, 200, {
      roomId,
      roomSid: room.sid,
      brokerToken,
      smsFailed: false,
      link,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
