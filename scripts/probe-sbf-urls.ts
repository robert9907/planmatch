// scripts/probe-sbf-urls.ts
//
// Per-plan Summary-of-Benefits URL probe. For every distinct
// (contract_id, plan_id, segment_id) in pm_plans across NC/TX/GA,
// HEADs medicareadvantage.com/plans/{lowercase-triple} and checks
// the returned page title contains the plan's contract-plan triple:
//
//   Real plan page  → title includes "H1036-307-000" (uppercase)
//   Fallback landing → title is "List of 2026 Medicare Advantage
//                       Plans by State ..." (their site-search index
//                       stub for uncovered plans)
//   404 / other      → some other title
//
// When the page resolves, we store the medicareadvantage.com URL as
// the plan's sbf_url; otherwise sbf_url stays NULL and api/plans.ts's
// planFinderUrl() falls through to the Google-search URL. Both
// cards on the Compare screen already open the link with target="_blank"
// so the broker never leaves the bench.
//
// Coverage on plan-match-prod (NC/TX/GA) as of the last probe:
//   ~62% of distinct triples land on real medicareadvantage.com plan
//   pages. Well-covered carriers: Humana, UnitedHealthcare, Aetna,
//   BCBS NC, Anthem, Devoted, Kaiser, Wellpoint, HealthSpring,
//   Molina, Experience Health. Not covered: Wellcare, most regional
//   BCBS variants, small carriers (Troy, Clover, Alignment, etc.).
//
// Run with:  npx tsx scripts/probe-sbf-urls.ts
//   Optional: --states NC,TX,GA (default) or --states all
//             --delay-ms 400 (default; be gentle with the CDN)

import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
  }
}

const DATABASE_URL = process.env.DATABASE_URL ?? '';
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL in .env.local');
  process.exit(1);
}

interface Args { states: string[]; delayMs: number; }
function parseArgs(argv: string[]): Args {
  let states = ['NC', 'TX', 'GA'];
  let delayMs = 400;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--states' && argv[i + 1]) {
      states = argv[i + 1] === 'all' ? [] : argv[i + 1].split(',').map((s) => s.trim().toUpperCase());
      i += 1;
    } else if (argv[i] === '--delay-ms' && argv[i + 1]) {
      delayMs = Number(argv[i + 1]);
      i += 1;
    }
  }
  return { states, delayMs };
}

interface PlanRef {
  contract_id: string; plan_id: string; segment_id: string;
  carrier: string | null; plan_name: string;
}

function buildTripleUrl(contract: string, plan: string, segment: string): string {
  const seg = (segment || '000').padStart(3, '0');
  return `https://www.medicareadvantage.com/plans/${contract.toLowerCase()}-${plan.toLowerCase()}-${seg}`;
}

function tripleUpper(contract: string, plan: string, segment: string): string {
  const seg = (segment || '000').padStart(3, '0');
  return `${contract}-${plan}-${seg}`.toUpperCase();
}

async function probeOne(contract: string, plan: string, segment: string): Promise<string | null> {
  const url = buildTripleUrl(contract, plan, segment);
  const upperTriple = tripleUpper(contract, plan, segment);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (planmatch-broker-tool)',
        Accept: 'text/html',
      },
      redirect: 'follow',
    });
    if (res.status !== 200) return null;
    const html = await res.text();
    const title = (html.match(/<title>([^<]+)<\/title>/) ?? [null, ''])[1];
    // "Real plan page" heuristic: the page title contains the plan's
    // contract-plan-segment triple. Uncovered plans land on the
    // "plans-by-state" or 404 title.
    return title.toUpperCase().includes(upperTriple) ? url : null;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new pg.Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    console.log(`→ ensuring migration 016 column exists`);
    await client.query(`
      ALTER TABLE pm_plans ADD COLUMN IF NOT EXISTS sbf_url text;
    `);

    // One row per distinct (contract, plan, segment) — pm_plans is
    // per-plan-county-state so many pm_plans rows share the same
    // triple. Probing once per triple keeps the sweep quick.
    let query = `
      SELECT DISTINCT ON (contract_id, plan_id, segment_id)
        contract_id, plan_id, segment_id,
        COALESCE(carrier, parent_organization) AS carrier,
        plan_name
      FROM pm_plans
      WHERE sanctioned = false`;
    if (args.states.length > 0) {
      query += ` AND state IN (${args.states.map((s) => `'${s}'`).join(',')})`;
    }
    query += ` ORDER BY contract_id, plan_id, segment_id`;
    const rows = await client.query<PlanRef>(query);
    console.log(`→ probing ${rows.rowCount} distinct triples across states=${args.states.length === 0 ? 'ALL' : args.states.join(',')} (${args.delayMs}ms between requests)`);

    let ok = 0;
    let miss = 0;
    let updated = 0;
    const missByCarrier = new Map<string, number>();
    const okByCarrier = new Map<string, number>();

    let processed = 0;
    for (const r of rows.rows) {
      const url = await probeOne(r.contract_id, r.plan_id, r.segment_id);
      const carrier = r.carrier ?? '(unknown)';
      if (url) {
        ok += 1;
        okByCarrier.set(carrier, (okByCarrier.get(carrier) ?? 0) + 1);
      } else {
        miss += 1;
        missByCarrier.set(carrier, (missByCarrier.get(carrier) ?? 0) + 1);
      }
      const u = await client.query(
        `UPDATE pm_plans SET sbf_url = $4
           WHERE contract_id = $1 AND plan_id = $2 AND segment_id = $3`,
        [r.contract_id, r.plan_id, r.segment_id, url],
      );
      updated += u.rowCount ?? 0;

      processed += 1;
      if (processed % 50 === 0) {
        console.log(`  progress: ${processed}/${rows.rowCount}  (ok=${ok}  miss=${miss})`);
      }
      if (args.delayMs > 0) {
        await new Promise((res) => setTimeout(res, args.delayMs));
      }
    }

    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`  probe-sbf-urls — done`);
    console.log(`═══════════════════════════════════════════════════════`);
    console.log(`  Distinct triples probed        : ${rows.rowCount}`);
    console.log(`  Landed on medicareadvantage.com: ${ok} (${((ok / (rows.rowCount ?? 1)) * 100).toFixed(1)}%)`);
    console.log(`  Fell back to Google search     : ${miss} (${((miss / (rows.rowCount ?? 1)) * 100).toFixed(1)}%)`);
    console.log(`  pm_plans row updates           : ${updated}`);

    if (okByCarrier.size > 0) {
      console.log(`\n  Top OK carriers by triple count:`);
      const sorted = [...okByCarrier].sort((a, b) => b[1] - a[1]);
      for (const [c, n] of sorted.slice(0, 12)) console.log(`    ${c}: ${n}`);
    }
    if (missByCarrier.size > 0) {
      console.log(`\n  Top MISS carriers by triple count (fall back to Google):`);
      const sorted = [...missByCarrier].sort((a, b) => b[1] - a[1]);
      for (const [c, n] of sorted.slice(0, 12)) console.log(`    ${c}: ${n}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
