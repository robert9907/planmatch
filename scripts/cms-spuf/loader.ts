// scripts/cms-spuf/loader.ts
//
// Loads parsed SPUF rows into the corresponding landing table via
// COPY FROM STDIN. The release row's status moves
// downloaded → loading → loaded as files complete. Per-table row
// counts accumulate in cms_spuf_releases.row_counts JSONB.

import { from as copyFrom } from 'pg-copy-streams';
import { pipeline } from 'node:stream/promises';
import type { PoolClient } from 'pg';
import type { CmsFileSpec } from './schema.js';
import { parseSpufEntry, listZipEntries } from './parser.js';
import { withClient } from './pg.js';

// ─── Release lifecycle ────────────────────────────────────────────────

export interface ReleaseInsert {
  planYear: number;
  releaseKind: 'quarterly' | 'monthly';
  releaseDate: string;     // YYYY-MM-DD
  sourceUrl: string;
  zipSha256: string;
  zipBytes: number;
}

// Inserts a release row keyed on zip_sha256. Returns the existing row's
// id (and whether it was already present) when the SHA collides — the
// caller decides whether to abort or re-import based on --force.
export async function insertRelease(meta: ReleaseInsert): Promise<{ releaseId: number; preexisting: boolean }> {
  return withClient(async (c) => {
    const ins = await c.query(
      `INSERT INTO cms_spuf_releases
         (plan_year, release_kind, release_date, source_url, zip_sha256, zip_bytes, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'downloaded')
       ON CONFLICT (zip_sha256) DO NOTHING
       RETURNING release_id`,
      [meta.planYear, meta.releaseKind, meta.releaseDate, meta.sourceUrl, meta.zipSha256, meta.zipBytes],
    );
    if (ins.rows[0]) return { releaseId: ins.rows[0].release_id, preexisting: false };
    // SHA collision — fetch the existing row.
    const sel = await c.query(
      `SELECT release_id FROM cms_spuf_releases WHERE zip_sha256 = $1`,
      [meta.zipSha256],
    );
    return { releaseId: sel.rows[0].release_id, preexisting: true };
  });
}

export async function setReleaseStatus(
  releaseId: number,
  status: 'loading' | 'loaded' | 'failed',
  fields: { error?: string; rowCounts?: Record<string, number> } = {},
): Promise<void> {
  await withClient(async (c) => {
    if (status === 'loaded') {
      await c.query(
        `UPDATE cms_spuf_releases
            SET status = 'loaded',
                imported_at = now(),
                row_counts = COALESCE($2::jsonb, row_counts)
          WHERE release_id = $1`,
        [releaseId, fields.rowCounts ? JSON.stringify(fields.rowCounts) : null],
      );
    } else if (status === 'failed') {
      await c.query(
        `UPDATE cms_spuf_releases
            SET status = 'failed', error = $2
          WHERE release_id = $1`,
        [releaseId, fields.error ?? null],
      );
    } else {
      await c.query(
        `UPDATE cms_spuf_releases SET status = $2 WHERE release_id = $1`,
        [releaseId, status],
      );
    }
  });
}

// Called before re-loading an existing release_id (e.g. --force). Wipes
// landing rows for that release across every table; the schema's ON
// DELETE CASCADE on the FK to cms_spuf_releases means a single DELETE
// of the release row would also wipe everything, but we want to keep
// the release row itself for audit.
export async function purgeLanding(releaseId: number): Promise<void> {
  await withClient(async (c) => {
    const tables = [
      'cms_spuf_plan_information',
      'cms_spuf_basic_drugs',
      'cms_spuf_beneficiary_cost',
      'cms_spuf_pharmacy_network',
      'cms_spuf_excluded_drugs',
      'cms_spuf_indication_based_coverage',
      'cms_spuf_insulin_beneficiary_cost',
      'cms_spuf_pricing',
      'cms_spuf_geographic_locator',
    ];
    for (const t of tables) {
      await c.query(`DELETE FROM ${t} WHERE release_id = $1`, [releaseId]);
    }
  });
}

// ─── Per-file load ────────────────────────────────────────────────────

// COPY column list. Excludes synthetic id columns and release_id
// (release_id is supplied via the prelude — see below). Order matches
// CmsFileSpec.columns and the CREATE TABLE definition.
function copyColumnList(spec: CmsFileSpec): string {
  return spec.columns.map((c) => c.pg).join(',');
}

// We want each row in the landing table to carry the current release_id
// without parser code knowing what it is. Trick: prepend release_id to
// each tuple in the COPY stream and put release_id first in the COPY
// column list. This costs one extra column-write per row but keeps the
// parser context-free.
function rowPrefix(releaseId: number): Buffer {
  return Buffer.from(`${releaseId}\t`, 'utf8');
}

export async function loadFile(opts: {
  client: PoolClient;
  spec: CmsFileSpec;
  zipPath: string;
  releaseId: number;
  workDir: string;
}): Promise<{ rows: number; skipped: boolean }> {
  const { client, spec, zipPath, releaseId, workDir } = opts;

  // Parse the entry. parseSpufEntry returns null when the file is not
  // present in this ZIP (quarterly-only files in monthly bundles, or
  // CMS-removed files like partial_gap_coverage.txt in 2025+).
  const parsed = await parseSpufEntry(zipPath, spec, workDir);
  if (!parsed) {
    console.log(`[load]   ${spec.fileName}: not present in ZIP — skipped`);
    return { rows: 0, skipped: true };
  }

  const columnList = `release_id,${copyColumnList(spec)}`;
  const sql = `COPY ${spec.landingTable} (${columnList}) FROM STDIN`;
  const sink = client.query(copyFrom(sql)) as unknown as NodeJS.WritableStream;

  // Prepend release_id to every line emitted by the parser.
  const prefix = rowPrefix(releaseId);
  const start = Date.now();
  let lineHead = true;

  await pipeline(
    parsed.copyStream,
    async function* (source) {
      for await (const chunk of source) {
        const buf = chunk as Buffer;
        // The parser emits one line at a time, each ending in '\n'. We
        // prepend release_id\t before each line. Track whether we're at
        // a line head across chunk boundaries.
        let cursor = 0;
        for (let i = 0; i < buf.length; i++) {
          if (lineHead) {
            // Flush anything pending up to here (none on first iter).
            if (cursor < i) yield buf.subarray(cursor, i);
            yield prefix;
            cursor = i;
            lineHead = false;
          }
          if (buf[i] === 0x0a /* \n */) {
            lineHead = true;
          }
        }
        if (cursor < buf.length) yield buf.subarray(cursor);
      }
    },
    sink,
  );

  const ms = Date.now() - start;
  const rows = parsed.rowCounter.count;
  console.log(`[load]   ${spec.fileName}: ${rows.toLocaleString()} rows in ${(ms / 1000).toFixed(1)}s`);
  return { rows, skipped: false };
}

// Inventory the ZIP contents up-front so the importer can warn about
// unexpected files (CMS shipping new tables) or missing ones.
export async function inventoryZip(zipPath: string): Promise<string[]> {
  return listZipEntries(zipPath);
}
