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

export interface AgentBaseDrugInput {
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

/** Parse a strength value normalized to MG for comparison. Mirror of
 *  parseStrengthMg in useResolveRxcuis — copied here so this module
 *  stays independent of the hook's export surface. */
function parseStrengthMg(raw: string): number | null {
  const m = raw.match(/(\d+(?:\.\d+)?)\s*(MG|MCG|G|ML|%)/i);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const unit = m[2].toUpperCase();
  if (unit === 'MCG') return v / 1000;
  if (unit === 'G') return v * 1000;
  return v;
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
function pickBestAgent(
  results: RxNormDrug[],
  rawStrength: string,
  rawInputName: string,
): RxNormDrug | null {
  if (results.length === 0) return null;
  const target = parseStrengthMg(rawStrength);
  const inputLower = rawInputName.toLowerCase();

  // Filter to strength-matched rows when a target strength exists.
  // Falls back to the full result set when no candidate matches, so
  // callers still get a result (potentially wrong-strength) rather
  // than nothing.
  const filtered = target != null
    ? results.filter((r) => {
        const s = parseStrengthMg(r.name);
        return s != null && Math.abs(s - target) < 0.0001;
      })
    : results;
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
  return scored[0]?.r ?? null;
}

/** Preferred display label for a resolved drug. Matches the consumer
 *  drug-search's format: brand > generic > full-name. Strips the
 *  trailing " Oral Tablet" / " Oral Capsule" so it doesn't duplicate
 *  the form field. */
function displayFromPicked(d: RxNormDrug): string {
  if (d.brand_name) {
    const s = d.strength ? ` ${d.strength}` : '';
    return `${d.brand_name}${s}`.trim();
  }
  if (d.generic_name) return d.generic_name.trim();
  return d.name;
}

/** Resolve a list of AgentBase free-text drug rows to canonical
 *  RxNorm concepts by hitting the library drug-search endpoint. Runs
 *  serially (not in parallel) — the endpoint's cold-start cost and
 *  the rate at which brokers actually load a client (one at a time)
 *  make a queue safer than a fan-out that could throw AbortErrors on
 *  the wire. Aborts cleanly when the caller's signal fires. */
export async function resolveAgentBaseDrugs(
  inputs: AgentBaseDrugInput[],
  signal?: AbortSignal,
): Promise<ResolvedAgentBaseDrug[]> {
  const out: ResolvedAgentBaseDrug[] = [];
  for (const input of inputs) {
    if (signal?.aborted) break;
    const originalName = input.name;
    const inputDose = input.dose?.trim() || null;
    const inputForm = input.form?.trim() || null;

    // rxcui already present — the CRM row already carries a resolved
    // concept from a prior sync. Trust it and skip the library call.
    if (input.rxcui) {
      out.push({
        originalName,
        canonicalName: originalName,
        rxcui: input.rxcui,
        dose: inputDose,
        form: inputForm,
        resolved: true,
      });
      continue;
    }

    // Strength for pickBest: dose column wins when populated, else
    // extract from the tail of the name. Empty string ("") is the
    // sentinel pickBest uses to fall through to results[0].
    const strength =
      inputDose ?? extractStrengthFromName(originalName) ?? '';
    const variants = buildNameVariants(originalName);
    // Precision-first: prepend "<bareStem> <normalizedStrength>"
    // queries to each variant. For ingredients like hydrochlorothiazide
    // where the pm_drugs monotherapy ranks BELOW combo drugs on a bare
    // stem query, the strength-included form surfaces the 25 MG
    // monotherapy at position 1. Without this, pickBest can't
    // distinguish "hydrochlorothiazide 25 MG / lisinopril 20 MG" from
    // the true "hydrochlorothiazide 25 MG Oral Tablet" — both match
    // strength 25 MG, and the combo ranks higher on the bare query.
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
    // (longest first — same order buildNameVariants emits).
    //
    // Shortest-first for the precision pass is deliberate: the bare
    // stem + strength ("Levetiracetam 500 MG") ranks the true generic
    // monotherapy ABOVE the branded equivalent (Keppra), while an
    // intermediate strip carrying a residual dose-form token
    // ("Levetiracetam TAB 500 MG") ranks Keppra first. The latter
    // wins if we hit it before the bare-stem precision query, and
    // pickBestAgent's brand penalty can't overcome the ranking gap.
    // Sorting precision variants shortest-first + break-on-first-hit
    // routes ambiguous cases to the canonical monotherapy generic.
    if (normalized) {
      const byLength = [...variants].sort((a, b) => a.length - b.length);
      for (const v of byLength) push(`${v} ${normalized}`);
    }
    for (const v of variants) push(v);

    let best: RxNormDrug | null = null;
    try {
      for (const q of queries) {
        if (signal?.aborted) return out;
        const results = await searchDrug(q, signal);
        if (results.length === 0) continue;
        const picked = pickBestAgent(results, strength, originalName);
        if (picked?.rxcui) {
          best = picked;
          break;
        }
      }
    } catch {
      // Transient error — leave unresolved. The Meds screen will
      // render the yellow warning and useResolveRxcuis retries in the
      // background if the med lands in state without a rxcui.
    }

    if (best?.rxcui) {
      out.push({
        originalName,
        canonicalName: displayFromPicked(best),
        rxcui: best.rxcui,
        dose: best.strength ?? inputDose,
        form: best.dose_form ?? inputForm,
        resolved: true,
      });
    } else {
      out.push({
        originalName,
        canonicalName: originalName,
        rxcui: null,
        dose: inputDose,
        form: inputForm,
        resolved: false,
      });
    }
  }
  return out;
}
