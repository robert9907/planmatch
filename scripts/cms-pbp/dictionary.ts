// scripts/cms-pbp/dictionary.ts
//
// Parses PBP_Benefits_2026_dictionary.xlsx into a per-file column map.
// CMS ships the dictionary as a single Excel sheet with one row per
// (FILE, NAME) — listing the SAS type, max length, and (for coded
// fields) enumerated CODES + CODE_VALUES. We use TYPE + LENGTH to
// drive CREATE TABLE column defs; the code-value pairs are useful
// later for building human-readable benefit descriptions.
//
// xlsx is a single 1.5 MB Sheet. Parse takes ~150 ms once. Cached
// per-process.

import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';

export type PbpColumnType =
  | 'text'      // CMS Char(N) → text in Postgres (preserve leading zeros)
  | 'numeric'   // CMS Num — store as numeric(12,4); empty / "." → null
  | 'integer';  // CMS Num with no decimal — smallint/integer

export interface PbpColumn {
  name: string;          // lowercase column name as it appears in the .txt header
  type: PbpColumnType;
  length: number | null; // CMS-declared max length (null for unbounded numerics)
  fieldTitle: string;    // human label, e.g. "Primary Care Physician — Min Copay"
  codes: Array<{ code: string; value: string }>; // for enumerated fields
}

export interface PbpFileSchema {
  fileName: string;       // e.g. "pbp_b7_health_prof.txt"
  columns: PbpColumn[];
}

interface DictionaryRow {
  FILE: string;
  NAME: string;
  TYPE: string;        // 'CHAR' / 'NUM' / sometimes 'CHARACTER' / 'NUMERIC'
  LENGTH: string | number;
  FIELD_TITLE?: string;
  CODES?: string;
  CODE_VALUES?: string;
}

let cached: Map<string, PbpFileSchema> | null = null;

// Loads the dictionary once and indexes by file name (lowercase, with .txt suffix).
export function loadDictionary(xlsxPath: string): Map<string, PbpFileSchema> {
  if (cached) return cached;
  const buf = readFileSync(xlsxPath);
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<DictionaryRow>(sheet, { defval: '' });

  const byFile = new Map<string, PbpColumn[]>();
  for (const r of rows) {
    const fileRaw = String(r.FILE ?? '').trim();
    const name = String(r.NAME ?? '').trim();
    if (!fileRaw || !name) continue;

    // CMS lists filenames without the .txt extension and sometimes
    // with mixed case. Normalize to lowercase + .txt.
    const fileName = (fileRaw.toLowerCase().endsWith('.txt') ? fileRaw : `${fileRaw}.txt`).toLowerCase();

    const typeRaw = String(r.TYPE ?? '').trim().toUpperCase();
    const lenRaw = r.LENGTH;
    const length =
      typeof lenRaw === 'number'
        ? Math.floor(lenRaw)
        : Number.parseInt(String(lenRaw).trim(), 10);

    const type: PbpColumnType = typeRaw.startsWith('CHAR') ? 'text' : 'numeric';
    const fieldTitle = String(r.FIELD_TITLE ?? '').trim();

    // Parse coded values. CMS ships them as parallel newline-delimited
    // CODES / CODE_VALUES lists in two adjacent cells.
    const codeList = String(r.CODES ?? '').split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
    const valueList = String(r.CODE_VALUES ?? '').split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
    const codes: Array<{ code: string; value: string }> = [];
    for (let i = 0; i < codeList.length; i++) {
      codes.push({ code: codeList[i], value: valueList[i] ?? '' });
    }

    const col: PbpColumn = {
      name: name.toLowerCase(),
      type,
      length: Number.isFinite(length) ? length : null,
      fieldTitle,
      codes,
    };
    let arr = byFile.get(fileName);
    if (!arr) {
      arr = [];
      byFile.set(fileName, arr);
    }
    arr.push(col);
  }

  // Dedupe by lowercase column name within each file. CMS's
  // dictionary occasionally lists the same column twice (typically
  // the cross-cutting columns like pbp_a_ben_cov that appear in every
  // file's logical schema but get repeated in the source spreadsheet).
  // Keep the first occurrence — Postgres can't have duplicate column
  // names in CREATE TABLE.
  cached = new Map(
    [...byFile.entries()].map(([fileName, columns]) => {
      const seen = new Set<string>();
      const deduped: PbpColumn[] = [];
      for (const c of columns) {
        if (seen.has(c.name)) continue;
        seen.add(c.name);
        deduped.push(c);
      }
      return [fileName, { fileName, columns: deduped }];
    }),
  );
  return cached;
}

// Returns the column list for a file. Returns [] if the file isn't in
// the dictionary — some PBP files (notably PlanArea.txt) ship without
// dictionary entries. The loader handles this by inferring text type
// from the file's actual header.
export function columnsFor(
  dictionary: Map<string, PbpFileSchema>,
  fileName: string,
): PbpColumn[] {
  const fs = dictionary.get(fileName.toLowerCase());
  if (!fs) return [];
  return fs.columns;
}
