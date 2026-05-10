// scripts/cms-pbp/parser.ts
//
// Streams one .txt entry out of the PBP ZIP and emits each row as a
// COPY-FROM TEXT format line. Conceptually identical to the SPUF
// parser but:
//   • PBP ZIP is FLAT — each .txt is a direct entry, no inner ZIPs
//   • delimiter is TAB (\t), not pipe (|)
//   • headers are lowercase
//   • encoding is ASCII, line endings CRLF
//   • no quoting; long free-text fields contain unescaped quotes
//
// Coercion: empty / "." → \N for nullable columns, escape backslashes
// and tabs/newlines/CRs in text values for COPY TEXT format.

import yauzl, { type Entry } from 'yauzl';
import { parse as csvParse } from 'csv-parse';
import { Readable, Transform } from 'node:stream';
import type { PbpColumn } from './dictionary.js';

export interface ParseResult {
  copyStream: Readable;
  rowCounter: { count: number };
}

const NULL_MARKER = '\\N';

function escapeText(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x5c) out += '\\\\';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else out += value[i];
  }
  return out;
}

// Coerce one CMS cell to its COPY-TEXT representation. The dictionary
// declares a column as either CHAR (text) or NUM (numeric); numerics
// can have decimals (parsed leniently) or be empty / "." for SAS-style
// missing.
export function coerceCell(raw: string | undefined, col: PbpColumn): string {
  const v = (raw ?? '').trim();
  if (v === '' || v === '.') return NULL_MARKER;
  if (col.type === 'numeric' || col.type === 'integer') {
    if (!/^-?\d+(\.\d+)?$/.test(v)) {
      // CMS occasionally ships pseudo-numeric junk like "*" or "N/A"
      // in numeric columns. Coerce to NULL rather than blowing up.
      return NULL_MARKER;
    }
    return v;
  }
  return escapeText(v);
}

// Header validation — case-insensitive name match against the
// dictionary-declared column list. Order MUST match because COPY uses
// positional column lists. Returns null on success, error string on
// mismatch.
export function validateHeader(actual: string[], expected: PbpColumn[]): string | null {
  if (actual.length !== expected.length) {
    return `expected ${expected.length} columns, header has ${actual.length}`;
  }
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i].trim().toLowerCase();
    const e = expected[i].name.toLowerCase();
    if (a !== e) return `col ${i}: expected ${e}, got ${a}`;
  }
  return null;
}

export function rowToCopyLine(values: string[], expected: PbpColumn[]): string {
  if (values.length !== expected.length) {
    throw new Error(`expected ${expected.length} fields, got ${values.length}`);
  }
  const out = new Array(expected.length);
  for (let i = 0; i < expected.length; i++) {
    out[i] = coerceCell(values[i], expected[i]);
  }
  return out.join('\t');
}

// Stream a named .txt entry out of the outer ZIP, parse it, and emit
// COPY-format lines. Returns null if the entry isn't present.
//
// `columns` is the deduped column list the importer wants in the
// landing table (one entry per unique column name from the file's
// header). `selectedIndices` is the position in each raw file row
// to project for the corresponding `columns[i]` — handles CMS files
// where the header lists the same column name twice (Section A's
// pbp_a_plan_type / pbp_a_ben_cov, etc.) by keeping first occurrence.
//
// The first row from csv-parse is the header — skipped (caller has
// already validated it). Subsequent rows are projected through
// selectedIndices and emitted as COPY-format lines.
export async function parsePbpEntry(opts: {
  zipPath: string;
  fileName: string;
  columns: PbpColumn[];
  selectedIndices: number[];
}): Promise<ParseResult | null> {
  const entryStream = await openEntry(opts.zipPath, opts.fileName);
  if (!entryStream) return null;

  const rowCounter = { count: 0 };
  let headerSeen = false;
  const expected = opts.columns;
  const idx = opts.selectedIndices;
  if (expected.length !== idx.length) {
    throw new Error(
      `${opts.fileName}: columns/selectedIndices length mismatch (${expected.length} vs ${idx.length})`,
    );
  }

  const csvStream = csvParse({
    delimiter: '\t',
    columns: false,
    relax_quotes: true,
    // Some PBP files have ragged trailing tabs — accept variable column
    // counts; rows with fewer than max(idx)+1 fields just produce nulls
    // for missing positions.
    relax_column_count: true,
    skip_empty_lines: true,
    bom: true,
    trim: false,
  });

  const recordsToCopy = new Transform({
    writableObjectMode: true,
    readableObjectMode: false,
    transform(record: string[], _enc, cb) {
      try {
        if (!headerSeen) {
          // Caller validated the header before calling us. Skip it.
          headerSeen = true;
          return cb();
        }
        const projected = new Array(expected.length);
        for (let i = 0; i < expected.length; i++) {
          projected[i] = record[idx[i]] ?? '';
        }
        const line = rowToCopyLine(projected, expected);
        rowCounter.count += 1;
        cb(null, line + '\n');
      } catch (err) {
        cb(err as Error);
      }
    },
  });

  entryStream.on('error', (err) => recordsToCopy.destroy(err));
  csvStream.on('error', (err) => recordsToCopy.destroy(err));
  entryStream.pipe(csvStream).pipe(recordsToCopy);

  return { copyStream: recordsToCopy, rowCounter };
}

// Deduplicate file-header column names. Returns the unique names in
// order of first appearance plus the indices in the original row that
// correspond to each unique name (first occurrence wins).
export function dedupeHeader(rawHeader: string[]): {
  uniqueNames: string[];
  selectedIndices: number[];
  duplicates: string[];
} {
  const seen = new Map<string, number>();
  const uniqueNames: string[] = [];
  const selectedIndices: number[] = [];
  const duplicates: string[] = [];
  for (let i = 0; i < rawHeader.length; i++) {
    const name = rawHeader[i].trim().toLowerCase();
    if (!name) continue;
    if (seen.has(name)) {
      duplicates.push(name);
      continue;
    }
    seen.set(name, i);
    uniqueNames.push(name);
    selectedIndices.push(i);
  }
  return { uniqueNames, selectedIndices, duplicates };
}

// ─── yauzl helpers ────────────────────────────────────────────────────

function openEntry(zipPath: string, fileName: string): Promise<Readable | null> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('failed to open zip'));
      let resolved = false;
      zip.on('entry', (entry: Entry) => {
        const base = entry.fileName.split('/').pop() ?? entry.fileName;
        if (base.toLowerCase() === fileName.toLowerCase()) {
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

// Reads the first line of a .txt entry inside the ZIP and returns the
// header column names (lowercased, trimmed). Used to drive the
// dynamic CREATE TABLE so the landing schema always matches the
// file's actual columns — the dictionary tells us types, the file
// tells us what's actually there.
export async function readHeader(zipPath: string, fileName: string): Promise<string[] | null> {
  const stream = await openEntry(zipPath, fileName);
  if (!stream) return null;
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let done = false;
    stream.on('data', (chunk: Buffer) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a /* \n */);
      if (nl !== -1) {
        done = true;
        stream.destroy();
        const line = buf.subarray(0, nl).toString('utf8').replace(/\r$/, '');
        const names = line.split('\t').map((s) => s.trim().toLowerCase()).filter(Boolean);
        resolve(names);
      }
    });
    stream.on('end', () => {
      if (done) return;
      const line = buf.toString('utf8').replace(/\r$/, '');
      const names = line.split('\t').map((s) => s.trim().toLowerCase()).filter(Boolean);
      resolve(names);
    });
    stream.on('error', reject);
  });
}

// Locates the dictionary .xlsx inside the ZIP and extracts it to a
// temp path. CMS names it `PBP_Benefits_2026_dictionary.xlsx`
// (lowercase preserved) — matched flexibly here to handle YoY name
// changes.
export async function extractDictionary(zipPath: string, destPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('failed to open zip'));
      let resolved = false;
      zip.on('entry', (entry: Entry) => {
        const base = entry.fileName.split('/').pop() ?? entry.fileName;
        if (/dictionary\.xlsx$/i.test(base)) {
          resolved = true;
          zip.openReadStream(entry, async (err2, stream) => {
            if (err2 || !stream) return reject(err2 ?? new Error('failed to open dictionary'));
            const { createWriteStream } = await import('node:fs');
            const { pipeline } = await import('node:stream/promises');
            try {
              await pipeline(stream, createWriteStream(destPath));
              zip.close();
              resolve(destPath);
            } catch (e) {
              zip.close();
              reject(e);
            }
          });
          return;
        }
        zip.readEntry();
      });
      zip.on('end', () => {
        if (!resolved) {
          zip.close();
          reject(new Error('dictionary.xlsx not found in PBP ZIP'));
        }
      });
      zip.on('error', (e: unknown) => reject(e));
      zip.readEntry();
    });
  });
}
