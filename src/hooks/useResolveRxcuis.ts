import { useEffect, useRef } from 'react';
import { useSession } from './useSession';
import { searchDrug, type RxNormDrug } from '@/lib/rxnorm';

// Background-resolve rxcuis for any medication added to the session
// without one. Photo-captured meds (CapturePanel never hits RxNorm) and
// CRM-hydrated meds (AgentBase records often lack rxcui on old leads)
// land in the session with rxcui === undefined. Those meds can't match
// pm_formulary — their formulary badges render red "not on formulary"
// on every plan. This hook watches the session, picks up un-resolved
// meds, runs the name through a cleanup chain, queries pm_drugs (see
// src/lib/rxnorm.ts → searchDrug), and writes the best rxcui back via
// updateMedication so formularyLookup can then expand and match.
//
// Cleanup chain (buildNameVariants below): AgentBase's free-text med
// names often arrive as "Synthroid (Levothyroxine)" / "Metoprolol XR
// 50mg" / "Wellbutrin SR 150 MG Daily". pm_drugs.search_text is
// lower(name || generic_name || brand_name) WITHOUT strength or
// release-form suffixes, so an ilike on the raw input misses on every
// row. We generate progressively-stripped variants and try each in
// order — the first one that returns rows wins. pickBest then uses
// the original strength string to pick the right-strength SBD/SCD
// when multiple appear.
//
// resolvedRef tracks which medication ids we've attempted so adjacent
// renders don't refire the same searches. A failed search clears the
// id so a future mount can retry.

export function useResolveRxcuis(): void {
  const medications = useSession((s) => s.medications);
  const updateMedication = useSession((s) => s.updateMedication);
  const resolvedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    // Sequential resolution. Parallel IIFEs hit a React effect-rerun
    // cascade: the first updateMedication call mutates the medications
    // array, the effect re-fires, cleanup flips `cancelled = true` on
    // the old closure, and every other in-flight IIFE bails at its next
    // await without writing — but they're already reserved in
    // resolvedRef, so they never retry. Net result was 1 of N meds
    // resolving per page load. One-at-a-time means at most one IIFE
    // exists per effect run; cleanup only cancels that single in-flight
    // search, the new effect run picks up where we left off (med2 not
    // in resolvedRef because we only reserve on success), and each
    // medication eventually resolves.
    void (async () => {
      for (const med of medications) {
        if (cancelled) return;
        if (med.rxcui) continue;
        if (resolvedRef.current.has(med.id)) continue;
        const rawName = med.name.trim();
        if (rawName.length < 2) continue;

        const strength = med.strength?.trim() ?? '';
        const variants = buildNameVariants(rawName);

        let best: RxNormDrug | null = null;
        try {
          for (const v of variants) {
            if (cancelled) return;
            const results = await searchDrug(v);
            if (cancelled) return;
            if (results.length > 0) {
              best = pickBest(results, strength);
              if (best?.rxcui) break;
              best = null; // strength didn't match — keep trying variants
            }
          }
        } catch {
          // Transient error — leave this med out of resolvedRef so a
          // future effect run retries. Move on to the next med so one
          // bad fetch doesn't block the rest of the batch.
          continue;
        }

        if (cancelled) return;

        if (best?.rxcui) {
          updateMedication(med.id, { rxcui: best.rxcui });
          // Reserve AFTER confirmed resolution so a mid-loop cleanup
          // leaves unprocessed meds retryable on the next effect run.
          resolvedRef.current.add(med.id);
        }
        // If no variant matched, do NOT add to resolvedRef — this lets
        // a future mount (e.g., after pm_drugs is refreshed, or after
        // the broker re-types the name) try again. Within this loop we
        // just move on to the next med; the unresolved one stays red
        // until something triggers a retry.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [medications, updateMedication]);
}

// Strip strength tokens — "Synthroid 50 MCG" → "Synthroid",
// "Metformin 500mg/5ml" → "Metformin". Anchored at a whitespace
// boundary so "Levothyroxine" isn't truncated to "Levothy" by an
// accidental digit elsewhere.
const STRENGTH_RE =
  /\s+\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?\s*(?:mg|mcg|g|ml|%|meq|units?|iu)\b.*$/gi;
// Strip release-form suffixes after the drug name. RxNorm encodes
// these as part of the dose_form column (e.g. "Extended Release Oral
// Tablet"), so they don't appear in search_text either.
const RELEASE_RE = /\s+(?:XR|ER|CR|SR|IR|DR|XL|MR|PA|LA|SA)\b/gi;
// Trailing dose-instruction noise — "Daily", "BID", "PRN", etc.
// brokers sometimes paste off a script.
const DOSE_INSTR_RE =
  /\s+(?:daily|bid|tid|qid|qd|qod|qhs|prn|po|sl|im|iv|sc|hs|am|pm)\b.*$/gi;

function buildNameVariants(rawName: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (s: string): void => {
    const t = s.trim().replace(/\s+/g, ' ');
    if (t.length < 2) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };

  const name = rawName.trim();
  add(name);

  // Parenthetical: "Synthroid (Levothyroxine)" → variants in this
  // order: ["Levothyroxine", "Synthroid"]. AgentBase's convention is
  // "Brand (Generic)" — try the generic side FIRST so pickBest lands
  // on the SCD rxcui (pm_formulary Tier 1, $0-10/month copays) before
  // the SBD branded rxcui (Tier 2-3, often coinsurance). If we resolve
  // to the brand rxcui by accident, the pricing on every Compare card
  // gets inflated for what's actually a generic.
  //
  // Risk: if a record arrives as "Generic (Brand)" instead, we'd try
  // the brand first and surface the wrong rxcui — but per CRM
  // convention this hasn't been the case, and pickBest's strength
  // matcher still picks the right strength regardless of form.
  const parens = name.match(/^([^(]+?)\s*\(([^)]+)\)/);
  if (parens) {
    add(parens[2]);
    add(parens[1]);
  }

  // Apply each strip in turn to every variant accumulated so far. Order
  // matters: dose-instruction first (so " 50 MG Daily" → " 50 MG"
  // before strength stripping kicks in), then strength, then release.
  for (const v of [...out]) {
    const noInstr = v.replace(DOSE_INSTR_RE, '').trim();
    if (noInstr !== v) add(noInstr);

    const noStrength = noInstr.replace(STRENGTH_RE, '').trim();
    if (noStrength !== noInstr) add(noStrength);

    const noRelease = noStrength.replace(RELEASE_RE, '').trim();
    if (noRelease !== noStrength) add(noRelease);

    // Combined strip in case the original variant skipped a step.
    const stripped = v.replace(DOSE_INSTR_RE, '').replace(STRENGTH_RE, '').replace(RELEASE_RE, '').trim();
    if (stripped !== v) add(stripped);
  }

  return out;
}

// Parse a strength string like "20mg", "1mg/0.75mL", "300 MG", "40 MCG"
// into a number normalized to MG. Returns null when nothing parseable
// is found — callers fall back to the raw [0] result.
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

// Pick the best candidate from a search-result list. When a strength
// is supplied, prefer the first candidate whose name parses to the
// same numeric strength; fall back to the raw [0] when no candidate
// matches (search returned nothing strength-relevant — better to
// resolve to something than nothing).
function pickBest(results: RxNormDrug[], rawStrength: string): RxNormDrug | null {
  if (results.length === 0) return null;
  const target = parseStrengthMg(rawStrength);
  if (target == null) return results[0];
  const strengthMatch = results.find((r) => {
    const s = parseStrengthMg(r.name);
    if (s == null) return false;
    return Math.abs(s - target) < 0.0001;
  });
  return strengthMatch ?? results[0];
}
