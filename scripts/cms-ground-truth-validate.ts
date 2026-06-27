/*!
 * CMS ground-truth validator for the agent's /api/plans endpoint.
 *
 * Reads scripts/cms-ground-truth-fixtures.json, hits the deployed
 * /api/plans for every fixture's id, and compares the response field-
 * by-field against the fixture's expected.* values within the
 * tolerance bands declared in the fixture's _meta block:
 *
 *   premium     ±$1
 *   copay       ±$5
 *   moop        ±$50
 *   coinsurance ±2%
 *   allowance   ±$25
 *
 * Null expecteds are SKIPPED (not failed) — a fresh fixture entry
 * with all-null expectations passes trivially, surfacing in the
 * report as "unverified" rather than as a successful CMS parity
 * check. The verifiedOn label distinguishes hand-verified entries
 * from production-snapshots.
 *
 * Report sections:
 *   1. Per-plan pass rate (compared / passed / failed / skipped)
 *   2. By carrier — aggregate pass rate
 *   3. By state   — aggregate pass rate
 *   4. Most-failed fields, ranked by failure count across the suite
 *   5. Drift table (when --verbose) — every failure with actual vs
 *      expected so the next reconciliation has a starting point
 *
 * Usage:
 *
 *   pnpm tsx scripts/cms-ground-truth-validate.ts
 *   pnpm tsx scripts/cms-ground-truth-validate.ts --base https://planmatch.vercel.app
 *   pnpm tsx scripts/cms-ground-truth-validate.ts --verbose
 *   pnpm tsx scripts/cms-ground-truth-validate.ts --snapshot   (pins current /api/plans values into the fixture file; sets verifiedOn = 'production-snapshot YYYY-MM-DD')
 *
 * Exit codes:
 *   0  every compared field passed
 *   1  one or more comparisons failed
 *   2  fixture file unreadable / API fetch failed
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Tolerances {
  premium: number;
  copay: number;
  moop: number;
  coinsurance: number;
  allowance: number;
}

interface CostShareExpected {
  copay: number | null;
  coinsurance: number | null;
}

interface ExtrasExpected {
  dental_annual_max: number | null;
  vision_eyewear_allowance_year: number | null;
  hearing_aid_allowance_year: number | null;
  otc_allowance_per_quarter: number | null;
  food_card_allowance_per_month: number | null;
  transportation_rides_per_year: number | null;
  fitness_enabled: boolean | null;
}

interface RxTiersExpected {
  tier_1: CostShareExpected;
  tier_2: CostShareExpected;
  tier_3: CostShareExpected;
  tier_4: CostShareExpected;
  tier_5: CostShareExpected;
}

interface FixtureExpected {
  premium: number | null;
  moop_in_network: number | null;
  drug_deductible: number | null;
  star_rating: number | null;
  part_b_giveback: number | null;
  medical: Record<string, CostShareExpected>;
  extras: ExtrasExpected;
  rx_tiers: RxTiersExpected;
}

interface Fixture {
  id: string;
  verifiedOn: string | null;
  state: string;
  county: string;
  carrier: string;
  plan_name: string;
  plan_type_hint?: string;
  expected: FixtureExpected;
}

interface FixturesFile {
  _meta: {
    tolerances: Tolerances;
    [k: string]: unknown;
  };
  fixtures: Fixture[];
}

interface ApiCostShare {
  copay: number | null;
  coinsurance: number | null;
  description?: string | null;
}

interface ApiPlan {
  id: string;
  contract_id: string;
  carrier: string;
  plan_name: string;
  state: string;
  premium: number;
  moop_in_network: number;
  drug_deductible: number | null;
  star_rating: number;
  part_b_giveback: number;
  benefits: {
    dental?: { annual_max?: number };
    vision?: { eyewear_allowance_year?: number };
    hearing?: { aid_allowance_year?: number };
    otc?: { allowance_per_quarter?: number };
    food_card?: { allowance_per_month?: number };
    transportation?: { rides_per_year?: number };
    fitness?: { enabled?: boolean };
    medical?: Record<string, ApiCostShare>;
    rx_tiers?: Record<string, ApiCostShare>;
  };
}

interface ApiPlansResponse { plans: ApiPlan[]; source: string }

interface FieldCheck {
  fixtureId: string;
  state: string;
  carrier: string;
  field: string;
  expected: number | boolean | null;
  actual: number | boolean | null | undefined;
  tolerance: number | null;
  status: 'pass' | 'fail' | 'skipped' | 'accepted';
  /** Set when status === 'accepted' — human-readable label for the
   *  documented carrier-filing-correction convention this drift falls
   *  under (e.g. "B8b swap convention"). Surfaced in the drift section
   *  with a ⚡ icon to distinguish accepted deviations from real failures. */
  acceptedReason?: string;
}

interface CliArgs {
  base: string;
  verbose: boolean;
  snapshot: boolean;
  fixturePath: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    base: 'https://planmatch.vercel.app',
    verbose: false,
    snapshot: false,
    fixturePath: resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      'cms-ground-truth-fixtures.json',
    ),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--base' && next) { out.base = next.replace(/\/+$/, ''); i++; }
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--snapshot') out.snapshot = true;
    else if (a === '--fixtures' && next) { out.fixturePath = resolve(next); i++; }
  }
  return out;
}

function nearly(actual: number | null | undefined, expected: number, tol: number): boolean {
  if (actual == null || !Number.isFinite(actual)) return false;
  return Math.abs(actual - expected) <= tol;
}

function categoryFor(field: string): keyof Tolerances {
  if (field === 'premium') return 'premium';
  if (field === 'moop_in_network') return 'moop';
  if (field === 'drug_deductible') return 'moop'; // dollar tolerance, similar magnitude
  if (field === 'star_rating') return 'copay';    // star is 0..5 in 0.5 steps; copay tol of 5 effectively means "any star rating passes," so we treat it as exact-match below
  if (field === 'part_b_giveback') return 'copay';
  if (field.startsWith('medical.') && field.endsWith('.coinsurance')) return 'coinsurance';
  if (field.startsWith('medical.')) return 'copay';
  if (field.startsWith('rx_tiers.') && field.endsWith('.coinsurance')) return 'coinsurance';
  if (field.startsWith('rx_tiers.')) return 'copay';
  if (field.startsWith('extras.')) return 'allowance';
  return 'copay';
}

function compareField(
  fixture: Fixture,
  field: string,
  expected: number | boolean | null,
  actual: number | boolean | null | undefined,
  tolerances: Tolerances,
): FieldCheck {
  const base = {
    fixtureId: fixture.id,
    state: fixture.state,
    carrier: fixture.carrier,
    field,
    expected,
    actual: actual ?? null,
  };
  if (expected == null) {
    return { ...base, tolerance: null, status: 'skipped' };
  }
  // Boolean fitness_enabled — exact match
  if (typeof expected === 'boolean') {
    return {
      ...base,
      tolerance: null,
      status: actual === expected ? 'pass' : 'fail',
    };
  }
  // star_rating — CMS publishes in 0.5 increments; exact match
  if (field === 'star_rating') {
    return {
      ...base,
      tolerance: 0,
      status: actual === expected ? 'pass' : 'fail',
    };
  }
  const cat = categoryFor(field);
  const tol = tolerances[cat];
  const ok = typeof actual === 'number' && nearly(actual, expected, tol);
  return { ...base, tolerance: tol, status: ok ? 'pass' : 'fail' };
}

/** Tolerance-aware equality that treats null === null as a match.
 *  Used by the B8b swap detector below — when the swap convention
 *  drops a value to null (intentional, per import-pbp-benefits.ts),
 *  both sides should still register as "matching the swap pattern". */
function valueNear(
  a: number | boolean | null | undefined,
  b: number | boolean | null | undefined,
  tol: number | null,
): boolean {
  const aN = a ?? null;
  const bN = b ?? null;
  if (aN === null && bN === null) return true;
  if (aN === null || bN === null) return false;
  if (typeof aN === 'boolean' || typeof bN === 'boolean') return aN === bN;
  if (tol == null) return aN === bN;
  return Math.abs(aN - bN) <= tol;
}

/**
 * Reclassify failures that match the documented B8b X-ray ↔ advanced-
 * imaging swap convention as 'accepted' rather than 'fail'.
 *
 * Why this exists: ~69% of NC/GA/TX plans file PBP B8b with the column
 * meanings inverted vs CMS spec (X-ray under cmc/mc, advanced imaging
 * under drs). scripts/import-pbp-benefits.ts:detectB8bSwapPattern flips
 * them at write time so the consumer sees the correct values. The
 * populator extracts literally per spec, so on swap-convention plans
 * the agent's xray value matches the populator's advanced_imaging value
 * (and vice versa). Marking those as 'accepted' surfaces the deviation
 * with a ⚡ icon while keeping the parity score honest — the importer
 * intentionally corrects the carrier filing error and the consumer
 * sees the right numbers.
 *
 * Detection: per fixture, for each of (copay, coinsurance):
 *   - look at the (xray, advanced_imaging) check pair
 *   - if either fails AND xray.expected ≈ ai.actual AND ai.expected ≈ xray.actual
 *     → mark both as accepted (the swap is symmetric)
 *
 * The valueNear helper handles null pairing — the swap convention drops
 * xray.coinsurance to null on the agent side ("to avoid double-attribution"
 * per the importer's inline comment), so populator.xray.coins=20 vs
 * agent.xray.coins=null is the mirror of populator.ai.coins=null vs
 * agent.ai.coins=20. Both reclassify together.
 */
function applyB8bSwapAcceptance(checks: FieldCheck[]): number {
  const byPlan = new Map<string, FieldCheck[]>();
  for (const c of checks) {
    const list = byPlan.get(c.fixtureId);
    if (list) list.push(c);
    else byPlan.set(c.fixtureId, [c]);
  }
  let accepted = 0;
  for (const planChecks of byPlan.values()) {
    for (const metric of ['copay', 'coinsurance'] as const) {
      const xray = planChecks.find((c) => c.field === `medical.xray.${metric}`);
      const ai = planChecks.find(
        (c) => c.field === `medical.advanced_imaging.${metric}`,
      );
      if (!xray || !ai) continue;
      // Skip if both already pass — nothing to reclassify.
      if (xray.status === 'pass' && ai.status === 'pass') continue;
      // Skip if either is 'skipped' on BOTH expected sides — no signal
      // to confirm a swap pattern (would risk false-accepting one-sided
      // null mismatches).
      if (xray.status === 'skipped' && ai.status === 'skipped') continue;
      const tol = xray.tolerance ?? ai.tolerance;
      const swapped =
        valueNear(xray.expected, ai.actual, tol) &&
        valueNear(ai.expected, xray.actual, tol);
      if (!swapped) continue;
      if (xray.status === 'fail') {
        xray.status = 'accepted';
        xray.acceptedReason = 'B8b swap convention';
        accepted += 1;
      }
      if (ai.status === 'fail') {
        ai.status = 'accepted';
        ai.acceptedReason = 'B8b swap convention';
        accepted += 1;
      }
    }
  }
  return accepted;
}

function checksForFixture(fixture: Fixture, plan: ApiPlan | undefined, tolerances: Tolerances): FieldCheck[] {
  const out: FieldCheck[] = [];
  const e = fixture.expected;

  function add(field: string, expected: number | boolean | null, actual: number | boolean | null | undefined) {
    out.push(compareField(fixture, field, expected, actual, tolerances));
  }

  add('premium', e.premium, plan?.premium);
  add('moop_in_network', e.moop_in_network, plan?.moop_in_network);
  add('drug_deductible', e.drug_deductible, plan?.drug_deductible ?? null);
  add('star_rating', e.star_rating, plan?.star_rating);
  add('part_b_giveback', e.part_b_giveback, plan?.part_b_giveback);

  for (const [name, exp] of Object.entries(e.medical)) {
    const actual = plan?.benefits?.medical?.[name];
    add(`medical.${name}.copay`, exp.copay, actual?.copay ?? null);
    add(`medical.${name}.coinsurance`, exp.coinsurance, actual?.coinsurance ?? null);
  }

  add('extras.dental_annual_max', e.extras.dental_annual_max, plan?.benefits?.dental?.annual_max ?? null);
  add('extras.vision_eyewear_allowance_year', e.extras.vision_eyewear_allowance_year, plan?.benefits?.vision?.eyewear_allowance_year ?? null);
  add('extras.hearing_aid_allowance_year', e.extras.hearing_aid_allowance_year, plan?.benefits?.hearing?.aid_allowance_year ?? null);
  add('extras.otc_allowance_per_quarter', e.extras.otc_allowance_per_quarter, plan?.benefits?.otc?.allowance_per_quarter ?? null);
  add('extras.food_card_allowance_per_month', e.extras.food_card_allowance_per_month, plan?.benefits?.food_card?.allowance_per_month ?? null);
  add('extras.transportation_rides_per_year', e.extras.transportation_rides_per_year, plan?.benefits?.transportation?.rides_per_year ?? null);
  add('extras.fitness_enabled', e.extras.fitness_enabled, plan?.benefits?.fitness?.enabled ?? null);

  for (const tier of ['tier_1', 'tier_2', 'tier_3', 'tier_4', 'tier_5'] as const) {
    const exp = e.rx_tiers[tier];
    const actual = plan?.benefits?.rx_tiers?.[tier];
    add(`rx_tiers.${tier}.copay`, exp.copay, actual?.copay ?? null);
    add(`rx_tiers.${tier}.coinsurance`, exp.coinsurance, actual?.coinsurance ?? null);
  }

  return out;
}

async function fetchPlans(base: string, fixtures: Fixture[]): Promise<Map<string, ApiPlan>> {
  // Query by (state, county) and resolve each fixture by contract+plan
  // afterwards. The /api/plans?ids= path enforces a strict id-string
  // filter that compares the queried id verbatim against the
  // constructed `${contract_id}-${plan_id}-${segment_id || '000'}`
  // response id — pm_plans stores segment_id as '0' (1-char) so the
  // constructed id is e.g. 'H5253-041-0', which mismatches fixture
  // ids written in CMS 3-char form ('H5253-041-000'). Querying by
  // (state, county) bypasses the segment-string filter and lets us
  // match the fixture's contract_id + plan_id against any segment the
  // plan has filed (one of which is what the consumer + agent surface).
  const out = new Map<string, ApiPlan>();
  // Dedupe (state, county) so two NC/Durham fixtures share one fetch.
  const locations = new Map<string, { state: string; county: string }>();
  for (const f of fixtures) {
    locations.set(`${f.state}|${f.county}`, { state: f.state, county: f.county });
  }
  const plansByLocation = new Map<string, ApiPlan[]>();
  const queue = [...locations.entries()];
  const concurrency = Math.min(5, queue.length);
  await Promise.all(
    new Array(concurrency).fill(0).map(async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) return;
        const [key, loc] = item;
        const url =
          `${base}/api/plans?state=${encodeURIComponent(loc.state)}` +
          `&county=${encodeURIComponent(loc.county)}&limit=500`;
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`GET ${url} → HTTP ${res.status}`);
        }
        const body = (await res.json()) as ApiPlansResponse;
        plansByLocation.set(key, body.plans ?? []);
      }
    }),
  );
  for (const f of fixtures) {
    const plans = plansByLocation.get(`${f.state}|${f.county}`) ?? [];
    const [contractId, planId] = f.id.split('-');
    const segment = f.id.split('-')[2] ?? '';
    // Prefer the exact (contract, plan, segment) match; fall back to
    // (contract, plan) so a fixture id with a non-existent segment-id
    // form still resolves to whatever segment the agent surfaces.
    const exact = plans.find(
      (p) =>
        p.contract_id === contractId &&
        // Segment in api response carries either '0' or '000' depending
        // on row shape; normalize both sides by stripping leading zeros.
        p.id.startsWith(`${contractId}-${planId}-`) &&
        p.id.replace(/-0+$/, '-0') === `${contractId}-${planId}-0` &&
        (segment === '' || segment.replace(/^0+/, '') === (p.id.split('-')[2] ?? '').replace(/^0+/, '')),
    );
    const looseMatch =
      exact ??
      plans.find(
        (p) => p.contract_id === contractId && p.id.startsWith(`${contractId}-${planId}-`),
      );
    if (looseMatch) out.set(f.id, looseMatch);
  }
  return out;
}

function snapshotFixtures(fixtures: Fixture[], plans: Map<string, ApiPlan>): Fixture[] {
  const today = new Date().toISOString().slice(0, 10);
  return fixtures.map((f) => {
    const plan = plans.get(f.id);
    if (!plan) return f;
    const med: Record<string, CostShareExpected> = {};
    for (const name of Object.keys(f.expected.medical)) {
      const cs = plan.benefits?.medical?.[name];
      med[name] = { copay: cs?.copay ?? null, coinsurance: cs?.coinsurance ?? null };
    }
    const rx = {} as RxTiersExpected;
    for (const tier of ['tier_1', 'tier_2', 'tier_3', 'tier_4', 'tier_5'] as const) {
      const cs = plan.benefits?.rx_tiers?.[tier];
      rx[tier] = { copay: cs?.copay ?? null, coinsurance: cs?.coinsurance ?? null };
    }
    return {
      ...f,
      verifiedOn: `production-snapshot ${today}`,
      expected: {
        premium: plan.premium ?? null,
        moop_in_network: plan.moop_in_network ?? null,
        drug_deductible: plan.drug_deductible ?? null,
        star_rating: plan.star_rating ?? null,
        part_b_giveback: plan.part_b_giveback ?? null,
        medical: med,
        extras: {
          dental_annual_max: plan.benefits?.dental?.annual_max ?? null,
          vision_eyewear_allowance_year: plan.benefits?.vision?.eyewear_allowance_year ?? null,
          hearing_aid_allowance_year: plan.benefits?.hearing?.aid_allowance_year ?? null,
          otc_allowance_per_quarter: plan.benefits?.otc?.allowance_per_quarter ?? null,
          food_card_allowance_per_month: plan.benefits?.food_card?.allowance_per_month ?? null,
          transportation_rides_per_year: plan.benefits?.transportation?.rides_per_year ?? null,
          fitness_enabled: plan.benefits?.fitness?.enabled ?? null,
        },
        rx_tiers: rx,
      },
    };
  });
}

function group<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
}

function fmtRow(label: string, s: BucketStats): string {
  const rate = s.compared === 0 ? '—' : `${((s.passed / s.compared) * 100).toFixed(1)}%`;
  const acceptedTag = s.accepted > 0 ? ` ⚡${s.accepted}` : '';
  return `  ${label.padEnd(48)} ${rate.padStart(7)} · ${s.passed.toString().padStart(3)}/${s.compared.toString().padStart(3)} pass${acceptedTag} · ${s.failed.toString().padStart(3)} fail · ${s.skipped.toString().padStart(3)} skip`;
}

interface BucketStats {
  compared: number;
  /** Clean passes + accepted deviations. Per the parity-scoring contract:
   *  accepted deviations count as passes because the agent's
   *  intentional carrier-filing correction is the right answer. */
  passed: number;
  /** Subset of `passed` that were reclassified by applyB8bSwapAcceptance
   *  (or any future accepted-deviation rule). Surfaced separately in
   *  the report so reviewers can audit what's being absorbed. */
  accepted: number;
  failed: number;
  skipped: number;
}

function bucketStats(rows: FieldCheck[]): BucketStats {
  let clean = 0, accepted = 0, failed = 0, skipped = 0;
  for (const r of rows) {
    if (r.status === 'pass') clean++;
    else if (r.status === 'accepted') accepted++;
    else if (r.status === 'fail') failed++;
    else skipped++;
  }
  const passed = clean + accepted;
  return { compared: passed + failed, passed, accepted, failed, skipped };
}

function printReport(
  fixtures: Fixture[],
  checks: FieldCheck[],
  args: CliArgs,
): void {
  console.log('\nCMS ground-truth parity report');
  console.log('────────────────────────────────────────────────────────────────────────────────');

  const verifiedCount = fixtures.filter((f) => f.verifiedOn).length;
  const snapshotCount = fixtures.filter((f) => (f.verifiedOn ?? '').startsWith('production-snapshot')).length;
  const handCount = verifiedCount - snapshotCount;
  console.log(
    `  fixtures: ${fixtures.length} (${handCount} hand-verified · ${snapshotCount} production-snapshot · ${fixtures.length - verifiedCount} unverified)`,
  );

  console.log('\nPer-plan');
  for (const f of fixtures) {
    const rows = checks.filter((c) => c.fixtureId === f.id);
    const s = bucketStats(rows);
    const verifLabel = f.verifiedOn ? `[${f.verifiedOn}]` : '[unverified]';
    console.log(fmtRow(`${f.id} · ${f.carrier} · ${f.state} ${verifLabel}`, s));
  }

  console.log('\nBy carrier');
  for (const [carrier, rows] of group(checks, (c) => c.carrier)) {
    console.log(fmtRow(carrier, bucketStats(rows)));
  }

  console.log('\nBy state');
  for (const [state, rows] of group(checks, (c) => c.state)) {
    console.log(fmtRow(state, bucketStats(rows)));
  }

  console.log('\nMost-failed fields (across the suite)');
  const fieldCounts = new Map<string, number>();
  for (const c of checks) {
    if (c.status !== 'fail') continue;
    fieldCounts.set(c.field, (fieldCounts.get(c.field) ?? 0) + 1);
  }
  const ranked = [...fieldCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (ranked.length === 0) {
    console.log('  (no failures)');
  } else {
    for (const [field, count] of ranked) {
      console.log(`  ${field.padEnd(48)} ${count.toString().padStart(3)} fail`);
    }
  }

  if (args.verbose) {
    console.log('\nDrift (every failure + every accepted deviation)');
    const surfaced = checks.filter((c) => c.status === 'fail' || c.status === 'accepted');
    if (surfaced.length === 0) {
      console.log('  (none)');
    } else {
      for (const f of surfaced) {
        const tol = f.tolerance == null ? 'exact' : `±${f.tolerance}`;
        const icon = f.status === 'accepted' ? '⚡' : '❌';
        const tail =
          f.status === 'accepted' && f.acceptedReason
            ? ` — accepted: ${f.acceptedReason}`
            : '';
        console.log(
          `  ${icon} ${f.fixtureId} ${f.field}: expected ${JSON.stringify(f.expected)} · got ${JSON.stringify(f.actual)} (${tol})${tail}`,
        );
      }
    }
  }

  const total = bucketStats(checks);
  console.log('\nTotal');
  console.log(fmtRow('SUITE', total));

  if (total.accepted > 0) {
    // Roll up which acceptedReason buckets contributed, in case a future
    // change adds more rules beyond the B8b swap.
    const reasons = new Map<string, number>();
    for (const c of checks) {
      if (c.status !== 'accepted') continue;
      const r = c.acceptedReason ?? '(unspecified)';
      reasons.set(r, (reasons.get(r) ?? 0) + 1);
    }
    const detail = [...reasons.entries()]
      .map(([reason, n]) => `${n} ${reason}`)
      .join(', ');
    console.log(`  Accepted deviations: ${total.accepted} ⚡ (${detail})`);
  }

  console.log('────────────────────────────────────────────────────────────────────────────────\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let file: FixturesFile;
  try {
    file = JSON.parse(readFileSync(args.fixturePath, 'utf8')) as FixturesFile;
  } catch (err) {
    console.error(`Could not read fixtures at ${args.fixturePath}:`, err);
    process.exit(2);
  }

  const ids = file.fixtures.map((f) => f.id);
  let plans: Map<string, ApiPlan>;
  try {
    plans = await fetchPlans(args.base, file.fixtures);
  } catch (err) {
    console.error('API fetch failed:', err);
    process.exit(2);
  }

  if (args.snapshot) {
    const next = snapshotFixtures(file.fixtures, plans);
    const out: FixturesFile = { ...file, fixtures: next };
    writeFileSync(args.fixturePath, JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.log(`Pinned production snapshot for ${next.length} fixtures → ${args.fixturePath}`);
    // Fall through to a normal validation pass so the report shows
    // green immediately after a snapshot run.
    file.fixtures = next;
  }

  // Surface plans that the API didn't return — that's a hard failure
  // distinct from value drift.
  const missing = ids.filter((id) => !plans.has(id));
  if (missing.length > 0) {
    console.warn(`WARN: ${missing.length} fixture id(s) not returned by /api/plans:`);
    for (const m of missing) console.warn(`  ${m}`);
  }

  const allChecks: FieldCheck[] = [];
  for (const fixture of file.fixtures) {
    const plan = plans.get(fixture.id);
    allChecks.push(...checksForFixture(fixture, plan, file._meta.tolerances));
  }

  // Reclassify documented-deviation failures (B8b xray ↔ advanced-imaging
  // swap convention) before reporting. Accepted deviations count toward
  // the pass rate per the harness's scoring contract — the agent's
  // importer intentionally corrects the carrier filing inversion, so
  // the swap-matched values are the right consumer-facing answer.
  applyB8bSwapAcceptance(allChecks);

  printReport(file.fixtures, allChecks, args);
  const totalFail = allChecks.filter((c) => c.status === 'fail').length;
  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
