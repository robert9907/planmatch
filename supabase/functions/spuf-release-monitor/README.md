# spuf-release-monitor

Daily CMS SPUF release watcher. Runs as a Supabase Edge Function on
the **Command Center** project (`kdqjyhuzxulgzxhihyjv`), reads
`cms_spuf_releases` from **Plan Match prod** (`rpcbrkmvalvdmroqzpaq`),
and SMSes Rob when CMS publishes a release we haven't imported yet.

Deployed separately from the Plan Match app because it monitors an
external CMS page — cross-project cron is intentional so a plan-match
deploy or outage can't take the monitor down.

## One-time setup

### 1. Provision the audit-log table (in Plan Match prod)

Apply once via the Supabase SQL Editor on project
`rpcbrkmvalvdmroqzpaq`. Not shipped as a repo migration because the
SPUF pipeline branch owns the `cms_spuf_*` schema; add it separately
in the plan-match-prod dashboard.

```sql
CREATE TABLE IF NOT EXISTS cms_spuf_release_checks (
  check_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  checked_at    timestamptz NOT NULL DEFAULT now(),
  plan_year     smallint,
  release_kind  text CHECK (release_kind IN ('quarterly','monthly')),
  release_date  date,
  source_url    text,
  status        text NOT NULL CHECK (status IN (
                  'new_release_available','current','cms_page_error'
                )),
  notes         text
);
CREATE INDEX IF NOT EXISTS idx_cms_spuf_release_checks_status_time
  ON cms_spuf_release_checks (status, checked_at DESC);
```

The edge function catches the "table does not exist" error and logs
loudly to the function log, so an SMS alert still fires on new
releases even if this table is missing — but the weekly digest
(`scripts/monitor-formulary-changes.ts --weekly-digest`) reads from
this table, so it should be provisioned before Monday-morning
reporting matters.

### 2. Set secrets on the Command Center project

```bash
supabase secrets set --project-ref kdqjyhuzxulgzxhihyjv \
  PM_PROD_SUPABASE_URL='https://rpcbrkmvalvdmroqzpaq.supabase.co' \
  PM_PROD_SUPABASE_SERVICE_KEY='<service-role-key-from-plan-match-prod>' \
  TWILIO_ACCOUNT_SID='<sid>' \
  TWILIO_AUTH_TOKEN='<token>' \
  TWILIO_PHONE_NUMBER='+1<twilio-e164>' \
  FORMULARY_ALERT_PHONE='+18287613326'
```

### 3. Deploy the function

From the repo root (`~/planmatch/planmatch`):

```bash
supabase functions deploy spuf-release-monitor \
  --project-ref kdqjyhuzxulgzxhihyjv --no-verify-jwt
```

`--no-verify-jwt` because pg_cron invokes the function with an
anonymous fetch — the function's own logic is idempotent and reads
only from a service-role Supabase client for the sensitive path.

### 4. Schedule daily via pg_cron on Command Center

Run once in the Command Center SQL Editor:

```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Every day at 07:15 UTC (03:15 America/New_York during DST, 02:15
-- during standard time). Early enough to catch releases posted the
-- previous business day; late enough that CMS's CDN has caught up.
SELECT cron.schedule(
  'spuf-release-monitor-daily',
  '15 7 * * *',
  $$
    SELECT net.http_post(
      url := 'https://kdqjyhuzxulgzxhihyjv.supabase.co/functions/v1/spuf-release-monitor',
      headers := '{"content-type":"application/json"}'::jsonb
    );
  $$
);
```

To pause: `SELECT cron.unschedule('spuf-release-monitor-daily');`

## Manual invocation

```bash
# Dry test against the deployed function
curl -X POST \
  https://kdqjyhuzxulgzxhihyjv.supabase.co/functions/v1/spuf-release-monitor \
  -H 'content-type: application/json'

# Local, before deploy
supabase functions serve spuf-release-monitor --env-file supabase/functions/spuf-release-monitor/.env.local
```

## Response shape

```json
{
  "started_at": "2026-07-22T07:15:00.000Z",
  "discovered": { "quarterly": [...], "monthly": [...] },
  "promoted_max": { "quarterly|2026": "2026-04-08", "monthly|2026": "2026-06-01" },
  "newer": [ { "kind": "quarterly", "planYear": 2026, "releaseDate": "2026-07-08", ... } ],
  "action": "alerted",
  "sms": { "ok": true, "sid": "SM..." }
}
```

- `action: "none"` — no newer releases; a `'current'` row logged.
- `action: "alerted"` — SMS sent; one `'new_release_available'` row
  logged per newer release.
- HTTP 502 — CMS page fetch failed (transient). A `'cms_page_error'`
  row is logged but NO SMS fires; persistent failures surface in the
  weekly digest.

## Observability

```sql
-- Last 20 checks
SELECT checked_at, release_kind, release_date, status, LEFT(notes, 80) AS notes
  FROM cms_spuf_release_checks
  ORDER BY checked_at DESC
  LIMIT 20;

-- Undelivered alerts (SMS sent but never actioned)
SELECT release_kind, release_date, source_url, checked_at
  FROM cms_spuf_release_checks
  WHERE status = 'new_release_available'
    AND NOT EXISTS (
      SELECT 1 FROM cms_spuf_releases r
      WHERE r.plan_year = cms_spuf_release_checks.plan_year
        AND r.release_kind = cms_spuf_release_checks.release_kind
        AND r.release_date = cms_spuf_release_checks.release_date
        AND r.promoted_at IS NOT NULL
    )
  ORDER BY checked_at DESC;
```

The second query is the same one `scripts/monitor-formulary-changes.ts
--weekly-digest` uses to surface pending imports.
