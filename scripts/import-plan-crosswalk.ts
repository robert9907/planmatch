#!/usr/bin/env tsx
/**
 * CMS Plan Crosswalk loader → aep.plan_crosswalk.
 *
 * The plan crosswalk is the file that tells us which of a client's plans renew,
 * consolidate, shrink their service area (SAR), expand (SAE), or terminate going
 * into the next contract year. It is the backbone of every AEP retention call.
 *
 * Source: https://www.cms.gov/files/zip/plan-crosswalk-<DEST_YEAR>.zip
 *   Inner: PlanCrosswalk<DEST_YEAR>_<MMDDYYYY>.txt   (tab-delimited, 11 cols)
 *          — the MMDDYYYY suffix is the posting date and is unguessable, so we
 *            GLOB the inner .txt by pattern rather than hardcoding the date.
 *
 * Hard-won facts baked into this loader (do not "simplify" them away):
 *
 *  • ENCODING IS cp1252, not UTF-8. Reading as UTF-8 blows up on 0x96 (en dash)
 *    in plan-name columns. We decode latin1 + a cp1252 0x80-0x9F fix-up map.
 *    (All columns we STORE are ASCII — ids + status — so this is belt-and-
 *    suspenders, but it keeps the parse honest and future-proofs a name column.)
 *
 *  • TERMINATION IS A STATUS, NOT A NULL. CURRENT_CONTRACT_ID / CURRENT_PLAN_ID
 *    are populated on EVERY row, including every "Terminated/Non-renewed
 *    Contract". STATUS is the ONLY source of truth for what happened. We NEVER
 *    infer termination from missing current values — a loader that did would
 *    report every terminated plan as renewing, the single most damaging error.
 *
 *  • THE FILE HAS NO SEGMENT ID. The crosswalk is contract-plan level. We write
 *    prev_segment / curr_segment as NULL rather than asserting '0' — '0' is a
 *    real segment value the source never states. (Nothing joins on segment.)
 *
 *  • from_year is the SOURCE year, not the filename's DESTINATION year. The
 *    PlanCrosswalk2027 file describes 2026 -> 2027, so its from_year is 2026.
 *    Passed explicitly via --from-year (required) so it is never guessed.
 *
 *  • STATUS is open. Each of the seven known values maps to a stable
 *    status_class slug (see STATUS_CLASS). An UNRECOGNIZED status RAISES — it
 *    never falls into a default bucket.
 *
 *  • Idempotent: a re-post supersedes. --apply does DELETE WHERE from_year=$y
 *    then INSERT, in one transaction, so a second posting replaces the first for
 *    that from_year rather than duplicating it.
 *
 * Usage:
 *   npm run crosswalk:import -- --zip=/path/to/plan-crosswalk-2026.zip --from-year=2026           # dry run
 *   npm run crosswalk:import -- --url=https://www.cms.gov/files/zip/plan-crosswalk-2027.zip --from-year=2026 --apply
 *   npm run crosswalk:import -- --from-year=2026 --apply    # defaults --url to the from_year+1 canonical zip
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import './cms-spuf/env.js';
import { withClient, withTransaction, closePool } from './cms-spuf/pg.js';

// ── CMS STATUS -> stable status_class slug ──────────────────────────────────
// Verbatim STATUS is stored too; this slug is what retention logic filters on.
// The six slugs match the aep.plan_crosswalk CHECK constraint
// ('renewal','consolidated','sar','terminated','new','other'). Confirmed against
// 2026_plan_crosswalk_readme.pdf:
//   • SAR = service area REDUCTION (keeps only a PORTION of the area → members
//     in dropped counties LOSE the plan). Its own adverse slug.
//   • SAE = service area EXPANSION (keeps all area, ADDS counties; employer-only
//     renewals). Non-adverse — no member loses coverage → folds into 'renewal'.
//   • New Plan = new plan on an existing contract; Initial Contract = new plan
//     on a new contract. Both are new supply with no prior-year member → 'new'.
// 'other' is intentionally never emitted — a future status must be mapped
// explicitly (after reading its definition), not defaulted.
const STATUS_CLASS: Record<string, string> = {
  'Renewal Plan': 'renewal',
  'Renewal Plan with SAE': 'renewal',
  'Renewal Plan with SAR': 'sar',
  'Consolidated Renewal Plan': 'consolidated',
  'Terminated/Non-renewed Contract': 'terminated',
  'New Plan': 'new',
  'Initial Contract': 'new',
};

// cp1252 bytes 0x80-0x9F that differ from latin1, keyed by byte -> Unicode code
// point. Everything else (0x00-0x7F, 0xA0-0xFF) is identical between cp1252 and
// latin1, so a native latin1 decode + this fix-up on the high range is a correct
// cp1252 decode. The five undefined cp1252 slots (0x81,0x8D,0x8F,0x90,0x9D) are
// absent here and pass through unchanged.
const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};
function decodeCp1252(buf: Buffer): string {
  let out = '';
  for (let i = 0; i < buf.length; i += 1) {
    const b = buf[i];
    const mapped = b >= 0x80 && b <= 0x9f && CP1252_HIGH[b] != null ? CP1252_HIGH[b] : b;
    out += String.fromCharCode(mapped);
  }
  return out;
}

const EXPECTED_HEADER = [
  'PREVIOUS_CONTRACT_ID', 'PREVIOUS_PLAN_ID', 'PREVIOUS_PLAN_NAME',
  'PREVIOUS_SNP_TYPE', 'PREVIOUS_SNP_INSTITUTIONAL',
  'CURRENT_CONTRACT_ID', 'CURRENT_PLAN_ID', 'CURRENT_PLAN_NAME',
  'CURRENT_SNP_TYPE', 'CURRENT_SNP_INSTITUTIONAL', 'STATUS',
];

interface Args {
  zip?: string;
  url?: string;
  fromYear: number;
  apply: boolean;
  keep: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { apply: false, keep: false };
  for (const a of argv) {
    if (a.startsWith('--zip=')) out.zip = a.slice(6);
    else if (a.startsWith('--url=')) out.url = a.slice(6);
    else if (a.startsWith('--from-year=')) out.fromYear = Number(a.slice(12));
    else if (a === '--apply') out.apply = true;
    else if (a === '--keep-download') out.keep = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.fromYear || !Number.isInteger(out.fromYear)) {
    throw new Error('--from-year=<YYYY> is required (the SOURCE year; the 2027 file is from_year=2026)');
  }
  return out as Args;
}

function canonicalUrl(destYear: number): string {
  return `https://www.cms.gov/files/zip/plan-crosswalk-${destYear}.zip`;
}

async function downloadZip(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: ${url} -> HTTP ${res.status}`);
  await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(dest));
}

// Pull the single PlanCrosswalk<DEST>_<MMDDYYYY>.txt out of the zip, matched by
// pattern (the date suffix is the posting date — globbed, never hardcoded).
function extractCrosswalkTxt(
  zipPath: string,
): Promise<{ buf: Buffer; entryName: string; destYear: number; postedMMDDYYYY: string }> {
  const re = /PlanCrosswalk(\d{4})_(\d{8})\.txt$/i;
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('zip open failed'));
      let matched: { destYear: number; posted: string; name: string } | null = null;
      zip.on('entry', (entry) => {
        const m = re.exec(entry.fileName);
        if (!m) return zip.readEntry();
        matched = { destYear: Number(m[1]), posted: m[2], name: entry.fileName };
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e ?? new Error('readStream failed'));
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () =>
            resolve({
              buf: Buffer.concat(chunks),
              entryName: matched!.name,
              destYear: matched!.destYear,
              postedMMDDYYYY: matched!.posted,
            }),
          );
          stream.on('error', reject);
        });
      });
      zip.on('end', () => {
        if (!matched) reject(new Error('no PlanCrosswalk<YYYY>_<MMDDYYYY>.txt entry found in zip'));
      });
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

interface Row {
  prevContract: string;
  prevPlan: string;
  currContract: string;
  currPlan: string;
  status: string;
  statusClass: string;
  isEmployer: boolean;
}

const isEmployerPlan = (planId: string): boolean => /^\d+$/.test(planId) && Number(planId) >= 800;

function parseRows(txt: string): { rows: Row[]; dataLineCount: number } {
  // CRLF per CMS; tolerate bare LF. Drop a trailing blank line if present.
  const lines = txt.split(/\r\n|\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) throw new Error('file is empty');

  const header = lines[0].split('\t');
  if (header.length !== EXPECTED_HEADER.length || header.some((h, i) => h !== EXPECTED_HEADER[i])) {
    throw new Error(`header mismatch.\n  expected: ${EXPECTED_HEADER.join(' | ')}\n  got:      ${header.join(' | ')}`);
  }
  const col = Object.fromEntries(EXPECTED_HEADER.map((n, i) => [n, i])) as Record<string, number>;

  const dataLines = lines.slice(1);
  const rows: Row[] = [];
  dataLines.forEach((line, i) => {
    const f = line.split('\t');
    if (f.length !== EXPECTED_HEADER.length) {
      throw new Error(`row ${i + 2}: expected ${EXPECTED_HEADER.length} columns, got ${f.length}`);
    }
    const prevContract = f[col.PREVIOUS_CONTRACT_ID].trim();
    const prevPlan = f[col.PREVIOUS_PLAN_ID].trim();
    const currContract = f[col.CURRENT_CONTRACT_ID].trim();
    const currPlan = f[col.CURRENT_PLAN_ID].trim();
    const status = f[col.STATUS].trim();

    // Every id field must be populated — the file guarantees this, and an empty
    // one means the parse drifted (bad split) or the file changed shape.
    if (!prevContract || !prevPlan || !currContract || !currPlan) {
      throw new Error(`row ${i + 2}: empty id field (prev ${prevContract}/${prevPlan}, curr ${currContract}/${currPlan})`);
    }
    const statusClass = STATUS_CLASS[status];
    if (!statusClass) {
      throw new Error(`row ${i + 2}: UNRECOGNIZED status ${JSON.stringify(status)} — add it to STATUS_CLASS after reading its readme definition; do not default it.`);
    }
    rows.push({
      prevContract,
      prevPlan,
      currContract,
      currPlan,
      status,
      statusClass,
      isEmployer: isEmployerPlan(prevPlan) || isEmployerPlan(currPlan),
    });
  });
  return { rows, dataLineCount: dataLines.length };
}

function summarize(rows: Row[]): void {
  const byStatus = new Map<string, number>();
  const byClass = new Map<string, number>();
  for (const r of rows) {
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    byClass.set(r.statusClass, (byClass.get(r.statusClass) ?? 0) + 1);
  }
  const contractChange = rows.filter((r) => r.prevContract !== r.currContract).length;
  const employer = rows.filter((r) => r.isEmployer).length;
  console.log(`\n  rows parsed: ${rows.length}`);
  console.log('  STATUS (verbatim):');
  for (const [k, v] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(5)}  ${k}`);
  console.log('  status_class:');
  for (const [k, v] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(5)}  ${k}`);
  console.log(`  contract changed (prev_contract <> curr_contract): ${contractChange}`);
  console.log(`  employer plans (plan_id >= 800 either side): ${employer}`);
}

// Supersede keys on from_year: DELETE the whole from_year, then INSERT the new
// posting. A same-year re-post (new posting date) replaces cleanly; a different
// from_year is never touched, so prior years stay as history. Each row records
// which posting it came from.
async function load(rows: Row[], fromYear: number, posting: string, sourceUrl: string): Promise<{ deleted: number; inserted: number }> {
  return withTransaction(async (c) => {
    const del = await c.query('DELETE FROM aep.plan_crosswalk WHERE from_year = $1', [fromYear]);
    const CHUNK = 500;
    const COLS = 12;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const values: unknown[] = [];
      const tuples = slice.map((r, j) => {
        const b = j * COLS;
        values.push(
          fromYear, r.prevContract, r.prevPlan, null, // prev_segment NULL — file has no segment
          r.currContract, r.currPlan, null,            // curr_segment NULL
          r.status, r.statusClass, r.isEmployer, posting, sourceUrl,
        );
        return `(${Array.from({ length: COLS }, (_, k) => `$${b + k + 1}`).join(',')})`;
      });
      const sql = `INSERT INTO aep.plan_crosswalk
        (from_year, prev_contract, prev_plan, prev_segment, curr_contract, curr_plan, curr_segment, status, status_class, is_employer, posting, source_url)
        VALUES ${tuples.join(',')}`;
      const res = await c.query(sql, values);
      inserted += res.rowCount ?? 0;
    }
    if (inserted !== rows.length) {
      throw new Error(`insert count ${inserted} != parsed rows ${rows.length} — rolling back`);
    }
    return { deleted: del.rowCount ?? 0, inserted };
  });
}

// Register the load in cms_watch the way the rest of the figure pipeline does:
// merge loaded_* into the source's config (NEVER rewrite curated metadata — the
// source row is owned by the watcher), append a check, and log an event. Reached
// over the direct Postgres connection (cms_watch is off the PostgREST surface, so
// no public wrapper is needed). Best-effort: a failure here must not fail a load
// that already committed.
async function registerCmsWatch(opts: {
  destYear: number;
  fromYear: number;
  posting: string;
  rows: number;
  sha256: string;
  contentBytes: number;
  zipUrl: string;
  detail: string;
}): Promise<void> {
  const sourceKey = `plan_crosswalk_${opts.destYear}`;
  const loadedTarget = `aep.plan_crosswalk from_year=${opts.fromYear}`;
  const loadedConfig = JSON.stringify({
    loaded_rows: opts.rows,
    loaded_sha256: opts.sha256,
    loaded_target: loadedTarget,
    loaded_posting: opts.posting,
  });
  await withClient(async (c) => {
    // Upsert only config (+ minimal row if the watcher hasn't created it yet).
    await c.query(
      // category 'crosswalk' matches the pipeline's existing plan_crosswalk_2027
      // source. On conflict we touch ONLY config — the source row is the
      // watcher's to curate (label, expected dates, notes, etc.).
      `insert into cms_watch.sources (source_key, domain, category, label, method, url, plan_year, config)
       values ($1,'medicare','crosswalk',$2,'http_probe',$3,$4,$5::jsonb)
       on conflict (source_key) do update
         set config = cms_watch.sources.config || excluded.config, updated_at = now()`,
      [sourceKey, `Plan Crosswalk ${opts.destYear}`, opts.zipUrl, opts.destYear, loadedConfig],
    );
    await c.query(
      `insert into cms_watch.checks (source_key, ok, available, http_status, content_bytes, content_hash, payload)
       values ($1, true, true, 200, $2, $3, $4::jsonb)`,
      [sourceKey, opts.contentBytes, opts.sha256,
       JSON.stringify({ loaded_rows: opts.rows, from_year: opts.fromYear, posting: opts.posting })],
    );
    await c.query(
      `insert into cms_watch.events (source_key, event_type, severity, plan_year, title, detail, url)
       values ($1,'new_item','normal',$2,$3,$4,$5)`,
      [sourceKey, opts.destYear,
       `Plan crosswalk ${opts.destYear} loaded (from_year=${opts.fromYear}, posting ${opts.posting}): ${opts.rows} rows`,
       opts.detail, opts.zipUrl],
    );
  });
}

function statusBreakdown(rows: Row[]): string {
  const byClass = new Map<string, number>();
  for (const r of rows) byClass.set(r.statusClass, (byClass.get(r.statusClass) ?? 0) + 1);
  const cc = rows.filter((r) => r.prevContract !== r.currContract).length;
  const emp = rows.filter((r) => r.isEmployer).length;
  const parts = [...byClass.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`);
  return `status_class: ${parts.join(', ')}. ${cc} contract changes; ${emp} employer.`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let zipPath = args.zip;
  let tmp: string | undefined;
  let sourceBase = args.url;
  if (!zipPath) {
    // Download. Default URL = the NEXT year's canonical zip (from_year + 1).
    sourceBase = args.url ?? canonicalUrl(args.fromYear + 1);
    tmp = await mkdtemp(join(tmpdir(), 'crosswalk-'));
    zipPath = join(tmp, 'crosswalk.zip');
    console.log(`Downloading ${sourceBase} ...`);
    await downloadZip(sourceBase, zipPath);
  }

  try {
    const { buf, entryName, destYear, postedMMDDYYYY } = await extractCrosswalkTxt(zipPath);
    const txt = decodeCp1252(buf);
    const { rows, dataLineCount } = parseRows(txt);

    const impliedSourceYear = destYear - 1;
    const sourceUrl = `${sourceBase ?? canonicalUrl(destYear)}#${entryName}`;

    console.log(`\nPlan Crosswalk — ${entryName}`);
    console.log(`  destination year (filename): ${destYear}  |  posted: ${postedMMDDYYYY}`);
    console.log(`  --from-year: ${args.fromYear}  (rule: source year = destYear-1 = ${impliedSourceYear})`);
    if (args.fromYear !== impliedSourceYear) {
      console.log(`  ! NOTE: --from-year ${args.fromYear} != rule-implied source year ${impliedSourceYear} for this file.`);
    }
    console.log(`  source_url: ${sourceUrl}`);
    summarize(rows);
    // Sanity: no silently dropped rows.
    if (rows.length !== dataLineCount) {
      throw new Error(`parsed ${rows.length} but file had ${dataLineCount} data lines`);
    }

    if (!args.apply) {
      console.log('\n  DRY RUN — no rows written. Re-run with --apply to load.');
    } else {
      const { deleted, inserted } = await load(rows, args.fromYear, postedMMDDYYYY, sourceUrl);
      console.log(`\n  APPLIED — from_year=${args.fromYear}: deleted ${deleted} prior rows, inserted ${inserted}.`);
      // Register in cms_watch (best-effort — the load is already committed).
      try {
        const sha256 = createHash('sha256').update(buf).digest('hex');
        await registerCmsWatch({
          destYear,
          fromYear: args.fromYear,
          posting: postedMMDDYYYY,
          rows: inserted,
          sha256,
          contentBytes: buf.length,
          zipUrl: sourceBase ?? canonicalUrl(destYear),
          detail: statusBreakdown(rows),
        });
        console.log(`  cms_watch: registered load on source plan_crosswalk_${destYear} (loaded_posting=${postedMMDDYYYY}).`);
      } catch (err) {
        console.warn(`  cms_watch: registration failed (load is unaffected): ${err instanceof Error ? err.message : err}`);
      }
    }
  } finally {
    if (tmp && !args.keep) await rm(tmp, { recursive: true, force: true });
    await closePool();
  }
}

main().catch((err) => {
  console.error('\n✗ crosswalk import failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
  void closePool();
});
