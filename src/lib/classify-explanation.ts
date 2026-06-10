// Maps a brain explanation string (BrainScore.explanations.gate{1,2,3,4})
// to a tri-state icon flavor so the UI can pick a green ✓, red ✗, or
// amber ⚠ next to each row.
//
// The brain ships customer-facing prose, not structured flags — every
// rule below is a pattern-match against the strings the
// plan-brain-explanations helpers emit (buildGate1/2/3Explanations +
// buildGate4Explanation).
//
// Mirrors apps/web/src/lib/classify-explanation.ts in the consumer
// repo. Updating an explanation string in plan-brain-explanations.ts
// requires updating the matching pattern here.

export type ExplanationState = 'pass' | 'fail' | 'unverified';

/**
 * Return the icon flavor that should accompany a single gate
 * explanation string. Order of checks matters:
 *  1. "unverified" / "estimated, confirm" → amber (uncertainty trumps
 *     the surface phrasing — a covered drug whose coverage is
 *     "estimated" should not look definitively green).
 *  2. Explicit-fail phrases → red.
 *  3. Gate-3 "$X (your pick: $Y+)" where X < Y → amber (partial /
 *     below threshold) by numeric comparison.
 *  4. Anything else → green (covers `Dr. X is in-network`,
 *     `Metformin — Tier 2, $4/mo`, `Dental $1,500 (your pick: $1,000+)`,
 *     `Fitness included`, the Gate 4 cost-rank line, etc).
 */
export function classifyExplanation(text: string): ExplanationState {
  const t = text.toLowerCase();

  // 1. Unverified / unknown / estimated.
  if (t.includes('unverified')) return 'unverified';
  if (t.includes('estimated, confirm')) return 'unverified';

  // 2. Explicit failures.
  if (t.includes('out-of-network')) return 'fail';
  if (t.includes('is not covered')) return 'fail';
  if (t.includes('not filed')) return 'fail';
  if (t.includes('not offered')) return 'fail';

  // 3. Gate-3 partial-threshold detection.
  // Strings look like "Dental $1,500 (your pick: $2,000+)" — if the
  // first dollar amount is below the threshold, treat as partial.
  const m = text.match(/\$([\d,]+)[^(]*\(your pick:\s*\$([\d,]+)\+/i);
  if (m) {
    const value = parseInt(m[1].replace(/,/g, ''), 10);
    const threshold = parseInt(m[2].replace(/,/g, ''), 10);
    if (Number.isFinite(value) && Number.isFinite(threshold) && value < threshold) {
      return 'unverified';
    }
  }

  return 'pass';
}

/**
 * Build the human summary line for a collapsed "Why this plan" header.
 * Counts pass / fail / unverified across the provider + drug gates and
 * picks the most useful one-liner. Examples:
 *   "All 3 providers in-network · All 2 medications covered"
 *   "2 of 3 providers in-network"
 *   "Metformin covered · Eliquis not covered"
 *
 * Returns an empty string when no provider OR drug data is available
 * (caller renders a generic "Why this plan" header).
 */
export function summarizeExplanations(
  gate1: ReadonlyArray<string>,
  gate2: ReadonlyArray<string>,
): string {
  const segments: string[] = [];

  if (gate1.length > 0) {
    const passes = gate1.filter((s) => classifyExplanation(s) === 'pass').length;
    if (passes === gate1.length) {
      segments.push(
        `All ${gate1.length} provider${gate1.length === 1 ? '' : 's'} in-network`,
      );
    } else {
      segments.push(`${passes} of ${gate1.length} providers in-network`);
    }
  }

  if (gate2.length > 0) {
    const passes = gate2.filter((s) => classifyExplanation(s) === 'pass').length;
    if (passes === gate2.length) {
      segments.push(
        `All ${gate2.length} medication${gate2.length === 1 ? '' : 's'} covered`,
      );
    } else {
      segments.push(`${passes} of ${gate2.length} medications covered`);
    }
  }

  return segments.join(' · ');
}
