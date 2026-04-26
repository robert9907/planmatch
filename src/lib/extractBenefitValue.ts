// extractBenefitValue — parses pm_plan_benefits.benefit_description
// strings into structured fields the agent UI can render.
//
// CMS files extras coverage in `pm_plan_benefits.benefit_description`
// (free text) more often than in the structured `coverage_amount` /
// `max_coverage` columns. Examples observed on plan-match-prod:
//
//   "Preventive + comprehensive dental · $45 copay"
//   "Routine eye exam + eyewear · $0 exam copay"
//   "Hearing covered"
//   "Tier 1 · Preferred Generic · 30-day retail · $0 copay"
//   "Part B premium giveback · $101.00/month"
//
// Each shape needs a different render. This parser pulls dollar
// amounts, periods (year/quarter/month), copays, and coverage levels
// (preventive / comprehensive / exam_only) so the QuoteDeliveryV4
// row formatters can show "$2,500/yr · comprehensive" instead of
// "Covered" or "—" when the structured fields are null.

export type BenefitPeriod = 'year' | 'quarter' | 'month' | 'day';

export type CoverageLevel =
  | 'preventive'
  | 'comprehensive'
  | 'exam_only'
  | 'aids_and_exam'
  | null;

export interface BenefitValue {
  /** Annual / quarterly / monthly cap, when filed. */
  amount: number | null;
  period: BenefitPeriod | null;
  /** Per-visit copay when described separately ("$45 copay"). */
  copay: number | null;
  /** Coverage breadth, when the description says so. */
  level: CoverageLevel;
  /** Original description (so callers can fall back to raw text). */
  raw: string | null;
}

const EMPTY: BenefitValue = {
  amount: null,
  period: null,
  copay: null,
  level: null,
  raw: null,
};

/**
 * @param description Raw benefit_description from pm_plan_benefits
 * @param benefitType One of dental | vision | hearing | otc | food_card |
 *                    fitness | partb_giveback. Drives level inference.
 */
export function extractBenefitValue(
  description: string | null | undefined,
  benefitType: string,
): BenefitValue {
  if (!description) return EMPTY;
  const text = description.trim();
  if (!text) return EMPTY;

  // Dollar-amount + period: "$2,500/yr", "$120/qtr", "$50/mo".
  // Allow "per year" / "per quarter" / "per month" full forms too.
  const periodMatch = text.match(
    /\$([\d,]+(?:\.\d+)?)\s*\/?\s*(yr|year|annual|qtr|quarter|mo|month|day)/i,
  );
  let amount: number | null = null;
  let period: BenefitPeriod | null = null;
  if (periodMatch) {
    amount = Number(periodMatch[1].replace(/,/g, ''));
    const unit = periodMatch[2].toLowerCase();
    if (unit.startsWith('yr') || unit.startsWith('annual') || unit.startsWith('year')) period = 'year';
    else if (unit.startsWith('qtr') || unit.startsWith('quarter')) period = 'quarter';
    else if (unit.startsWith('mo') || unit.startsWith('month')) period = 'month';
    else if (unit.startsWith('day')) period = 'day';
  }

  // Copay-only patterns: "$45 copay", "$0 exam copay", "$15 visit".
  // Don't match if we already pulled a period above (period $ wins).
  let copay: number | null = null;
  if (!periodMatch) {
    const copayMatch = text.match(/\$(\d+(?:\.\d+)?)\s*(?:exam\s+)?copay\b/i);
    if (copayMatch) copay = Number(copayMatch[1]);
  }

  // Coverage level — keyword scan against benefit-type-specific
  // vocabulary. Order matters: 'comprehensive' should win over
  // 'preventive' when both appear ("Preventive + comprehensive").
  const lowered = text.toLowerCase();
  let level: CoverageLevel = null;
  if (benefitType === 'dental') {
    if (/comprehensive/.test(lowered)) level = 'comprehensive';
    else if (/preventive/.test(lowered)) level = 'preventive';
  } else if (benefitType === 'vision') {
    if (/eyewear|frames|lenses|contacts/.test(lowered)) level = 'comprehensive';
    else if (/exam/.test(lowered)) level = 'exam_only';
  } else if (benefitType === 'hearing') {
    if (/aid|aids|fitting/.test(lowered)) level = 'aids_and_exam';
    else if (/exam/.test(lowered)) level = 'exam_only';
  }

  return { amount, period, copay, level, raw: text };
}

/**
 * Format a parsed BenefitValue into the agent-quote display string
 * the V4 spec mandates per benefit type.
 *
 * Display rules:
 *   • amount + period   → "$2,500/yr"
 *   • copay only        → "$45 copay"
 *   • level only        → "Preventive only" / "Exam only" / "Aids + exams"
 *   • mix of dollar + level → "$2,500/yr · comprehensive"
 *   • nothing parsed but raw text exists → return the raw text
 *   • truly empty       → "—"
 */
export function formatBenefitDisplay(
  value: BenefitValue,
  fallbackAmount?: number,
  fallbackPeriod?: BenefitPeriod,
): string {
  const parts: string[] = [];

  // Prefer parsed amount; fall back to caller-provided amount when
  // the structured Plan field carries it but the description didn't.
  const amount = value.amount ?? fallbackAmount ?? null;
  const period = value.period ?? fallbackPeriod ?? null;

  if (amount != null && amount > 0 && period) {
    parts.push(`$${amount.toLocaleString()}${periodSuffix(period)}`);
  } else if (value.copay != null) {
    parts.push(`$${value.copay} copay`);
  }

  if (value.level) {
    if (parts.length > 0) parts.push(levelLabel(value.level));
    else parts.push(levelLabel(value.level));
  }

  if (parts.length > 0) return parts.join(' · ');
  // Description-but-no-parse — show raw text; never fall back to
  // generic "Covered" (per the V4 spec).
  if (value.raw) return value.raw;
  return '—';
}

function periodSuffix(period: BenefitPeriod): string {
  switch (period) {
    case 'year':    return '/yr';
    case 'quarter': return '/qtr';
    case 'month':   return '/mo';
    case 'day':     return '/day';
  }
}

function levelLabel(level: NonNullable<CoverageLevel>): string {
  switch (level) {
    case 'preventive':     return 'preventive only';
    case 'comprehensive':  return 'comprehensive';
    case 'exam_only':      return 'exam only';
    case 'aids_and_exam':  return 'aids + exams';
  }
}
