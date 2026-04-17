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
