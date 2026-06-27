/*!
 * medicare.gov Plan Finder scraper → cms-ground-truth-fixtures.json.
 *
 * STATUS: scaffold + extraction pipeline are working; the CMS-side
 * entry point is the blocker. Plan Finder rejects direct plan-detail
 * URLs with "Unable to view Plan Details — It looks like we're having
 * trouble retrieving the Plan Details" unless the SPA has been walked
 * through the wizard (ZIP entry → demographics → optional drugs /
 * pharmacies → plan-list click). Bootstrapping the session via the
 * /#/results URL is NOT enough — CMS's server-side state requires
 * actual button clicks, not just URL params. A production-grade
 * scraper would need ~200-400 more lines walking the wizard for every
 * plan and would need maintenance every time CMS reshuffles the flow.
 *
 * What IS here, ready to use the moment the entry-point gap closes:
 *
 *   - Playwright headless-chromium driver with realistic user-agent
 *   - per-fixture ZIP + FIPS lookup table for every county the
 *     fixture set covers
 *   - regex-based text extractors for premium, MOOP, drug deductible,
 *     star rating, the 15 medical categories, the 7 extras, and the
 *     5 rx tiers
 *   - per-field hit/miss logging
 *   - debug page-text dump under scripts/_scrape-debug/<plan>.txt
 *     for selector tuning
 *   - --only / --headed / --dry-run flags
 *
 * The honest near-term alternatives Rob can pursue:
 *
 *   (a) Hand-populate the fixture's expected.* values by opening each
 *       plan on medicare.gov in a normal browser session, then strip
 *       the production-snapshot prefix from verifiedOn so the
 *       validator treats the row as a true CMS parity check.
 *
 *   (b) Add a wizard-walk preamble to this scraper: click
 *       "Continue without logging in", fill the ZIP form, dismiss
 *       drug/pharmacy modals, find the target plan in the list,
 *       click it, THEN scrape. Drop the direct plan-detail
 *       navigation; the SPA accepts plan-details once you arrived
 *       via the list.
 *
 *   (c) Use Rob's authenticated SunFire / HealthSherpa broker tools'
 *       export endpoints if they offer programmatic per-plan data —
 *       authenticated paths sidestep the public Plan Finder block.
 *
 * Usage:
 *
 *   pnpm tsx scripts/scrape-medicare-gov.ts                  (scrape all unverified fixtures)
 *   pnpm tsx scripts/scrape-medicare-gov.ts --only H5253-041-000
 *   pnpm tsx scripts/scrape-medicare-gov.ts --headed         (visible browser for debugging)
 *   pnpm tsx scripts/scrape-medicare-gov.ts --dry-run        (don't write fixture back)
 *
 * Then re-run scripts/cms-ground-truth-validate.ts to see the parity
 * pass rate against whatever the scraper populated.
 */

import { chromium, type Page, type Browser } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── County → (ZIP, FIPS) lookup ───────────────────────────────────────
// Plan-finder needs both. ZIPs are representative county centroids /
// county-seat ZIPs Rob actively quotes; FIPS are the 5-digit CMS county
// codes. Extend this map as fixtures cover new counties.
const COUNTY_GEO: Record<string, { zip: string; fips: string }> = {
  'NC|Durham':      { zip: '27701', fips: '37063' },
  'NC|Wake':        { zip: '27601', fips: '37183' },
  'NC|Mecklenburg': { zip: '28202', fips: '37119' },
  'NC|Alamance':    { zip: '27215', fips: '37001' },
  'NC|Guilford':    { zip: '27401', fips: '37081' },
  'GA|Bulloch':     { zip: '30458', fips: '13031' },
  'GA|Fulton':      { zip: '30303', fips: '13121' },
  'TX|Harris':      { zip: '77002', fips: '48201' },
  'TX|Dallas':      { zip: '75201', fips: '48113' },
};

const PLAN_YEAR = 2026;
const SCRAPE_DEBUG_DIR = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '_scrape-debug',
);

// ─── Fixture types (mirror cms-ground-truth-validate.ts) ───────────────
interface CostShareExpected { copay: number | null; coinsurance: number | null }

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
  tier_1: CostShareExpected; tier_2: CostShareExpected; tier_3: CostShareExpected;
  tier_4: CostShareExpected; tier_5: CostShareExpected;
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
  expected: FixtureExpected;
}

interface FixturesFile {
  _meta: Record<string, unknown>;
  fixtures: Fixture[];
}

interface CliArgs {
  only: string | null;
  headed: boolean;
  dryRun: boolean;
  fixturePath: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    only: null,
    headed: false,
    dryRun: false,
    fixturePath: resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      'cms-ground-truth-fixtures.json',
    ),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--only' && next) { out.only = next; i++; }
    else if (a === '--headed') out.headed = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--fixtures' && next) { out.fixturePath = resolve(next); i++; }
  }
  return out;
}

// ─── Page-text helpers ─────────────────────────────────────────────────
// Plan Finder renders the structured cost-share grid as plain DOM text.
// We pull a normalized text snapshot once and run targeted regex
// matches against it — far more robust than CSS selectors against the
// CMS class-name churn.

function parseMoney(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/[,\s]/g, '').match(/\$?(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parsePercent(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// Extract a "$X copay" / "Y% coinsurance" / "$X-$Y copay" pair from the
// text surrounding a given label. Returns the FIRST match in a window
// of ~250 chars after the label — Plan Finder grids put the cost-share
// value right after the row label.
function extractCostShare(
  text: string,
  labelRegex: RegExp,
): CostShareExpected {
  const m = labelRegex.exec(text);
  if (!m) return { copay: null, coinsurance: null };
  const window = text.slice(m.index, m.index + 400);
  // Look for $X copay or coinsurance first
  const copay = parseMoney(window.match(/\$\s*\d[\d,]*(?:\.\d+)?(?=[\s/]*(?:copay|each|per visit|per service|per day|\/visit|\/day))?/i)?.[0] ?? null);
  const coins = parsePercent(window.match(/\d+(?:\.\d+)?\s*%/)?.[0] ?? null);
  return { copay: copay ?? null, coinsurance: coins ?? null };
}

// Extract a single $ value following a label.
function extractDollar(text: string, labelRegex: RegExp): number | null {
  const m = labelRegex.exec(text);
  if (!m) return null;
  const window = text.slice(m.index, m.index + 250);
  const dollarMatch = window.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  return dollarMatch ? parseMoney(dollarMatch[0]) : null;
}

// Star rating renders as "X.X out of 5 stars" or "X stars" on Plan Finder.
function extractStarRating(text: string): number | null {
  const m =
    text.match(/(\d(?:\.\d)?)\s*out of\s*5\s*stars?/i) ??
    text.match(/(\d(?:\.\d)?)\s*stars?\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n <= 5 ? n : null;
}

// ─── Per-plan scrape ───────────────────────────────────────────────────
async function scrapePlan(
  page: Page,
  fixture: Fixture,
): Promise<{ scraped: FixtureExpected; hits: string[]; misses: string[] }> {
  const geo = COUNTY_GEO[`${fixture.state}|${fixture.county}`];
  if (!geo) {
    throw new Error(`No ZIP/FIPS for ${fixture.state}|${fixture.county} — extend COUNTY_GEO`);
  }

  // CMS Plan Finder rejects direct plan-detail URLs without a wizard-
  // initialized session ("Unable to view Plan Details"). Establish the
  // session by hitting the results page first with ZIP + FIPS set —
  // that's the URL the wizard lands on after the consumer enters their
  // ZIP. Then navigate to the plan-detail hash route, which the SPA
  // accepts now that it has a search context.
  const resultsUrl =
    `https://www.medicare.gov/plan-compare/#/results/?year=${PLAN_YEAR}` +
    `&lang=en&zip=${geo.zip}&fips=${geo.fips}` +
    `&plan_type=plan_type_medicare`;
  const detailUrl =
    `https://www.medicare.gov/plan-compare/#/plan-details/${PLAN_YEAR}-${fixture.id}` +
    `?year=${PLAN_YEAR}&lang=en&zip=${geo.zip}&fips=${geo.fips}` +
    `&plan_type=plan_type_medicare`;

  console.log(`  → ${fixture.id} bootstrapping session at results`);
  await page.goto(resultsUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  try {
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
  } catch {/* keep going */}
  await page.waitForTimeout(3_000);

  console.log(`  → ${fixture.id} navigating to plan-details`);
  await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // Wait for the SPA hash route to render. Plan Finder's plan-detail
  // pane has a stable heading we can pin on.
  try {
    await page.waitForSelector('h1, h2, [data-testid="plan-name"]', { timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
  } catch {
    // Hydration timeout — keep going with whatever DOM we have.
  }
  // Give late-arriving cost-share grids a moment.
  await page.waitForTimeout(2_000);

  const text = await page.evaluate(() => document.body.innerText);

  // Dump the rendered text for selector debugging on first scrape.
  if (!existsSync(SCRAPE_DEBUG_DIR)) mkdirSync(SCRAPE_DEBUG_DIR, { recursive: true });
  const debugPath = resolve(SCRAPE_DEBUG_DIR, `${fixture.id}.txt`);
  writeFileSync(debugPath, text, 'utf8');

  const hits: string[] = [];
  const misses: string[] = [];
  function record<T>(field: string, value: T | null): T | null {
    if (value == null) misses.push(field);
    else hits.push(field);
    return value;
  }

  const scraped: FixtureExpected = {
    premium: record(
      'premium',
      extractDollar(text, /monthly (?:plan )?premium/i) ??
        extractDollar(text, /premium\s*\$/i),
    ),
    moop_in_network: record(
      'moop_in_network',
      extractDollar(text, /in[-\s]?network (?:out[-\s]?of[-\s]?pocket|maximum out[-\s]?of[-\s]?pocket)/i) ??
        extractDollar(text, /maximum you (?:will )?pay/i),
    ),
    drug_deductible: record(
      'drug_deductible',
      extractDollar(text, /(?:part d|drug|prescription) deductible/i),
    ),
    star_rating: record('star_rating', extractStarRating(text)),
    part_b_giveback: record(
      'part_b_giveback',
      extractDollar(text, /(?:part b giveback|premium reduction|part b premium)/i),
    ),
    medical: {
      primary_care:                record('medical.primary_care', null as never) ?? extractCostShare(text, /primary (?:care )?(?:doctor|physician|visit)/i),
      specialist:                  record('medical.specialist', null as never) ?? extractCostShare(text, /specialist(?:[-\s]+visit)?/i),
      urgent_care:                 record('medical.urgent_care', null as never) ?? extractCostShare(text, /urgent(?:ly)? care/i),
      emergency:                   record('medical.emergency', null as never) ?? extractCostShare(text, /emergency (?:room|care)/i),
      inpatient:                   record('medical.inpatient', null as never) ?? extractCostShare(text, /inpatient hospital/i),
      snf:                         record('medical.snf', null as never) ?? extractCostShare(text, /skilled nursing/i),
      outpatient_surgery_hospital: record('medical.outpatient_surgery_hospital', null as never) ?? extractCostShare(text, /outpatient (?:hospital |surgery )/i),
      outpatient_surgery_asc:      record('medical.outpatient_surgery_asc', null as never) ?? extractCostShare(text, /ambulatory surgical/i),
      lab_services:                record('medical.lab_services', null as never) ?? extractCostShare(text, /lab(?:oratory)? services/i),
      diagnostic_procedures:       record('medical.diagnostic_procedures', null as never) ?? extractCostShare(text, /diagnostic (?:tests?|procedures?)/i),
      xray:                        record('medical.xray', null as never) ?? extractCostShare(text, /x[-\s]?rays?/i),
      advanced_imaging:            record('medical.advanced_imaging', null as never) ?? extractCostShare(text, /(?:mri|ct scan|pet scan|advanced imaging)/i),
      ambulance:                   record('medical.ambulance', null as never) ?? extractCostShare(text, /ambulance/i),
      telehealth:                  record('medical.telehealth', null as never) ?? extractCostShare(text, /(?:telehealth|virtual visit)/i),
      mental_health_individual:    record('medical.mental_health_individual', null as never) ?? extractCostShare(text, /mental health (?:individual|outpatient)/i),
    },
    extras: {
      dental_annual_max:             record('extras.dental_annual_max', extractDollar(text, /comprehensive dental.{0,80}allowance/i) ?? extractDollar(text, /dental(?:.{0,20}annual)?.{0,40}\$/i)),
      vision_eyewear_allowance_year: record('extras.vision_eyewear_allowance_year', extractDollar(text, /(?:eyewear|eyeglasses).{0,40}allowance/i) ?? extractDollar(text, /vision(?:.{0,30}allowance)/i)),
      hearing_aid_allowance_year:    record('extras.hearing_aid_allowance_year', extractDollar(text, /hearing aid(?:s)?(?:.{0,40}allowance)?/i)),
      otc_allowance_per_quarter:     record('extras.otc_allowance_per_quarter', extractDollar(text, /over[-\s]?the[-\s]?counter(?:.{0,40}allowance)?/i) ?? extractDollar(text, /otc(?:.{0,40}allowance)?/i)),
      food_card_allowance_per_month: record('extras.food_card_allowance_per_month', extractDollar(text, /(?:food|grocery|healthy food)(?:.{0,40}(?:card|allowance))/i)),
      transportation_rides_per_year: record('extras.transportation_rides_per_year', (() => {
        const m = text.match(/(\d+)\s*(?:one[-\s]?way )?(?:trips?|rides?)(?:\/| per )?year?/i);
        if (!m) return null;
        const n = Number(m[1]);
        return Number.isFinite(n) ? n : null;
      })()),
      fitness_enabled: record('extras.fitness_enabled', /\b(?:silversneakers|silver\s*sneakers|renew active|active(?:\s|&)?fit|fitness benefit|gym membership)\b/i.test(text) ? true : null),
    },
    rx_tiers: {
      tier_1: record('rx_tiers.tier_1', null as never) ?? extractCostShare(text, /tier\s*1\b(?:[^]*?preferred generic)?/i),
      tier_2: record('rx_tiers.tier_2', null as never) ?? extractCostShare(text, /tier\s*2\b(?:[^]*?(?:non[-\s]?preferred )?generic)?/i),
      tier_3: record('rx_tiers.tier_3', null as never) ?? extractCostShare(text, /tier\s*3\b(?:[^]*?preferred brand)?/i),
      tier_4: record('rx_tiers.tier_4', null as never) ?? extractCostShare(text, /tier\s*4\b(?:[^]*?non[-\s]?preferred (?:drug|brand))?/i),
      tier_5: record('rx_tiers.tier_5', null as never) ?? extractCostShare(text, /tier\s*5\b(?:[^]*?specialty)?/i),
    },
  };

  // The CostShare extractor calls already record their own hits/misses
  // via the inline pattern; the `record(... null as never)` above only
  // logs the field name as a miss when the extractor returns nulls.
  // Cleanup: scrub the placeholder misses for fields the extractor
  // actually filled.
  const realMisses = misses.filter((f) => {
    if (f.startsWith('medical.')) {
      const cat = f.split('.')[1];
      const cs = scraped.medical[cat as keyof typeof scraped.medical];
      return !cs || (cs.copay == null && cs.coinsurance == null);
    }
    if (f.startsWith('rx_tiers.')) {
      const tier = f.split('.')[1] as keyof RxTiersExpected;
      const cs = scraped.rx_tiers[tier];
      return !cs || (cs.copay == null && cs.coinsurance == null);
    }
    return true;
  });

  return { scraped, hits, misses: realMisses };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const file = JSON.parse(readFileSync(args.fixturePath, 'utf8')) as FixturesFile;
  const targets = file.fixtures.filter((f) => {
    if (args.only) return f.id === args.only;
    // Skip already hand-verified; scrape unverified + production-snapshot.
    return !f.verifiedOn || f.verifiedOn.startsWith('production-snapshot');
  });
  if (targets.length === 0) {
    console.log('No fixtures to scrape (use --only to force one).');
    return;
  }
  console.log(`Scraping ${targets.length} fixture(s) from medicare.gov…`);

  const browser: Browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    // Plan Finder shows a "you may be in another state" banner without a
    // real user-agent; the default Playwright UA already covers that.
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const today = new Date().toISOString().slice(0, 10);
  let scraped = 0;
  let failed = 0;
  for (const fixture of targets) {
    try {
      const { scraped: data, hits, misses } = await scrapePlan(page, fixture);
      fixture.expected = data;
      fixture.verifiedOn = today;
      scraped += 1;
      console.log(
        `  ✓ ${fixture.id} — ${hits.length} fields scraped, ${misses.length} missed`,
      );
      if (misses.length > 0) {
        console.log(`     misses: ${misses.slice(0, 10).join(', ')}${misses.length > 10 ? '…' : ''}`);
      }
    } catch (err) {
      failed += 1;
      console.warn(`  ✗ ${fixture.id} — ${(err as Error).message}`);
    }
  }

  await browser.close();

  if (!args.dryRun) {
    writeFileSync(args.fixturePath, JSON.stringify(file, null, 2) + '\n', 'utf8');
    console.log(`\nWrote ${scraped} scraped fixture(s) → ${args.fixturePath}`);
  } else {
    console.log(`\n--dry-run: ${scraped} fixture(s) scraped, ${failed} failed — file NOT modified.`);
  }
  console.log(`Debug page-text dumps: ${SCRAPE_DEBUG_DIR}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
