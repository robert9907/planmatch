// Hospital indemnity quote — Bankers Fidelity Vantage Flex Plus (HI21BFLIC).
//
// Benefit options, amounts and yearly limits come from the carrier's
// underwriting guide (HI21BFLIC UWG IS, 6-25) and the NC outline of coverage.
//
// RATES: the only real Bankers Fidelity prices we have are the per-benefit
// line items from one eApp quote (NC, age 53, Individual, Nov 10 2026, total
// $130.93). A build that matches that quote prices EXACTLY. Anything else —
// another age, another household tier, another amount, or an option with no
// line item — is an ESTIMATE (linear by amount, plus an assumed age curve and
// household multipliers). Estimated quotes cannot be sent to clients; see
// `canSend`. When the carrier rate manual arrives, replace RATE_53_IND,
// ageFactor and HOUSEHOLD with the real tables and this file's callers keep
// working.

export type HospitalState = 'NC' | 'TX' | 'GA';
export const HOSPITAL_STATES: HospitalState[] = ['NC', 'TX', 'GA'];

export type Household = 'ind' | 'sp' | 'ch' | 'fam';
export const HOUSEHOLD_LABEL: Record<Household, string> = {
  ind: 'Individual',
  sp: 'Individual & spouse',
  ch: 'Individual & child(ren)',
  fam: 'Family',
};

export type BenefitPeriod = 1 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 15 | 21 | 31;
export const BENEFIT_PERIODS: BenefitPeriod[] = [1, 3, 4, 5, 6, 7, 8, 9, 10, 15, 21, 31];

export interface HospitalBenefits {
  /** Hospital admission, per admission (5 admissions / year). */
  adm: number;
  /** Daily hospital confinement, per day. */
  daily: number;
  /** Days paid per policy year (1 = first day only). */
  period: BenefitPeriod;
  /** Air ambulance per trip. */
  air: number;
  /** Ground/water ambulance per trip. */
  gnd: number;
  icuA: boolean;
  icuD: boolean;
  /** Outpatient surgery (hospital / ASC), 0 = not added. */
  osh: number;
  maj: number;
  inv: number;
  min: number;
  hs: number;
  /** Rehab unit $50/day for 15 or 31 days; 0 = not added. */
  rehab: 0 | 15 | 31;
  snf: number;
  nlt: boolean;
  lodge: boolean;
  maternity: boolean;
  mentalNervous: boolean;
}

/** Fixed by the plan — not selectable. Observation always equals daily. */
export const FIXED = { er: 200, uc: 50 } as const;

const range = (a: number, b: number, step: number): number[] => {
  const out: number[] = [];
  for (let x = a; x <= b; x += step) out.push(x);
  return out;
};

/** Allowed amounts per the underwriting guide. 0 = rider not added. */
export const OPTIONS = {
  adm: range(100, 5000, 100),
  daily: range(100, 750, 25),
  air: range(100, 400, 50),
  gnd: range(100, 400, 25),
  osh: [0, 250, 500, 750, 1000],
  maj: [0, 100, 200, 300, 400, 500],
  inv: [0, 100, 200, 300, 400, 500],
  min: [0, 25, 50, 75, 100],
  hs: [0, 50, 75, 100],
  snf: [0, 100, 150, 200],
} as const;

export const BALANCED: HospitalBenefits = {
  adm: 5000, daily: 750, period: 15, air: 100, gnd: 400,
  icuA: true, icuD: true, osh: 1000, maj: 500, inv: 500, min: 100, hs: 100,
  rehab: 0, snf: 0, nlt: false, lodge: false, maternity: false, mentalNervous: false,
};
export const PACKAGES: Record<'essential' | 'balanced' | 'max', HospitalBenefits> = {
  essential: {
    adm: 1000, daily: 200, period: 5, air: 200, gnd: 200,
    icuA: false, icuD: false, osh: 0, maj: 0, inv: 0, min: 0, hs: 0,
    rehab: 0, snf: 0, nlt: false, lodge: false, maternity: false, mentalNervous: false,
  },
  balanced: BALANCED,
  max: {
    adm: 5000, daily: 750, period: 31, air: 400, gnd: 400,
    icuA: true, icuD: true, osh: 1000, maj: 500, inv: 500, min: 100, hs: 100,
    rehab: 31, snf: 200, nlt: true, lodge: true, maternity: false, mentalNervous: true,
  },
};

// ─── Rates ───────────────────────────────────────────────────────────────

/** BFLIC eApp line items, NC, age 53, Individual (Nov 10 2026). */
const RATE_53_IND = {
  adm: { at: 5000, monthly: 53.04 },
  daily: { at: 750, monthly: 33.47 }, // at a 15-day benefit period
  er: 2.57,
  uc: 0.54,
  obs: { at: 750, monthly: 3.05 },
  air: { at: 100, monthly: 0.01 },
  gnd: { at: 400, monthly: 2.68 },
  icuA: 0.87,
  icuD: 1.67,
  osh: { at: 1000, monthly: 18.33 },
  maj: { at: 500, monthly: 4.32 },
  inv: { at: 500, monthly: 3.5 },
  min: { at: 100, monthly: 2.44 },
  hs: { at: 100, monthly: 4.44 },
} as const;

/** ESTIMATE: relative cost of a benefit period vs the 15-day line item. */
const PERIOD_FACTOR: Record<BenefitPeriod, number> = {
  1: 0.35, 3: 0.55, 4: 0.59, 5: 0.63, 6: 0.67, 7: 0.72, 8: 0.76, 9: 0.8, 10: 0.85, 15: 1, 21: 1.15, 31: 1.3,
};
/** ESTIMATE: options with no BFLIC line item yet. */
const UNPRICED = {
  rehab15: 1.55, rehab31: 2.6, snfPer100: 3.4, nlt: 1.2, lodge: 1.35, maternity: 18.4, mentalNervous: 6.8,
};
/** ESTIMATE: issue-age curve relative to 53. */
const ageFactor = (age: number): number => Math.pow(1.032, age - 53);
/** ESTIMATE: household tier multipliers. */
const HOUSEHOLD: Record<Household, number> = { ind: 1, sp: 1.85, ch: 1.45, fam: 2.3 };

export interface PriceLine {
  key: string;
  label: string;
  monthly: number;
}

export interface HospitalPrice {
  lines: PriceLine[];
  total: number;
  /** True only when every line is a real BFLIC line item for this build. */
  exact: boolean;
  /** Why the price is an estimate (empty when exact). */
  estimateReasons: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function priceHospital(b: HospitalBenefits, age: number, household: Household): HospitalPrice {
  const reasons: string[] = [];
  if (age !== 53) reasons.push(`age ${age} (real rates only for 53 so far)`);
  if (household !== 'ind') reasons.push(`${HOUSEHOLD_LABEL[household]} tier`);
  const f = ageFactor(age) * HOUSEHOLD[household];
  const lines: PriceLine[] = [];
  const add = (key: string, label: string, base: number) => {
    if (base > 0) lines.push({ key, label, monthly: r2(base * f) });
  };
  const scaled = (key: string, label: string, v: number, ref: { at: number; monthly: number }) => {
    if (v <= 0) return;
    if (v !== ref.at) reasons.push(`${label} ${money0(v)}`);
    add(key, label, (v / ref.at) * ref.monthly);
  };

  scaled('adm', 'Hospital admission', b.adm, RATE_53_IND.adm);
  if (b.daily !== RATE_53_IND.daily.at) reasons.push(`Daily confinement ${money0(b.daily)}`);
  if (b.period !== 15) reasons.push(`${b.period === 1 ? 'first-day' : `${b.period}-day`} benefit period`);
  add('daily', 'Daily hospital confinement', (b.daily / RATE_53_IND.daily.at) * RATE_53_IND.daily.monthly * PERIOD_FACTOR[b.period]);
  add('er', 'Emergency room', RATE_53_IND.er);
  add('uc', 'Urgent care', RATE_53_IND.uc);
  add('obs', 'Observation room', (b.daily / RATE_53_IND.obs.at) * RATE_53_IND.obs.monthly);
  scaled('air', 'Ambulance: air', b.air, RATE_53_IND.air);
  scaled('gnd', 'Ambulance: ground/water', b.gnd, RATE_53_IND.gnd);
  if (b.icuA) add('icuA', 'ICU admission', RATE_53_IND.icuA);
  if (b.icuD) add('icuD', 'Daily ICU confinement', RATE_53_IND.icuD);
  scaled('osh', 'Outpatient surgery', b.osh, RATE_53_IND.osh);
  scaled('maj', 'Major diagnostic exam', b.maj, RATE_53_IND.maj);
  scaled('inv', 'Invasive diagnostic exam', b.inv, RATE_53_IND.inv);
  scaled('min', 'Minor diagnostic exam', b.min, RATE_53_IND.min);
  scaled('hs', 'Health screening', b.hs, RATE_53_IND.hs);

  if (b.rehab) {
    reasons.push('Rehab unit (no BFLIC price yet)');
    add('rehab', `Rehab unit (${b.rehab} days)`, b.rehab === 15 ? UNPRICED.rehab15 : UNPRICED.rehab31);
  }
  if (b.snf) {
    reasons.push('Skilled nursing (no BFLIC price yet)');
    add('snf', 'Skilled nursing confinement', (b.snf / 100) * UNPRICED.snfPer100);
  }
  if (b.nlt) { reasons.push('Non-local transportation (no BFLIC price yet)'); add('nlt', 'Non-local transportation', UNPRICED.nlt); }
  if (b.lodge) { reasons.push('Family lodging (no BFLIC price yet)'); add('lodge', 'Family member lodging', UNPRICED.lodge); }
  if (b.maternity) { reasons.push('Maternity (no BFLIC price yet)'); add('maternity', 'Maternity', UNPRICED.maternity); }
  if (b.mentalNervous) { reasons.push('Mental/nervous & substance abuse (no BFLIC price yet)'); add('mentalNervous', 'Mental/nervous & substance abuse', UNPRICED.mentalNervous); }

  const total = r2(lines.reduce((s, l) => s + l.monthly, 0));
  return { lines, total, exact: reasons.length === 0, estimateReasons: reasons };
}

/** Days the daily benefit pays in a year. */
export const periodDays = (b: Pick<HospitalBenefits, 'period'>): number => b.period;

/** What a stay of `days` pays (ambulance + admission + daily, capped by the yearly period). */
export function stayPays(b: HospitalBenefits, days: number): number {
  return b.adm + b.daily * Math.min(days, b.period);
}

export interface SendCheck {
  ok: boolean;
  reason: string | null;
}

/** Estimated prices never go to a client. */
export function canSend(price: HospitalPrice, age: number | null, state: string | null): SendCheck {
  if (age == null) return { ok: false, reason: 'Enter the client’s age.' };
  if (age < 18 || age > 85) return { ok: false, reason: 'Vantage Flex Plus issues ages 18 to 85.' };
  if (!state || !HOSPITAL_STATES.includes(state as HospitalState)) {
    return { ok: false, reason: 'Pick NC, TX or GA.' };
  }
  if (!price.exact) {
    return {
      ok: false,
      reason: `Estimated price — can't send until the Bankers Fidelity rate manual is loaded (${price.estimateReasons.join('; ')}).`,
    };
  }
  return { ok: true, reason: null };
}

export function money0(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}
export function money2(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
