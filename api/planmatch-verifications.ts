// Provider Verification Queue — agent-side bridge to
// plan-match-prod.provider_verifications.
//
// GET    /api/planmatch-verifications                  → queue (unverified + researching)
// GET    /api/planmatch-verifications?session_id=…     → rows for one session
// PATCH  /api/planmatch-verifications { id, status, in_network_carriers? }
//
// Statuses: 'unverified' | 'researching' | 'verified'.
//   unverified  — consumer submitted on the widget, Rob hasn't opened
//   researching — Rob opened the row in the drawer
//   verified    — Rob ticked carrier checkboxes and saved
//
// in_network_carriers is an array of CMS contract IDs (e.g. ['H5619',
// 'H1036']) and is required when transitioning to 'verified'. These
// contracts feed the consumer widget's rankTop3Live boost so plans
// whose contract_id appears in every provider's list rank higher on
// the "Strongest Match" ribbon.
//
// This endpoint replaces the one that used to live in AgentBase CRM.
// AgentBase still exposes a read-only GET + its own PATCH for CRM-side
// observability; the agent-tool queue UI calls this (own-origin).

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from './_lib/supabase.js';

const VALID_STATUSES = new Set(['unverified', 'researching', 'verified']);
const QUEUE_STATUSES = ['unverified', 'researching'];

function setCors(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') return await handleGet(req, res);
    if (req.method === 'PATCH') return await handlePatch(req, res);
    return res.status(405).json({ error: 'GET or PATCH required' });
  } catch (err) {
    console.error('[planmatch-verifications] fatal:', err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}

async function handleGet(req: VercelRequest, res: VercelResponse) {
  const sessionId = typeof req.query.session_id === 'string'
    ? req.query.session_id.trim()
    : '';

  let query = supabase()
    .from('provider_verifications')
    .select('*')
    .order('created_at', { ascending: false });

  if (sessionId) {
    query = query.eq('session_id', sessionId);
  } else {
    // Queue view: only rows Rob still owes action on.
    query = query.in('status', QUEUE_STATUSES).limit(100);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[planmatch-verifications GET]', error);
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({
    verifications: data ?? [],
    count: (data ?? []).length,
  });
}

async function handlePatch(req: VercelRequest, res: VercelResponse) {
  const body = (req.body ?? {}) as {
    id?: number | string;
    status?: string;
    in_network_carriers?: unknown;
  };
  const id = body.id;
  const status = body.status;

  if (id == null) return res.status(400).json({ error: 'id required' });
  if (typeof status !== 'string' || !VALID_STATUSES.has(status)) {
    return res.status(400).json({
      error: `status must be one of ${[...VALID_STATUSES].join(', ')}`,
    });
  }

  // Contract-ID shape guard: letters + digits (e.g. "H1036", "S4802").
  // Keeps free-text like "Humana HMO" from corrupting the rank-boost
  // match set on the consumer widget.
  let carriers: string[] | null = null;
  if (Array.isArray(body.in_network_carriers)) {
    carriers = Array.from(
      new Set(
        body.in_network_carriers
          .map((c) => (typeof c === 'string' ? c.trim().toUpperCase() : ''))
          .filter((c) => /^[A-Z]\d{3,5}$/.test(c)),
      ),
    );
  }
  if (status === 'verified' && (!carriers || carriers.length === 0)) {
    return res.status(400).json({
      error: 'in_network_carriers (non-empty array of contract IDs) required when status=verified',
    });
  }

  const update: Record<string, unknown> = {
    status,
    // Terminal-only stamps so the CRM-side GET can show Rob's response
    // time without recomputing from realtime events. Clear them when
    // walking status back (edits).
    verified_by: status === 'verified' ? 'rob' : null,
    verified_at: status === 'verified' ? new Date().toISOString() : null,
  };
  if (carriers !== null) update.in_network_carriers = carriers;
  if (status !== 'verified' && carriers === null) {
    update.in_network_carriers = [];
  }

  const { data, error } = await supabase()
    .from('provider_verifications')
    .update(update)
    .eq('id', id)
    .select('*')
    .single();

  if (error) {
    console.error('[planmatch-verifications PATCH]', error);
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({ ok: true, verification: data });
}
