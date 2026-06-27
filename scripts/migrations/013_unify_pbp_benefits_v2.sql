-- 013_unify_pbp_benefits_v2.sql
--
-- Consolidates all pbp_benefits sources into pbp_benefits_v2 so the
-- compatibility view becomes a simple SELECT FROM v2 and
-- pbp_benefits_legacy can be dropped.
--
-- Three changes:
--   1. Widen the unique index to include `source` — current index is
--      (contract_id, plan_id, segment_id, plan_year, benefit_type,
--      COALESCE(tier_id,'')), which forces exactly one row per cell.
--      Sources are layered priorities — the consumer's merge API
--      applies the priority chain at query time — so they need to
--      coexist as separate rows.
--   2. Migrate medicare_gov / sb_ocr / manual rows from
--      pbp_benefits_legacy into pbp_benefits_v2. Drops the pbp_federal
--      rows (superseded by cms_pbp; already filtered from the view).
--   3. Redefine the pbp_benefits view to read v2 only.
--
-- After this, pbp_benefits_legacy is unreferenced and can be dropped
-- (handled by a follow-up DROP TABLE — kept separate so a rollback
-- step is one ALTER VIEW away).
--
-- Run in the Supabase SQL editor — service-role JWT can't do DDL via
-- PostgREST. Idempotent.
-- ═══════════════════════════════════════════════════════════════════

-- 1. Widen the unique index to include source.
DROP INDEX IF EXISTS uq_pbp_benefits_v2_natural;
CREATE UNIQUE INDEX uq_pbp_benefits_v2_natural
  ON pbp_benefits_v2 (
    contract_id, plan_id, segment_id, plan_year, benefit_type,
    COALESCE(tier_id, ''), source
  );

-- 2. Migrate carrier-side rows from legacy. plan_id in legacy is the
-- combined "H1234-005" or "H1234-005-0" string; split it back into
-- contract_id / plan_id / segment_id. Default segment_id to '0' when
-- the legacy row uses the 2-part form.
INSERT INTO pbp_benefits_v2 (
  contract_id, plan_id, segment_id, plan_year, benefit_type, tier_id,
  copay, copay_max, coinsurance, coinsurance_max,
  copay_mail_order, coinsurance_mail_order, copay_preferred,
  description, source, release_id
)
-- DISTINCT ON dedupes within the legacy set — the legacy table itself
-- has duplicate (plan, benefit_type, tier, source) rows from iterative
-- scraper upserts (the unique index on legacy uses just plan/type/tier
-- without source, so a re-scrape from a different source path inserts
-- a duplicate). Pick the row with the most-filled values per cell.
SELECT DISTINCT ON (
  SPLIT_PART(plan_id, '-', 1),
  SPLIT_PART(plan_id, '-', 2),
  COALESCE(NULLIF(SPLIT_PART(plan_id, '-', 3), ''), '0'),
  benefit_type,
  COALESCE(tier_id, ''),
  source
)
  SPLIT_PART(plan_id, '-', 1)                                         AS contract_id,
  SPLIT_PART(plan_id, '-', 2)                                         AS plan_id,
  COALESCE(NULLIF(SPLIT_PART(plan_id, '-', 3), ''), '0')              AS segment_id,
  2026                                                                 AS plan_year,
  benefit_type,
  tier_id,
  copay,
  copay_max,
  coinsurance,
  coinsurance_max,
  copay_mail_order,
  coinsurance_mail_order,
  copay_preferred,
  description,
  source,
  NULL                                                                 AS release_id
FROM pbp_benefits_legacy
WHERE source IN ('medicare_gov', 'sb_ocr', 'manual')
ORDER BY
  SPLIT_PART(plan_id, '-', 1),
  SPLIT_PART(plan_id, '-', 2),
  COALESCE(NULLIF(SPLIT_PART(plan_id, '-', 3), ''), '0'),
  benefit_type,
  COALESCE(tier_id, ''),
  source,
  -- tie-break: prefer rows with non-null cost-share, most-recent first
  (copay IS NOT NULL) DESC,
  (coinsurance IS NOT NULL) DESC,
  id DESC
ON CONFLICT (contract_id, plan_id, segment_id, plan_year, benefit_type,
             COALESCE(tier_id, ''), source)
DO UPDATE SET
  copay = EXCLUDED.copay,
  copay_max = EXCLUDED.copay_max,
  coinsurance = EXCLUDED.coinsurance,
  coinsurance_max = EXCLUDED.coinsurance_max,
  copay_mail_order = EXCLUDED.copay_mail_order,
  coinsurance_mail_order = EXCLUDED.coinsurance_mail_order,
  copay_preferred = EXCLUDED.copay_preferred,
  description = EXCLUDED.description;

-- 3. Redefine the view — drop the UNION ALL with pbp_benefits_legacy
-- since v2 now holds every source.
DROP VIEW IF EXISTS pbp_benefits;
CREATE VIEW pbp_benefits AS
SELECT
  contract_id || '-' || plan_id AS plan_id,
  benefit_type,
  tier_id,
  copay,
  copay_max,
  coinsurance,
  coinsurance_max,
  copay_mail_order,
  coinsurance_mail_order,
  copay_preferred,
  description,
  source
FROM pbp_benefits_v2;

COMMENT ON VIEW pbp_benefits IS
  'Compatibility view over pbp_benefits_v2. All sources (cms_pbp, medicare_gov, sb_ocr, manual) coexist as separate rows; the consumer merge API at api/plans-with-extras.ts applies the priority chain. pbp_benefits_legacy was dropped after this migration.';

-- ═══ VERIFICATION ═══════════════════════════════════════════════════

-- Source distribution after migration — should match the previous view
-- output (cms_pbp + carrier sources).
SELECT source, COUNT(*) AS rows
FROM pbp_benefits_v2
GROUP BY source ORDER BY source;

-- Spot check: Durham NC plan H1914-010 medicare_gov data should be visible
SELECT contract_id || '-' || plan_id AS plan_id, benefit_type, copay, source
FROM pbp_benefits_v2
WHERE contract_id = 'H1914' AND plan_id = '010' AND source = 'medicare_gov'
LIMIT 5;
