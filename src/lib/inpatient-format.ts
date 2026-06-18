// Inpatient day-tier formatter — agent variant.
//
// Mirrors the consumer-side helper at ~/Code/plan-match/apps/web/src/lib
// /inpatient-format.ts (parseInpatientTiers), but returns a multi-line
// label tuned for the narrow compare-card cells in agent-v3.
//
// Per [[feedback_inpatient_full_ladder]] CMS disclosure requires every
// day-tier to be visible on every surface. pm_plan_benefits stores only
// the day-1 copay in the structured `copay` column; the rest of the
// ladder is in `benefit_description`, e.g.
//
//   "Inpatient hospital · Days 1–6: $325/day · Days 7–90: $0/day"
//   "SNF · Days 1–20: $0/day · Days 21–50: $218/day · Days 51–100: $0/day"
//   "Mental health inpatient · Days 1–7: $325/day · Days 8–90: $0/day"
//
// Rendering "$325" alone for SNF understates the $218/day middle tier
// liability — that's the bug.

export interface InpatientDayTier {
  copay: number;
  dayStart: number;
  dayEnd: number;
}

export function parseInpatientTiers(
  description: string | null | undefined,
): InpatientDayTier[] {
  if (!description) return [];
  const tiers: InpatientDayTier[] = [];
  // Three shapes coexist in pm_plan_benefits.benefit_description, all
  // emitted by different importer paths (the amount-first form
  // round-trips into the DB through the consumer-side formatter):
  //
  //   Range-first   : "Days 1–5: $75/day"   /  "Day 1: $0/day"
  //   Amount-first  : "$495/day (days 1-7)" /  "$0/day (days 8-90)"
  //   Per-day flat  : "$0 per-day copay"    /  "$2230 per-day copay"
  //
  // The per-day-flat shape (every Aetna D-SNP plan in NC, plus a
  // handful of other carriers) collapses the entire inpatient stay
  // into one synthetic tier covering CMS-standard days 1-90 when the
  // carrier files a single uniform per-day copay. Without this branch
  // the row fell back to "$X/day" alone with no day range, and D-SNP
  // plans displayed the structured-copay column ($1920) instead of
  // the description's true member-out-of-pocket ($0).
  //
  // All three produce the same { dayStart, dayEnd, copay } shape; we
  // run every regex and sort by dayStart so a mixed-shape description
  // still renders the ladder in day order.
  const RANGE_FIRST =
    /Days?\s+(\d+)\s*[–-]\s*(\d+)\s*:\s*\$\s*(\d+(?:\.\d+)?)\s*\/\s*day/gi;
  const AMOUNT_FIRST =
    /\$\s*(\d+(?:\.\d+)?)\s*\/\s*day\s*\(\s*days?\s+(\d+)\s*[–-]\s*(\d+)\s*\)/gi;
  const PER_DAY_FLAT =
    /\$\s*(\d+(?:\.\d+)?)\s*per[-\s]?day\s+copay/gi;

  const pushTier = (dayStart: number, dayEnd: number, copay: number) => {
    if (
      Number.isFinite(dayStart) &&
      Number.isFinite(dayEnd) &&
      Number.isFinite(copay) &&
      dayStart <= dayEnd
    ) {
      tiers.push({ copay, dayStart, dayEnd });
    }
  };

  let m: RegExpExecArray | null;
  while ((m = RANGE_FIRST.exec(description)) !== null) {
    pushTier(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  while ((m = AMOUNT_FIRST.exec(description)) !== null) {
    pushTier(Number(m[2]), Number(m[3]), Number(m[1]));
  }
  // Only synthesize a 1-90 tier from the per-day-flat shape when the
  // ranged regexes found nothing — otherwise we'd double-count the
  // first tier with a competing full-stay synthetic.
  if (tiers.length === 0) {
    while ((m = PER_DAY_FLAT.exec(description)) !== null) {
      pushTier(1, 90, Number(m[1]));
    }
  }
  tiers.sort((a, b) => a.dayStart - b.dayStart);
  return tiers;
}

function fmtDollars(n: number): string {
  return n % 1 === 0 ? `$${n}` : `$${n.toFixed(2)}`;
}

// Agent compare cells are narrow (~250px). Render the ladder as one
// tier per line using a newline; callers must apply `whiteSpace:
// pre-line` to the cell. Falls back to "$X/day" or the coinsurance %
// when the description has no parseable tier breakdown. Returns null
// only when nothing is available so the cell can render "Not available".
export function formatInpatientLadder(
  description: string | null | undefined,
  copay: number | null | undefined,
  coinsurance: number | null | undefined,
): string | null {
  const tiers = parseInpatientTiers(description);
  if (tiers.length > 0) {
    return tiers
      .map((t) => `${fmtDollars(t.copay)}/day · days ${t.dayStart}-${t.dayEnd}`)
      .join('\n');
  }
  if (typeof copay === 'number') return copay === 0 ? '$0/day' : `${fmtDollars(copay)}/day`;
  if (typeof coinsurance === 'number') return `${coinsurance}%`;
  return null;
}

// Numeric winner comparison uses the FIRST-tier copay (where the
// meaningful cost difference lives — $0 trailing tiers are a federal
// cap convention, not a plan-by-plan diff).
export function firstTierCopay(
  description: string | null | undefined,
  copay: number | null | undefined,
): number | null {
  const tiers = parseInpatientTiers(description);
  if (tiers.length > 0) return tiers[0].copay;
  return typeof copay === 'number' ? copay : null;
}
