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
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    force: false,
    dryRun: false,
    skipPromote: false,
    keepZip: false,
    skipSpecs: [...DEFAULT_SKIP],
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun) {
    console.log('[main] DRY RUN — no DB writes');
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
