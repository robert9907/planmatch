// Frozen Current-vs-Challenger comparison carried on a client quote.
//
// Built from the exact rows the broker sees on the Compare → Head to Head
// screen (same metrics, same formatting, same win/lose direction), so the
// page the client opens matches what was on the screen share line for line.
// The consumer quote API (robert9907/plan-match api/quotes.ts) validates and
// stores this as pm_quotes.head_to_head; QuotePage renders it.

export interface HeadToHeadPlanRef {
  carrier: string;
  plan_name: string;
  /** "H6622-060" style id shown under the plan name. */
  plan_id_display: string;
  /** contract_plan_segment key, e.g. "H6622_060_0". */
  contract_plan_segment: string;
  sbf_url: string | null;
}

export interface HeadToHeadRow {
  /** Section header the row sits under ("Overview", "Drug Coverage", …). */
  group: string;
  label: string;
  current: string;
  challenger: string;
  /** Challenger vs current on this row. */
  dir: 'better' | 'worse' | 'same' | null;
  /** Delta pill text ("$2,700", "0.5★", "2"); null = no pill. */
  delta: string | null;
}

export interface HeadToHeadQuote {
  /** 'Current' when the baseline is the client's current plan. */
  baseline_label: string;
  current: HeadToHeadPlanRef;
  challenger: HeadToHeadPlanRef;
  rows: HeadToHeadRow[];
  challenger_wins: number;
  current_wins: number;
  /** Estimated annual savings moving to the challenger; null when ≤ 0. */
  annual_savings: number | null;
}

export function contractPlanSegment(planId: string): string {
  const parts = planId.split('-');
  const contract = parts[0] ?? '';
  const plan = parts[1] ?? '';
  const segment = parts.length >= 3 ? parts.slice(2).join('-') : '0';
  return `${contract}_${plan}_${segment}`;
}
