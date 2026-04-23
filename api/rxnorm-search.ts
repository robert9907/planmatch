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
//   Step 3 · merge + dedupe by rxcui, sort so that specific-strength
//           tablet/capsule concepts come first — because those are the
//           only rxcuis the CMS formulary file actually indexes.
//
// Why the sort was rewritten: the previous ranker keyed on exact-name
// match, which floated ingredient-level (tty=IN) and approximateTerm
// form concepts ("atorvastatin Oral Suspension") to the top. A user
// picking "atorvastatin" got rxcui 83367 (ingredient) or 2631866
// (Atorvaliq SBDF, a niche branded suspension) — neither of which
// exists in pm_formulary. The badges rendered 0 / N covered even for
// common drugs. New order: SCD tablet/capsule > SBD tablet/capsule >
// other oral forms > ingredient/brand-name > dose-form/group > combos.
// Within a bucket, sort by strength ascending so "10 MG, 20 MG, 40 MG,
// 80 MG" surface in that order.
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

    // Merge by rxcui. A single rxcui can show up in both the approx
    // response (often with an abbreviated name like "GABAPENTIN 300MG
    // CAP" and no tty) and in /drugs.json (with the canonical name
    // "gabapentin 300 MG Oral Capsule" and tty=SCD). We key on rxcui and
    // upgrade the stored entry when drugs.json provides a typed version,
    // so the ranker can score on the real tty + form.
    const byRxcui = new Map<string, RxNormDrug>();
    for (const c of candidates) {
      if (!c.rxcui || !c.name) continue;
      const rxcui = String(c.rxcui);
      if (byRxcui.has(rxcui)) continue;
      byRxcui.set(rxcui, { rxcui, name: String(c.name) });
    }
    const approxDrugs = [...byRxcui.values()];

    // Resolve an INGREDIENT name to use as the seed for /drugs.json.
    // Anchoring on approxDrugs[0].name directly breaks badly when the
    // top approx result is a combination product or a strength-shaped
    // form: "metformin 500 MG" → approx top "EMPAGLIFLOZIN 5MG/METFORMIN
    // 500MG TAB" (Synjardy) → /drugs.json returns Synjardy's tree, not
    // metformin's. Walking to the ingredient first gives us the full
    // canonical drug tree every time, and rank() — with the strength
    // boost — still surfaces the user's intended strength.
    //
    // Fallback chain (first non-empty wins): walk the approx results
    // in order asking RxNav for each concept's IN/MIN, then if none
    // resolves (SCDC components like 316256 "metformin 500 MG" have
    // neither an IN nor a TTY), strip the trailing strength+unit from
    // the original query. That handles bare-ingredient searches
    // ("atorvastatin") as well as strength-qualified ones ("metformin
    // 500 MG" → "metformin").
    let ingredientName: string | null = null;
    for (const d of approxDrugs.slice(0, 5)) {
      ingredientName = await resolveIngredientName(d.rxcui, controller.signal);
      if (ingredientName) break;
    }
    const strippedQuery = q.replace(/\s*\d+(?:\.\d+)?\s*(?:MG|MCG|G|ML|%|IU)\b.*$/i, '').trim();
    const seedName =
      ingredientName ?? (strippedQuery && strippedQuery !== q ? strippedQuery : null) ?? approxDrugs[0]?.name ?? null;
    let drugsName: string | null = null;
    const fullDrugs: RxNormDrug[] = [];
    if (seedName) {
      const drugsUrl = `${RXNAV}/drugs.json?name=${encodeURIComponent(seedName)}`;
      const drugsRes = await fetch(drugsUrl, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (drugsRes.ok) {
        drugsName = seedName;
        const drugsBody = (await drugsRes.json()) as {
          drugGroup?: { conceptGroup?: { tty?: string; conceptProperties?: DrugConcept[] }[] };
        };
        const groups = drugsBody.drugGroup?.conceptGroup ?? [];
        for (const group of groups) {
          const tty = group?.tty;
          for (const c of group?.conceptProperties ?? []) {
            if (!c?.rxcui || !c?.name) continue;
            const rxcui = String(c.rxcui);
            const typed: RxNormDrug = {
              rxcui,
              name: String(c.name),
              synonym: c.synonym ? String(c.synonym) : undefined,
              tty: tty ? String(tty) : c.tty ? String(c.tty) : undefined,
            };
            // Upgrade: drugs.json carries the canonical name + tty.
            // Overwrite the approx entry so the ranker sees the tty
            // bucket and the real form (capsule/tablet/etc).
            byRxcui.set(rxcui, typed);
            fullDrugs.push(typed);
          }
        }
      } else {
        console.log('[rxnorm-search] drugs.json failed', {
          status: drugsRes.status,
          seedName,
        });
      }
    }

    const merged = [...byRxcui.values()];
    const ranked = rank(merged, q).slice(0, 40);

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

// Ingredient lookup — returns the ingredient (IN/MIN) name for a given
// rxcui so /drugs.json can anchor on the canonical drug tree instead of
// whatever idiosyncratic string the approxTerm endpoint returned first.
// Cached across invocations since the ingredient ↔ rxcui mapping is
// stable and Fluid Compute re-uses function instances.
const ingredientNameCache = new Map<string, string | null>();

async function resolveIngredientName(
  rxcui: string,
  signal: AbortSignal,
): Promise<string | null> {
  const cached = ingredientNameCache.get(rxcui);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(
      `${RXNAV}/rxcui/${encodeURIComponent(rxcui)}/related.json?tty=IN+MIN`,
      { headers: { Accept: 'application/json' }, signal },
    );
    if (!res.ok) {
      ingredientNameCache.set(rxcui, null);
      return null;
    }
    const body = (await res.json()) as {
      relatedGroup?: {
        conceptGroup?: { tty?: string; conceptProperties?: { name?: string }[] }[];
      };
    };
    const groups = body.relatedGroup?.conceptGroup ?? [];
    for (const g of groups) {
      for (const c of g.conceptProperties ?? []) {
        if (c?.name) {
          ingredientNameCache.set(rxcui, c.name);
          return c.name;
        }
      }
    }
    ingredientNameCache.set(rxcui, null);
    return null;
  } catch {
    // Don't cache transient errors so a subsequent request can retry.
    return null;
  }
}

// TTY bucket weight — lower is better. SCD (generic clinical drug) wins
// over SBD (branded) so a bare "atorvastatin" search lands on the
// generic 20 MG Oral Tablet, not on Lipitor 20 MG. Approximate-term
// concepts (tty=undefined) slot below SBD so they don't outrank the
// specific-strength forms returned by /drugs.json.
function ttyWeight(tty: string | undefined): number {
  switch (tty) {
    case 'SCD':
      return 10;
    case 'SBD':
      return 20;
    case 'GPCK':
      return 30;
    case 'BPCK':
      return 40;
    case 'IN':
    case 'MIN':
    case 'PIN':
      return 50;
    case 'BN':
      return 55;
    case 'SCDF':
    case 'SBDF':
    case 'SCDG':
    case 'SBDG':
    case 'DF':
    case 'DFG':
      return 60;
    default:
      return 70;
  }
}

// Form bucket — tablet/capsule are the overwhelmingly common oral forms
// and the ones most plans carry. Suspensions/solutions/liquids are
// niche branded variants (e.g. Atorvaliq for atorvastatin) that almost
// never appear on MA formularies, so they sort after tablet/capsule
// within the same tty bucket.
function formWeight(name: string): number {
  const n = name.toLowerCase();
  if (/\b(oral tablet|tablet|capsule|oral capsule)\b/.test(n)) return 0;
  if (/\bchewable tablet\b/.test(n)) return 1;
  if (/\b(sublingual|orally disintegrating|odt)\b/.test(n)) return 2;
  if (/\b(oral solution|oral suspension|oral liquid|syrup|elixir)\b/.test(n)) return 5;
  if (/\b(injection|injectable|injectable solution|prefilled syringe)\b/.test(n)) return 6;
  if (/\b(patch|cream|ointment|gel|spray|inhalation)\b/.test(n)) return 7;
  return 4;
}

// Parse the first "<number> MG" (or MG/ML, MCG, etc.) so 10 MG sorts
// before 20 MG before 40 MG within the same drug. Returns Infinity when
// no strength is present so strengthless concepts (ingredient, BN,
// dose-form) sink below specific-strength forms.
function strengthFor(name: string): number {
  const m = name.match(/(\d+(?:\.\d+)?)\s*(MG|MCG|G|ML|%)/i);
  if (!m) return Number.POSITIVE_INFINITY;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return Number.POSITIVE_INFINITY;
  const unit = m[2].toUpperCase();
  if (unit === 'MCG') return v / 1000;
  if (unit === 'G') return v * 1000;
  return v;
}

// Combination products ("amlodipine 10 MG / atorvastatin 10 MG Oral
// Tablet [Caduet]") have a slash separating ingredients. A user typing
// the base ingredient almost never wants the combo, so we demote them
// below single-ingredient concepts of the same form/strength.
function isCombination(name: string): boolean {
  return /\s\/\s/.test(name);
}

// Extended-release / sustained-release / delayed-release modifiers.
// Within the same tty+form+strength bucket, a search for "metformin
// 500 MG" should prefer the immediate-release 500 MG tablet over the
// "24 HR ... Extended Release" variant — the IR form is what most
// prescriptions default to and is the one that matches the widest set
// of formulary rows. Detected via the RxNorm name conventions: "24 HR",
// "12 HR", "Extended Release", "Modified", "Osmotic", "Sustained",
// "Delayed", "Once-Daily", and the bare -ER / -XR / -SR / -DR suffixes.
function isExtendedRelease(name: string): boolean {
  return /\b(\d+\s*HR|Extended Release|Sustained Release|Delayed Release|Modified|Osmotic|Once-Daily|ER|XR|SR|DR)\b/i.test(
    name,
  );
}

function rank(drugs: RxNormDrug[], query: string): RxNormDrug[] {
  const lq = query.toLowerCase();
  // When the user includes a strength in the query ("Jardiance 25 MG",
  // "Gabapentin 300 MG"), promote concepts with that exact strength
  // above other specific-strength concepts in the same tty+form bucket.
  // Without this, sort-by-strength-ascending surfaces the lowest dose
  // first and the user has to scroll past 100 / 200 / 300 MG to reach
  // what they typed.
  const qStrength = strengthFor(query);
  const hasQueryStrength = Number.isFinite(qStrength);

  return [...drugs].sort((a, b) => {
    const ca = isCombination(a.name) ? 1 : 0;
    const cb = isCombination(b.name) ? 1 : 0;
    if (ca !== cb) return ca - cb;

    const wa = ttyWeight(a.tty) + formWeight(a.name);
    const wb = ttyWeight(b.tty) + formWeight(b.name);
    if (wa !== wb) return wa - wb;

    if (hasQueryStrength) {
      const ma = strengthFor(a.name) === qStrength ? 0 : 1;
      const mb = strengthFor(b.name) === qStrength ? 0 : 1;
      if (ma !== mb) return ma - mb;
    }

    // Prefer immediate-release over extended-release within the same
    // tty+form+strength bucket. Applied after the strength-match check
    // so "metformin 500 MG ER" still beats "metformin 750 MG IR" when
    // the user typed "500 MG"; the ER penalty only sorts among ties.
    const ea = isExtendedRelease(a.name) ? 1 : 0;
    const eb = isExtendedRelease(b.name) ? 1 : 0;
    if (ea !== eb) return ea - eb;

    const sa = strengthFor(a.name);
    const sb = strengthFor(b.name);
    if (sa !== sb) return sa - sb;

    // Final tiebreaker: prefer a case-insensitive exact name match so
    // typing "jardiance" surfaces the BN concept first within its
    // (weaker) bucket, then alphabetical.
    const na = a.name.toLowerCase();
    const nb = b.name.toLowerCase();
    const exa = na === lq ? 0 : 1;
    const exb = nb === lq ? 0 : 1;
    if (exa !== exb) return exa - exb;
    return na.localeCompare(nb);
  });
}
