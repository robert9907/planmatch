# OTC + Telehealth ingest investigation

Generated as Task 4 of the CMS 2026 ground-truth audit. **READ-ONLY** —
no ingest code modified. Cross-repo investigation: agent app
(`~/planmatch/planmatch`) plus the consumer-side importers (`~/Code/plan-match/scripts/`).

The OTC + telehealth corruption surfaced in Pass 2 (`cms-benefit-sync-2026.ts`)
is a write-path issue. This document records who writes those rows and
where the bug sits, so the next coding pass can patch the right file
instead of guessing.

---

## OTC corruption — pattern observed

Spot-check (transcript task 1) showed a consistent shape across
Aetna/Clover/UHC/Wellcare in NC:

| Plan | CMS PBP | DB row |
|---|---|---|
| H2293-001 Aetna | copay=0, max_coverage=50 | copay=**50**, max_coverage=**200** |
| H2293-002 Aetna | copay=0, max_coverage=110 | copay=**110**, max_coverage=**440** |
| H5141-026 Clover | copay=0, max_coverage=80 | copay=**80**, max_coverage=**320** |

Three things are wrong simultaneously:

1. **The quarterly allowance lands in `copay`** instead of `coverage_amount`.
2. **`max_coverage` = quarterly × 4** (annual rollup), so the column
   semantics flipped: copay holds the quarterly $, max_coverage holds
   the annual $.
3. **`coverage_amount` is NULL** — the agent's `buildBenefits()` in
   `api/plans.ts:1262` reads `otc?.coverage_amount` for
   `allowance_per_quarter` and gets 0, so the UI tier filter (≥ $150/qtr)
   silently filters out plans that DO carry an OTC allowance.

This is the same shape every time — a single broken writer, not many.

## OTC — actively-maintained writers (all CORRECT)

Three importers in the consumer repo all write OTC the right way today:

### `~/Code/plan-match/scripts/merge-pbp-into-pm-plan-benefits.ts:478-502`
Authoritative merge from `pbp_benefits` → `pm_plan_benefits`. Builds:
```ts
{
  benefit_category: 'otc',
  coverage_amount: quarterly,       // ✓ correct column
  copay: null,                       // ✓ no value in copay
  coinsurance: null,
  max_coverage: annual,              // ✓ quarterly × 4
}
```
Sources are ranked `otc_allowance > otc > otc_items`. This is the
canonical writer going forward.

### `~/Code/plan-match/scripts/repair-benefits-from-pbp.ts:244-251`
Repair pass that reads from raw `pbp_b13b_maxplan_amt` + period code,
annualises, and writes:
```ts
setDesired(k, 'otc', { coverage_amount: annual / 4, max_coverage: annual });
```
Same convention as merge-pbp.

### `~/Code/plan-match/scripts/backfill-benefits-from-pbp.ts:50, 142-180`
Backfill of `coverage_amount` for rows where it's currently NULL.
Targets the `vision`/`hearing`/`otc` cap categories. Only updates
`coverage_amount` + `max_coverage`; never writes to `copay`.

**The same file also has an OTC outlier-cleanup pass** (around line
310-360): flags `coverage_amount > $500/qtr`, clears values
`> $1,500/qtr` to NULL because those were CSV-column-misread parses
in the legacy importer. The comment block already names "Humana H1036-331
shows $4,260/month (≈$51k/yr)" as the canary.

## OTC — the LEGACY broken writer (gone but residue persists)

None of the three active scripts above produce the
`copay=quarterly, max_coverage=annual` shape we still see in the DB.
That means the bad rows are **historical** — written by a legacy
importer that has already been removed from the codebase (likely the
"legacy CSV importer" the outlier-cleanup comment references).

### What this implies for the fix

- **No code patch needed** in the live ingest pipeline — the writers
  in the active path do the right thing.
- The remediation is a **one-shot DB cleanup migration**, not a code
  change:
  1. For every `pm_plan_benefits` row where
     `benefit_category='otc' AND coverage_amount IS NULL AND copay IS NOT NULL AND max_coverage = copay * 4`
     (the exact corruption signature):
     - move the value: `coverage_amount = copay`, `copay = NULL`
     - leave `max_coverage` alone (annual rollup is correct)
  2. After the move, re-run `merge-pbp-into-pm-plan-benefits.ts` to
     pick up plans where CMS PBP carries newer values.
- If a UI surface relies on `coverage_amount`, this cleanup unblocks it.
  If anything reads `copay` for OTC (it shouldn't — that's a schema
  misuse), grep before running.

---

## Telehealth corruption — pattern observed

Spot-check showed a single suspicious value across many plans:

| Plan | CMS PBP coins | DB coins |
|---|---|---|
| H0111-004 Wellcare | 20% | **$2,000** |
| H1112-006 Wellcare | 20% | **$2,000** |
| H5216-242 Humana | 20% | **$2,000** |
| H8390-017 CareSource | 20% | **$2,000** |
| Many more across carriers | — | **$2,000** uniformly |

The value `2000` sitting in the `coinsurance` column (which is a
percentage 0-100 by schema) is the smoking gun — no plan in any
universe has a 2000% telehealth coinsurance.

## Telehealth — actively-maintained writers (all CORRECT)

### `~/Code/plan-match/scripts/backfill-benefits-from-pbp.ts:55, 197-285`
Insert-missing-rows path for `telehealth` + `transportation`. Writes:
```ts
{
  benefit_category: 'telehealth',
  coverage_amount: amt,             // copay value, in coverage_amount
  copay: null,
  coinsurance: null,                // ✓ never writes here
  max_coverage: null,
}
```

### `~/Code/plan-match/scripts/repair-benefits-from-pbp.ts:302`
```ts
if (telehealth != null && telehealth > 0)
  setDesired(k, 'telehealth', { copay: telehealth });
```
Writes telehealth value to `copay`. Never touches coinsurance.

### `~/planmatch/planmatch/scripts/scrape-medicare-gov.mjs:830`
Writes telehealth description-only into `pbp_benefits`:
```js
if (rawPlan.telehealth === true)
  push('telehealth', null, null, null, 'Telehealth included');
```
`coinsurance` argument is `null`. The scraper itself can't be the
source of `2000` in coinsurance.

## Telehealth — the LEGACY broken writer

Same conclusion as OTC: none of the active writers can produce
`coinsurance=2000`. The corruption is residue from a removed importer.
Possible origins (best guesses, can't be confirmed from the current code):

- An older CSV importer that may have written a virtual-visit annual
  OOP cap (often filed at $2,000 on Plan Finder telehealth detail
  pages) into the coinsurance column instead of a separate cap column.
- A bulk INSERT from a one-off SQL run that used a placeholder constant.

### Remediation

- **No active code to fix.**
- One-shot SQL cleanup migration: scrub the corrupted rows. Two
  options, ordered by safety:
  1. Conservative: `SET coinsurance = NULL WHERE benefit_category='telehealth' AND coinsurance = 2000`. Lets the next merge-pbp pass fill in the real value.
  2. Aggressive: `DELETE` those rows; force the next `backfill-benefits-from-pbp.ts` run to recreate from scratch.
- Verify under sample (`scripts/probe-aetna-h3146-006-pipeline.ts` is
  already the pipeline-trace tool we'd use).

---

## What to do next

1. Write the cleanup migration (separate from this commit). Two
   statements, both confined to `pm_plan_benefits`:
   - OTC column-flip recovery (criteria above).
   - Telehealth `coinsurance=2000` scrub.
2. Run them against `plan-match-prod`
   (`rpcbrkmvalvdmroqzpaq.supabase.co`) — the SAME Supabase project
   the agent app reads from. **Both repos share the DB**, so a single
   cleanup pass fixes both UIs.
3. Re-run `scripts/cms-benefit-sync-2026.ts` to confirm telehealth
   and OTC categories climb out of the 26-34% match-rate bucket.

Linked to:
- `migrations/proposed-cms-benefit-sync-2026.sql` — has the SQL for
  these plans pre-generated but with the WRONG column mapping (it
  proposed updating `copay` for OTC because the diff was computed
  field-by-field). Do **not** apply that file's OTC / telehealth
  statements — use the column-flip migration above instead.
- `migrations/unsafe-do-not-apply.sql` — already quarantines OTC +
  telehealth statements from the proposed-benefit-sync output for
  exactly this reason.

— end —
