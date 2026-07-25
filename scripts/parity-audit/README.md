# Parity Audit — Plan Match vs Medicare Plan Finder

Head-to-head validation that Plan Match returns benefit data identical to Medicare Plan Finder (MPF) for a fixed panel of 25 stress-test beneficiary profiles.

**Authoritative spec:** `docs/parity-audit/SPEC.md` (v2.0, 2026-07-23) — reference numbers, IRA MFP drug list, DB gap priorities, post-IRA §11404 LIS structure.
**Historical:** `docs/parity-audit/spec-corrections.md` — v1→v2 corrections trail (retained for audit chain of custody).

**Effective field count:** 92 per plan (94 spec fields minus 2 day-limit fields marked N/A per SPEC.md §3.3 note).

## Architecture

```
scripts/parity-audit/
├── README.md              ← this file
├── types.ts               ← BeneficiaryProfile, PlanSnapshot, FieldComparison, ParityReport
├── fixtures/
│   ├── profiles.ts        ← 25 typed profiles (NC 1–9, TX 10–17, GA 18–25)
│   ├── drug-classification.ts   ← Part B / Part D classification table
│   └── index.ts           ← re-exports allProfiles, profileById
├── lib/
│   ├── mpf-scrape.ts      ← MPF snapshot (extends Consumer scraper strategy)
│   ├── pm-snapshot.ts     ← Plan Match snapshot (Supabase query, matches PlanSnapshot shape)
│   ├── diff-engine.ts     ← Compares two PlanSnapshots → FieldComparison[]
│   ├── report-md.ts       ← Per-profile narrative markdown
│   ├── report-csv.ts      ← Field-level CSV export
│   └── report-rollup.ts   ← State/overall parity dashboard
└── run.ts                 ← CLI entry point

_tmp/parity-audit/         ← Cached snapshots + report output (gitignored)
├── mpf/<profile-id>/<contract>-<plan>-<segment>.json
├── pm/<profile-id>/<contract>-<plan>-<segment>.json
└── reports/<run-timestamp>/
    ├── per-profile/*.md
    ├── comparisons.csv
    └── rollup.md
```

## Data flow

```
Profile fixture ──┬── mpf-scrape ──► MPF PlanSnapshot ──┐
                  │                                       ├── diff-engine ──► FieldComparison[]
                  └── pm-snapshot ──► PM PlanSnapshot ────┘                     │
                                                                                 ▼
                                                                          report-md + csv + rollup
```

## CLI

```bash
# Run one profile end-to-end (MPF scrape + PM snapshot + diff + report)
npm run audit:parity -- --profile 01-margaret

# Run all 25 (long — ~60 min for MPF scrape)
npm run audit:parity -- --all

# Skip MPF re-scrape (use cached snapshots)
npm run audit:parity -- --all --use-mpf-cache

# Report from existing snapshots
npm run audit:parity -- --report-only

# One state only (NC | TX | GA)
npm run audit:parity -- --state NC --verbose

# Force re-scrape
npm run audit:parity -- --profile 01-margaret --refresh-mpf --refresh-pm
```

## MPF scraper notes

Ported from `~/Code/plan-match/scripts/scrape-medicare-gov.ts`. Key differences:

1. Accepts a `BeneficiaryProfile` (drug list + LIS + Medicaid + ESRD), not just ZIP/FIPS.
2. Constructs POST `/plans/search` body with `prescriptions`, `lis`, and `snp_type` derived from profile.
3. Constructs GET `/plan/{year}/{contract}/{plan}/{segment}?lis=…` per plan with profile's LIS level.
4. Filters top 5 MAPD + top 2 PDP from search results.
5. Caches per profile — re-runs skip network unless `--refresh`.

Playwright real Chrome (not Chromium) — Akamai blocks bundled Chromium's TLS fingerprint.

Rate limits: 3.5s between plan-detail fetches, 8s between counties. For 25 profiles × ~7 plans = 175 detail calls, expect ~40–60 minutes wall time with cooldowns.

## PM snapshot notes

Queries `plan-match-prod` Supabase (`rpcbrkmvalvdmroqzpaq`) with `_template-probe.ts` env pattern:
- `pm_plans` (identification + premium + MOOP + deductible)
- `pm_plan_benefits` (medical + supplemental copays)
- `pbp_benefits_v2` (fallback for benefit categories pm_plan_benefits doesn't cover)
- `pm_formulary_v2` (per-drug tier + PA/QL/ST — note: `copay_default` / `coinsurance_default`, coinsurance is 0..1 fraction)

Uses `fetchAllRows()` pagination helper (PostgREST 1000-row cap). See `_template-probe.ts:59` for the pattern.

## Known gaps (from sanity check)

DB does not store: `part_b_giveback`, `medical_deductible_oon`, tier-6 preferred/standard split, mail-order 90-day per tier, specialty pharmacy per-drug flag, cardiac/pulmonary rehab, home health, dialysis, food-card grocery restriction, caregiver/in-home-support/acupuncture/worldwide-emergency/nurse-hotline.

Snapshot fields tied to missing columns return `null` — diff engine treats `null vs. MPF value` as FAIL with root cause `F2` (missing field). This is expected; parity remediation plan will cover schema additions per category.

## Fail codes (spec §4.2)

| Code | Category | Weight |
|------|----------|--------|
| F1 | Value mismatch | Major (2x if > $10) / Minor |
| F2 | Missing field | Minor |
| F3 | Extra field | Display (0.5x) |
| F4 | Formulary error | Major (2x) |
| F5 | Eligibility filter error | Critical (3x) |
| F6 | Plan missing | Critical (3x) |
| F7 | LIS/Dual override failure | Critical (3x) |
| F8 | IRA provision error | Major (2x) |
| F9 | Part B vs D misclassification | Critical (3x) |
| F10 | Supplemental benefit error | Minor |

## Status

- [x] Sanity check against codebase (72/94 fields present in DB)
- [x] Spec corrections logged
- [x] Types defined
- [x] 25 profile fixtures authored
- [x] MPF scrape module — `lib/mpf-scrape.ts` (996 lines; ported from Consumer scraper)
- [x] PM snapshot module — `lib/pm-snapshot.ts` (1,124 lines; uses existing `dual-eligible.ts` LIS schedules)
- [x] Diff engine — `lib/diff-engine.ts` (931 lines; F1–F10 fail codes + severity weights)
- [x] Report generators — `lib/report-md.ts`, `lib/report-csv.ts`, `lib/report-rollup.ts`
- [x] CLI wrapper — `run.ts` + `npm run audit:parity`
- [ ] End-to-end validation on Profile 01 (Margaret / Durham) — requires live MPF + Supabase creds
- [ ] Full run on all 25 profiles

## Known limitations (as-built)

Documented in subagent reports; will need follow-up fixes:

1. **MPF formulary drug-coverage** (mpf-scrape.ts) — `drugCoverage[]` stubbed to `[]`. The `/api/v1/data/formulary` endpoint wasn't fully reverse-engineered. Diff engine treats missing `drugCoverage` on the MPF side gracefully (marks as F2 not F4). **v2 note:** Per SPEC.md §4.1 Step 1b, use CMS public formulary files as drug ground truth instead — download from cms.gov/data-research/statistics-trends-and-reports/mcr-electronic-data/formulary and compare against Plan Match's formulary import + MPF's display as a three-way check.

2. **MPF prescription payload shape** (mpf-scrape.ts) — Best-guess `{name, dosage, quantity, frequency, package}` — SPA likely wants `rxcui`. Plan search should still work; drug-cost estimates may return empty. Verify by intercepting a real request.

3. **PM LIS income band** (pm-snapshot.ts) — Post-IRA §11404 the full-LIS tier has two income sub-bands (≤100% FPL = $1.60/$4.90; >100–150% FPL = $5.10/$12.65). Snapshot currently defaults full-LIS to `full_low`. Add `profile.lisIncomeBand` if diff engine needs to distinguish. QMB/full-dual is auto-mapped to `full_low`.

4. **PM QMB drug copay** (pm-snapshot.ts) — v2 spec §5.2 says QMB + full LIS should show **$4.90 per Rx uniform** (not tier-based). Current mapping uses `full_low` = $1.60/$4.90. Close enough for brand ($4.90 both), but generic differs ($1.60 vs $4.90). Fix if F1 counts pile up on generic tiers for QMB profiles (2, 6, 17).

5. **PM drug-name matching** (pm-snapshot.ts) — Case-insensitive contains match on `pm_formulary.drug_name`. Drug fixtures have no RxCUI field; add if false-negatives crop up.

6. **IRA MFP validation** — `fixtures/ira-mfp-drugs.ts` flags the 10 MFP drugs. Diff engine does not yet cross-check that MPF/PM cost estimates reflect Maximum Fair Prices — exact MFP dollar amounts for the 8 "negotiated" drugs are not published as machine-readable data. Broker manually reviews MFP annotations in per-profile reports.

7. **DB schema gaps** (per SPEC.md §9) — 22 fields return `null` on PM side. Diff engine emits F2 (minor) for those. Priority 1 (3 columns) closes in day 1 — API mapping only. Priority 2 (6 columns) mirrors the food-card sprint pattern. Priority 3 (8 columns) = formulary schema migration. Priority 4 (5 columns) = supplemental expansion. Total effort: 5–8 days to close all 22.
