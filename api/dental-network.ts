// /api/dental-network — dentist network status for the agent-v3 Dental quote.
//
//   GET  ?npi=1234567890  → { networks, verifications }   (npi optional)
//   POST { carrier, network, npi, dentist_name, practice_address?, status }
//        status: 'in_network' | 'not_in_network' | 'clear' (removes the check)
//
// No NC dental carrier publishes a usable machine-readable dentist directory
// for its individual plans, so network status is the broker's own check of
// the carrier's find-a-dentist page, recorded once per (carrier, network,
// NPI) and shown on every plan on that network. See
// supabase/migrations/008_pm_dental_network.sql.
//
// Broker-only (requireSession), same-origin (no CORS). Service-role reads
// and writes; the tables are RLS-on with no policies.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, sendJson, serverError } from './_lib/http.js';
import { requireSession } from './_lib/require-session.js';

type Status = 'in_network' | 'not_in_network';

interface NetworkRow {
  carrier: string;
  network: string;
  directory_url: string;
  directory_note: string | null;
}

const NPI_RE = /^\d{10}$/;
const VERIFICATION_COLUMNS = 'carrier,network,npi,dentist_name,practice_address,status,source,verified_at';

function env(): { base: string; key: string } {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('Supabase env not configured');
  return { base: url.replace(/\/$/, ''), key };
}

async function rest(path: string, init: RequestInit = {}): Promise<unknown> {
  const { base, key } = env();
  const r = await fetch(`${base}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function loadNetworks(): Promise<NetworkRow[]> {
  return (await rest('pm_dental_network?select=carrier,network,directory_url,directory_note&order=carrier.asc,network.asc')) as NetworkRow[];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (await requireSession(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      const npi = req.query.npi == null ? null : String(req.query.npi).trim();
      if (npi !== null && !NPI_RE.test(npi)) return badRequest(res, 'npi must be 10 digits');
      const networks = await loadNetworks();
      const verifications = npi
        ? await rest(`pm_dental_network_verification?select=${VERIFICATION_COLUMNS}&npi=eq.${npi}`)
        : [];
      return sendJson(res, 200, { networks, verifications });
    }

    if (req.method === 'POST') {
      const body = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body ?? {}) as Record<string, unknown>;
      const carrier = typeof body.carrier === 'string' ? body.carrier.trim() : '';
      const network = typeof body.network === 'string' ? body.network.trim() : '';
      const npi = typeof body.npi === 'string' ? body.npi.trim() : '';
      const status = body.status;
      if (!carrier || !network) return badRequest(res, 'carrier and network required');
      if (!NPI_RE.test(npi)) return badRequest(res, 'npi must be 10 digits');
      if (status !== 'in_network' && status !== 'not_in_network' && status !== 'clear') {
        return badRequest(res, "status must be 'in_network', 'not_in_network' or 'clear'");
      }

      const networks = await loadNetworks();
      if (!networks.some((n) => n.carrier === carrier && n.network === network)) {
        return badRequest(res, 'unknown carrier/network');
      }

      const match = `carrier=eq.${encodeURIComponent(carrier)}&network=eq.${encodeURIComponent(network)}&npi=eq.${npi}`;
      if (status === 'clear') {
        await rest(`pm_dental_network_verification?${match}`, { method: 'DELETE' });
        return sendJson(res, 200, { cleared: true });
      }

      const dentistName = typeof body.dentist_name === 'string' ? body.dentist_name.trim() : '';
      if (!dentistName) return badRequest(res, 'dentist_name required');
      const practiceAddress = typeof body.practice_address === 'string' && body.practice_address.trim()
        ? body.practice_address.trim()
        : null;

      const rows = (await rest(
        `pm_dental_network_verification?on_conflict=carrier,network,npi&select=${VERIFICATION_COLUMNS}`,
        {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify({
            carrier,
            network,
            npi,
            dentist_name: dentistName,
            practice_address: practiceAddress,
            status: status as Status,
            source: 'broker_verified',
            verified_at: new Date().toISOString(),
          }),
        },
      )) as unknown[];
      return sendJson(res, 200, { verification: rows[0] ?? null });
    }

    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { error: 'GET or POST required' });
  } catch (err) {
    return serverError(res, err);
  }
}
