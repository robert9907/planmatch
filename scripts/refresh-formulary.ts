#!/usr/bin/env tsx
// scripts/refresh-formulary.ts
//
// One-command CMS SPUF refresh. Wraps the existing importer
// (scripts/import-cms-spuf.ts) so an operator (or a cron trigger from
// the release monitor) can run a single command and get:
//
//   1. Discovery of the latest CMS SPUF/PUF ZIP for the requested
//      (year, kind) — reuses scripts/cms-spuf/discover.ts.
//   2. Idempotency check — if the discovered release_date is already
//      promoted in cms_spuf_releases, skip and confirm; --force bypasses.
//   3. Delegates download / validate / load / promote to
//      `npm run formulary:import` (child process). Does NOT reimplement
//      or edit any of the SPUF pipeline internals — those are already
//      hardened (parser.test.ts, schema.ts, promote.ts single-txn swap).
//   4. Read-back — queries cms_spuf_releases + pm_formulary_v2 for the
//      just-imported release and captures per-state row counts.
//   5. Confirmation SMS to Rob's phone summarising: release date,
//      duration, row counts per state, and any warnings.
//
// Usage:
//   npm exec tsx scripts/refresh-formulary.ts
//     Latest quarterly release for the current calendar year, promote,
//     SMS on success.
//
//   npm exec tsx scripts/refresh-formulary.ts -- --kind=monthly
//   npm exec tsx scripts/refresh-formulary.ts -- --year=2026 --quarter=Q1
//   npm exec tsx scripts/refresh-formulary.ts -- --release-date=20260408
//
//   --force        Bypass "already promoted" check.
//   --dry-run      Discovery + already-promoted check ONLY. Skips the
//                  import subprocess AND the SMS send. Prints what
//                  would happen. Composes and prints the SMS body so
//                  operators can review it.
//
// Env (via scripts/cms-spuf/env.ts → .env.local):
//   DATABASE_URL           — Plan Match prod Postgres URI. Same var the
//                            underlying importer uses.
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_PHONE_NUMBER
//   FORMULARY_ALERT_PHONE  — E.164 destination; defaults to +18287613326.
//
// Exit codes:
//   0  success (or dry-run completed) — SMS sent unless --dry-run
//   1  discovery failed (CMS page changed or no releases yet)
//   2  invalid args
//   3  importer subprocess failed (SMS still sent with failure body)
//   4  post-import read-back failed (importer succeeded but we can't
//      confirm row counts — SMS sent with warning)

import './cms-spuf/env.js';
import { spawn } from 'node:child_process';
import { getPool, withClient } from './cms-spuf/pg.js';
import { discoverRelease, type DiscoveredRelease } from './cms-spuf/discover.js';
import { sendSms } from '../api/_lib/twilio.js';

const DEFAULT_ALERT_PHONE = '+18287613326';

interface Args {
  year: number;
  kind: 'quarterly' | 'monthly';
  quarter?: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  releaseDate?: string;
  force: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    year: new Date().getUTCFullYear(),
    kind: 'quarterly',
    force: false,
    dryRun: false,
  };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([a-zA-Z0-9-]+)(=(.*))?$/);
    if (!m) {
      console.error(`Bad arg: ${a}`);
      process.exit(2);
    }
    const [, key, , val] = m;
    switch (key) {
      case 'year':          out.year = Number(val); break;
      case 'kind':          out.kind = val as Args['kind']; break;
      case 'quarter':       out.quarter = val as Args['quarter']; break;
      case 'release-date':  out.releaseDate = val; break;
      case 'force':         out.force = true; break;
      case 'dry-run':       out.dryRun = true; break;
      case 'help':
      case 'h':
        printHelp();
        process.exit(0);
      default:
        console.error(`Unknown flag: --${key}`);
        process.exit(2);
    }
  }
  if (out.kind !== 'quarterly' && out.kind !== 'monthly') {
    console.error(`--kind must be quarterly or monthly`);
    process.exit(2);
  }
  return out;
}

function printHelp(): void {
  console.log(
    [
      'One-command CMS SPUF refresh.',
      '',
      'Usage:',
      '  refresh-formulary                          Latest quarterly, current year',
      '  refresh-formulary --kind=monthly',
      '  refresh-formulary --year=2026 --quarter=Q1',
      '  refresh-formulary --release-date=20260408',
      '  refresh-formulary --force                  Re-import even if promoted',
      '  refresh-formulary --dry-run                Discovery + check only',
    ].join('\n'),
  );
}

// ── Idempotency check ───────────────────────────────────────────────

interface AlreadyPromoted {
  releaseId: number;
  promotedAt: string;
}

async function findAlreadyPromoted(rel: DiscoveredRelease): Promise<AlreadyPromoted | null> {
  return withClient(async (c) => {
    const r = await c.query<{ release_id: number; promoted_at: string }>(
      `SELECT release_id, promoted_at::text
         FROM cms_spuf_releases
         WHERE plan_year = $1
           AND release_kind = $2
           AND release_date = $3::date
           AND promoted_at IS NOT NULL
         ORDER BY promoted_at DESC
         LIMIT 1`,
      [rel.planYear, rel.releaseKind, rel.releaseDate],
    );
    if (r.rows.length === 0) return null;
    return { releaseId: r.rows[0].release_id, promotedAt: r.rows[0].promoted_at };
  });
}

// ── Subprocess runner ───────────────────────────────────────────────

interface ImportResult {
  exitCode: number;
  durationMs: number;
  stdoutTail: string; // last ~20 lines
  stderrTail: string;
}

// Spawn `npm run formulary:import -- <args>` and stream stdout/stderr
// through to the terminal so long imports (30-90 min) still show
// progress. Retains the tail for the failure SMS body.
async function runImport(args: Args): Promise<ImportResult> {
  const passthrough: string[] = [];
  if (args.releaseDate) {
    // release-date pins the exact ZIP; year is still required and
    // trivially derivable from the date.
    passthrough.push(`--year=${args.year}`);
    passthrough.push(`--kind=${args.kind}`);
    passthrough.push(`--release-date=${args.releaseDate}`);
  } else if (args.kind === 'quarterly' && args.quarter) {
    passthrough.push(`--year=${args.year}`);
    passthrough.push(`--quarter=${args.quarter}`);
  } else {
    passthrough.push(`--year=${args.year}`);
    passthrough.push(`--kind=${args.kind}`);
  }
  if (args.force) passthrough.push('--force');

  const startedAt = Date.now();
  console.log(`[refresh] $ npm run formulary:import -- ${passthrough.join(' ')}`);

  return new Promise<ImportResult>((resolve, reject) => {
    const child = spawn('npm', ['run', 'formulary:import', '--', ...passthrough], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const outLines: string[] = [];
    const errLines: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      process.stdout.write(text);
      for (const l of text.split('\n')) if (l.trim()) outLines.push(l);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      process.stderr.write(text);
      for (const l of text.split('\n')) if (l.trim()) errLines.push(l);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? -1,
        durationMs: Date.now() - startedAt,
        stdoutTail: outLines.slice(-20).join('\n'),
        stderrTail: errLines.slice(-20).join('\n'),
      });
    });
  });
}

// ── Read-back ───────────────────────────────────────────────────────

interface StateRowCount {
  state: string;
  planCount: number;
  formularyRows: number;
}

interface PromotedRelease {
  releaseId: number;
  planYear: number;
  releaseKind: string;
  releaseDate: string;
  promotedAt: string;
  rowCounts: Record<string, number> | null;
}

async function fetchJustPromoted(rel: DiscoveredRelease): Promise<PromotedRelease | null> {
  return withClient(async (c) => {
    const r = await c.query<{
      release_id: number;
      plan_year: number;
      release_kind: string;
      release_date: string;
      promoted_at: string;
      row_counts: Record<string, number> | null;
    }>(
      `SELECT release_id, plan_year, release_kind, release_date::text,
              promoted_at::text, row_counts
         FROM cms_spuf_releases
         WHERE plan_year = $1
           AND release_kind = $2
           AND release_date = $3::date
           AND promoted_at IS NOT NULL
         ORDER BY promoted_at DESC
         LIMIT 1`,
      [rel.planYear, rel.releaseKind, rel.releaseDate],
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return {
      releaseId: row.release_id,
      planYear: row.plan_year,
      releaseKind: row.release_kind,
      releaseDate: row.release_date,
      promotedAt: row.promoted_at,
      rowCounts: row.row_counts,
    };
  });
}

async function fetchStateRowCounts(releaseId: number): Promise<StateRowCount[]> {
  return withClient(async (c) => {
    const r = await c.query<{ state: string; plan_count: string; formulary_rows: string }>(
      `WITH state_plans AS (
         SELECT DISTINCT p.contract_id, p.plan_id, p.segment_id, p.state
           FROM cms_spuf_plan_information p
           WHERE p.release_id = $1
             AND p.plan_suppressed_yn = 'N'
             AND p.state IS NOT NULL
       )
       SELECT sp.state,
              COUNT(DISTINCT sp.contract_id || '-' || sp.plan_id || '-' || sp.segment_id)::text AS plan_count,
              COUNT(f.*)::text                                                                   AS formulary_rows
         FROM state_plans sp
         LEFT JOIN pm_formulary_v2 f
           ON f.contract_id = sp.contract_id
          AND f.plan_id = sp.plan_id
          AND f.segment_id = sp.segment_id
         GROUP BY sp.state
         ORDER BY sp.state`,
      [releaseId],
    );
    return r.rows.map((row) => ({
      state: row.state,
      planCount: Number(row.plan_count),
      formularyRows: Number(row.formulary_rows),
    }));
  });
}

// ── SMS composers ───────────────────────────────────────────────────

function fmtDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m${s.toString().padStart(2, '0')}s` : `${s}s`;
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function composeSuccess(
  rel: DiscoveredRelease,
  promoted: PromotedRelease,
  states: StateRowCount[],
  durationMs: number,
): string {
  const lines: string[] = [];
  lines.push(`✅ Formulary refreshed`);
  lines.push(`${rel.releaseKind} ${rel.releaseDate} (PY${rel.planYear})`);
  lines.push(`Duration: ${fmtDuration(durationMs)}`);
  if (states.length > 0) {
    lines.push('Rows/state:');
    for (const s of states.slice(0, 12)) {
      lines.push(`  ${s.state}: ${s.planCount} plans / ${fmtCount(s.formularyRows)} rows`);
    }
  }
  if (promoted.rowCounts) {
    const totals = Object.entries(promoted.rowCounts)
      .map(([file, count]) => `${file}=${fmtCount(count)}`)
      .join(' · ');
    lines.push(`Files: ${totals}`);
  }
  return lines.join('\n');
}

function composeAlreadyPromoted(rel: DiscoveredRelease, already: AlreadyPromoted): string {
  return (
    `ℹ️ Formulary already current\n` +
    `${rel.releaseKind} ${rel.releaseDate} (PY${rel.planYear})\n` +
    `Promoted ${already.promotedAt}. Pass --force to re-import.`
  );
}

function composeFailure(rel: DiscoveredRelease | null, result: ImportResult): string {
  const head = rel
    ? `❌ Formulary refresh FAILED for ${rel.releaseKind} ${rel.releaseDate} (PY${rel.planYear})`
    : `❌ Formulary refresh FAILED before import started`;
  const tail = (result.stderrTail || result.stdoutTail || '(no output)').slice(-500);
  return (
    `${head}\n` +
    `Exit ${result.exitCode} after ${fmtDuration(result.durationMs)}.\n` +
    `Tail:\n${tail}`
  );
}

// ── SMS send ────────────────────────────────────────────────────────

async function trySend(body: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log('[dry-run] Would SMS:');
    console.log('---');
    console.log(body);
    console.log('---');
    return;
  }
  const to = process.env.FORMULARY_ALERT_PHONE ?? DEFAULT_ALERT_PHONE;
  try {
    const { sid } = await sendSms({ to, body });
    console.log(`[sms] delivered sid=${sid} to=${to}`);
  } catch (err) {
    console.error(`[sms] FAILED to send: ${err instanceof Error ? err.message : err}`);
    // Deliberately do not re-throw — a Twilio outage shouldn't fail
    // an otherwise-successful refresh. Log and continue.
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  console.log(
    `[refresh] mode=${args.dryRun ? 'DRY-RUN' : 'LIVE'} kind=${args.kind} year=${args.year}` +
      `${args.quarter ? ` quarter=${args.quarter}` : ''}` +
      `${args.releaseDate ? ` release-date=${args.releaseDate}` : ''}`,
  );

  const pool = getPool();
  try {
    // 1. Discovery — surface CMS page changes early with a clean exit 1.
    let discovered: DiscoveredRelease;
    try {
      discovered = await discoverRelease({
        year: args.year,
        kind: args.kind,
        quarter: args.quarter,
        releaseDate: args.releaseDate,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[refresh] discovery failed: ${msg}`);
      // Best-effort SMS so a broken CMS page doesn't fail silently.
      await trySend(
        `❌ Formulary refresh — CMS discovery failed for ${args.kind} PY${args.year}. ${msg.slice(0, 200)}`,
        args.dryRun,
      );
      process.exit(1);
    }
    console.log(
      `[refresh] discovered ${discovered.fileName} (${discovered.releaseDate}) — ${discovered.url}`,
    );

    // 2. Already-promoted check — skip unless --force.
    if (!args.force) {
      const already = await findAlreadyPromoted(discovered);
      if (already) {
        console.log(
          `[refresh] release_id=${already.releaseId} already promoted at ${already.promotedAt}. Skipping (pass --force to re-import).`,
        );
        await trySend(composeAlreadyPromoted(discovered, already), args.dryRun);
        return;
      }
    }

    // 3. Dry-run stops here — importer isn't invoked.
    if (args.dryRun) {
      const body =
        `ℹ️ [dry-run] Would refresh formulary\n` +
        `${discovered.releaseKind} ${discovered.releaseDate} (PY${discovered.planYear})\n` +
        `URL: ${discovered.url}`;
      console.log('[dry-run] Skipping import subprocess.');
      await trySend(body, args.dryRun);
      return;
    }

    // 4. Delegate to import-cms-spuf.ts via npm.
    const result = await runImport(args);
    if (result.exitCode !== 0) {
      console.error(`[refresh] importer failed with exit ${result.exitCode}`);
      await trySend(composeFailure(discovered, result), args.dryRun);
      process.exit(3);
    }

    // 5. Read-back — pull the promoted row + per-state counts.
    const promoted = await fetchJustPromoted(discovered);
    if (!promoted) {
      const body =
        `⚠️ Formulary import exited 0 but no promoted_at row found for ` +
        `${discovered.releaseKind} ${discovered.releaseDate} (PY${discovered.planYear}). ` +
        `Verify manually.`;
      await trySend(body, args.dryRun);
      process.exit(4);
    }
    const states = await fetchStateRowCounts(promoted.releaseId);
    await trySend(composeSuccess(discovered, promoted, states, result.durationMs), args.dryRun);
    console.log('[refresh] done.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[refresh] fatal:', err);
  process.exit(1);
});
