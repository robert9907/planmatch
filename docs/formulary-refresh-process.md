# Formulary refresh process

How the CMS SPUF formulary gets from `data.cms.gov` into Plan Match
prod (`rpcbrkmvalvdmroqzpaq`), what runs automatically, what still
needs a human, and how to verify the pipeline is healthy.

## Data path

```
                     data.cms.gov
                          │
                          │  SPUF/PUF ZIP (600 MB – 1 GB)
                          ▼
   scripts/cms-spuf/discover.ts + download.ts
                          │
                          ▼
   scripts/cms-spuf/loader.ts   (COPY FROM into landing tables)
                          │
                          ▼
   scripts/cms-spuf/promote.ts  (single-txn swap into pm_*_v2)
                          │
                          ▼
              Plan Match prod (rpcbrkmvalvdmroqzpaq)
                • cms_spuf_releases      (release ledger)
                • cms_spuf_*             (landing, 20+ M rows)
                • pm_formulary_v2        (~1.5 M rows, served)
                • pm_beneficiary_cost_v2 (per pharmacy_type / days)
```

## Automated components

### 1. Daily release monitor (Supabase Edge Function)

- **Where**: `supabase/functions/spuf-release-monitor/` in this repo,
  deployed to the **Command Center** Supabase project
  (`kdqjyhuzxulgzxhihyjv`).
- **Runs**: `pg_cron` schedule `15 7 * * *` UTC (03:15 America/New_York
  during DST). Setup instructions in
  `supabase/functions/spuf-release-monitor/README.md`.
- **What it does**: Scrapes the CMS quarterly + monthly SPUF index
  pages, compares the latest `release_date` per (kind, plan_year)
  against `cms_spuf_releases.promoted_at` in Plan Match prod. When a
  newer release is found:
  - SMSes Rob at `+18287613326` via Twilio REST API.
  - Inserts a row into `cms_spuf_release_checks` with
    `status = 'new_release_available'`.
- **When it stays silent**: The check log gets a `'current'` row
  every day the pipeline is up-to-date. No SMS on days when nothing
  new is available. Transient CMS 5xx errors get a `'cms_page_error'`
  log row but do NOT SMS — persistent failures surface in the weekly
  digest instead.

### 2. Daily staleness alert (script cron)

- **Where**: `scripts/monitor-formulary-changes.ts --daily`.
- **Runs**: Suggested via `launchd`/`cron` on Rob's Mac Mini at
  03:15 ET (see below).
- **What it does**: Reads the currently-active `cms_spuf_releases`
  row from Plan Match prod. If `promoted_at` is more than **45 days**
  ago (previously 90), SMSes Rob. Threshold lowered so a single
  missed CMS release triggers a page instead of two.

Cron recipe:
```bash
# Daily 03:15 America/New_York — belt-and-braces alongside the edge
# function's release monitor. Different signal: this alerts on our
# import being stale even if CMS hasn't published anything new.
15 3 * * * cd ~/planmatch/planmatch && \
  /usr/local/bin/npx tsx scripts/monitor-formulary-changes.ts --daily \
  >> /tmp/formulary-monitor.log 2>&1
```

### 3. Weekly digest (script cron)

- **Where**: `scripts/monitor-formulary-changes.ts --weekly-digest`.
- **Runs**: Monday 08:00 America/New_York.
- **What it does**: SMSes Rob a compact report:
  - Days since last active-release promotion.
  - Per-state plan + formulary row counts (via
    `cms_spuf_plan_information` ⨝ `pm_formulary_v2`).
  - Per-carrier row counts, plus any carrier whose row count dropped
    ≥20 % vs. the prior superseded release (early warning for a
    carrier exit or a broken import).
  - Any `cms_spuf_release_checks` rows with
    `status='new_release_available'` that don't have a matching
    promoted release yet — i.e. releases the edge function detected
    but nobody has run `refresh-formulary` for.

Cron recipe:
```bash
# Monday 08:00 America/New_York (12:00 UTC standard, 13:00 DST)
0 12 * * 1 cd ~/planmatch/planmatch && \
  /usr/local/bin/npx tsx scripts/monitor-formulary-changes.ts --weekly-digest \
  >> /tmp/formulary-monitor.log 2>&1
```

### 4. One-command refresh (manual today, automatable)

- **Where**: `scripts/refresh-formulary.ts`.
- **Wraps**: `npm run formulary:import` (the existing importer). Does
  NOT reimplement or modify anything under `scripts/cms-spuf/` —
  those internals are hardened (parser tests, single-txn promote).
- **Does**: Discovers the latest release, checks
  `cms_spuf_releases` for an already-promoted match (skip unless
  `--force`), invokes the importer as a child process, then reads
  back per-state row counts and SMSes a confirmation.

Left manual today because full imports take 30–90 minutes and Rob
prefers to eyeball the promote step. To go fully hands-off in the
future, wire the release monitor's SMS body into a cron trigger for
this script — the SMS body already tells the operator exactly what
command to run.

## Manual triggers

### Refresh to the latest available release

```bash
cd ~/planmatch/planmatch
npm exec tsx scripts/refresh-formulary.ts
```

- Defaults: `--kind=quarterly`, `--year=<current UTC year>`.
- Dry-run (discovery + already-promoted check only):
  `npm exec tsx scripts/refresh-formulary.ts -- --dry-run`.
- Force re-import a release already at `status='active'`:
  `npm exec tsx scripts/refresh-formulary.ts -- --force`.
- Pick a specific release:
  `npm exec tsx scripts/refresh-formulary.ts -- --release-date=20260408`.
- Monthly instead of quarterly:
  `npm exec tsx scripts/refresh-formulary.ts -- --kind=monthly`.

### Skip the wrapper and go direct

Same underlying tool, no SMS or skip-if-current guard:

```bash
npm run formulary:import -- --year=2026 --quarter=Q2
```

Useful when you need `--skip-promote` (load landing only, promote
manually later), `--url=<override>`, or any of the other flags the
underlying importer supports (see `--help`).

### Fire the release monitor by hand

```bash
curl -X POST \
  https://kdqjyhuzxulgzxhihyjv.supabase.co/functions/v1/spuf-release-monitor \
  -H 'content-type: application/json' | jq
```

Response payload documented in
`supabase/functions/spuf-release-monitor/README.md`.

## Verifying a refresh succeeded

Run these in order — each takes seconds.

### 1. Confirm the release row promoted

```sql
SELECT release_id, plan_year, release_kind, release_date,
       promoted_at, status, row_counts
  FROM cms_spuf_releases
  ORDER BY release_id DESC
  LIMIT 5;
```

Expect the newest row to have `status='active'` and
`promoted_at` within the last few minutes. Older rows for the same
plan year should have flipped to `status='superseded'`.

### 2. Confirm plan counts moved

```sql
SELECT release_id, COUNT(*) AS plan_rows
  FROM cms_spuf_plan_information
  GROUP BY release_id
  ORDER BY release_id DESC
  LIMIT 5;
```

The new release should have roughly the same number of rows as the
prior one (typical delta ±5 %). A >20 % drop is a red flag — either
CMS filed a truncated release or the loader hit an error partway.

### 3. Confirm the app tables were rebuilt

```sql
SELECT COUNT(*) AS formulary_v2_rows FROM pm_formulary_v2;
SELECT COUNT(*) AS beneficiary_cost_rows FROM pm_beneficiary_cost_v2;
```

Compare against pre-refresh row counts (Rob captures these before
starting an import).

### 4. Spot-check per-state coverage

Same query the SMS confirmation uses:

```sql
WITH state_plans AS (
  SELECT DISTINCT p.contract_id, p.plan_id, p.segment_id, p.state
    FROM cms_spuf_plan_information p
    WHERE p.release_id = (SELECT MAX(release_id) FROM cms_spuf_releases WHERE status = 'active')
      AND p.plan_suppressed_yn = 'N'
      AND p.state IS NOT NULL
)
SELECT sp.state,
       COUNT(DISTINCT sp.contract_id || '-' || sp.plan_id || '-' || sp.segment_id) AS plan_count,
       COUNT(f.*)                                                                    AS formulary_rows
  FROM state_plans sp
  LEFT JOIN pm_formulary_v2 f
    ON f.contract_id = sp.contract_id
   AND f.plan_id = sp.plan_id
   AND f.segment_id = sp.segment_id
  GROUP BY sp.state
  ORDER BY sp.state;
```

Rob's active states (NC, GA, TX) should each show non-zero plan and
formulary counts.

### 5. Live-check a well-known drug

```sql
SELECT contract_id, plan_id, tier, copay_default, coinsurance_default
  FROM pm_formulary_v2
  WHERE rxcui = '1000010'      -- Ozempic 2 mg/1.5 mL pen (SCD rxcui)
  LIMIT 10;
```

If this returns zero rows for known-covering carriers (Humana, UHC,
BCBSNC in NC), the promote step joined poorly against `basic_drugs`
— open `_tmp/probe-ozempic-formulary.ts` for the diagnostic script.

## Alert escalation

Every automated component points at Rob's phone
(`+18287613326`, override with `FORMULARY_ALERT_PHONE`). There is no
paging tier below Rob today — the consumer + agent apps degrade
gracefully to tier-only display when formulary rows are missing (see
the `feedback_not_available_fields.md` memory).

Order of what to check when an SMS lands:

1. **`new CMS SPUF release available`** — release monitor. Run
   `refresh-formulary` when Rob has 60–90 min of runway. No user-
   visible impact until stale enough to trip the daily alert.
2. **`Plan Match formulary is Nd stale`** — daily monitor. Import is
   ≥45 days old. Run `refresh-formulary` at the next available
   window; if CMS hasn't published anything new (release monitor
   still logs `'current'`), this is a CMS release-cadence problem,
   not ours.
3. **`Formulary refresh FAILED`** — the wrapper itself failed. Read
   the SMS tail (last 500 chars of stderr/stdout from
   `import-cms-spuf.ts`) and cross-check `cms_spuf_releases.status`
   — a `'failed'` row means the promote transaction rolled back
   cleanly, so re-running is safe.
4. **`Formulary already current`** — informational, no action.

## Failure-mode notes

- **CMS moves the ZIP URL pattern** — `discover.ts`'s regex is
  intentionally narrow (`SPUF_YYYY_YYYYMMDD.zip` /
  `YYYY_YYYYMMDD.zip`). If CMS ships a URL under a different name the
  discovery step throws before download starts and the SMS body
  carries the CMS error. Fix: update the `filenameRe` patterns in
  both `scripts/cms-spuf/discover.ts` and
  `supabase/functions/spuf-release-monitor/index.ts` together.
- **`cms_spuf_release_checks` missing** — the edge function catches
  the "relation does not exist" error and continues to send SMS
  alerts, but the weekly digest can't surface pending imports until
  the table exists. See the DDL block in the function's README.
- **Twilio outage** — `refresh-formulary.ts` logs and continues on
  SMS failure so an import doesn't roll back over a Twilio 500. Both
  monitor scripts propagate the error (cron log shows the failure).
