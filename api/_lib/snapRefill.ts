// Snap Link label math: days' supply and next refill date.
//
// Everything here is derived only from what is printed on the bottle.
// When the label doesn't give enough to be sure, the answer is null and
// the CRM cell stays blank — a wrong refill date is worse than none.

const NUM_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, a: 1, an: 1, half: 0.5,
};

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const m = String(v).match(/\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Units taken per day from the label directions, or null if unclear. */
export function unitsPerDay(instructions: string | null | undefined): number | null {
  const s = (instructions ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return null;
  // Tapers, titrations, "as needed" and multi-step directions have no
  // single daily rate — don't guess.
  if (/\b(then|increase|decrease|taper|as needed|prn|if needed|when needed|alternate|every other|weekly|week|month|sliding)\b/.test(s)) {
    return null;
  }
  return phaseRate(s);
}

function phaseRate(s: string): number | null {

  let perDose = 1;
  const dose = s.match(/\b(take|give|use)\s+(\d+(?:\.\d+)?|one|two|three|four|five|six|a|an|half)\s*(?:\(\d+\)\s*)?(tablet|tab|capsule|cap|pill|softgel)s?\b/);
  if (dose) {
    perDose = /^\d/.test(dose[2]) ? Number(dose[2]) : NUM_WORDS[dose[2]];
  } else if (!/\b(tablet|tab|capsule|cap|pill|softgel)s?\b/.test(s)) {
    return null; // no unit stated at all
  }

  let timesPerDay: number | null = null;
  const everyHours = s.match(/every (\d+) hours?/);
  if (everyHours) timesPerDay = 24 / Number(everyHours[1]);
  else if (/\b(four times|4 times) (a|per|each) day|\bqid\b/.test(s)) timesPerDay = 4;
  else if (/\b(three times|3 times) (a|per|each) day|\btid\b/.test(s)) timesPerDay = 3;
  else if (/\b(twice|two times|2 times) (a|per|each) day|twice daily|\bbid\b/.test(s)) timesPerDay = 2;
  else if (/\b(once|one time|1 time) (a|per|each) day|once daily|\bdaily\b|every day|each day|\bqd\b|at bedtime|every (morning|evening|night)|in the (morning|evening)/.test(s)) timesPerDay = 1;
  if (timesPerDay == null || !Number.isFinite(timesPerDay)) return null;

  const total = perDose * timesPerDay;
  return total > 0 ? total : null;
}

/**
 * Days a quantity lasts under a two-step titration label, e.g.
 * "1 capsule two times a day for 14 days, then increase to 1 capsule
 * 3 times a day": first 14 days at 2/day, the rest at 3/day.
 * Only the exact "<rate> for N days, then <rate>" shape is handled.
 */
export function titrationDays(instructions: string | null | undefined, quantity: number): number | null {
  const s = (instructions ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const parts = s.split(/,?\s*\bthen\b\s*/);
  if (parts.length !== 2) return null;
  const [first, second] = parts;
  if (/\b(as needed|prn|taper|decrease|every other|weekly|week|month)\b/.test(s)) return null;
  const forDays = first.match(/\bfor (\d+) days?\b/);
  if (!forDays) return null;
  const phase1Days = Number(forDays[1]);
  const r1 = phaseRate(first.replace(forDays[0], ''));
  // Second phase usually reads "increase to 1 capsule 3 times a day".
  const r2 = phaseRate(second.replace(/^(increase|decrease) to /, 'take '));
  if (r1 == null || r2 == null || /\bfor \d+ days?\b/.test(second)) return null;
  const used1 = r1 * phase1Days;
  if (quantity <= used1) return Math.floor(quantity / r1);
  return phase1Days + Math.floor((quantity - used1) / r2);
}

/** Days' supply: printed value first, else quantity ÷ daily units (solid oral forms only). */
export function daysSupply(opts: {
  printedDaysSupply?: unknown;
  quantity?: unknown;
  instructions?: string | null;
  form?: string | null;
  ndc?: string | null;
}): number | null {
  let printed = toNumber(opts.printedDaysSupply);
  // Vision sometimes lifts a number off the NDC ("65162-102-50" → 50).
  // A days' supply equal to an NDC segment is not trusted.
  if (printed != null && opts.ndc) {
    const segs = String(opts.ndc).split(/\D+/).filter(Boolean).map(Number);
    if (segs.includes(printed)) printed = null;
  }
  if (printed != null && (printed > 365 || printed < 1)) printed = null;

  let computed: number | null = null;
  const qty = toNumber(opts.quantity);
  const form = (opts.form ?? '').toLowerCase();
  const solid = !form || /tablet|capsule|tab|cap|pill|softgel/.test(form);
  if (qty != null && solid) {
    const perDay = unitsPerDay(opts.instructions);
    computed = perDay != null ? Math.floor(qty / perDay) : titrationDays(opts.instructions, qty);
    if (computed != null && (computed < 1 || computed > 365)) computed = null;
  }

  // Both known and far apart → the printed number was probably misread.
  if (printed != null && computed != null) {
    return Math.abs(printed - computed) / computed > 0.25 ? computed : Math.round(printed);
  }
  return printed != null ? Math.round(printed) : computed;
}

/** Parse a label date (YYYY-MM-DD, MM/DD/YYYY, MM/DD/YY, MM-DD-YYYY) to a UTC Date. */
export function parseLabelDate(s: string | null | undefined): Date | null {
  const t = (s ?? '').trim();
  let y: number, mo: number, d: number;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})\b/))) {
    mo = +m[1]; d = +m[2]; y = +m[3]; if (y < 100) y += 2000;
  } else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null; // e.g. 02/31
  // Sanity window: a fill date from the last two years, not in the future.
  const now = Date.now();
  if (dt.getTime() > now + 2 * 86400000 || dt.getTime() < now - 730 * 86400000) return null;
  return dt;
}

/** Next refill = fill date + days' supply, as YYYY-MM-DD (the CRM's date format). */
export function nextRefillDate(lastFilled: string | null | undefined, days: number | null): string | null {
  if (days == null) return null;
  const filled = parseLabelDate(lastFilled);
  if (!filled) return null;
  const next = new Date(filled.getTime() + days * 86400000);
  return next.toISOString().slice(0, 10);
}

export function quantityText(v: unknown): string | null {
  const n = toNumber(v);
  return n == null ? null : String(n);
}
