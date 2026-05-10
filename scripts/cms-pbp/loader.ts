// scripts/cms-pbp/loader.ts
//
// CREATE TABLE the landing table from the dictionary's column list,
// ALTER TABLE ADD COLUMN for any new columns CMS introduced this year,
// then COPY FROM STDIN the parsed rows. release_id is prepended to
// every row in a streaming transform (same trick the SPUF importer
// uses) so the parser stays context-free.
//
// PBP files are smaller than SPUF — biggest is PlanArea at ~2.3M rows.
// COPY is fast; per-file load is seconds, not minutes.

import { from as copyFrom } from 'pg-copy-streams';
import { pipeline } from 'node:stream/promises';
import type { PoolClient } from 'pg';
import { withClient } from '../cms-spuf/pg.js';
import type { PbpFileSpec } from './schema.js';
import { FORCED_TEXT_COLUMNS } from './schema.js';
import type { PbpColumn } from './dictionary.js';
import { dedupeHeader, parsePbpEntry, readHeader } from './parser.js';

// ─── Release lifecycle ────────────────────────────────────────────────

export interface ReleaseInsert {
  planYear: number;
  releaseDate: string;
  sourceUrl: string;
  zipSha256: string;
  zipBytes: number;
}

export async function insertRelease(meta: ReleaseInsert): Promise<{ releaseId: number; preexisting: boolean }> {
  return withClient(async (c) => {
    const ins = await c.query(
      `INSERT INTO pbp_releases
         (plan_year, release_date, source_url, zip_sha256, zip_bytes, status)
       VALUES ($1, $2, $3, $4, $5, 'downloaded')
       ON CONFLICT (zip_sha256) DO NOTHING
       RETURNING release_id`,
      [meta.planYear, meta.releaseDate, meta.sourceUrl, meta.zipSha256, meta.zipBytes],
    );
    if (ins.rows[0]) return { releaseId: ins.rows[0].release_id, preexisting: false };
    const sel = await c.query(`SELECT release_id FROM pbp_releases WHERE zip_sha256 = $1`, [meta.zipSha256]);
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
        `UPDATE pbp_releases
            SET status='loaded', imported_at=now(), row_counts=COALESCE($2::jsonb, row_counts)
          WHERE release_id=$1`,
        [releaseId, fields.rowCounts ? JSON.stringify(fields.rowCounts) : null],
      );
    } else if (status === 'failed') {
      await c.query(`UPDATE pbp_releases SET status='failed', error=$2 WHERE release_id=$1`, [releaseId, fields.error ?? null]);
    } else {
      await c.query(`UPDATE pbp_releases SET status=$2 WHERE release_id=$1`, [releaseId, status]);
    }
  });
}

export async function purgeLanding(releaseId: number, tables: string[]): Promise<void> {
  await withClient(async (c) => {
    for (const t of tables) {
      // Skip tables that don't exist yet — a prior run may have failed
      // before all landing tables were created.
      const exists = await c.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
        [t],
      );
      if (exists.rows.length === 0) continue;
      await c.query(`DELETE FROM ${t} WHERE release_id = $1`, [releaseId]);
    }
  });
}

// ─── Dynamic schema management ────────────────────────────────────────

// Postgres type for a CMS column. PK / ID-shaped columns are forced
// to text to preserve leading zeros even when CMS declares them as NUM.
function pgTypeFor(col: PbpColumn): string {
  if (FORCED_TEXT_COLUMNS.has(col.name)) return 'text';
  if (col.type === 'text') return 'text';
  // CMS NUM columns are stored as numeric(20,4) — wide enough for any
  // declared LENGTH, preserves up to 4 decimal places. Promote step
  // narrows to specific types when projecting into pbp_*_v2.
  return 'numeric(20,4)';
}

// CREATE TABLE IF NOT EXISTS … with the full dictionary column list,
// then ALTER TABLE ADD COLUMN for any columns the dictionary has but
// the existing table is missing (YoY column drift).
export async function ensureLandingTable(
  client: PoolClient,
  spec: PbpFileSpec,
  columns: PbpColumn[],
): Promise<{ created: boolean; addedColumns: string[] }> {
  // Does the table exist?
  const exists = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [spec.landingTable],
  );

  if (exists.rows.length === 0) {
    const tolerateDupes = spec.dedupePolicy === 'tolerate-duplicates';
    const colDefs: string[] = [];
    if (tolerateDupes) {
      colDefs.push(`id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`);
    }
    colDefs.push(`release_id bigint NOT NULL REFERENCES pbp_releases(release_id) ON DELETE CASCADE`);
    for (const col of columns) {
      const isPk = spec.pkColumns.includes(col.name);
      const nn = isPk ? ' NOT NULL' : '';
      colDefs.push(`${col.name} ${pgTypeFor(col)}${nn}`);
    }
    if (!tolerateDupes) {
      const pk = ['release_id', ...spec.pkColumns].join(', ');
      colDefs.push(`PRIMARY KEY (${pk})`);
    }
    const ddl = `CREATE TABLE ${spec.landingTable} (\n  ${colDefs.join(',\n  ')}\n)`;
    await client.query(ddl);
    if (tolerateDupes) {
      // Non-unique index on the natural key for join performance.
      await client.query(
        `CREATE INDEX ${spec.landingTable}_natural_idx ON ${spec.landingTable} (${['release_id', ...spec.pkColumns].join(', ')})`,
      );
    }
    return { created: true, addedColumns: [] };
  }

  // Table exists — find missing columns.
  const live = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [spec.landingTable],
  );
  const liveNames = new Set(live.rows.map((r) => r.column_name as string));
  const missing = columns.filter((c) => !liveNames.has(c.name));
  for (const col of missing) {
    await client.query(
      `ALTER TABLE ${spec.landingTable} ADD COLUMN IF NOT EXISTS ${col.name} ${pgTypeFor(col)}`,
    );
  }
  return { created: false, addedColumns: missing.map((c) => c.name) };
}

// ─── Per-file load ────────────────────────────────────────────────────

function rowPrefix(releaseId: number): Buffer {
  return Buffer.from(`${releaseId}\t`, 'utf8');
}

export async function loadFile(opts: {
  client: PoolClient;
  spec: PbpFileSpec;
  zipPath: string;
  releaseId: number;
  /** Dictionary entries for this file (typed metadata). The actual
   *  column SET — and column ORDER — comes from the file's header
   *  row, since the dictionary occasionally lists columns CMS removed
   *  from the file (or vice versa) and we want CREATE TABLE to match
   *  the file exactly. */
  dictionaryColumns: PbpColumn[];
}): Promise<{ rows: number; skipped: boolean; created: boolean; addedColumns: string[] }> {
  const { client, spec, zipPath, releaseId, dictionaryColumns } = opts;

  // 1. Read the actual file header to drive the column list.
  const rawHeader = await readHeader(zipPath, spec.fileName);
  if (!rawHeader) {
    console.log(`[load]   ${spec.fileName}: not present in ZIP — skipped`);
    return { rows: 0, skipped: true, created: false, addedColumns: [] };
  }

  // 2. Dedupe the file's header. CMS occasionally lists the same
  //    column name twice in the header row (Section A has both
  //    pbp_a_plan_type and pbp_a_ben_cov duplicated). Keep first
  //    occurrence; project subsequent rows through selectedIndices.
  const { uniqueNames, selectedIndices, duplicates } = dedupeHeader(rawHeader);
  if (duplicates.length > 0) {
    console.log(`[load]   ${spec.fileName}: header has duplicate column(s), keeping first: ${duplicates.join(', ')}`);
  }

  // 3. Match each header name to a dictionary entry. Unknown names
  //    default to text (CMS occasionally adds columns the published
  //    dictionary hasn't caught up with yet — load the data, warn).
  const byName = new Map(dictionaryColumns.map((c) => [c.name.toLowerCase(), c] as const));
  const unknownInDict: string[] = [];
  const columns: PbpColumn[] = uniqueNames.map((name) => {
    const dict = byName.get(name);
    if (dict) return { ...dict, name };
    unknownInDict.push(name);
    return { name, type: 'text' as const, length: null, fieldTitle: '', codes: [] };
  });
  if (unknownInDict.length > 0) {
    console.log(`[load]   ${spec.fileName}: ${unknownInDict.length} col(s) absent from dictionary, defaulting to text: ${unknownInDict.slice(0, 5).join(', ')}${unknownInDict.length > 5 ? '…' : ''}`);
  }

  // 4. Make sure the target table exists with these columns.
  const ddl = await ensureLandingTable(client, spec, columns);
  if (ddl.created) console.log(`[load]   ${spec.landingTable}: CREATE TABLE (${columns.length} cols)`);
  else if (ddl.addedColumns.length) console.log(`[load]   ${spec.landingTable}: +${ddl.addedColumns.length} new col(s)`);

  // 5. Parse the .txt entry from the ZIP.
  const parsed = await parsePbpEntry({
    zipPath,
    fileName: spec.fileName,
    columns,
    selectedIndices,
  });
  if (!parsed) {
    return { rows: 0, skipped: true, ...ddl };
  }

  // COPY column list: release_id first, then dictionary columns in
  // their declared order.
  const columnList = `release_id,${columns.map((c) => c.name).join(',')}`;
  const sql = `COPY ${spec.landingTable} (${columnList}) FROM STDIN`;
  const sink = client.query(copyFrom(sql)) as unknown as NodeJS.WritableStream;

  const prefix = rowPrefix(releaseId);
  let lineHead = true;
  const start = Date.now();

  await pipeline(
    parsed.copyStream,
    async function* (source) {
      for await (const chunk of source) {
        const buf = chunk as Buffer;
        let cursor = 0;
        for (let i = 0; i < buf.length; i++) {
          if (lineHead) {
            if (cursor < i) yield buf.subarray(cursor, i);
            yield prefix;
            cursor = i;
            lineHead = false;
          }
          if (buf[i] === 0x0a /* \n */) lineHead = true;
        }
        if (cursor < buf.length) yield buf.subarray(cursor);
      }
    },
    sink,
  );

  const ms = Date.now() - start;
  const rows = parsed.rowCounter.count;
  console.log(`[load]   ${spec.fileName}: ${rows.toLocaleString()} rows in ${(ms / 1000).toFixed(1)}s`);
  return { rows, skipped: false, ...ddl };
}
