// POST /api/hospital-quote-send — agent-v3 Hospital tab sends a hospital
// indemnity quote (Bankers Fidelity Vantage Flex Plus) on its own link.
//
// Broker-only (requireSession). Re-prices the benefits here with the same
// table the screen uses and REFUSES anything that isn't an exact BFLIC rate,
// so an estimated price can never reach a client even if the browser is
// tampered with. Then forwards a frozen snapshot to the consumer host's
// POST /api/product-quotes with the QUOTE_API_SECRET bearer (same pattern as
// api/quote-send.ts). The consumer saves it, sends the text/email, and serves
// the page at /hospital-quote/:id[/first-last].

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendJson } from './_lib/http.js';
import { requireSession } from './_lib/require-session.js';
import {
  BENEFIT_PERIODS,
  HOSPITAL_STATES,
  HOUSEHOLD_LABEL,
  OPTIONS,
  canSend,
  priceHospital,
  type HospitalBenefits,
  type Household,
} from './_lib/hospitalIndemnity.js';

const QUOTE_API_BASE = 'https://planmatch.generationhealth.me';
const MAX_BODY_BYTES = 16 * 1024;

function clean(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Keeps line breaks (the text message is multi-line); strips other control chars. */
function cleanMessage(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

const inList = (v: unknown, list: readonly number[]): v is number => typeof v === 'number' && list.includes(v);

function parseBenefits(raw: unknown): HospitalBenefits | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const bool = (k: string) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : null);
  const b = {
    adm: r.adm, daily: r.daily, period: r.period, air: r.air, gnd: r.gnd,
    icuA: bool('icuA'), icuD: bool('icuD'), osh: r.osh, maj: r.maj, inv: r.inv, min: r.min, hs: r.hs,
    rehab: r.rehab, snf: r.snf, nlt: bool('nlt'), lodge: bool('lodge'),
    maternity: bool('maternity'), mentalNervous: bool('mentalNervous'),
  };
  if (
    !inList(b.adm, OPTIONS.adm) || !inList(b.daily, OPTIONS.daily) || !inList(b.period, BENEFIT_PERIODS) ||
    !inList(b.air, OPTIONS.air) || !inList(b.gnd, OPTIONS.gnd) || !inList(b.osh, OPTIONS.osh) ||
    !inList(b.maj, OPTIONS.maj) || !inList(b.inv, OPTIONS.inv) || !inList(b.min, OPTIONS.min) ||
    !inList(b.hs, OPTIONS.hs) || !inList(b.rehab, [0, 15, 31]) || !inList(b.snf, OPTIONS.snf) ||
    b.icuA === null || b.icuD === null || b.nlt === null || b.lodge === null || b.maternity === null || b.mentalNervous === null
  ) return null;
  return b as HospitalBenefits;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST required' });
  if (await requireSession(req, res)) return;

  const secret = process.env.QUOTE_API_SECRET;
  if (!secret || secret.length < 32) {
    return sendJson(res, 503, { error: 'Quote sending is not configured (QUOTE_API_SECRET)' });
  }

  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? null);
  if (Buffer.byteLength(rawBody ?? '') > MAX_BODY_BYTES) return sendJson(res, 413, { error: 'Quote too large' });
  let body: Record<string, unknown> | null = null;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body as Record<string, unknown>); } catch { body = null; }
  if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'JSON body required' });

  const mode = body.mode === 'personal' ? 'personal' : body.mode === 'general' ? 'general' : null;
  if (!mode) return sendJson(res, 400, { error: 'mode must be personal or general' });
  const clientName = mode === 'personal' ? clean(body.clientName, 120) : '';
  if (mode === 'personal' && clientName.split(' ').filter(Boolean).length < 2) {
    return sendJson(res, 400, { error: 'A personal quote needs the client’s first and last name' });
  }
  const stateCode = clean(body.stateCode, 2).toUpperCase();
  if (!HOSPITAL_STATES.includes(stateCode as never)) return sendJson(res, 400, { error: 'State must be NC, TX or GA' });
  const age = Number(body.age);
  if (!Number.isInteger(age)) return sendJson(res, 400, { error: 'Age is required' });
  const household = (['ind', 'sp', 'ch', 'fam'] as Household[]).find((h) => h === body.household);
  if (!household) return sendJson(res, 400, { error: 'Unknown household tier' });
  const benefits = parseBenefits(body.benefits);
  if (!benefits) return sendJson(res, 400, { error: 'Benefits are outside the Vantage Flex Plus options' });
  if (benefits.maternity && stateCode !== 'NC') return sendJson(res, 400, { error: 'Maternity is North Carolina only' });

  const price = priceHospital(benefits, age, household);
  const check = canSend(price, age, stateCode);
  if (!check.ok) return sendJson(res, 422, { error: check.reason ?? 'Quote can’t be sent' });

  const zip = clean(body.zip, 5);
  const payload = {
    product: 'hospital_indemnity',
    mode,
    clientName: clientName || null,
    clientPhone: clean(body.clientPhone, 20) || null,
    clientEmail: clean(body.clientEmail, 200) || null,
    send: {
      sms: (body.send as { sms?: unknown } | undefined)?.sms === true,
      email: (body.send as { email?: unknown } | undefined)?.email === true,
    },
    stateCode,
    zip: /^\d{5}$/.test(zip) ? zip : null,
    message: cleanMessage(body.message, 600) || null,
    agentName: 'Rob Simm',
    agentPhone: '(828) 761-3326',
    agentNpn: '10447418',
    snapshot: {
      carrier: 'Bankers Fidelity Life Insurance Company',
      planName: 'Vantage Flex Plus',
      policyForm: 'HI21BFLIC',
      age,
      household,
      householdLabel: HOUSEHOLD_LABEL[household],
      monthlyPremium: price.total,
      rateBasis: 'bflic_exact',
      benefits,
    },
  };

  try {
    const upstream = await fetch(`${QUOTE_API_BASE}/api/product-quotes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify(payload),
    });
    const text = await upstream.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = { error: `Quote service returned ${upstream.status}` }; }
    return sendJson(res, upstream.status, data);
  } catch (err) {
    console.error('[api/hospital-quote-send] upstream failed:', err);
    return sendJson(res, 502, { error: 'Could not reach the quote service' });
  }
}
