// scripts/cms-spuf/parser.ts
//
// Streams one entry out of the SPUF ZIP, validates its header against
// the CmsFileSpec column list, and emits each data row as a TAB-
// delimited line in Postgres COPY FROM TEXT format. The output stream
// is meant to be piped straight into pg-copy-streams.
//
// Why parse rather than COPY FROM CSV directly:
//   - CMS occasionally posts files with column-order or column-name
//     drift; we want a loud error rather than silently mis-loading.
//   - A handful of CMS columns are emitted as text in the file but
//     defined as numeric in the landing table (e.g., the COST_MIN_AMT_*
//     fields). Empty strings need to become NULL, not '0' or ''.
//   - Empty optional values are sometimes whitespace, sometimes empty,
//     sometimes a literal " " — normalize once here.
//
// COPY FROM TEXT format escaping (Postgres docs):
//   \\  → backslash
//   \n  → newline
//   \r  → carriage return
//   \t  → tab
//   \N  → null (literal backslash-N as the entire field)

import yauzl, { type Entry } from 'yauzl';
import { parse as csvParse } from 'csv-parse';
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CmsColumn, CmsFileSpec } from './schema.js';

// ─── COPY TEXT escaping ───────────────────────────────────────────────

const NULL_MARKER = '\\N';

function escapeText(value: string): string {
  // Order matters — backslash first or we'd double-escape our own escapes.
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x5c) out += '\\\\';                  // \
    else if (c === 0x0a) out += '\\n';              // \n
    else if (c === 0x0d) out += '\\r';              // \r
    else if (c === 0x09) out += '\\t';              // \t
    else out += value[i];
  }
  return out;
}

// ─── Per-type coercion ────────────────────────────────────────────────

export interface CoerceContext {
  fileName: string;
  rowNum: number;
  column: CmsColumn;
}

function coerceCell(raw: string | undefined, ctx: CoerceContext): string {
  const v = (raw ?? '').trim();
  if (v === '') {
    if (ctx.column.nullable) return NULL_MARKER;
    // CMS sometimes emits whitespace where it shouldn't. We don't fail
    // hard on this — emit NULL_MARKER and let the NOT NULL constraint
    // catch it during COPY (with row context in the error).
    return NULL_MARKER;
  }
  // SAS-style missing-numeric sentinel. CMS sometimes ships `.` in
  // numeric columns to mean "not applicable" (e.g. insulin_beneficiary_cost
  // TIER for plans with no tiered insulin benefit). Treat as NULL for
  // numeric and smallint; for text/yn fall through (`.` is a real value).
  if ((ctx.column.type === 'smallint' || ctx.column.type === 'numeric') && v === '.') {
    return NULL_MARKER;
  }
  switch (ctx.column.type) {
    case 'text':
    case 'yn':
      return escapeText(v);
    case 'smallint': {
      // Allow leading zeros ("030") and signs. parseInt drops trailing
      // junk silently — guard with a regex first.
      if (!/^-?\d+$/.test(v)) {
        throw new Error(
          `${ctx.fileName} row ${ctx.rowNum} ${ctx.column.cms}: not an integer: ${JSON.stringify(v)}`,
        );
      }
      return String(Number(v));
    }
    case 'numeric': {
      if (!/^-?\d+(\.\d+)?$/.test(v)) {
        throw new Error(
          `${ctx.fileName} row ${ctx.rowNum} ${ctx.column.cms}: not numeric: ${JSON.stringify(v)}`,
        );
      }
      return v;
    }
    case 'date': {
      if (!/^\d{8}$/.test(v)) {
        throw new Error(
          `${ctx.fileName} row ${ctx.rowNum} ${ctx.column.cms}: not YYYYMMDD: ${JSON.stringify(v)}`,
        );
      }
      return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    }
  }
}

// ─── Header validation ────────────────────────────────────────────────

export function validateHeader(actual: string[], spec: CmsFileSpec): void {
  if (actual.length !== spec.columns.length) {
    throw new Error(
      `${spec.fileName}: expected ${spec.columns.length} columns, header has ${actual.length}. ` +
        `actual=${actual.join('|')}`,
    );
  }
  const mismatches: string[] = [];
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i].trim().toUpperCase();
    const e = spec.columns[i].cms.toUpperCase();
    if (a !== e) mismatches.push(`col ${i}: expected ${e}, got ${a}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`${spec.fileName} header mismatch: ${mismatches.join('; ')}`);
  }
}

// ─── Row transform ────────────────────────────────────────────────────

// Builds one COPY-format line (no trailing newline; caller adds it).
export function rowToCopyLine(values: string[], spec: CmsFileSpec, rowNum: number): string {
  if (values.length !== spec.columns.length) {
    throw new Error(
      `${spec.fileName} row ${rowNum}: expected ${spec.columns.length} fields, got ${values.length}`,
    );
  }
  const out: string[] = new Array(spec.columns.length);
  for (let i = 0; i < spec.columns.length; i++) {
    out[i] = coerceCell(values[i], {
      fileName: spec.fileName,
      rowNum,
      column: spec.columns[i],
    });
  }
  return out.join('\t');
}

// ─── Streaming entry → COPY rows ──────────────────────────────────────
//
// The CMS SPUF ZIP is a ZIP-of-ZIPs: the outer archive contains one
// inner ZIP per data file (with human-friendly names like
// "basic drugs formulary file  PPUF_2026Q1.zip"), and each inner ZIP
// contains the actual pipe-delimited .txt. pharmacy_networks is split
// into multiple parts (e.g. "part 1.zip" through "part 6.zip"), each
// containing a partial .txt — concatenated logically with the header
// row dropped on parts 2+.
//
// Pipeline per spec:
//   1. Find matching inner ZIP entries in the outer ZIP (by regex)
//   2. Stream-extract each inner ZIP to a temp file
//   3. Stream-extract its single .txt to a temp file
//   4. Concatenate .txt files into one canonical stream (drop headers
//      on parts 2+) and pipe through csv-parse → COPY-format

export interface ParseResult {
  copyStream: Readable;
  rowCounter: { count: number };
}

// Produces tab-delimited COPY rows for a CmsFileSpec. Uses a pipeline
// of:
//   concatTxts (async iterable, drops header on parts 2+) →
//   csv-parse (object-mode records) →
//   recordsToCopy Transform (object-mode in, byte-mode out) →
//   ParseResult.copyStream (consumed by pg-copy-streams)
//
// All streams have native backpressure — the COPY sink controls the
// pace, csv-parse and the file readers throttle automatically. The
// previous implementation manually managed Readable.push() and watched
// for a 'drain' event that doesn't exist on Readable streams, which
// blew memory when consumers were slower than the producer (e.g.
// loading the 2 GB pricing file).

export async function parseSpufEntry(
  zipPath: string,
  spec: CmsFileSpec,
  workDir: string,
): Promise<ParseResult | null> {
  const txtPaths = await locateAndExtract(zipPath, spec, workDir);
  if (txtPaths.length === 0) return null;

  const rowCounter = { count: 0 };
  let headerSeen = false;

  const csvStream = csvParse({
    delimiter: '|',
    columns: false,
    relax_quotes: true,
    relax_column_count: false,
    skip_empty_lines: true,
    bom: true,
    trim: false,
  });

  // Object-mode in, byte-mode out — converts each parsed CSV record
  // to a COPY-format line. validateHeader runs once on the first row.
  const recordsToCopy = new Transform({
    writableObjectMode: true,
    readableObjectMode: false,
    transform(record: string[], _enc, cb) {
      try {
        if (!headerSeen) {
          validateHeader(record, spec);
          headerSeen = true;
          return cb();
        }
        const line = rowToCopyLine(record, spec, rowCounter.count + 1);
        rowCounter.count += 1;
        cb(null, line + '\n');
      } catch (err) {
        cb(err as Error);
      }
    },
  });

  // Async-iterable source: read each .txt sequentially, dropping the
  // header line on every file after the first. Native backpressure via
  // for-await-of.
  const source = Readable.from(concatTxts(txtPaths));

  // Wire up: source → csv-parse → recordsToCopy. Errors propagate.
  // We don't await the pipeline; the loader awaits the COPY sink which
  // ends when recordsToCopy ends.
  source.on('error', (err) => recordsToCopy.destroy(err));
  csvStream.on('error', (err) => recordsToCopy.destroy(err));
  source.pipe(csvStream).pipe(recordsToCopy);

  return { copyStream: recordsToCopy, rowCounter };
}

// Reads each .txt path sequentially. Keeps the header on path 0 (csv-
// parse needs it for validation), strips the first line on every
// subsequent path. Standard async iterable — pipeline backpressure
// works through it natively.
async function* concatTxts(paths: string[]): AsyncIterable<Buffer> {
  for (let i = 0; i < paths.length; i++) {
    const stripHeader = i > 0;
    let headerDropped = !stripHeader;
    for await (const chunk of createReadStream(paths[i])) {
      let buf = chunk as Buffer;
      if (!headerDropped) {
        const nl = buf.indexOf(0x0a /* \n */);
        if (nl === -1) continue;             // entire chunk is the header
        buf = buf.subarray(nl + 1);
        headerDropped = true;
      }
      yield buf;
    }
  }
}

// ─── locate & extract ────────────────────────────────────────────────
//
// Finds matching inner ZIPs in the outer SPUF, extracts each to a
// temp file, then extracts its single inner .txt. Returns the temp
// .txt paths sorted by part number for multi-part specs.

async function locateAndExtract(
  outerZipPath: string,
  spec: CmsFileSpec,
  workDir: string,
): Promise<string[]> {
  const matches = await listMatchingEntries(outerZipPath, spec.innerZipPattern);
  if (matches.length === 0) return [];

  // For multi-part files, sort by trailing "part N" number so parts
  // load in order. Single-part files have one match.
  const sorted = sortByPartNumber(matches);
  if (!spec.multiPart && sorted.length > 1) {
    throw new Error(
      `${spec.name}: regex matched ${sorted.length} entries (${sorted
        .map((s) => s.name)
        .join(', ')}) but spec is single-part`,
    );
  }

  const dest = join(workDir, spec.name);
  mkdirSync(dest, { recursive: true });

  const txtPaths: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const innerZipPath = join(dest, `inner-${i}.zip`);
    const innerTxtPath = join(dest, `data-${i}.txt`);
    await extractEntryToFile(outerZipPath, sorted[i].entryName, innerZipPath);
    await extractSingleTxt(innerZipPath, innerTxtPath);
    txtPaths.push(innerTxtPath);
  }
  return txtPaths;
}

// Sorts inner-ZIP entries by trailing "part N" (1-indexed). Entries
// without "part" stay in alphabetical order.
function sortByPartNumber(
  entries: { entryName: string; name: string }[],
): { entryName: string; name: string }[] {
  const partNum = (n: string): number => {
    const m = n.match(/part\s*(\d+)/i);
    return m ? Number(m[1]) : 0;
  };
  return [...entries].sort((a, b) => {
    const na = partNum(a.name);
    const nb = partNum(b.name);
    if (na !== nb) return na - nb;
    return a.name.localeCompare(b.name);
  });
}

// Returns inner-ZIP entries whose basename matches the given regex.
function listMatchingEntries(
  zipPath: string,
  pattern: RegExp,
): Promise<{ entryName: string; name: string }[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('failed to open zip'));
      const out: { entryName: string; name: string }[] = [];
      zip.on('entry', (entry: Entry) => {
        const base = entry.fileName.split('/').pop() ?? entry.fileName;
        if (pattern.test(base)) out.push({ entryName: entry.fileName, name: base });
        zip.readEntry();
      });
      zip.on('end', () => {
        zip.close();
        resolve(out);
      });
      zip.on('error', (e: unknown) => reject(e));
      zip.readEntry();
    });
  });
}

// Stream-extract a single named entry from a ZIP to a destination path.
async function extractEntryToFile(
  zipPath: string,
  entryName: string,
  destPath: string,
): Promise<void> {
  const stream = await openEntryByName(zipPath, entryName);
  if (!stream) throw new Error(`Entry not found in ${zipPath}: ${entryName}`);
  await pipeline(stream, createWriteStream(destPath));
}

// Extract the single .txt file inside an inner ZIP. Inner ZIPs in the
// SPUF bundle each contain exactly one .txt; if that ever changes the
// importer should fail loudly rather than silently picking the wrong file.
async function extractSingleTxt(innerZipPath: string, destPath: string): Promise<void> {
  const txtName = await new Promise<string>((resolve, reject) => {
    yauzl.open(innerZipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('failed to open inner zip'));
      const txtNames: string[] = [];
      zip.on('entry', (entry: Entry) => {
        const base = entry.fileName.split('/').pop() ?? entry.fileName;
        if (base.toLowerCase().endsWith('.txt')) txtNames.push(entry.fileName);
        zip.readEntry();
      });
      zip.on('end', () => {
        zip.close();
        if (txtNames.length === 0) return reject(new Error(`No .txt in ${innerZipPath}`));
        if (txtNames.length > 1) {
          return reject(new Error(`Multiple .txt files in ${innerZipPath}: ${txtNames.join(', ')}`));
        }
        resolve(txtNames[0]);
      });
      zip.on('error', (e: unknown) => reject(e));
      zip.readEntry();
    });
  });
  await extractEntryToFile(innerZipPath, txtName, destPath);
}

// Open a named entry's read stream. Used by extractEntryToFile.
function openEntryByName(zipPath: string, entryName: string): Promise<Readable | null> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('failed to open zip'));
      let resolved = false;
      zip.on('entry', (entry: Entry) => {
        if (entry.fileName === entryName) {
          resolved = true;
          zip.openReadStream(entry, (err2, stream) => {
            if (err2 || !stream) return reject(err2 ?? new Error('failed to open entry'));
            stream.on('end', () => zip.close());
            stream.on('error', () => zip.close());
            resolve(stream);
          });
          return;
        }
        zip.readEntry();
      });
      zip.on('end', () => {
        if (!resolved) {
          zip.close();
          resolve(null);
        }
      });
      zip.on('error', (e: unknown) => reject(e));
      zip.readEntry();
    });
  });
}

// List every entry in the ZIP — used by the importer for the
// "unexpected entries" warning at the start of each run.
export function listZipEntries(zipPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('failed to open zip'));
      const names: string[] = [];
      zip.on('entry', (entry: Entry) => {
        const base = entry.fileName.split('/').pop() ?? entry.fileName;
        names.push(base);
        zip.readEntry();
      });
      zip.on('end', () => {
        zip.close();
        resolve(names);
      });
      zip.on('error', (e: unknown) => reject(e));
      zip.readEntry();
    });
  });
}

// Returns a fresh per-import working directory for inner-ZIP and
// extracted-.txt scratch files. The CLI cleans this up at the end
// unless --keep-zip is set.
export function makeWorkDir(): string {
  const dir = join(tmpdir(), `cms-spuf-work-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
