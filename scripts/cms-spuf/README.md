# CMS SPUF / PUF importer

Imports the CMS Quarterly (SPUF) or Monthly (PUF) Prescription Drug Plan Formulary, Pharmacy Network & Pricing release into Postgres. Replaces the legacy `pm_formulary` table (2.3M rows, missing `segment_id` / `formulary_id` / `plan_year`) with a versioned `pm_*_v2` schema derived from CMS source files.

## Source

- Quarterly index: <https://data.cms.gov/provider-summary-by-type-of-service/medicare-part-d-prescribers/quarterly-prescription-drug-plan-formulary-pharmacy-network-and-pricing-information>
- Monthly index: <https://data.cms.gov/provider-summary-by-type-of-service/medicare-part-d-prescribers/monthly-prescription-drug-plan-formulary-and-pharmacy-network-information>

The quarterly bundle is preferred — it includes `pricing.txt` (NDC-level unit costs) which the monthly bundle omits.

## Prerequisites

1. Run migrations 004 and 005 in the Supabase SQL editor:
   - `scripts/migrations/004_cms_spuf_landing.sql`
   - `scripts/migrations/005_cms_spuf_app_tables.sql`

2. Add `DATABASE_URL` to `.env.local`. From the Supabase dashboard:
   - Project Settings → Database → Connection string → URI
   - Use the **Session pooler (port 5432)** — not transaction pooler. COPY FROM and long swap transactions need a real connection.
   - Form: `postgresql://postgres.<project>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`

3. Install new deps:
   ```sh
   npm install
   ```

## Commands

```sh
# Latest 2026 quarterly
npm run formulary:import -- --year=2026 --quarter=Q1

# Specific release date (when CMS posts errata)
npm run formulary:import -- --year=2026 --quarter=Q1 --release-date=20260408

# Latest monthly
npm run formulary:import -- --year=2026 --kind=monthly

# Re-import (override SHA-256 idempotency check)
npm run formulary:import -- --year=2026 --quarter=Q1 --force

# Skip the swap, leave landing rows in place for inspection
npm run formulary:import -- --year=2026 --quarter=Q1 --skip-promote

# Dry-run: download + parse + validate, no DB writes
npm run formulary:import -- --year=2026 --quarter=Q1 --dry-run

# Use a pre-downloaded ZIP (skip the network fetch entirely)
npm run formulary:import -- --zip=/tmp/SPUF_2026_20260408.zip

# Explicit URL (bypass discovery)
npm run formulary:import -- --url=https://data.cms.gov/.../SPUF_2026_20260408.zip
```

## Architecture

```
discover.ts   ─┐
download.ts   ─┤
parser.ts     ─┼─►  cms_spuf_releases  ─►  cms_spuf_*  (landing)  ─►  pm_*_v2  (app)
loader.ts     ─┤            │                   │                       │
promote.ts    ─┘            │                   │                       │
                           SHA-256          per-release             active swap
                          idempotency       partitioning           in single tx
```

Each ZIP becomes one row in `cms_spuf_releases` keyed by SHA-256. Landing tables carry that release_id alongside every row. Promotion deletes the prior plan_year's rows from each `pm_*_v2` table and replaces them with `INSERT … SELECT` from the new release's landing rows — all inside one transaction so readers never see partial state.

## File map

| File | Purpose |
|---|---|
| `scripts/import-cms-spuf.ts` | CLI entrypoint, argument parsing, orchestration |
| `scripts/cms-spuf/schema.ts` | Per-file CMS column definitions (single source of truth) |
| `scripts/cms-spuf/discover.ts` | Resolve `--year --quarter` to a concrete ZIP URL |
| `scripts/cms-spuf/download.ts` | Streaming download with inline SHA-256 |
| `scripts/cms-spuf/parser.ts` | Streaming pipe-delimited parser → COPY-format rows |
| `scripts/cms-spuf/loader.ts` | `COPY FROM STDIN` per file; release lifecycle |
| `scripts/cms-spuf/promote.ts` | Single-transaction swap into `pm_*_v2` |
| `scripts/cms-spuf/pg.ts` | Shared `pg.Pool`, transaction helper |
| `scripts/cms-spuf/env.ts` | `.env.local` loader |
| `scripts/cms-spuf/parser.test.ts` | Header + coercion unit tests |

## Idempotency

Re-running with the same ZIP is a no-op. The release row already exists (matched by `zip_sha256`); the importer logs the existing `release_id` and exits. Pass `--force` to re-import — the existing landing rows for that release are purged first, then loaded fresh.

The `pm_*_v2` tables are versioned by `plan_year` only — once a release is promoted, it owns that year. Promoting a different release for the same year deletes the prior rows and inserts the new ones in one transaction, then flips `cms_spuf_releases.status` from `active` → `superseded` for the prior release.

## Verification

After a successful import, sanity-check with the verification queries at the bottom of each migration file. A few useful ad hoc queries:

```sql
-- Active release per plan_year
SELECT plan_year, release_kind, release_date, row_counts
FROM cms_spuf_releases
WHERE status = 'active'
ORDER BY plan_year DESC;

-- Spot-check pm_formulary_v2 vs the legacy table
SELECT
  (SELECT COUNT(*) FROM pm_formulary_v2 WHERE plan_year = 2026) AS v2_rows,
  (SELECT COUNT(*) FROM pm_formulary_legacy)                   AS legacy_rows;

-- Confirm the compatibility view returns the legacy column shape
SELECT contract_id, plan_id, rxcui, drug_name, tier, copay, coinsurance,
       prior_auth, step_therapy, quantity_limit
FROM pm_formulary
WHERE rxcui = '1731317'
LIMIT 5;
```

## Ongoing operation

CMS posts a new quarterly release ~4× per year (Jan, Apr, Jul, Oct). Schedule:

```sh
# Cron-style — first Monday of every quarter
npm run formulary:import -- --year=$(date +%Y) --quarter=$(...)
```

For day-to-day refreshes between quarters, the monthly bundle covers everything except `pricing.txt`.

## After parity

Once one production cycle confirms `pm_formulary_v2` matches expected reads:

```sql
-- Drop the legacy table — frees ~2.3M rows of stale data
DROP TABLE pm_formulary_legacy;
```

## Tests

```sh
npm run formulary:test    # parser unit tests (header validation, row coercion)
```

Smoke testing the full pipeline against a real release is best done in a non-prod Supabase project: run with `--skip-promote` first, inspect the landing rows, then promote.

## Troubleshooting

**"DATABASE_URL must be set"** — Add it to `.env.local`. Use the Session pooler URL (port 5432), not the transaction pooler.

**`relation "cms_spuf_releases" does not exist`** — Run migrations 004 and 005 first.

**`statement timeout`** during promotion — The promote transaction sets `statement_timeout = 0` locally, but if your connection's role enforces a hard cap, raise it before running. Hosted Supabase typically allows this.

**Unexpected entries in ZIP** — The importer logs them and proceeds. CMS occasionally adds new files (e.g. an experimental dataset); update `schema.ts` to handle them.

**Header mismatch** — CMS renamed a column. Update the relevant `CmsFileSpec.columns` array; the test suite catches the spelling drift.
