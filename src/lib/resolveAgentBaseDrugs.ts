// resolveAgentBaseDrugs — batch RxNorm resolver for drugs hydrated from
// the AgentBase CRM. The CRM stores medications as free-text strings
// ("Atorvastatin Calcium TAB 20MG") because brokers type them straight
// into a lead form. Those raw strings never match /api/library/
// drug-search: the endpoint's search_text is lower(name || generic ||
// brand) without salt suffixes, dose forms, or strength embedded.
//
// This utility runs synchronously BEFORE the agent Meds screen sees
// the drugs, so the row lands with a real rxcui + canonical name +
// tier badge on first paint. Contrast with useResolveRxcuis, which
// fires reactively AFTER meds hit the store — that hook stays as a
// safety net for other paths (photo capture, manual re-entry), but
// the AgentBase deep-link now goes through the pre-resolve pass so
// there's no visible "No RxNorm match" flash while the async
// resolver catches up.
//
// The strength-from-name fallback is the critical addition vs.
// useResolveRxcuis: brokers rarely file a separate `dose` column, so
// the AgentBase row has the strength embedded in the name only.
// Without extracting "20MG" from the tail before calling pickBest,
// the resolver falls back to results[0] (typically the highest-dose
// SBD) and every row silently lands on the wrong strength.

import { searchDrug, type RxNormDrug } from './rxnorm';
import { buildNameVariants } from '@/hooks/useResolveRxcuis';
import { parseDrugRoute } from '../../api/_lib/formulary-sibling-match';

/** One strength on a label, normalized: amount in MG (or UNT) per unit.
 *  per 'each' = per tablet/capsule; 'ml' / 'g' / 'actuat' / 'hr' = ratio;
 *  'pct' = a percent written as mg per g/mL (0.01% → 0.1). */
export interface Strength {
  v: number;
  u: 'mg' | 'unt';
  per: 'each' | 'ml' | 'g' | 'mg' | 'actuat' | 'hr' | 'pct';
}

function amountToMg(n: number, unit: string): { v: number; u: 'mg' | 'unt' } {
  const x = unit.toLowerCase();
  if (x === 'mcg') return { v: n / 1000, u: 'mg' };
  if (x === 'g') return { v: n * 1000, u: 'mg' };
  if (x.startsWith('un')) return { v: n, u: 'unt' };
  return { v: n, u: 'mg' };
}

/** Every strength on a dose or RxNorm label. Handles "20MG", "50 mcg",
 *  "10 MG/ML", "5 mg/0.5 mL" (→ 10 per mL), "0.05 MG/ACTUAT", "0.01%",
 *  and unit-less combo doses "10-325" / "10/325" (→ 10 MG + 325 MG). */
export function parseStrengths(text: string, _comboHint = false): Strength[] {
  const t = text ?? '';
  const combo = t.match(/^\s*(\d*\.?\d+)\s*[-/]\s*(\d*\.?\d+)\s*(mg)?\s*$/i);
  if (combo) {
    return [
      { v: Number(combo[1]), u: 'mg', per: 'each' },
      { v: Number(combo[2]), u: 'mg', per: 'each' },
    ];
  }
  const out: Strength[] = [];
  let rest = t;
  const ratio = /(\d*\.?\d+)\s*(mg|mcg|g|unt|units?)\s*\/\s*(\d*\.?\d+)?\s*(ml|gm|g|mg|actuat|hr|h)\b/gi;
  rest = rest.replace(ratio, (_m, n, unit, denom, per) => {
    const a = amountToMg(Number(n), unit);
    const d = denom ? Number(denom) : 1;
    const p = per.toLowerCase();
    const perKey: Strength['per'] =
      p === 'ml' ? 'ml' : p === 'gm' || p === 'g' ? 'g' : p === 'mg' ? 'mg' : p === 'actuat' ? 'actuat' : 'hr';
    if (d > 0) out.push({ v: a.v / d, u: a.u, per: perKey });
    return ' ';
  });
  rest = rest.replace(/(\d*\.?\d+)\s*%/g, (_m, n) => {
    out.push({ v: Number(n) * 10, u: 'mg', per: 'pct' });
    return ' ';
  });
  for (const m of rest.matchAll(/(\d*\.?\d+)\s*(mg|mcg|g|unt|units?)\b/gi)) {
    const a = amountToMg(Number(m[1]), m[2]);
    out.push({ v: a.v, u: a.u, per: 'each' });
  }
  return out;
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(a), Math.abs(b));
}

function compatiblePer(target: Strength['per'], cand: Strength['per']): boolean {
  if (target === cand) return true;
  if (target === 'each' && cand === 'actuat') return true; // "50 mcg" per spray
  if (target === 'pct' && (cand === 'g' || cand === 'ml')) return true;
  return false;
}

/** True when every target strength appears on the candidate label. */
export function strengthsMatch(target: Strength[], cand: Strength[]): boolean {
  if (target.length === 0) return true;
  return target.every((t) => cand.some((c) => c.u === t.u && compatiblePer(t.per, c.per) && close(t.v, c.v)));
}

export interface AgentBaseDrugInput {
  /** CRM row primary key (client_medications.id). Optional — callers
   *  outside the AgentBase hydration path may not have one. Threaded
   *  through so the caller can persist the resolved rxcui back to the
   *  originating row without re-matching on free-text name. */
  id?: string;
  /** Free-text drug name as filed in AgentBase (raw broker input). */
  name: string;
  /** Separate dose column when the broker split it; often empty. */
  dose?: string | null;
  /** Dosage form column ("Tablet", "Capsule"); often empty. */
  form?: string | null;
  /** rxcui already resolved on a prior sync — short-circuits the
   *  library call so we don't re-fetch drugs that already round-tripped
   *  through the resolver. */
  rxcui?: string | null;
}

export interface ResolvedAgentBaseDrug {
  /** CRM row primary key echoed from the input, when supplied. Callers
   *  use it to persist the resolved rxcui back to the originating row. */
  id?: string;
  /** True when the input carried a non-null rxcui (already resolved
   *  server-side). Callers use this to skip writeback for rows that
   *  don't need it — the writeback path only targets originally-null
   *  rows anyway, but this saves the round trip. */
  hadInputRxcui: boolean;
  /** Raw AgentBase name preserved for display + re-search pre-fill. */
  originalName: string;
  /** Canonical name derived from the picked RxNorm concept, or the
   *  original when nothing matched. */
  canonicalName: string;
  /** Picked rxcui, or null when no variant matched. */
  rxcui: string | null;
  /** Strength in "20 MG" form — from the picked drug, else the input
   *  dose, else extracted from the name. */
  dose: string | null;
  /** Dose form in "Oral Tablet" form — from the picked drug, else the
   *  input form. */
  form: string | null;
  /** true when the library returned a match; false when we fell back
   *  to the original name. Drives the yellow "tap to re-search"
   *  warning on the Meds screen. */
  resolved: boolean;
  /** true only when the picked concept survived the strength filter in
   *  pickBestAgent (target strength was extractable AND at least one
   *  result matched it). False when the pick came from the full-results
   *  fallback (no strength match) or when no target strength was
   *  extractable. Persistence callers gate on this — a resolved-but-
   *  strength-mismatched pick keeps rendering in the session but does
   *  NOT get written to the client's permanent CRM row. Always true
   *  for the input.rxcui echo path (the CRM row already trusts it). */
  strengthMatched: boolean;
}

/** Extract a "20 MG" style strength from the tail of a free-text drug
 *  name. Handles both "20MG" (agentbase style, no space) and "20 mg"
 *  (broker paste from a script). Returns null when nothing parseable
 *  lands — callers fall through to a strength-less pickBest which
 *  returns the first search hit. */
export function extractStrengthFromName(name: string): string | null {
  const m = name.match(
    /(\d+(?:\.\d+)?)\s*(mg|mcg|g|ml|meq|units?|iu|%)\b/i,
  );
  if (!m) return null;
  const unit = m[2].toUpperCase();
  return `${m[1]} ${unit}`;
}

/** Normalize a strength string to the query form: "25mg" → "25 MG",
 *  "20MG" → "20 MG", "25 MG" → "25 MG". The library drug-search
 *  tokenizes on whitespace, so an un-spaced strength ("20MG") won't
 *  rank correct-strength rows into the top-5 window. Returns null
 *  when the input can't be parsed as a strength. */
function normalizeStrength(raw: string): string | null {
  const m = raw.match(
    /(\d+(?:\.\d+)?)\s*(mg|mcg|g|ml|meq|units?|iu|%)\b/i,
  );
  if (!m) return null;
  return `${m[1]} ${m[2].toUpperCase()}`;
}


/** Pick the best candidate from a search-result list, biased toward
 *  the monotherapy generic when the input doesn't reference a brand
 *  name.
 *
 *  Why the biasing: the shared library ranks RxNorm concepts by rxcui
 *  ascending, so brand-name SBDs (Keppra, Lopressor, Lipitor) surface
 *  ABOVE the generic SCD at the same strength. Without a nudge,
 *  pickBest lands on the branded row for every AgentBase entry —
 *  which then inflates the per-plan cost estimate (brand tiers 3-5
 *  vs generic tier 1). The nudge: when the input string doesn't
 *  contain the candidate's brand_name (case-insensitive), penalize
 *  the branded rxcui and prefer the generic. Ditto for combos — a
 *  bare-stem query surfaces same-strength combos ahead of the
 *  monotherapy for ingredients like hydrochlorothiazide, and no
 *  broker types "hydrochlorothiazide" meaning "hydrochlorothiazide
 *  25 MG / lisinopril 20 MG". */
interface PickedDrug {
  drug: RxNormDrug;
  /** True only when a target strength was extractable from the input
   *  AND at least one result matched it (i.e. the pick came from the
   *  strength-filtered pool, not the full-results fallback). Callers
   *  use this to gate persistence — a strength-mismatched pick still
   *  drives the in-memory session (better than "No RxNorm match" on
   *  the Meds screen) but should NOT be written to the client's
   *  permanent CRM row. Also false when the input carried no parseable
   *  strength — the pick is a guess relative to the intended row. */
  strengthMatched: boolean;
}

function pickBestAgent(
  results: RxNormDrug[],
  target: Strength[],
  rawInputName: string,
): PickedDrug | null {
  if (results.length === 0) return null;
  const inputLower = rawInputName.toLowerCase();

  // Filter to strength-matched rows when a target strength exists.
  // Falls back to the full result set when no candidate matches; the
  // caller rejects that fallback whenever a strength was filed.
  const filtered = target.length > 0
    ? results.filter((r) => strengthsMatch(target, parseStrengths(r.name)))
    : results;
  const strengthMatched = target.length > 0 && filtered.length > 0;
  const pool = filtered.length > 0 ? filtered : results;

  const scored = pool.map((r) => {
    const brand = r.brand_name?.trim() ?? '';
    const brandInInput = brand.length > 0 && inputLower.includes(brand.toLowerCase());
    const isBrand = brand.length > 0;
    const isCombo = /\s\/\s|\s\+\s/.test(r.name);
    return {
      r,
      // Lower score wins. Order:
      //   • combo: +200 (biggest penalty — combos are almost never
      //     the intended concept for a bare-ingredient query)
      //   • brand not referenced by input: +100
      //   • name length as a tiebreaker (shorter tends to be the
      //     canonical monotherapy)
      score:
        (isCombo ? 200 : 0) +
        (isBrand && !brandInInput ? 100 : 0) +
        r.name.length / 100,
    };
  });
  scored.sort((a, b) => a.score - b.score);
  const winner = scored[0]?.r;
  if (!winner) return null;
  return { drug: winner, strengthMatched };
}

/** Preferred display label for a resolved drug. Matches the consumer
 *  drug-search's format: brand > generic > full-name. Strips the
 *  trailing " Oral Tablet" / " Oral Capsule" so it doesn't duplicate
 *  the form field. */
function displayFromPicked(d: RxNormDrug): string {
  if (d.brand_name) {
    // A pen's "strength" can come back as its fill volume ("0.5 ML");
    // only append a real dose strength.
    const s = d.strength && /MG|MCG|UNT|%/i.test(d.strength) ? ` ${d.strength}` : '';
    return `${d.brand_name}${s}`.trim();
  }
  if (d.generic_name) return d.generic_name.trim();
  return d.name;
}

/** Resolve a single AgentBase drug row against the library. Extracted
 *  so the outer resolver can fan the drugs out concurrently — the
 *  break-on-first-hit query loop stays serialised per-drug (order
 *  matters for pickBest's precision-vs-brand ranking), but individual
 *  drugs no longer wait behind each other. Each searchDrug fetch is
 *  wrapped with a 5s timeout inside library-client.ts, so a stuck query
 *  yields a null-rxcui result instead of freezing the entire hydration. */
type DrugSearchFn = (query: string, signal?: AbortSignal) => Promise<RxNormDrug[]>;

async function resolveOne(
  input: AgentBaseDrugInput,
  signal: AbortSignal | undefined,
  search: DrugSearchFn,
): Promise<ResolvedAgentBaseDrug> {
  const originalName = input.name;
  const inputDose = input.dose?.trim() || null;
  const inputForm = input.form?.trim() || null;

  // rxcui already present — the CRM row already carries a resolved
  // concept from a prior sync. Trust it and skip the library call.
  if (input.rxcui) {
    return {
      id: input.id,
      hadInputRxcui: true,
      originalName,
      canonicalName: originalName,
      rxcui: input.rxcui,
      dose: inputDose,
      form: inputForm,
      resolved: true,
      strengthMatched: true,
    };
  }

  // Strength for pickBest: dose column wins when populated, else
  // extract from the tail of the name. Empty string ("") is the
  // sentinel pickBest uses to fall through to results[0].
  const strength =
    inputDose ?? extractStrengthFromName(originalName) ?? '';
  // Strengths to require: from the dose column when it parses, else from
  // the name. "10-325" (no unit) is a two-ingredient combo strength.
  const fromDose = inputDose ? parseStrengths(inputDose) : [];
  const target = fromDose.length > 0 ? fromDose : parseStrengths(originalName);
  // "Fluticasone Propionate Nasal Spray, USP" finds nothing in drug-search;
  // without the "USP" / punctuation it finds the nasal spray.
  const cleanedName = originalName.replace(/\bUSP\b/gi, ' ').replace(/[,;]/g, ' ').replace(/\s+/g, ' ').trim();
  const variants = [
    ...(cleanedName !== originalName ? buildNameVariants(cleanedName) : []),
    ...buildNameVariants(originalName),
  ];
  const route = parseDrugRoute(`${originalName} ${inputForm ?? ''}`);
  const normalized = normalizeStrength(strength);
  const queries: string[] = [];
  const seen = new Set<string>();
  const push = (q: string): void => {
    if (!seen.has(q)) {
      seen.add(q);
      queries.push(q);
    }
  };
  // Two-pass: precision variants (shortest first), then bare variants
  // (longest first — same order buildNameVariants emits). Shortest-first
  // for the precision pass ranks the bare stem + strength above the
  // intermediate variant carrying a residual dose-form token, so
  // pickBestAgent routes ambiguous cases to the canonical monotherapy
  // generic instead of the brand equivalent.
  // Combo dose ("HYDROcodone-ACETAMINOPHEN" + "10-325"): spell both
  // strengths out — drug-search returns the exact 10/325 product for it.
  const ingredients = cleanedName.split(/\s*[-/]\s*/).filter((x) => /[a-z]/i.test(x));
  if (ingredients.length === 2 && target.length === 2 && target.every((t) => t.per === 'each')) {
    push(`${ingredients[0]} ${target[0].v} MG / ${ingredients[1]} ${target[1].v} MG`);
  }
  if (normalized) {
    const byLength = [...variants].sort((a, b) => a.length - b.length);
    for (const v of byLength) push(`${v} ${normalized}`);
  }
  for (const v of variants) push(v);

  // When the CRM row carries a strength, only a pick AT that strength is
  // accepted. A query whose results hold no matching strength (e.g.
  // "oxycodone 5 MG" → only OxyContin 10/15/20 MG ER) is skipped and the
  // next variant is tried; if none match, the row stays unresolved and
  // shows the yellow "tap to re-search" warning. Falling back to the
  // nearest wrong-strength row put "Oxycontin 10 MG" on a client who takes
  // oxycodone 5 mg (Janet Moses, 2026-10-20) — a different drug at double
  // the dose, priced against the wrong formulary rows.
  const requireStrength = target.length > 0;
  let best: PickedDrug | null = null;
  try {
    for (const q of queries) {
      if (signal?.aborted) break;
      // One failing query (drug-search 500s on some punctuation) must not
      // abort the remaining variants — skip it and keep going.
      let results: RxNormDrug[];
      try {
        results = await search(q, signal);
      } catch {
        if (signal?.aborted) break;
        continue;
      }
      // Never cross route: a nasal spray request can't land on an inhaler
      // or a topical cream of the same ingredient.
      if (route != null) results = results.filter((r) => parseDrugRoute(r.name) === route);
      if (results.length === 0) continue;
      const picked = pickBestAgent(results, target, originalName);
      if (!picked?.drug.rxcui) continue;
      if (requireStrength && !picked.strengthMatched) continue;
      best = picked;
      break;
    }
  } catch {
    // Transient error (fetch failure, 5s library timeout, abort) —
    // fall through to unresolved. The Meds screen renders the yellow
    // warning and useResolveRxcuis retries in the background if the
    // med lands in state without a rxcui.
  }

  if (best?.drug.rxcui) {
    return {
      id: input.id,
      hadInputRxcui: false,
      originalName,
      canonicalName: displayFromPicked(best.drug),
      rxcui: best.drug.rxcui,
      dose: best.drug.strength ?? inputDose,
      form: best.drug.dose_form ?? inputForm,
      resolved: true,
      strengthMatched: best.strengthMatched,
    };
  }
  return {
    id: input.id,
    hadInputRxcui: false,
    originalName,
    canonicalName: originalName,
    rxcui: null,
    dose: inputDose,
    form: inputForm,
    resolved: false,
    strengthMatched: false,
  };
}

/** Resolve a batch of AgentBase free-text drug rows to canonical RxNorm
 *  concepts. Fans out per-drug in parallel (Promise.all) — the previous
 *  serial-over-drugs loop meant one stalled /api/library/drug-search
 *  invocation blocked every subsequent drug's resolution, which
 *  manifested as "meds hung" in Rob's 2026-08-09 handoff session. The
 *  library-client.ts 5s per-fetch timeout bounds worst-case latency to
 *  (5s × queries-per-drug). Aborts cleanly when the caller's signal
 *  fires. */
export async function resolveAgentBaseDrugs(
  inputs: AgentBaseDrugInput[],
  signal?: AbortSignal,
  /** Injectable for tests; production always uses the library search. */
  search: DrugSearchFn = searchDrug,
): Promise<ResolvedAgentBaseDrug[]> {
  return Promise.all(inputs.map((input) => resolveOne(input, signal, search)));
}
