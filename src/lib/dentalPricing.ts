// Dental quote pricing — pure functions shared by the agent-v3 Dental screen
// and its test (scripts/tests/dental-pricing.test.ts).
//
// The rate table (pm_dental_rate) is uneven by design: carriers publish
// prices in different shapes, and we only store what a carrier actually
// showed. A row can be:
//   • statewide          — zip null, zip_prefixes null
//   • ZIP-area rated      — zip_prefixes = ['270','271',…] (Delta NC EHB)
//   • one quoted ZIP      — zip = '27713' (a quote run for one address)
//   • age-banded          — age_min/age_max range
//   • one quoted age      — age_min = age_max (a quote run for one DOB)
//
// Rule: never invent a price. When the client doesn't match what was quoted
// (different age, different ZIP), we still show the quoted price but flag it
// so the broker knows to re-quote before presenting it as the client's rate.

export type DentalTier = 'individual' | 'self_plus_1' | 'self_plus_2_or_more' | 'family' | 'dependent';

// How a carrier prices more than one person (pm_dental_plan.household_pricing):
//   tier       — flat household tiers in pm_dental_rate.tier (Ameritas, MetLife,
//                Delta EHB). Missing column on older rows = tier.
//   sum_by_age — each person pays their own age rate; couple = primary +
//                spouse × (1 − spouse_discount_pct). Confirmed against carrier
//                quotes 2026-10-17 (Guardian, Cigna, BCBS NC, Delta non-EHB).
//                Children (under 19): each child pays the plan's age-18 rate,
//                with the same dependent discount — confirmed by quotes for
//                Guardian, Cigna (incl. a family of 4) and BCBS; Delta publishes
//                its 0–18 rate equal to 18–64. spouse_discount_pct applies to
//                every dependent (Cigna: spouse and children both 15%).
//                A tier 'dependent' row, when present, prices every dependent
//                instead (Guardian Select: flat rate, primary must be 50+).
//   sum_by_age_adults — same as sum_by_age but only adults are confirmed
//                (Humana: "per individual" rates, no child rate shown).
//                Children → needs_quote.
export type HouseholdPricing = 'tier' | 'sum_by_age' | 'sum_by_age_adults';

export interface DentalRate {
  zip: string | null;
  zip_prefixes: string[] | null;
  age_min: number | null;
  age_max: number | null;
  tier: string;
  monthly_premium: number;
  is_starting_at: boolean;
}

export interface DentalPlan {
  id: string;
  carrier: string;
  plan_name: string;
  state: string;
  plan_type: string;
  is_insurance: boolean;
  network: string | null;
  annual_max: string | null;
  deductible: string | null;
  waiting_period: string | null;
  preventive: string | null;
  basic: string | null;
  major: string | null;
  orthodontia: string | null;
  implants: string | null;
  dentures: string | null;
  crowns: string | null;
  root_canals: string | null;
  periodontics: string | null;
  oral_surgery: string | null;
  waiting_waiver: string | null;
  missing_tooth_clause: string | null;
  eligibility: string | null;
  extras: string | null;
  covers_implants: boolean | null;
  covers_major: boolean | null;
  no_waiting: boolean | null;
  source_doc: string | null;
  source_url: string | null;
  captured_at: string;
  implant_wait_months?: number | null;
  household_pricing?: HouseholdPricing;
  spouse_discount_pct?: number | null;
  rates: DentalRate[];
}

export type PriceFlag =
  | 'quoted_other_age'   // only quoted at a single different age
  | 'quoted_other_zip'   // only quoted for a single different ZIP
  | 'starting_at';       // carrier published a floor price, not a quote

export type PriceResult =
  | { kind: 'price'; monthly: number; flags: PriceFlag[]; quotedAge: number | null; quotedZip: string | null }
  | { kind: 'ineligible'; minAge: number }   // client under the plan's minimum age
  | { kind: 'no_tier' }                      // plan has rates, but not for this household size
  | { kind: 'no_rate' }                      // nothing quoted yet
  | { kind: 'needs_quote'; reason: 'spouse_age' | 'children' }; // per-person plan we can't price

export interface Household {
  /** undefined = no spouse; null = spouse covered but age not entered */
  spouseAge?: number | null;
  /** children under 19 */
  children: number;
}

export interface PriceInput {
  age: number | null;
  zip: string | null;
  /** Legacy single-select tier. Ignored when `household` is given. */
  tier?: DentalTier;
  household?: Household;
}

export function householdTier(h: Household): DentalTier {
  const size = 1 + (h.spouseAge !== undefined ? 1 : 0) + Math.max(0, h.children);
  return size === 1 ? 'individual' : size === 2 ? 'self_plus_1' : 'self_plus_2_or_more';
}

const cents = (n: number) => Math.round(n * 100 + 1e-9) / 100;

// Per-person carriers charge a child under 19 their age-18 rate (see header).
const CHILD_RATE_AGE = 18;

function zipMatches(r: DentalRate, zip: string | null): 'exact' | 'statewide' | 'other' {
  if (r.zip_prefixes && r.zip_prefixes.length) {
    return zip && r.zip_prefixes.includes(zip.slice(0, 3)) ? 'exact' : 'other';
  }
  if (r.zip) return zip === r.zip ? 'exact' : 'other';
  return 'statewide';
}

function ageMatches(r: DentalRate, age: number | null): boolean {
  if (age == null) return r.age_min == null && r.age_max == null;
  return (r.age_min == null || age >= r.age_min) && (r.age_max == null || age <= r.age_max);
}

const isPointAge = (r: DentalRate) => r.age_min != null && r.age_min === r.age_max;

export function priceDentalPlan(
  plan: Pick<DentalPlan, 'rates'> & Partial<Pick<DentalPlan, 'household_pricing' | 'spouse_discount_pct'>>,
  input: PriceInput,
): PriceResult {
  const h = input.household;
  const perPerson = plan.household_pricing === 'sum_by_age' || plan.household_pricing === 'sum_by_age_adults';
  if (h && perPerson && householdTier(h) !== 'individual') {
    if (plan.household_pricing === 'sum_by_age_adults' && h.children > 0) return { kind: 'needs_quote', reason: 'children' };
    if (h.spouseAge === null) return { kind: 'needs_quote', reason: 'spouse_age' };
    const primary = priceOne(plan, { age: input.age, zip: input.zip, tier: 'individual' });
    if (primary.kind !== 'price') return primary;
    const hasDependentRow = plan.rates.some((r) => r.tier === 'dependent');
    const dependent = (age: number) =>
      hasDependentRow
        ? priceOne(plan, { age: null, zip: input.zip, tier: 'dependent' })
        : priceOne(plan, { age, zip: input.zip, tier: 'individual' });
    const deps: PriceResult[] = [];
    if (h.spouseAge !== undefined) {
      const s = dependent(h.spouseAge);
      if (s.kind !== 'price') return { kind: 'needs_quote', reason: 'spouse_age' };
      deps.push(s);
    }
    for (let i = 0; i < h.children; i++) {
      const c = dependent(CHILD_RATE_AGE);
      if (c.kind !== 'price') return c;
      deps.push(c);
    }
    const disc = Number(plan.spouse_discount_pct ?? 0);
    let total = primary.monthly;
    const flags = new Set(primary.flags);
    for (const d of deps) {
      if (d.kind !== 'price') continue;
      total += cents(d.monthly * (1 - disc / 100));
      d.flags.forEach((f) => flags.add(f));
    }
    return { kind: 'price', monthly: cents(total), flags: [...flags], quotedAge: primary.quotedAge, quotedZip: primary.quotedZip };
  }
  const tier = h ? householdTier(h) : input.tier ?? 'individual';
  return priceOne(plan, { age: input.age, zip: input.zip, tier });
}

function priceOne(
  plan: Pick<DentalPlan, 'rates'>,
  input: { age: number | null; zip: string | null; tier: DentalTier },
): PriceResult {
  if (!plan.rates.length) return { kind: 'no_rate' };
  // Carriers name the 3+ household tier differently: MetLife "Self + 2 or
  // more", Delta "Family" (subscriber + 2 or more). Same household.
  const tierRows = plan.rates.filter(
    (r) => r.tier === input.tier || (input.tier === 'self_plus_2_or_more' && r.tier === 'family'),
  );
  if (!tierRows.length) return { kind: 'no_tier' };

  // ZIP: prefer an area/ZIP-specific row for this client, then statewide
  // rows. ZIP-area rows for OTHER areas are dropped when a statewide
  // fallback exists (Delta EHB "all other NC ZIPs"). A single quoted ZIP
  // that isn't the client's is kept but flagged.
  const exact = tierRows.filter((r) => zipMatches(r, input.zip) === 'exact');
  const statewide = tierRows.filter((r) => zipMatches(r, input.zip) === 'statewide');
  const otherZip = tierRows.filter((r) => zipMatches(r, input.zip) === 'other' && !(r.zip_prefixes && r.zip_prefixes.length));
  const pool = exact.length ? exact : statewide.length ? statewide : otherZip;
  if (!pool.length) return { kind: 'no_rate' };

  const flags: PriceFlag[] = [];
  let row = pool.find((r) => ageMatches(r, input.age));

  if (!row) {
    const ranged = pool.filter((r) => !isPointAge(r) && r.age_min != null);
    if (input.age != null && ranged.length && ranged.every((r) => input.age! < (r.age_min as number))) {
      return { kind: 'ineligible', minAge: Math.min(...ranged.map((r) => r.age_min as number)) };
    }
    // Only single-age quotes exist (e.g. quoted at 66): show the closest one, flagged.
    const points = pool.filter(isPointAge);
    if (points.length) {
      const target = input.age ?? (points[0].age_min as number);
      row = points.reduce((a, b) =>
        Math.abs((a.age_min as number) - target) <= Math.abs((b.age_min as number) - target) ? a : b,
      );
      flags.push('quoted_other_age');
    } else {
      // An age band gap (e.g. a carrier step we couldn't confirm). Don't guess.
      return { kind: 'no_rate' };
    }
  }

  if (row.zip && row.zip !== input.zip) flags.push('quoted_other_zip');
  if (row.is_starting_at) flags.push('starting_at');

  return {
    kind: 'price',
    monthly: Number(row.monthly_premium),
    flags,
    quotedAge: isPointAge(row) ? row.age_min : null,
    quotedZip: row.zip,
  };
}

// Missing-tooth rule (pm_dental_plan.missing_tooth_clause), stored as
// "<status>: <plain-English detail>":
//   No:  — replaces teeth already missing at enrollment
//   Yes: — won't replace teeth missing/pulled before the plan started
//   N/A: — plan doesn't cover tooth replacement at all
//   anything else (Unconfirmed:, blank) — not confirmed; never treat as covered
export type MissingToothStatus = 'replaces' | 'excludes' | 'na' | 'unknown';

export function missingToothStatus(clause: string | null | undefined): MissingToothStatus {
  if (!clause) return 'unknown';
  if (/^No:/.test(clause)) return 'replaces';
  if (/^Yes:/.test(clause)) return 'excludes';
  if (/^N\/A:/.test(clause)) return 'na';
  return 'unknown';
}

export function ageFromDob(dob: string | null | undefined, today = new Date()): number | null {
  if (!dob) return null;
  // Accept YYYY-MM-DD or MM/DD/YYYY.
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dob);
  if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; }
  else if (us) { y = +us[3]; m = +us[1]; d = +us[2]; }
  else return null;
  let age = today.getFullYear() - y;
  if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age--;
  return age >= 0 && age < 120 ? age : null;
}
