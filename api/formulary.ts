// GET /api/formulary — per-(plan, rxcui) formulary lookup.
//
// Used by Step 3 Medications to render tier / copay / coinsurance for
// every added drug against every eligible plan, and by Step 5 to cut
// plans whose formulary lacks any of the client's medications.
//
// Query shapes:
//   /api/formulary?contract_plan_id=H1234_005&rxcui=105028
//       → { tier, copay, coinsurance, drug_name } | { tier: 'not_covered' }
//
//   /api/formulary?rxcuis=105028,6809,36567&contract_ids=H1234,H5253
//       → { rows: [{ contract_plan_id, rxcui, tier, copay, coinsurance }] }
//     Bulk lookup for the Step 5 funnel; the server does one query per
//     call instead of N calls from the browser.
//
// RXCUI expansion
//   The CMS landscape formulary file uses SCD/SBD-level rxcuis (specific
//   strength + dose form, e.g. 310431 = "gabapentin 300 MG Oral Capsule").
//   RxNorm search frequently returns the ingredient-level rxcui (IN, e.g.
//   25480 = "gabapentin") for a bare name query, which then misses every
//   row in pm_formulary. Before querying, expand each input rxcui to its
//   related SCD/SBD/GPCK/BPCK rxcuis via RxNorm's /related.json endpoint
//   and match on the union — keyed back to the original rxcui so the
//   client cache stays stable.
//
// Rows are grouped by (contract_id, plan_id, original_rxcui) and the
// best (lowest numeric, non-null) tier wins — if a plan covers any
// related form of the drug, the drug is considered on-formulary.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';
import { supabase } from './_lib/supabase.js';

interface FormularyRow {
  contract_id: string;
  plan_id: string;
  rxcui: string;
  drug_name: string | null;
  tier: number | null;
  copay: number | null;
  // Coinsurance in pm_formulary is stored as a fraction (0.20 = 20%).
  // pm_plan_benefits stores rx_tier coinsurance as a percent integer
  // (25 = 25%). Callers rendering a mixed UI must normalize to one or
  // the other — the Step 6 MedicationsSection does percent.
  coinsurance: number | null;
  prior_auth: boolean | null;
  step_therapy: boolean | null;
  quantity_limit: boolean | null;
}

const RXNAV = 'https://rxnav.nlm.nih.gov/REST';
// Clinical-drug tty set: SCD = semantic clinical drug, SBD = semantic
// branded drug, GPCK/BPCK = generic/branded pack. Covers every tty
// level that appears in the CMS landscape formulary file.
const CLINICAL_TTY = 'SCD+SBD+GPCK+BPCK';
// Ingredient tty set used by the tier-3 walk-up so one /related.json
// call returns both the clinical-drug siblings and the ingredient
// anchors we'd need for tier 3.
const RELATED_TTY = 'SCD+SBD+GPCK+BPCK+IN+MIN+PIN';
const RELATED_TIMEOUT_MS = 4_000;

// Fluid Compute re-uses function instances across requests, so this
// module-level cache amortizes RxNorm calls across the whole session
// (and often across sessions). Maps original rxcui → the full set of
// candidate rxcuis to query pm_formulary against, including itself.
const expansionCache = new Map<string, string[]>();

// Fetch helper wrapping the 4-second abort and JSON parse. Returns the
// set of rxcuis found under the requested tty filter (the input rxcui
// is never added here — the caller decides whether to include it).
async function relatedRxcuis(
  rxcui: string,
  tty: string,
): Promise<{ ok: boolean; byTty: Map<string, string[]> }> {
  const byTty = new Map<string, string[]>();
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), RELATED_TIMEOUT_MS);
  try {
    const url = `${RXNAV}/rxcui/${encodeURIComponent(rxcui)}/related.json?tty=${tty}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!res.ok) {
      console.log('[formulary] related.json failed', { rxcui, tty, status: res.status });
      return { ok: false, byTty };
    }
    const body = (await res.json()) as {
      relatedGroup?: {
        conceptGroup?: { tty?: string; conceptProperties?: { rxcui?: string }[] }[];
      };
    };
    for (const g of body.relatedGroup?.conceptGroup ?? []) {
      const bucket = g.tty ?? 'UNKNOWN';
      const list = byTty.get(bucket) ?? [];
      for (const c of g.conceptProperties ?? []) {
        if (c?.rxcui) list.push(String(c.rxcui));
      }
      if (list.length > 0) byTty.set(bucket, list);
    }
    return { ok: true, byTty };
  } catch (err) {
    console.log('[formulary] related.json error', {
      rxcui,
      tty,
      err: (err as Error).message,
    });
    return { ok: false, byTty };
  } finally {
    clearTimeout(timeout);
  }
}

// Three-tier rxcui expansion driving the pm_formulary candidate set.
//
// Tier 1: self. `pm_formulary` is keyed on strength-level rxcuis, so if
//   the user's rxcui is already a SCD/SBD/GPCK/BPCK row, this hits.
// Tier 2: direct /related.json expansion with tty=SCD+SBD+GPCK+BPCK+
//   IN+MIN+PIN. Adds sibling clinical drugs (e.g. SBD Jardiance 25 MG
//   → SCD generic empagliflozin 25 MG) plus captures the ingredient
//   rxcuis we need for tier 3.
// Tier 3: for each ingredient found in tier 2, re-run /related.json
//   with tty=SCD+SBD+GPCK+BPCK to pick up EVERY clinical drug under
//   that ingredient. This catches non-strength starting points (BN
//   "Jardiance", IN "empagliflozin", SBDF "empagliflozin Oral Tablet
//   [Jardiance]"), which the previous expansion missed because
//   related.json on a BN doesn't always surface every SBD.
//
// pickBestRow still prefers the exact user rxcui when rows exist for it
// — the broader tier-3 set is only consulted when nothing tighter
// matches, so the "covered / not covered" badge stays honest.
async function expandRxcui(rxcui: string): Promise<string[]> {
  const cached = expansionCache.get(rxcui);
  if (cached) return cached;

  const candidates = new Set<string>([rxcui]);
  const ingredients = new Set<string>();

  // Tier 2.
  const tier2 = await relatedRxcuis(rxcui, RELATED_TTY);
  if (tier2.ok) {
    for (const [tty, list] of tier2.byTty) {
      if (tty === 'IN' || tty === 'MIN' || tty === 'PIN') {
        for (const r of list) ingredients.add(r);
      } else {
        for (const r of list) candidates.add(r);
      }
    }
  }

  // Tier 3 — walk each ingredient back down to every clinical drug.
  // Runs in parallel because each call is independent. Kept behind the
  // tier-2 succeeded check so a transient RxNav failure can be retried
  // on the next request rather than cached as a narrow expansion.
  let tier3Ok = true;
  if (tier2.ok && ingredients.size > 0) {
    const tier3Results = await Promise.all(
      [...ingredients].map((ing) => relatedRxcuis(ing, CLINICAL_TTY)),
    );
    for (const r of tier3Results) {
      if (!r.ok) {
        tier3Ok = false;
        continue;
      }
      for (const list of r.byTty.values()) {
        for (const rx of list) candidates.add(rx);
      }
    }
  }

  const list = [...candidates];
  // Memoize only when every RxNav call succeeded. A partial expansion
  // (one tier-3 ingredient failed, or tier 2 itself failed) would
  // permanently narrow the candidate set for this Fluid Compute
  // instance; leaving it uncached lets the next request retry.
  if (tier2.ok && tier3Ok) expansionCache.set(rxcui, list);
  return list;
}

// Rows get a score triple we compare lexically: (isExact, isCombo,
// tier). Lower wins on every axis. Exact-match always beats any
// sibling — the caller asked about rxcui X, so if pm_formulary has a
// row with rxcui X for this plan, that row is the answer regardless of
// tier. Within non-exact rows we exclude combinations (HCTZ/lisinopril
// and amlodipine/atorvastatin combos share an ingredient with the
// query but are different drugs) by giving them the highest isCombo
// penalty, then fall back to lowest tier.
//
// The combo penalty only applies when the user's queried drug itself
// isn't a combination. For a query like hydrocodone/APAP 856903 — a
// drug that is BY DEFINITION a combo — every real match will have a
// combo name and suppressing them would force "not covered". The
// suppressCombos flag lets the caller opt out when appropriate.
interface ScoredRow {
  row: FormularyRow;
  isExact: boolean;
  isCombo: boolean;
}

function isComboName(name: string | null): boolean {
  return typeof name === 'string' && / \/ /.test(name);
}

// Combo-drug detection on the queried rxcui. Hits RxNav's property
// endpoint once per rxcui and caches the answer across requests (Fluid
// Compute instance reuse). A failed fetch returns false without
// caching so the next request can retry rather than living with a
// stale "not a combo" verdict.
const comboCache = new Map<string, boolean>();

async function isCombinationRxcui(rxcui: string): Promise<boolean> {
  const cached = comboCache.get(rxcui);
  if (cached !== undefined) return cached;
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), RELATED_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${RXNAV}/rxcui/${encodeURIComponent(rxcui)}/property.json?propName=RxNorm%20Name`,
      { headers: { Accept: 'application/json' }, signal: ctl.signal },
    );
    if (!res.ok) return false;
    const body = (await res.json()) as {
      propConceptGroup?: { propConcept?: { propValue?: string }[] };
    };
    const name = body.propConceptGroup?.propConcept?.[0]?.propValue ?? null;
    const combo = isComboName(name);
    comboCache.set(rxcui, combo);
    return combo;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function pickBestScored(
  current: ScoredRow | undefined,
  candidate: ScoredRow,
  suppressCombos: boolean,
): ScoredRow {
  if (!current) return candidate;

  if (current.isExact !== candidate.isExact) {
    return current.isExact ? current : candidate;
  }
  if (suppressCombos && current.isCombo !== candidate.isCombo) {
    return current.isCombo ? candidate : current;
  }
  const ct = current.row.tier;
  const nt = candidate.row.tier;
  if (ct == null && nt == null) return current;
  if (ct == null) return candidate;
  if (nt == null) return current;
  return nt < ct ? candidate : current;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');

  const contractPlanId =
    typeof req.query.contract_plan_id === 'string' ? req.query.contract_plan_id.trim() : '';
  const rxcui = typeof req.query.rxcui === 'string' ? req.query.rxcui.trim() : '';

  const rxcuisCsv = typeof req.query.rxcuis === 'string' ? req.query.rxcuis : '';
  const contractIdsCsv = typeof req.query.contract_ids === 'string' ? req.query.contract_ids : '';

  try {
    const sb = supabase();

    // ─── Bulk mode ──────────────────────────────────────────────────
    if (rxcuisCsv) {
      const originals = rxcuisCsv.split(',').map((s) => s.trim()).filter(Boolean);
      if (originals.length === 0) return sendJson(res, 200, { rows: [] });

      // Expansion and combo-classification run in parallel per original.
      // Combo classification is what decides whether the caller's final
      // filter should suppress combo siblings: a query on hydrocodone/
      // APAP itself is a combo, so suppressing combos would zero every
      // plan's coverage.
      const [expansions, comboFlags] = await Promise.all([
        Promise.all(originals.map(expandRxcui)),
        Promise.all(originals.map(isCombinationRxcui)),
      ]);
      const suppressByOriginal = new Map<string, boolean>();
      for (let i = 0; i < originals.length; i++) {
        suppressByOriginal.set(originals[i], !comboFlags[i]);
      }
      const candidateToOriginals = new Map<string, Set<string>>();
      for (let i = 0; i < originals.length; i++) {
        const original = originals[i];
        for (const candidate of expansions[i]) {
          let set = candidateToOriginals.get(candidate);
          if (!set) {
            set = new Set<string>();
            candidateToOriginals.set(candidate, set);
          }
          set.add(original);
        }
      }
      const allCandidates = [...candidateToOriginals.keys()];
      const contractIds = contractIdsCsv
        ? contractIdsCsv.split(',').map((s) => s.trim()).filter(Boolean)
        : [];

      // PostgREST on Supabase-hosted projects enforces a server-side
      // max-rows=1000 cap per response. Our `.limit(...)` is silently
      // trimmed when it would exceed it. A single bulk query across all
      // contracts routinely returns thousands of rows for common drugs
      // (metformin 861007 × 13 contracts × many plans) and the trimmed
      // tail drops exact-match rows that the client then renders as
      // "Not on formulary."
      //
      // Fan out per (rxcui-chunk × contract_id). Each chunk targets a
      // single contract, so max rows = CHUNK × plans_in_contract.
      // Humana (H1036) has ~40 NC plans, so CHUNK=20 guarantees
      // ≤ 800 rows per chunk — well below 1000 even if every rxcui in
      // the chunk is on every plan. Belt-and-suspenders: if a chunk
      // response hits exactly 1000, page the tail with Range until we
      // exhaust it.
      const CHUNK = 20;
      const queryContracts = contractIds.length > 0 ? contractIds : [null];
      const rxChunks: string[][] = [];
      for (let i = 0; i < allCandidates.length; i += CHUNK) {
        rxChunks.push(allCandidates.slice(i, i + CHUNK));
      }
      async function fetchChunk(rxChunk: string[], cid: string | null): Promise<FormularyRow[]> {
        const out: FormularyRow[] = [];
        let from = 0;
        const PAGE = 1000;
        while (true) {
          let q = sb
            .from('pm_formulary')
            .select(
              'contract_id, plan_id, rxcui, drug_name, tier, copay, coinsurance, prior_auth, step_therapy, quantity_limit',
            )
            .in('rxcui', rxChunk)
            .range(from, from + PAGE - 1);
          if (cid) q = q.eq('contract_id', cid);
          const { data: page, error } = await q;
          if (error) throw error;
          if (!page || page.length === 0) break;
          for (const r of page as FormularyRow[]) out.push(r);
          if (page.length < PAGE) break;
          from += PAGE;
        }
        return out;
      }
      const chunkResults = await Promise.all(
        rxChunks.flatMap((rxChunk) => queryContracts.map((cid) => fetchChunk(rxChunk, cid))),
      );
      const data: FormularyRow[] = [];
      for (const rows of chunkResults) for (const r of rows) data.push(r);

      // Collapse (contract_id, plan_id, original_rxcui) → best row. Each
      // cell is keyed per original so its own suppressCombos setting
      // applies during the pickBestScored comparison.
      type CellKey = string;
      const cellOriginal = new Map<CellKey, string>();
      const best = new Map<CellKey, ScoredRow>();
      for (const r of data) {
        const originalsForRow = candidateToOriginals.get(r.rxcui);
        if (!originalsForRow) continue;
        const combo = isComboName(r.drug_name);
        for (const original of originalsForRow) {
          const key = `${r.contract_id}_${r.plan_id}::${original}`;
          cellOriginal.set(key, original);
          const scored: ScoredRow = {
            row: { ...r, rxcui: original },
            isExact: r.rxcui === original,
            isCombo: combo,
          };
          const suppress = suppressByOriginal.get(original) ?? true;
          best.set(key, pickBestScored(best.get(key), scored, suppress));
        }
      }
      const rows: {
        contract_plan_id: string;
        rxcui: string;
        tier: number | null;
        copay: number | null;
        coinsurance: number | null;
        drug_name: string | null;
        prior_auth: boolean;
        step_therapy: boolean;
        quantity_limit: boolean;
      }[] = [];
      for (const [key, s] of best) {
        const original = cellOriginal.get(key);
        const suppress = suppressByOriginal.get(original ?? '') ?? true;
        // Suppress combo-only sibling hits so a plan covering the wrong
        // drug (HCTZ/lisinopril vs. plain lisinopril) doesn't render as
        // covered. When the query is itself a combo drug, every match
        // legitimately has a combo drug_name and suppression is off.
        if (suppress && !s.isExact && s.isCombo) continue;
        const r = s.row;
        rows.push({
          contract_plan_id: `${r.contract_id}_${r.plan_id}`,
          rxcui: r.rxcui,
          tier: r.tier,
          copay: r.copay,
          coinsurance: r.coinsurance,
          drug_name: r.drug_name,
          prior_auth: r.prior_auth === true,
          step_therapy: r.step_therapy === true,
          quantity_limit: r.quantity_limit === true,
        });
      }
      res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=120');
      return sendJson(res, 200, { rows });
    }

    // ─── Single lookup ──────────────────────────────────────────────
    if (!contractPlanId) return badRequest(res, 'contract_plan_id or rxcuis required');
    if (!rxcui) return badRequest(res, 'rxcui required');

    const [contractId, planId] = contractPlanId.split('_');
    if (!contractId || !planId) {
      return badRequest(res, 'contract_plan_id must be "<contract_id>_<plan_id>"');
    }

    // Expand + classify the query's combo status in parallel.
    const [candidates, queryIsCombo] = await Promise.all([
      expandRxcui(rxcui),
      isCombinationRxcui(rxcui),
    ]);
    const suppressCombos = !queryIsCombo;

    // Single lookup is bounded to one (contract, plan) pair so the
    // 1000-row cap isn't reachable here, but we still chunk the rxcui
    // list to keep URLs short and mirror the bulk path's ergonomics.
    const CHUNK = 150;
    const chunkResults = await Promise.all(
      Array.from({ length: Math.ceil(candidates.length / CHUNK) }, (_, i) => {
        const chunk = candidates.slice(i * CHUNK, (i + 1) * CHUNK);
        return sb
          .from('pm_formulary')
          .select(
            'drug_name, tier, copay, coinsurance, rxcui, prior_auth, step_therapy, quantity_limit',
          )
          .eq('contract_id', contractId)
          .eq('plan_id', planId)
          .in('rxcui', chunk)
          .range(0, chunk.length - 1);
      }),
    );
    const data: FormularyRow[] = [];
    for (const res of chunkResults) {
      if (res.error) throw res.error;
      if (res.data) for (const r of res.data as FormularyRow[]) data.push(r);
    }

    if (data.length === 0) {
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
      return sendJson(res, 200, { tier: 'not_covered' });
    }

    let best: ScoredRow | undefined;
    for (const r of data) {
      const scored: ScoredRow = {
        row: r,
        isExact: r.rxcui === rxcui,
        isCombo: isComboName(r.drug_name),
      };
      best = pickBestScored(best, scored, suppressCombos);
    }

    // Suppress combo-only sibling hits unless the query is itself a
    // combo drug. An exact match always passes; a combo-drug query
    // (hydrocodone/APAP, amlodipine/benazepril) accepts combo siblings
    // because by definition every valid match has a combo drug_name.
    if (!best || (suppressCombos && !best.isExact && best.isCombo)) {
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
      return sendJson(res, 200, { tier: 'not_covered' });
    }

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    return sendJson(res, 200, {
      tier: best.row.tier ?? 'not_covered',
      copay: best.row.copay ?? null,
      coinsurance: best.row.coinsurance ?? null,
      drug_name: best.row.drug_name ?? null,
      prior_auth: best.row.prior_auth === true,
      step_therapy: best.row.step_therapy === true,
      quantity_limit: best.row.quantity_limit === true,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
