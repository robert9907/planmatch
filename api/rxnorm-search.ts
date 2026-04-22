// GET /api/rxnorm-search — server-side proxy for the NLM RxNav API.
//
// Why a proxy when rxnav sends `access-control-allow-origin: *`?
//   1. Server-side logs for debugging type-ahead behavior.
//   2. Uniformity with /api/npi-search.
//   3. We fan out to TWO rxnav endpoints and merge — doing that in
//      the browser would double the request count the user sees.
//
// The bug we are fixing: rxnav's /drugs.json?name=X requires an
// (almost) exact drug name. Typing "gabapent" (mid-word) returns
// {"drugGroup":{"name":null}} with no conceptGroup at all. Only
// "gabapentin" (full word) returns data. So the front-end appeared
// broken — it was actually hitting an exact-match endpoint.
//
// Strategy:
//   Step 1 · /approximateTerm.json?term=<q>  → fuzzy/prefix candidates
//   Step 2 · for the top named candidate, /drugs.json?name=<name>
//           → full clinical drug tree (strengths, brand variants)
//   Step 3 · merge + dedupe by rxcui, sort: exact > prefix > SBD/SCD
//           > ingredient > other.
//
// Response: { drugs: RxNormDrug[], meta?: { approxCount, drugsName? } }

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { badRequest, cors, sendJson, serverError } from './_lib/http.js';

const RXNAV = 'https://rxnav.nlm.nih.gov/REST';
const TIMEOUT_MS = 10_000;
const APPROX_MAX = 20;

interface RxNormDrug {
  rxcui: string;
  name: string;
  synonym?: string;
  tty?: string;
}

interface ApproxCandidate {
  rxcui?: string;
  name?: string;
  score?: string;
  rank?: string;
  source?: string;
}

interface DrugConcept {
  rxcui?: string;
  name?: string;
  synonym?: string;
  tty?: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return badRequest(res, 'GET required');

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 2) return badRequest(res, 'q query param must be at least 2 characters');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const approxUrl = `${RXNAV}/approximateTerm.json?term=${encodeURIComponent(q)}&maxEntries=${APPROX_MAX}`;
    const approxRes = await fetch(approxUrl, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!approxRes.ok) {
      const body = await approxRes.text();
      console.log('[rxnorm-search] approxTerm failed', {
        status: approxRes.status,
        q,
        body: body.slice(0, 200),
      });
      return sendJson(res, 502, {
        error: `RxNav approximateTerm ${approxRes.status}`,
        detail: body.slice(0, 300),
      });
    }
    const approxBody = (await approxRes.json()) as {
      approximateGroup?: { candidate?: ApproxCandidate[] };
    };
    const candidates: ApproxCandidate[] = approxBody.approximateGroup?.candidate ?? [];

    const approxDrugs: RxNormDrug[] = [];
    const seen = new Set<string>();
    for (const c of candidates) {
      if (!c.rxcui || !c.name) continue;
      if (seen.has(c.rxcui)) continue;
      seen.add(c.rxcui);
      approxDrugs.push({ rxcui: String(c.rxcui), name: String(c.name) });
    }

    // Pick the top named candidate as the seed for /drugs.json — usually
    // this is the ingredient-level name (e.g. "Gabapentin") which unlocks
    // the full branded/strength tree in step 2.
    const topName = approxDrugs[0]?.name ?? null;
    let drugsName: string | null = null;
    let fullDrugs: RxNormDrug[] = [];
    if (topName) {
      const drugsUrl = `${RXNAV}/drugs.json?name=${encodeURIComponent(topName)}`;
      const drugsRes = await fetch(drugsUrl, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (drugsRes.ok) {
        drugsName = topName;
        const drugsBody = (await drugsRes.json()) as {
          drugGroup?: { conceptGroup?: { tty?: string; conceptProperties?: DrugConcept[] }[] };
        };
        const groups = drugsBody.drugGroup?.conceptGroup ?? [];
        for (const group of groups) {
          const tty = group?.tty;
          for (const c of group?.conceptProperties ?? []) {
            if (!c?.rxcui || !c?.name) continue;
            if (seen.has(String(c.rxcui))) continue;
            seen.add(String(c.rxcui));
            fullDrugs.push({
              rxcui: String(c.rxcui),
              name: String(c.name),
              synonym: c.synonym ? String(c.synonym) : undefined,
              tty: tty ? String(tty) : c.tty ? String(c.tty) : undefined,
            });
          }
        }
      } else {
        console.log('[rxnorm-search] drugs.json failed', {
          status: drugsRes.status,
          topName,
        });
      }
    }

    const merged = [...approxDrugs, ...fullDrugs];
    const ranked = rank(merged, q).slice(0, 25);

    console.log('[rxnorm-search]', {
      q,
      approxCount: candidates.length,
      drugsName,
      drugsCount: fullDrugs.length,
      returned: ranked.length,
    });

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    return sendJson(res, 200, {
      drugs: ranked,
      meta: { approxCount: candidates.length, drugsName },
    });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      return sendJson(res, 504, {
        error: 'RxNav upstream timed out',
        detail: `Exceeded ${TIMEOUT_MS} ms.`,
      });
    }
    return serverError(res, err);
  } finally {
    clearTimeout(timeout);
  }
}

function rank(drugs: RxNormDrug[], query: string): RxNormDrug[] {
  const lq = query.toLowerCase();
  const score = (d: RxNormDrug): number => {
    const n = d.name.toLowerCase();
    if (n === lq) return 0;
    if (n.startsWith(lq)) return 1;
    if (d.tty === 'SBD' || d.tty === 'SCD') return 2;
    if (d.tty === 'IN' || d.tty === 'MIN' || d.tty === 'PIN') return 3;
    if (d.tty === 'BN') return 4;
    if (n.includes(lq)) return 5;
    return 6;
  };
  return [...drugs].sort((a, b) => score(a) - score(b));
}
