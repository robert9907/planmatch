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
  /** Coinsurance percentage when described ("20% coinsurance"). */
  coinsurance: number | null;
  /** Eyewear allowance dollar value (vision-specific). */
  eyewearAllowance: number | null;
  /** "rider" keyword present — plan requires a premium rider for
   *  comprehensive coverage. */
  hasRider: boolean;
  /** Coverage breadth, when the description says so. */
  level: CoverageLevel;
  /** Original description (so callers can fall back to raw text). */
  raw: string | null;
}

const EMPTY: BenefitValue = {
  amount: null,
  period: null,
  copay: null,
  coinsurance: null,
  eyewearAllowance: null,
  hasRider: false,
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
  // Always run, even when a period was matched, because dental rows
  // commonly have BOTH an annual max and a per-visit copay.
  let copay: number | null = null;
  const copayMatch = text.match(/\$(\d+(?:\.\d+)?)\s*(?:exam\s+)?copay\b/i);
  if (copayMatch) copay = Number(copayMatch[1]);

  // Coinsurance percentage: "20% coinsurance", "30% coins".
  let coinsurance: number | null = null;
  const coinsMatch = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:coinsurance|coins)\b/i);
  if (coinsMatch) coinsurance = Number(coinsMatch[1]);

  // Eyewear allowance (vision-specific): "$50 eyewear allowance".
  let eyewearAllowance: number | null = null;
  const eyewearMatch = text.match(/\$(\d+(?:\.\d+)?)\s*eyewear\s*allowance/i);
  if (eyewearMatch) eyewearAllowance = Number(eyewearMatch[1]);

  // Rider — plan requires monthly premium for comprehensive coverage.
  const hasRider = /\brider\b/i.test(text);

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

  return { amount, period, copay, coinsurance, eyewearAllowance, hasRider, level, raw: text };
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

// ─── Per-benefit-type display formatters ──────────────────────────
//
// Tight columns (~190px) demand short strings. Each formatter
// produces the most informative label that still fits without
// truncation. Per the V4 spec: dollar amounts are always preserved,
// keyword qualifiers ("comprehensive" → "comp" or just "P+C") are
// abbreviated as needed.

/**
 * Dental display tiers per V4 spec:
 *   • Preventive only          → "Preventive"
 *   • P+C with annual max      → "P+C · $2,500/yr"
 *   • P+C with per-visit copay → "P+C · $45 copay"
 *   • P+C with coinsurance     → "P+C · 20% coins"
 *   • P+C with rider           → "P+C · $44/mo rider"
 *   • Both max + copay         → "P+C · $2,500/yr · $45 copay"
 *   • description-only fallback→ raw text
 *   • truly empty              → "—"
 */
export function formatDental(annualMax: number, description: string | null | undefined): string {
  const v = extractBenefitValue(description, 'dental');
  // Preventive-only — only when description explicitly says so AND
  // doesn't say comprehensive. (Default CMS shape is P+C; rare to
  // see preventive-only.)
  if (v.level === 'preventive') return 'Preventive';

  const head = 'P+C';
  const parts: string[] = [head];
  if (annualMax > 0) parts.push(`$${annualMax.toLocaleString()}/yr`);
  if (v.hasRider && v.amount != null && v.period === 'month') {
    parts.push(`$${v.amount}/mo rider`);
  }
  if (v.copay != null) parts.push(`$${v.copay} copay`);
  else if (v.coinsurance != null) parts.push(`${v.coinsurance}% coins`);

  if (parts.length > 1) return parts.join(' · ');
  // No structured numbers — just description (or em dash).
  if (v.raw) return v.raw;
  return '—';
}

/**
 * Vision display:
 *   • Eyewear allowance + exam → "Exam + $50 eyewear"
 *   • Eyewear allowance only   → "$50/yr eyewear"
 *   • Exam-only with copay     → "$0 exam copay"
 *   • Exam covered, no detail  → "Exam + eyewear" or "Exam only"
 *   • Empty                    → "—"
 */
export function formatVision(
  structuredEyewear: number,
  examIncluded: boolean,
  description: string | null | undefined,
): string {
  const v = extractBenefitValue(description, 'vision');
  const eyewearAmt = v.eyewearAllowance ?? (structuredEyewear > 0 ? structuredEyewear : null);

  if (eyewearAmt != null && examIncluded) {
    return `Exam + $${eyewearAmt.toLocaleString()} eyewear`;
  }
  if (eyewearAmt != null) {
    return `$${eyewearAmt.toLocaleString()}/yr eyewear`;
  }
  // No eyewear $ but exam copay extracted → "$0 exam copay" style.
  if (v.copay != null && /exam/i.test(v.raw ?? '')) {
    return `Exam + eyewear · $${v.copay} exam`;
  }
  // "Routine eye exam + eyewear" with no $ at all → minimal label.
  if (/eyewear/i.test(v.raw ?? '')) return 'Exam + eyewear';
  if (examIncluded) return 'Exam only';
  if (v.raw) return v.raw;
  return '—';
}

/**
 * Hearing display:
 *   • Per-ear allowance        → "$X per ear"
 *   • Total hearing-aid allow. → "$X/yr aids"
 *   • Aids + exam covered      → "Aids + exam"
 *   • Coinsurance on aids      → "Aids · 20% coins"
 *   • Exam only                → "Exam only"
 *   • Empty                    → "—"
 */
export function formatHearing(
  structuredAllowance: number,
  examIncluded: boolean,
  description: string | null | undefined,
): string {
  const v = extractBenefitValue(description, 'hearing');
  const perEar = /per\s+ear/i.test(v.raw ?? '');
  const allowance = v.amount ?? (structuredAllowance > 0 ? structuredAllowance : null);

  if (allowance != null && perEar) return `$${allowance.toLocaleString()} per ear`;
  if (allowance != null) return `$${allowance.toLocaleString()}/yr aids`;
  if (v.coinsurance != null) return `Aids · ${v.coinsurance}% coins`;
  if (/aid/i.test(v.raw ?? '')) {
    if (examIncluded) return 'Aids + exam';
    return 'Aids covered';
  }
  if (examIncluded) return 'Exam only';
  if (v.raw === 'Hearing covered') return 'Covered';
  if (v.raw) return v.raw;
  return '—';
}

/**
 * OTC display — always quarterly, converting from monthly when CMS
 * filed it that way. coverage_amount on pm_plan_benefits IS already
 * the quarterly value when populated (per the importer); we use it
 * directly when available.
 *
 *   • $X/qtr (preferred)
 *   • Otherwise convert monthly × 3 → "$X/qtr"
 *   • Empty → "—"
 */
export function formatOtc(structuredQuarterly: number, description: string | null | undefined): string {
  if (structuredQuarterly > 0) return `$${structuredQuarterly.toLocaleString()}/qtr`;
  const v = extractBenefitValue(description, 'otc');
  if (v.amount != null && v.period === 'quarter') return `$${v.amount.toLocaleString()}/qtr`;
  if (v.amount != null && v.period === 'month') return `$${(v.amount * 3).toLocaleString()}/qtr`;
  if (v.amount != null && v.period === 'year') return `$${Math.round(v.amount / 4).toLocaleString()}/qtr`;
  if (v.raw) return v.raw;
  return '—';
}

/**
 * Food card — monthly amount.
 *   • $X/mo (real value)
 *   • "Included" when CMS marks the benefit offered with no dollar cap
 *     (coverage_amount === 1 from the importer's "offered" sentinel)
 *   • "—" otherwise
 */
export function formatFoodCard(structuredMonthly: number, description: string | null | undefined): string {
  if (structuredMonthly > 1) return `$${structuredMonthly}/mo`;
  if (structuredMonthly === 1) return 'Included';
  const v = extractBenefitValue(description, 'food_card');
  if (v.amount != null && v.period === 'month') return `$${v.amount}/mo`;
  if (v.amount != null && v.period === 'year') return `$${Math.round(v.amount / 12)}/mo`;
  if (v.raw) return v.raw;
  return '—';
}
