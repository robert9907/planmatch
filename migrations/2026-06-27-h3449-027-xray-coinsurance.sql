-- migrations/2026-06-27-h3449-027-xray-coinsurance.sql
--
-- Backfill: pm_plan_benefits.xray.coinsurance for H3449-027 (Blue Medicare
-- Essential HMO, NC) — segments '1' and '2'.
--
-- Root cause (per scripts/_probe-h3449-027-xray.ts):
--
--   1. CMS source pbp_b8_clin_diag_ther has the correct value:
--      pbp_b8b_coins_pct_drs = 20 for both segments.
--   2. cms-pbp/promote.ts populates pbp_benefits_v2 from raw PBP, but
--      for H3449-027 it emits ZERO b8-derived rows — the b8b extractor
--      branch is dropping the plan on the way through. Plumbing
--      investigation deferred (separate scope from the validator fix).
--   3. The original pm_plan_benefits populator wrote a copay=0 row for
--      H3449-027 xray (matching the b8b copay range $0..$300) but
--      didn't fill coinsurance.
--   4. scripts/cms-benefit-sync-2026.ts DID surface this gap and emit
--      an UPSERT to migrations/proposed-cms-benefit-sync-2026.sql:
--        VALUES ('H3449', '027', '001', 'xray', 20)
--      but that segment_id format ('001' zero-padded) does not match
--      pm_plan_benefits' stored format ('1'), so the ON CONFLICT clause
--      would not have matched — and the proposed migration appears to
--      have been left unapplied for these xray rows specifically. The
--      advanced_imaging counterpart for this plan IS already coins=20,
--      so something else (manual fix? curated subset?) handled that row
--      asymmetrically.
--
-- Fix: targeted UPDATE matching the actual stored segment_id format.
-- Only updates rows where coinsurance IS NULL — defensive in case of
-- prior partial fixes.
--
-- Validator: scripts/cms-ground-truth-validate.ts will reach 228/228
-- after this runs (6 accepted B8b swaps + 1 newly-greened xray check).

UPDATE pm_plan_benefits
SET coinsurance = 20
WHERE contract_id = 'H3449'
  AND plan_id = '027'
  AND benefit_category = 'xray'
  AND coinsurance IS NULL;
