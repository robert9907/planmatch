#!/usr/bin/env tsx
// scripts/import-cms-spuf.ts
//
// Imports a CMS Quarterly (SPUF) or Monthly (PUF) Prescription Drug
// Plan Formulary, Pharmacy Network & Pricing release into the landing
// tables (migration 004) and promotes it into the pm_*_v2 app tables
// (migration 005).
//
// Usage:
//   npm run formulary:import -- --year=2026 --quarter=Q1
//   npm run formulary:import -- --year=2026 --quarter=Q1 --force
//   npm run formulary:import -- --year=2026 --kind=monthly
//   npm run formulary:import -- --url=<zip-url>            (override discovery)
//   npm run formulary:import -- --zip=/path/to/local.zip   (skip download)
//   npm run formulary:import -- --dry-run                  (parse, don't write)
//   npm run formulary:import -- --skip-promote             (load landing only)
//
// Required env (.env.local):
//   DATABASE_URL                — Postgres connection string from Supabase
//   (SUPABASE_URL/SERVICE_ROLE_KEY are NOT used by this script)

import './cms-spuf/env.js';
import { rmSync, unlinkSync } from 'node:fs';
import { closePool, withClient } from './cms-spuf/pg.js';
import { discoverRelease, parseUrlMetadata } from './cms-spuf/discover.js';
import { downloadZip, shaLocal } from './cms-spuf/download.js';
import { ALL_FILES, DEFAULT_SKIP } from './cms-spuf/schema.js';
import {
  insertRelease,
  setReleaseStatus,
  purgeLanding,
  loadFile,
  inventoryZip,
} from './cms-spuf/loader.js';
import { makeWorkDir } from './cms-spuf/parser.js';
import { promote } from './cms-spuf/promote.js';

// ─── Args ─────────────────────────────────────────────────────────────

interface Args {
  year?: number;
  quarter?: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  kind?: 'quarterly' | 'monthly';
  releaseDate?: string; // YYYYMMDD
  url?: string;
  zip?: string;
  force: boolean;
  dryRun: boolean;
  skipPromote: boolean;
  keepZip: boolean;
  skipSpecs: string[]; // resolved skip list (from --skip or DEFAULT_SKIP)
  /** Finish an already-staged release: skip download + load, promote only. */
  promoteOnly: boolean;
  /** Which release to promote. Required with --promote-only. */
  releaseId: number | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    force: false,
    dryRun: false,
    skipPromote: false,
    keepZip: false,
    skipSpecs: [...DEFAULT_SKIP],
    promoteOnly: false,
    releaseId: null,
  };
  let skipExplicit = false;
  for (const arg of argv) {
    const m = arg.match(/^--([a-zA-Z0-9-]+)(=(.*))?$/);
    if (!m) continue;
    const key = m[1];
    const val = m[3];
    switch (key) {
      case 'year':            out.year = Number(val); break;
      case 'quarter':         out.quarter = val as Args['quarter']; break;
      case 'kind':            out.kind = val as Args['kind']; break;
      case 'release-date':    out.releaseDate = val; break;
      case 'url':             out.url = val; break;
      case 'zip':             out.zip = val; break;
      case 'force':           out.force = true; break;
      case 'dry-run':         out.dryRun = true; break;
      case 'skip-promote':    out.skipPromote = true; break;
      case 'promote-only':    out.promoteOnly = true; break;
      case 'release-id':      out.releaseId = Number(val); break;
      case 'keep-zip':        out.keepZip = true; break;
      case 'skip':
        // --skip=     → load everything (override default)
        // --skip=a,b → only skip a and b
        skipExplicit = true;
        out.skipSpecs = (val ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case 'help':
      case 'h':
        printHelp();
        process.exit(0);
      default:
        console.warn(`[args] unknown flag: --${key}`);
    }
  }
  // Validate --skip names against known specs.
  if (skipExplicit) {
    const known = new Set(ALL_FILES.map((f) => f.name));
    const bad = out.skipSpecs.filter((s) => !known.has(s));
    if (bad.length > 0) {
      throw new Error(
        `Unknown --skip name(s): ${bad.join(', ')}. ` +
          `Valid: ${[...known].join(', ')}`,
      );
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`
CMS SPUF / PUF importer

Required (one of):
  --year=YYYY --quarter=Q1|Q2|Q3|Q4    Pick latest matching quarterly release
  --year=YYYY --kind=monthly           Pick latest monthly release for the year
  --url=https://data.cms.gov/.../*.zip Explicit ZIP URL
  --zip=/local/path/*.zip              Use an already-downloaded ZIP

Optional:
  --release-date=YYYYMMDD              Pick a specific release if multiple match
  --force                              Re-import even if SHA matches existing release
  --dry-run                            Parse and validate, no DB writes
  --skip-promote                       Load landing tables but don't swap pm_*_v2
  --promote-only --release-id=N        Promote an ALREADY-STAGED release into
                                       pm_*_v2. No download, no re-load. Use when
                                       an import died after the COPY phase and
                                       left the release stuck at status='loading'.
  --skip=spec1,spec2                   Skip these file specs. Default: ${DEFAULT_SKIP.join(',')}
                                       Pass --skip= to load everything.
                                       Names: plan_information, basic_drugs, beneficiary_cost,
                                       pharmacy_networks, excluded_drugs, indication_based_coverage,
                                       insulin_beneficiary_cost, pricing, geographic_locator
  --keep-zip                           Don't delete the temp ZIP/work dir after import
  --help                               This message
`);
}

// ─── Main ─────────────────────────────────────────────────────────────

/**
 * Promote a release whose landing rows are already staged.
 *
 * Verifies before touching anything: the release must exist, must not already
 * be promoted, and must actually have rows in the landing tables. A release
 * marked 'loading' with NO staged rows died during the COPY phase, not after
 * it — promoting that would publish a partial formulary, so it is refused and
 * the operator is sent to a full re-import instead.
 */
async function promoteOnly(releaseId: number, dryRun: boolean): Promise<void> {
  const release = await withClient(async (c) => {
    const { rows } = await c.query(
      `SELECT release_id, plan_year, release_kind, release_date, status,
              imported_at, promoted_at
         FROM cms_spuf_releases
        WHERE release_id = $1`,
      [releaseId],
    );
    return rows[0] as
      | {
          release_id: number;
          plan_year: number;
          release_kind: string;
          release_date: string;
          status: string;
          imported_at: string | null;
          promoted_at: string | null;
        }
      | undefined;
  });

  if (!release) throw new Error(`No release with release_id=${releaseId}`);

  console.log(
    `[promote-only] release_id=${release.release_id} plan_year=${release.plan_year} ` +
      `kind=${release.release_kind} date=${release.release_date} status=${release.status}`,
  );

  if (release.promoted_at) {
    console.log(
      `[promote-only] Already promoted at ${release.promoted_at}. ` +
        `Re-promoting is safe but pointless unless the landing rows changed.`,
    );
  }

  // Count what is actually staged, per landing table. This doubles as the
  // row_counts the interrupted run never got to write.
  const tables = [...new Set(ALL_FILES.map((f) => f.landingTable))];
  const rowCounts: Record<string, number> = {};
  await withClient(async (c) => {
    for (const t of tables) {
      const { rows } = await c.query(
        `SELECT count(*)::bigint AS n FROM ${t} WHERE release_id = $1`,
        [releaseId],
      );
      rowCounts[t] = Number(rows[0].n);
    }
  });

  console.log('[promote-only] Staged rows:');
  for (const [t, n] of Object.entries(rowCounts)) {
    console.log(`        ${t}: ${n.toLocaleString()}`);
  }

  const staged = Object.values(rowCounts).reduce((a, b) => a + b, 0);
  if (staged === 0) {
    throw new Error(
      `release_id=${releaseId} has no landing rows. It died during the COPY ` +
        `phase, not after it — re-import with --force rather than promoting ` +
        `a partial load.`,
    );
  }

  if (dryRun) {
    console.log('[promote-only] DRY RUN — stopping before promote.');
    return;
  }

  // Record the 'loaded' state the interrupted run never wrote, so the release
  // row stops lying about where it got to even if the promote then fails.
  await setReleaseStatus(releaseId, 'loaded', { rowCounts });

  console.log('[promote-only] Promoting to pm_*_v2 (single transaction)…');
  const t0 = Date.now();
  const { counts } = await promote({ releaseId, planYear: release.plan_year });
  console.log(
    `[promote-only] Promotion complete in ${((Date.now() - t0) / 1000).toFixed(1)}s:`,
  );
  for (const [t, n] of Object.entries(counts)) {
    console.log(`        ${t}: ${n.toLocaleString()}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun) {
    console.log('[main] DRY RUN — no DB writes');
  }

  // 0) --promote-only: finish a release whose landing rows are already in.
  //
  // The load phase COPYs each file in its own auto-committed transaction and
  // only then writes status='loaded' + row_counts. So a run killed between
  // the last COPY and that write (OOM, closed terminal, laptop asleep — a
  // 2.5 GB import takes a while) leaves a release with COMPLETE staging rows,
  // status stuck at 'loading', row_counts null and error null. Nothing threw,
  // so nothing was recorded as failed.
  //
  // Without this flag the only way forward is --force, which purges the
  // landing rows and re-downloads and re-loads 1.1M+ rows to rebuild state
  // that is already correct in the database. This promotes what is there.
  //
  // promote() is idempotent per plan year — DELETE FROM pm_*_v2 WHERE
  // plan_year, then INSERT from the given release, in one transaction — so
  // re-running is safe.
  if (args.promoteOnly) {
    if (args.releaseId === null || !Number.isFinite(args.releaseId)) {
      throw new Error('--promote-only requires --release-id=N');
    }
    await promoteOnly(args.releaseId, args.dryRun);
    return;
  }

  // 1) Resolve the release we're importing.
  let url: string;
  let releaseDate: string;
  let planYear: number;
  let releaseKind: 'quarterly' | 'monthly';
  let fileName: string;

  if (args.zip) {
    // Local ZIP — derive metadata from filename. Skip the discover step.
    const meta = parseUrlMetadata(args.zip);
    url = `file://${args.zip}`;
    releaseDate = meta.releaseDate;
    planYear = meta.planYear;
    releaseKind = meta.releaseKind;
    fileName = meta.fileName;
    console.log(`[main] Local zip: ${args.zip}`);
  } else if (args.url) {
    url = args.url;
    const meta = parseUrlMetadata(args.url);
    releaseDate = meta.releaseDate;
    planYear = meta.planYear;
    releaseKind = meta.releaseKind;
    fileName = meta.fileName;
    console.log(`[main] Using explicit URL: ${url}`);
  } else {
    if (!args.year) throw new Error('Pass --year=YYYY (or --url, or --zip).');
    const kind = args.kind ?? 'quarterly';
    const discovered = await discoverRelease({
      year: args.year,
      kind,
      quarter: args.quarter,
      releaseDate: args.releaseDate,
    });
    url = discovered.url;
    releaseDate = discovered.releaseDate;
    planYear = discovered.planYear;
    releaseKind = discovered.releaseKind;
    fileName = discovered.fileName;
    console.log(`[main] Discovered ${releaseKind} release: ${fileName} (${releaseDate})`);
  }

  // 2) Get the ZIP onto disk, compute SHA-256.
  let zipPath: string;
  let zipSha: string;
  let zipBytes: number;
  if (args.zip) {
    const sha = await shaLocal(args.zip);
    zipPath = args.zip;
    zipSha = sha.sha256;
    zipBytes = sha.bytes;
    console.log(`[main] Local zip sha256=${zipSha.slice(0, 16)}…`);
  } else {
    const dl = await downloadZip(url, fileName);
    zipPath = dl.filePath;
    zipSha = dl.sha256;
    zipBytes = dl.bytes;
  }

  // 3) Inventory ZIP — warn about entries no spec claims.
  const entries = await inventoryZip(zipPath);
  const claimed = new Set<string>();
  for (const e of entries) {
    for (const spec of ALL_FILES) if (spec.innerZipPattern.test(e)) claimed.add(e);
  }
  const unexpected = entries.filter(
    (e) =>
      !claimed.has(e) &&
      !e.toLowerCase().endsWith('.pdf') &&
      !/sample/i.test(e),
  );
  if (unexpected.length > 0) {
    console.warn(`[main] ZIP contains entries no spec matches (ignored): ${unexpected.join(', ')}`);
  }
  if (args.skipSpecs.length > 0) {
    console.log(`[main] Skipping specs: ${args.skipSpecs.join(', ')}`);
  }

  if (args.dryRun) {
    console.log('[main] Dry run — exiting before DB writes');
    if (!args.zip && !args.keepZip) unlinkSync(zipPath);
    return;
  }

  // 4) Insert release row (idempotency by SHA).
  const { releaseId, preexisting } = await insertRelease({
    planYear,
    releaseKind,
    releaseDate,
    sourceUrl: url,
    zipSha256: zipSha,
    zipBytes,
  });

  if (preexisting && !args.force) {
    console.log(
      `[main] Release with sha=${zipSha.slice(0, 16)}… already imported (release_id=${releaseId}). ` +
        `Pass --force to re-import.`,
    );
    if (!args.zip && !args.keepZip) unlinkSync(zipPath);
    return;
  }

  if (preexisting && args.force) {
    console.log(`[main] --force: purging landing rows for release_id=${releaseId}`);
    await purgeLanding(releaseId);
  }

  console.log(`[main] release_id=${releaseId}, plan_year=${planYear}, kind=${releaseKind}`);

  // 5) Load each landing table.
  // Strategy: open a FRESH client per spec, so a long inner-ZIP
  // extraction (e.g. ~2 GB pricing.txt) can't time out an idle
  // Postgres connection between files. Each COPY is its own auto-
  // committed transaction; failures don't taint the next file.
  const workDir = makeWorkDir();
  console.log(`[main] Work dir: ${workDir}`);
  const skipSet = new Set(args.skipSpecs);
  await setReleaseStatus(releaseId, 'loading');
  const rowCounts: Record<string, number> = {};
  try {
    for (const spec of ALL_FILES) {
      if (skipSet.has(spec.name)) {
        console.log(`[load]   ${spec.name}: skipped (--skip)`);
        continue;
      }
      const result = await withClient(async (client) => {
        await client.query(`SET statement_timeout = 0`);
        return loadFile({ client, spec, zipPath, releaseId, workDir });
      });
      if (!result.skipped) rowCounts[spec.landingTable] = result.rows;
    }
    await setReleaseStatus(releaseId, 'loaded', { rowCounts });
  } catch (err) {
    // Log the real load-phase error first; mark-as-failed is a best-
    // effort so the release row's status reflects reality. Don't let
    // the status-update error mask the actual cause.
    console.error('[main] Load failed:', (err as Error).message);
    try {
      await setReleaseStatus(releaseId, 'failed', { error: (err as Error).message });
    } catch (statusErr) {
      console.error('[main] (also) failed to mark release as failed:', (statusErr as Error).message);
    }
    if (!args.keepZip) {
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    throw err;
  }

  console.log('[main] Landing complete:');
  for (const [t, n] of Object.entries(rowCounts)) {
    console.log(`        ${t}: ${n.toLocaleString()}`);
  }

  // 6) Promote — unless told not to.
  if (args.skipPromote) {
    console.log('[main] --skip-promote: leaving pm_*_v2 untouched');
  } else {
    console.log('[main] Promoting to pm_*_v2 (single transaction)…');
    const t0 = Date.now();
    const { counts } = await promote({ releaseId, planYear });
    const ms = Date.now() - t0;
    console.log(`[main] Promotion complete in ${(ms / 1000).toFixed(1)}s:`);
    for (const [t, n] of Object.entries(counts)) {
      console.log(`        ${t}: ${n.toLocaleString()}`);
    }
  }

  // 7) Cleanup.
  if (!args.keepZip) {
    try {
      rmSync(workDir, { recursive: true, force: true });
      console.log(`[main] Deleted ${workDir}`);
    } catch (err) {
      console.warn(`[main] Failed to delete ${workDir}: ${(err as Error).message}`);
    }
  }
  if (!args.zip && !args.keepZip) {
    try {
      unlinkSync(zipPath);
      console.log(`[main] Deleted ${zipPath}`);
    } catch (err) {
      console.warn(`[main] Failed to delete ${zipPath}: ${(err as Error).message}`);
    }
  }
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('[main] FAILED:', err);
    await closePool().catch(() => {});
    process.exit(1);
  });
