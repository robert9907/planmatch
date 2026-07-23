// supabase/functions/spuf-release-monitor/index.ts
//
// Daily CMS SPUF release monitor. Runs as a Supabase Edge Function on
// the Command Center project (kdqjyhuzxulgzxhihyjv) — scheduled via
// Supabase's `pg_cron` + `net.http_post` pattern (see README.md in
// this directory).
//
// What it does:
//   1. Scrapes the two CMS SPUF dataset pages for the latest quarterly
//      and monthly release ZIP URLs.
//   2. Connects to the Plan Match prod Supabase (rpcbrkmvalvdmroqzpaq)
//      and reads the max `release_date` from cms_spuf_releases per
//      (release_kind, plan_year) that has `promoted_at IS NOT NULL`.
//   3. If CMS is publishing a newer release than what's promoted:
//        - SMS Rob at (828) 761-3326 via Twilio REST API.
//        - INSERT a `cms_spuf_release_checks` row with
//          status='new_release_available'.
//   4. If we're current on both kinds: INSERT a single 'current'
//      status row and return 200 with a JSON summary.
//
// Runtime: Supabase Edge Functions run on Deno Deploy. Do NOT import
// npm libs (twilio, pg, @supabase/supabase-js — the last one has a
// Deno-compatible ESM build we pull via esm.sh below).
//
// Env (set via `supabase secrets set --project-ref kdqjyhuzxulgzxhihyjv`):
//   PM_PROD_SUPABASE_URL          rpcbrkmvalvdmroqzpaq project URL
//   PM_PROD_SUPABASE_SERVICE_KEY  service-role key with SELECT on
//                                 cms_spuf_releases + INSERT on
//                                 cms_spuf_release_checks
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_PHONE_NUMBER
//   FORMULARY_ALERT_PHONE         E.164; defaults to +18287613326
//
// Schema dependency (documented — not created here since this repo's
// migrations are owned by the SPUF pipeline branch, per the task
// constraints). Apply once in the plan-match-prod project via the
// Supabase SQL Editor:
//
//   CREATE TABLE IF NOT EXISTS cms_spuf_release_checks (
//     check_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
//     checked_at    timestamptz NOT NULL DEFAULT now(),
//     plan_year     smallint,
//     release_kind  text CHECK (release_kind IN ('quarterly','monthly')),
//     release_date  date,
//     source_url    text,
//     status        text NOT NULL CHECK (status IN (
//                     'new_release_available','current','cms_page_error'
//                   )),
//     notes         text
//   );
//   CREATE INDEX IF NOT EXISTS idx_cms_spuf_release_checks_status_time
//     ON cms_spuf_release_checks (status, checked_at DESC);
//
// The edge function catches the "table does not exist" case and logs
// loudly to the function log — the SMS alert still fires on new
// releases regardless of whether the audit log exists.

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const QUARTERLY_INDEX =
  'https://data.cms.gov/provider-summary-by-type-of-service/medicare-part-d-prescribers/quarterly-prescription-drug-plan-formulary-pharmacy-network-and-pricing-information';
const MONTHLY_INDEX =
  'https://data.cms.gov/provider-summary-by-type-of-service/medicare-part-d-prescribers/monthly-prescription-drug-plan-formulary-and-pharmacy-network-information';
const DEFAULT_ALERT_PHONE = '+18287613326';

interface Discovered {
  kind: 'quarterly' | 'monthly';
  planYear: number;
  releaseDate: string; // YYYY-MM-DD
  releaseDateYmd: string; // YYYYMMDD
  url: string;
  fileName: string;
}

function parseYmd(ymd: string): string | null {
  if (!/^\d{8}$/.test(ymd)) return null;
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

// Mirror of scripts/cms-spuf/discover.ts, adapted for Deno + fetch.
async function discoverLatest(
  kind: 'quarterly' | 'monthly',
): Promise<Discovered[]> {
  const indexUrl = kind === 'quarterly' ? QUARTERLY_INDEX : MONTHLY_INDEX;
  const res = await fetch(indexUrl, {
    headers: { 'user-agent': 'planmatch-spuf-monitor/1.0' },
  });
  if (!res.ok) {
    throw new Error(`CMS ${kind} index fetch failed: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  const re =
    /href="(https:\/\/data\.cms\.gov\/sites\/default\/files\/[^"]+\.zip)"/gi;
  const hrefs = new Set<string>();
  for (const m of html.matchAll(re)) hrefs.add(m[1]);

  const filenameRe =
    kind === 'quarterly'
      ? /\/(SPUF_(\d{4})_(\d{8})\.zip)$/i
      : /\/((\d{4})_(\d{8})\.zip)$/i;

  const found: Discovered[] = [];
  for (const href of hrefs) {
    const m = href.match(filenameRe);
    if (!m) continue;
    const releaseDate = parseYmd(m[3]);
    if (!releaseDate) continue;
    found.push({
      kind,
      planYear: Number(m[2]),
      releaseDate,
      releaseDateYmd: m[3],
      url: href,
      fileName: m[1],
    });
  }

  // Latest-per-year, per kind. Return one row per plan year (usually
  // just current year + previous around the year boundary).
  const byYear = new Map<number, Discovered>();
  for (const d of found) {
    const existing = byYear.get(d.planYear);
    if (!existing || d.releaseDateYmd > existing.releaseDateYmd) {
      byYear.set(d.planYear, d);
    }
  }
  return [...byYear.values()].sort((a, b) => b.planYear - a.planYear);
}

interface PromotedRow {
  planYear: number;
  releaseKind: 'quarterly' | 'monthly';
  releaseDate: string;
}

async function fetchPromotedReleases(
  supabase: ReturnType<typeof createClient>,
): Promise<PromotedRow[]> {
  const { data, error } = await supabase
    .from('cms_spuf_releases')
    .select('plan_year, release_kind, release_date')
    .not('promoted_at', 'is', null)
    .order('release_date', { ascending: false });
  if (error) throw new Error(`cms_spuf_releases query failed: ${error.message}`);
  return (data ?? []).map((r: any) => ({
    planYear: r.plan_year,
    releaseKind: r.release_kind,
    releaseDate: r.release_date,
  }));
}

// Return the highest promoted release_date per (plan_year, kind).
// Newer discovered releases only "matter" if they exceed this.
function maxPromoted(rows: PromotedRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const key = `${r.releaseKind}|${r.planYear}`;
    const prev = out.get(key);
    if (!prev || r.releaseDate > prev) out.set(key, r.releaseDate);
  }
  return out;
}

async function sendSms(body: string, to: string): Promise<{ ok: boolean; sid?: string; err?: string }> {
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const token = Deno.env.get('TWILIO_AUTH_TOKEN');
  const from = Deno.env.get('TWILIO_PHONE_NUMBER');
  if (!sid || !token || !from) {
    return { ok: false, err: 'Twilio env not fully configured (SID/token/phone_number)' };
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = btoa(`${sid}:${token}`);
  const form = new URLSearchParams({ To: to, From: from, Body: body });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  const payload = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    return { ok: false, err: `Twilio ${res.status}: ${payload?.message ?? res.statusText}` };
  }
  return { ok: true, sid: payload?.sid };
}

// Insert a log row; degrade gracefully if the table isn't provisioned
// yet (see schema block at the top of this file). We DO NOT silently
// swallow — the failure gets logged so Rob spots the missing table.
async function logCheck(
  supabase: ReturnType<typeof createClient>,
  payload: {
    planYear: number | null;
    releaseKind: 'quarterly' | 'monthly' | null;
    releaseDate: string | null;
    sourceUrl: string | null;
    status: 'new_release_available' | 'current' | 'cms_page_error';
    notes?: string;
  },
): Promise<void> {
  const { error } = await supabase.from('cms_spuf_release_checks').insert({
    plan_year: payload.planYear,
    release_kind: payload.releaseKind,
    release_date: payload.releaseDate,
    source_url: payload.sourceUrl,
    status: payload.status,
    notes: payload.notes ?? null,
  });
  if (error) {
    console.error(
      `[log] cms_spuf_release_checks insert failed (status=${payload.status}): ${error.message}`,
    );
  }
}

function composeAlert(newer: Discovered[]): string {
  const lines = ['📥 New CMS SPUF release available'];
  for (const d of newer) {
    lines.push(`${d.kind} ${d.releaseDate} (PY${d.planYear})`);
  }
  lines.push('');
  lines.push('Run: npm exec tsx scripts/refresh-formulary.ts');
  if (newer.some((d) => d.kind === 'monthly')) {
    lines.push('  (add --kind=monthly for the monthly release)');
  }
  return lines.join('\n');
}

// Entrypoint — Supabase Edge Functions call the default export with a
// standard Request; return a Response.
Deno.serve(async (req: Request): Promise<Response> => {
  const summary: Record<string, unknown> = { started_at: new Date().toISOString() };

  const pmUrl = Deno.env.get('PM_PROD_SUPABASE_URL');
  const pmKey = Deno.env.get('PM_PROD_SUPABASE_SERVICE_KEY');
  if (!pmUrl || !pmKey) {
    return new Response(
      JSON.stringify({ error: 'PM_PROD_SUPABASE_URL + PM_PROD_SUPABASE_SERVICE_KEY required' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
  const supabase = createClient(pmUrl, pmKey, { auth: { persistSession: false } });
  const alertPhone = Deno.env.get('FORMULARY_ALERT_PHONE') ?? DEFAULT_ALERT_PHONE;

  // 1. Discover.
  let quarterly: Discovered[] = [];
  let monthly: Discovered[] = [];
  try {
    [quarterly, monthly] = await Promise.all([
      discoverLatest('quarterly'),
      discoverLatest('monthly'),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[discovery] ${msg}`);
    await logCheck(supabase, {
      planYear: null,
      releaseKind: null,
      releaseDate: null,
      sourceUrl: null,
      status: 'cms_page_error',
      notes: msg,
    });
    // Do NOT SMS on discovery failure — CMS occasionally serves 5xx
    // during maintenance windows, and we don't want to page Rob for
    // a transient. The check log carries the record; the weekly
    // digest surfaces persistent failures.
    return new Response(
      JSON.stringify({ ...summary, error: `discovery: ${msg}` }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }

  summary.discovered = { quarterly, monthly };

  // 2. Compare against promoted.
  const promoted = await fetchPromotedReleases(supabase);
  const maxByKey = maxPromoted(promoted);
  const newer: Discovered[] = [];
  for (const d of [...quarterly, ...monthly]) {
    const key = `${d.kind}|${d.planYear}`;
    const promotedDate = maxByKey.get(key);
    if (!promotedDate || d.releaseDate > promotedDate) {
      newer.push(d);
    }
  }
  summary.newer = newer;
  summary.promoted_max = Object.fromEntries(maxByKey);

  // 3. Alert + log.
  if (newer.length === 0) {
    await logCheck(supabase, {
      planYear: null,
      releaseKind: null,
      releaseDate: null,
      sourceUrl: null,
      status: 'current',
      notes: `q=${quarterly[0]?.releaseDate ?? 'none'} m=${monthly[0]?.releaseDate ?? 'none'}`,
    });
    return new Response(JSON.stringify({ ...summary, action: 'none' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  const sms = await sendSms(composeAlert(newer), alertPhone);
  summary.sms = sms;
  for (const d of newer) {
    await logCheck(supabase, {
      planYear: d.planYear,
      releaseKind: d.kind,
      releaseDate: d.releaseDate,
      sourceUrl: d.url,
      status: 'new_release_available',
      notes: sms.ok ? `SMS sid=${sms.sid}` : `SMS FAILED: ${sms.err}`,
    });
  }
  return new Response(JSON.stringify({ ...summary, action: 'alerted' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});
