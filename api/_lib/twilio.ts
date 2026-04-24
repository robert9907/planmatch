import Twilio from 'twilio';

let cached: ReturnType<typeof Twilio> | null = null;

function twilio() {
  if (cached) return cached;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set');
  cached = Twilio(sid, token);
  return cached;
}

export function twilioClient() {
  return twilio();
}

function fromNumber(): string {
  const n = process.env.TWILIO_PHONE_NUMBER;
  if (!n) throw new Error('TWILIO_PHONE_NUMBER must be set');
  return n;
}

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits.startsWith('+') ? digits : `+${digits}`;
}

export async function sendCaptureSms(params: {
  to: string;
  clientFirstName: string;
  link: string;
}): Promise<{ sid: string }> {
  const greeting = params.clientFirstName ? `Hi ${params.clientFirstName}! ` : 'Hi! ';
  const body =
    `${greeting}Rob Simm (Generation Health) asked you to photograph your medication bottles. ` +
    `Tap the link and follow the prompts — it only takes a minute:\n${params.link}\n\n` +
    `This link expires in 24 hours. Reply STOP to opt out.`;

  const msg = await twilio().messages.create({
    to: normalizePhone(params.to),
    from: fromNumber(),
    body,
  });
  return { sid: msg.sid };
}

// Raw SMS helper so callers that aren't the photo-capture flow can send
// their own body without inheriting the capture copy. Used by the
// screen-share feature to drop a "your broker is sharing their screen"
// link to the client.
export async function sendSms(params: { to: string; body: string }): Promise<{ sid: string }> {
  const msg = await twilio().messages.create({
    to: normalizePhone(params.to),
    from: fromNumber(),
    body: params.body,
  });
  return { sid: msg.sid };
}

// Mint a Twilio Video access token. Requires a Standard API Key
// (TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET) — the account auth token
// alone cannot sign Video grants. Identity is whatever the caller
// wants; we use "broker" for Rob and "viewer" for the client so the
// server-side participant callbacks can distinguish them.
export function mintVideoToken(params: {
  identity: string;
  roomName: string;
  ttlSeconds?: number;
}): string {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKey = process.env.TWILIO_API_KEY_SID;
  const apiSecret = process.env.TWILIO_API_KEY_SECRET;
  if (!accountSid || !apiKey || !apiSecret) {
    throw new Error(
      'TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, and TWILIO_API_KEY_SECRET must be set to mint Video tokens',
    );
  }
  const AccessToken = Twilio.jwt.AccessToken;
  const VideoGrant = AccessToken.VideoGrant;
  const token = new AccessToken(accountSid, apiKey, apiSecret, {
    identity: params.identity,
    ttl: params.ttlSeconds ?? 60 * 60, // 1h default
  });
  const grant = new VideoGrant({ room: params.roomName });
  token.addGrant(grant);
  return token.toJwt();
}
