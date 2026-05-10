#!/usr/bin/env tsx
// scripts/import-cms-pbp.ts
//
// Imports a CMS Plan Benefit Package (PBP) Benefits release into the
// landing tables (migration 010) and promotes it into the pbp_*_v2
// app tables (migration 011).
//
// Usage:
//   npm run pbp:import -- --year=2026
//   npm run pbp:import -- --year=2026 --force
//   npm run pbp:import -- --url=https://www.cms.gov/files/zip/pbp-benefits-2026.zip
//   npm run pbp:import -- --zip=/path/to/local.zip --year=2026
//   npm run pbp:import -- --year=2026 --dry-run
//   npm run pbp:import -- --year=2026 --skip-promote
//
// Required env (.env.local):
//   DATABASE_URL — Postgres connection string from Supabase

import './cms-spuf/env.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { closePool, withClient } from './cms-spuf/pg.js';
import { discoverRelease, parseUrlMetadata } from './cms-pbp/discover.js';
import { downloadZip, shaLocal } from './cms-pbp/download.js';
import { ALL_FILES } from './cms-pbp/schema.js';
import { columnsFor, loadDictionary } from './cms-pbp/dictionary.js';
import { extractDictionary, listZipEntries } from './cms-pbp/parser.js';
import {
  insertRelease,
  setReleaseStatus,
  purgeLanding,
  loadFile,
} from './cms-pbp/loader.js';
import { promote } from './cms-pbp/promote.js';

interface Args {
  year?: number;
  url?: string;
  zip?: string;
  force: boolean;
  dryRun: boolean;
  skipPromote: boolean;
  keepZip: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { force: false, dryRun: false, skipPromote: false, keepZip: false };
  for (const arg of argv) {
    const m = arg.match(/^--([a-zA-Z0-9-]+)(=(.*))?$/);
    if (!m) continue;
    const key = m[1];
    const val = m[3];
    switch (key) {
      case 'year':         out.year = Number(val); break;
      case 'url':          out.url = val; break;
      case 'zip':          out.zip = val; break;
      case 'force':        out.force = true; break;
      case 'dry-run':      out.dryRun = true; break;
      case 'skip-promote': out.skipPromote = true; break;
      case 'keep-zip':     out.keepZip = true; break;
      case 'help':
      case 'h':
        printHelp();
        process.exit(0);
      default:
        console.warn(`[args] unknown flag: --${key}`);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`
CMS PBP Benefits importer

Required (one of):
  --year=YYYY                    Pick canonical pbp-benefits-YYYY.zip URL
  --url=https://...              Explicit ZIP URL
  --zip=/local/path/*.zip        Use an already-downloaded ZIP

Optional:
  --force                        Re-import even if SHA matches existing release
  --dry-run                      Parse and validate, no DB writes
  --skip-promote                 Load landing tables but don't swap pbp_*_v2
  --keep-zip                     Don't delete the temp ZIP after import
  --help                         This message
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.dryRun) console.log('[main] DRY RUN — no DB writes');

  // 1) Resolve which release we're importing.
  let url: string;
  let releaseDate: string;
  let planYear: number;
  let fileName: string;

  if (args.zip) {
    if (!args.year) throw new Error('--zip requires --year=YYYY');
    const meta = parseUrlMetadata(args.zip);
    url = `file://${args.zip}`;
    fileName = meta.fileName;
    planYear = args.year;
    // Use today's date for local-zip mode; release_date is the SHA's
    // first-seen date, not authoritative.
    releaseDate = new Date().toISOString().slice(0, 10);
    console.log(`[main] Local zip: ${args.zip}`);
  } else if (args.url) {
    url = args.url;
    const meta = parseUrlMetadata(args.url);
    fileName = meta.fileName;
    planYear = args.year ?? meta.planYearGuess ?? 0;
    if (!planYear) throw new Error('Could not infer plan year from URL — pass --year');
    releaseDate = new Date().toISOString().slice(0, 10);
    console.log(`[main] Using explicit URL: ${url}`);
  } else {
    if (!args.year) throw new Error('Pass --year=YYYY (or --url, or --zip).');
    const d = await discoverRelease({ year: args.year });
    url = d.url;
    releaseDate = d.releaseDate;
    planYear = d.planYear;
    fileName = d.fileName;
    console.log(`[main] CMS PBP release: ${fileName} (${releaseDate})`);
  }

  // 2) Get the ZIP onto disk + SHA.
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

  // 3) Inventory ZIP — surface unexpected entries.
  const entries = await listZipEntries(zipPath);
  const expected = new Set(ALL_FILES.map((f) => f.fileName.toLowerCase()));
  const unexpected = entries.filter(
    (e) =>
      !expected.has(e.toLowerCase()) &&
      !e.toLowerCase().endsWith('.sas') &&
      !e.toLowerCase().endsWith('.xlsx') &&
      !e.toLowerCase().startsWith('readme') &&
      !/^pbp_(b3|b5|b11|b12|b19|b20|mrx|step|section_c|ds_vbid|vbid)/i.test(e) &&
      !/_vbid_uf/i.test(e) &&
      !/^planregionarea/i.test(e),
  );
  if (unexpected.length > 0) {
    console.warn(`[main] ZIP contains entries no spec matches (ignored): ${unexpected.slice(0, 6).join(', ')}${unexpected.length > 6 ? `, … (${unexpected.length} total)` : ''}`);
  }

  if (args.dryRun) {
    console.log('[main] Dry run — exiting before DB writes');
    if (!args.zip && !args.keepZip) unlinkSync(zipPath);
    return;
  }

  // 4) Extract dictionary.xlsx and parse it.
  const dictPath = join(tmpdir(), `pbp-dict-${Date.now()}.xlsx`);
  console.log('[main] Extracting dictionary…');
  await extractDictionary(zipPath, dictPath);
  const dictionary = loadDictionary(dictPath);
  console.log(`[main] Dictionary: ${dictionary.size} files described`);

  // 5) Insert release row (idempotency by SHA).
  const { releaseId, preexisting } = await insertRelease({
    planYear, releaseDate, sourceUrl: url, zipSha256: zipSha, zipBytes,
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
    await purgeLanding(releaseId, ALL_FILES.map((f) => f.landingTable));
  }
  console.log(`[main] release_id=${releaseId}, plan_year=${planYear}`);

  // 6) Load each landing table.
  await setReleaseStatus(releaseId, 'loading');
  const rowCounts: Record<string, number> = {};
  try {
    for (const spec of ALL_FILES) {
      const cols = columnsFor(dictionary, spec.fileName);
      const result = await withClient(async (client) => {
        await client.query(`SET statement_timeout = 0`);
        return loadFile({ client, spec, zipPath, releaseId, dictionaryColumns: cols });
      });
      if (!result.skipped) rowCounts[spec.landingTable] = result.rows;
    }
    await setReleaseStatus(releaseId, 'loaded', { rowCounts });
  } catch (err) {
    console.error('[main] Load failed:', (err as Error).message);
    try { await setReleaseStatus(releaseId, 'failed', { error: (err as Error).message }); } catch { /* ignore */ }
    throw err;
  }

  console.log('[main] Landing complete:');
  for (const [t, n] of Object.entries(rowCounts)) {
    console.log(`        ${t}: ${n.toLocaleString()}`);
  }

  // 7) Promote to v2.
  if (args.skipPromote) {
    console.log('[main] --skip-promote: leaving pbp_*_v2 untouched');
  } else {
    console.log('[main] Promoting to pbp_*_v2 (single transaction)…');
    const t0 = Date.now();
    const { counts } = await promote({ releaseId, planYear });
    console.log(`[main] Promotion complete in ${((Date.now() - t0) / 1000).toFixed(1)}s:`);
    for (const [t, n] of Object.entries(counts)) {
      console.log(`        ${t}: ${n.toLocaleString()}`);
    }
  }

  // 8) Cleanup.
  try { unlinkSync(dictPath); } catch { /* ignore */ }
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
