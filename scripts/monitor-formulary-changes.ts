#!/usr/bin/env tsx
// scripts/monitor-formulary-changes.ts
//
// Formulary staleness monitor + weekly digest for the CMS SPUF import
// pipeline. Two modes:
//
//   npm exec tsx scripts/monitor-formulary-changes.ts --daily
//     Runs the alert path. If the currently-active release's
//     promoted_at is older than STALENESS_ALERT_DAYS (45), SMSes Rob
//     with the delta. Exit 0 always — this is a monitor, not a gate.
//
//   npm exec tsx scripts/monitor-formulary-changes.ts --weekly-digest
//     Composes a Monday-morning digest covering:
//       - Days since last active-release promotion (national)
//       - Per-state row counts + implied staleness (rows serving
//         plans in each state)
//       - Per-carrier row counts + carriers approaching drop-out
//         (carriers whose row count in the active release fell more
//         than CARRIER_DROP_PCT vs. the prior release)
//       - Any CMS SPUF releases discovered by the release monitor
//         (cms_spuf_release_checks) that haven't been imported yet.
//
//   npm exec tsx scripts/monitor-formulary-changes.ts --dry-run
//     Runs both queries but skips the SMS send. Prints the composed
//     body to stdout so cron output shows what would have gone out.
//
// Env (via scripts/cms-spuf/env.ts → .env.local):
//   DATABASE_URL           — Postgres URI for plan-match-prod
//                            (rpcbrkmvalvdmroqzpaq). Same var the
//                            existing SPUF importer uses.
//   TWILIO_ACCOUNT_SID     — required for SMS send in --daily and
//   TWILIO_AUTH_TOKEN        --weekly-digest. Skipped when --dry-run.
//   TWILIO_PHONE_NUMBER
//   FORMULARY_ALERT_PHONE  — E.164 destination. Defaults to Rob's
//                            +18287613326 (CLAUDE.md). Override for
//                            local testing.
//
// Cron wiring lives in the deploy docs (docs/formulary-refresh-process.md
// § Automation). Suggested schedules:
//   --daily          03:15 ET, every day
//   --weekly-digest  08:00 ET, every Monday (0 12 * * 1  UTC)
//
// The alert threshold intentionally sits at 45 days — CMS publishes
// quarterly + monthly refreshes on a ~30-day cadence, so 45 days
// covers a full release + one week of grace before we start worrying.
// The pre-Phase-4 threshold was 90 days; that gave two full missed
// releases before anyone noticed. Rob asked for 45 to catch a single
// slip.

import './cms-spuf/env.js';
import { getPool, withClient } from './cms-spuf/pg.js';
import { sendSms } from '../api/_lib/twilio.js';

// ── Config ──────────────────────────────────────────────────────────

const STALENESS_ALERT_DAYS = 45;
const CARRIER_APPROACH_DAYS = 35;          // "approaching staleness" in digest
const CARRIER_DROP_PCT = 20;               // percent drop that flags a carrier
const DEFAULT_ALERT_PHONE = '+18287613326';

interface Args {
  daily: boolean;
  digest: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { daily: false, digest: false, dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === '--daily') out.daily = true;
    else if (a === '--weekly-digest') out.digest = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  if (!out.daily && !out.digest) {
    console.error('Must pass --daily or --weekly-digest (or both).');
    printUsage();
    process.exit(2);
  }
  return out;
}

function printUsage(): void {
  console.error(
    [
      'Usage:',
      '  monitor-formulary-changes --daily            Alert on national staleness',
      '  monitor-formulary-changes --weekly-digest    Compose Monday digest',
      '  monitor-formulary-changes --dry-run          Skip SMS; print body',
    ].join('\n'),
  );
}

// ── Types ───────────────────────────────────────────────────────────

interface ActiveRelease {
  releaseId: number;
  planYear: number;
  releaseKind: 'quarterly' | 'monthly';
  releaseDate: string;
  promotedAt: string | null;
  daysSincePromoted: number | null;
}

interface StateCoverage {
  state: string;
  planCount: number;
  formularyRowCount: number;
}

interface CarrierCoverage {
  carrier: string;
  planCount: number;
  formularyRowCount: number;
  priorFormularyRowCount: number | null;
  pctChange: number | null;
}

interface PendingRelease {
  planYear: number;
  releaseKind: string;
  releaseDate: string;
  sourceUrl: string;
  detectedAt: string;
}

// ── Queries ─────────────────────────────────────────────────────────

async function fetchActiveRelease(): Promise<ActiveRelease | null> {
  return withClient(async (c) => {
    const r = await c.query<{
      release_id: number;
      plan_year: number;
      release_kind: 'quarterly' | 'monthly';
      release_date: string;
      promoted_at: string | null;
    }>(
      `SELECT release_id, plan_year, release_kind, release_date::text, promoted_at::text
         FROM cms_spuf_releases
         WHERE status = 'active'
         ORDER BY plan_year DESC, release_date DESC
         LIMIT 1`,
    );
    const row = r.rows[0];
    if (!row) return null;
    let days: number | null = null;
    if (row.promoted_at) {
      const ms = Date.now() - new Date(row.promoted_at).getTime();
      days = Math.floor(ms / (24 * 60 * 60 * 1000));
    }
    return {
      releaseId: row.release_id,
      planYear: row.plan_year,
      releaseKind: row.release_kind,
      releaseDate: row.release_date,
      promotedAt: row.promoted_at,
      daysSincePromoted: days,
    };
  });
}

// Per-state coverage — how many plans and formulary rows we're serving
// each state under the currently-active release. A state with zero
// rows (or zero plans) is a red flag: either the release excluded that
// state, or the state's carriers all exited, or the join broke.
async function fetchStateCoverage(releaseId: number): Promise<StateCoverage[]> {
  return withClient(async (c) => {
    const r = await c.query<{ state: string; plan_count: string; formulary_row_count: string }>(
      `WITH state_plans AS (
         SELECT DISTINCT p.contract_id, p.plan_id, p.segment_id, p.state
           FROM cms_spuf_plan_information p
           WHERE p.release_id = $1
             AND p.plan_suppressed_yn = 'N'
             AND p.state IS NOT NULL
       )
       SELECT sp.state,
              COUNT(DISTINCT sp.contract_id || '-' || sp.plan_id || '-' || sp.segment_id)::text AS plan_count,
              COUNT(f.*)::text AS formulary_row_count
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
      formularyRowCount: Number(row.formulary_row_count),
    }));
  });
}

// Per-carrier coverage vs. the prior superseded release. A carrier
// whose row count dropped >CARRIER_DROP_PCT is either exiting the
// market or their formulary import broke — either way, worth an
// eyeball in the digest.
async function fetchCarrierCoverage(activeReleaseId: number): Promise<CarrierCoverage[]> {
  return withClient(async (c) => {
    // Find the most recent superseded release ONE step back — that's
    // the natural "prior" baseline. There may be older ones too, but
    // recent-vs-prior is the meaningful delta.
    const priorR = await c.query<{ release_id: number }>(
      `SELECT release_id
         FROM cms_spuf_releases
         WHERE status = 'superseded'
         ORDER BY promoted_at DESC NULLS LAST
         LIMIT 1`,
    );
    const priorReleaseId = priorR.rows[0]?.release_id ?? null;

    const r = await c.query<{
      carrier: string | null;
      plan_count: string;
      formulary_row_count: string;
      prior_formulary_row_count: string | null;
    }>(
      `WITH active_carrier_plans AS (
         SELECT DISTINCT p.contract_id, p.plan_id, p.segment_id,
                COALESCE(NULLIF(TRIM(p.contract_name), ''), 'Unknown carrier') AS carrier
           FROM cms_spuf_plan_information p
           WHERE p.release_id = $1
             AND p.plan_suppressed_yn = 'N'
       ),
       active_rows AS (
         SELECT acp.carrier,
                COUNT(DISTINCT acp.contract_id || '-' || acp.plan_id || '-' || acp.segment_id) AS plan_count,
                COUNT(f.*) AS row_count
           FROM active_carrier_plans acp
           LEFT JOIN pm_formulary_v2 f
             ON f.contract_id = acp.contract_id
            AND f.plan_id = acp.plan_id
            AND f.segment_id = acp.segment_id
           GROUP BY acp.carrier
       ),
       prior_carrier_rows AS (
         SELECT COALESCE(NULLIF(TRIM(p.contract_name), ''), 'Unknown carrier') AS carrier,
                COUNT(*) AS row_count
           FROM cms_spuf_plan_information p
           JOIN cms_spuf_basic_drugs d
             ON d.release_id = p.release_id
            AND d.formulary_id = p.formulary_id
           WHERE p.release_id = $2
             AND p.plan_suppressed_yn = 'N'
           GROUP BY 1
       )
       SELECT a.carrier,
              a.plan_count::text,
              a.row_count::text                        AS formulary_row_count,
              pc.row_count::text                       AS prior_formulary_row_count
         FROM active_rows a
         LEFT JOIN prior_carrier_rows pc ON pc.carrier = a.carrier
         ORDER BY a.plan_count DESC, a.carrier`,
      [activeReleaseId, priorReleaseId],
    );

    return r.rows.map((row) => {
      const current = Number(row.formulary_row_count);
      const prior = row.prior_formulary_row_count == null ? null : Number(row.prior_formulary_row_count);
      const pctChange =
        prior == null || prior === 0 ? null : Math.round(((current - prior) / prior) * 1000) / 10;
      return {
        carrier: row.carrier ?? 'Unknown carrier',
        planCount: Number(row.plan_count),
        formularyRowCount: current,
        priorFormularyRowCount: prior,
        pctChange,
      };
    });
  });
}

// CMS releases the daily edge-function discovered but that haven't been
// promoted yet. Read from cms_spuf_release_checks; degrade gracefully
// when the table doesn't exist (edge function not deployed yet).
async function fetchPendingReleases(): Promise<PendingRelease[]> {
  return withClient(async (c) => {
    const exists = await c.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'cms_spuf_release_checks'
       ) AS exists`,
    );
    if (!exists.rows[0]?.exists) return [];
    const r = await c.query<{
      plan_year: number;
      release_kind: string;
      release_date: string;
      source_url: string;
      detected_at: string;
    }>(
      `SELECT plan_year, release_kind, release_date::text,
              source_url, detected_at::text
         FROM cms_spuf_release_checks
         WHERE status = 'new_release_available'
           AND NOT EXISTS (
             SELECT 1 FROM cms_spuf_releases r
             WHERE r.plan_year = cms_spuf_release_checks.plan_year
               AND r.release_kind = cms_spuf_release_checks.release_kind
               AND r.release_date = cms_spuf_release_checks.release_date
               AND r.promoted_at IS NOT NULL
           )
         ORDER BY release_date DESC
         LIMIT 5`,
    );
    return r.rows.map((row) => ({
      planYear: row.plan_year,
      releaseKind: row.release_kind,
      releaseDate: row.release_date,
      sourceUrl: row.source_url,
      detectedAt: row.detected_at,
    }));
  });
}

// ── Body composers ──────────────────────────────────────────────────

function composeDailyAlert(active: ActiveRelease): string {
  const days = active.daysSincePromoted ?? 0;
  return (
    `⚠️ Plan Match formulary is ${days}d stale.\n` +
    `Active release: ${active.releaseKind} ${active.releaseDate} ` +
    `(plan year ${active.planYear}).\n` +
    `Promoted ${active.promotedAt ?? '—'}.\n` +
    `Run: npm exec tsx scripts/refresh-formulary.ts`
  );
}

function composeDigest(
  active: ActiveRelease | null,
  states: StateCoverage[],
  carriers: CarrierCoverage[],
  pending: PendingRelease[],
): string {
  const lines: string[] = [];
  lines.push('📅 Weekly formulary digest');
  if (!active) {
    lines.push('❌ No active cms_spuf_releases row. Import needed.');
  } else {
    const staleLabel =
      (active.daysSincePromoted ?? 0) >= STALENESS_ALERT_DAYS
        ? ' ⚠️ STALE'
        : (active.daysSincePromoted ?? 0) >= CARRIER_APPROACH_DAYS
          ? ' ⚠️ approaching'
          : '';
    lines.push(
      `Active: ${active.releaseKind} ${active.releaseDate} (PY${active.planYear}) — ` +
        `${active.daysSincePromoted ?? '?'}d since promoted${staleLabel}`,
    );
  }

  // Per-state rows: compact ("NC:132/847k · GA:112/712k · TX:298/1.9M").
  if (states.length > 0) {
    const compact = states
      .map((s) => `${s.state}:${s.planCount}/${fmtCount(s.formularyRowCount)}`)
      .join(' · ');
    lines.push(`States: ${compact}`);
  }

  // Carriers approaching drop-out — anything with pctChange <= -CARRIER_DROP_PCT.
  const dropping = carriers.filter(
    (c) => c.pctChange != null && c.pctChange <= -CARRIER_DROP_PCT,
  );
  if (dropping.length > 0) {
    lines.push(`⚠️ Carriers with ≥${CARRIER_DROP_PCT}% row drop vs prior release:`);
    for (const c of dropping.slice(0, 5)) {
      lines.push(`  ${c.carrier}: ${fmtCount(c.formularyRowCount)} (${c.pctChange}%)`);
    }
  }

  // Undelivered CMS releases the release monitor spotted.
  if (pending.length > 0) {
    lines.push(`📥 New CMS releases not yet imported:`);
    for (const p of pending) {
      lines.push(`  ${p.releaseKind} ${p.releaseDate} (PY${p.planYear})`);
    }
    lines.push('Run: npm exec tsx scripts/refresh-formulary.ts');
  }

  return lines.join('\n');
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
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
  const { sid } = await sendSms({ to, body });
  console.log(`[sms] delivered sid=${sid} to=${to}`);
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const pool = getPool();
  try {
    if (args.daily) {
      const active = await fetchActiveRelease();
      if (!active) {
        const body = '⚠️ Plan Match: no active cms_spuf_releases row. Import needed.';
        await trySend(body, args.dryRun);
      } else if ((active.daysSincePromoted ?? 0) >= STALENESS_ALERT_DAYS) {
        await trySend(composeDailyAlert(active), args.dryRun);
      } else {
        console.log(
          `[daily] OK — ${active.daysSincePromoted ?? '?'}d since promoted (threshold ${STALENESS_ALERT_DAYS}d). No alert.`,
        );
      }
    }
    if (args.digest) {
      const active = await fetchActiveRelease();
      const states = active ? await fetchStateCoverage(active.releaseId) : [];
      const carriers = active ? await fetchCarrierCoverage(active.releaseId) : [];
      const pending = await fetchPendingReleases();
      const body = composeDigest(active, states, carriers, pending);
      await trySend(body, args.dryRun);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[monitor] fatal:', err);
  process.exit(1);
});
