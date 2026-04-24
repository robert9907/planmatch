-- 001_pbp_benefits.sql
--
-- Overlay table for benefit data from sources richer than the federal
-- PBP structured extract. Every row carries a `source`; the merge API
-- (api/plans-with-extras.ts) picks the highest-priority non-null row
-- per (plan_id, benefit_type, tier_id) using the priority chain:
--
--   medicare_gov > sb_ocr > manual > pbp_federal
--
-- The existing pm_plan_benefits table stays as the base layer (no
-- schema changes required). Rows here REPLACE pm_plan_benefits rows at
-- merge time for the same (plan_id, benefit_type), they do not
-- duplicate them.
--
-- Run this in the Supabase SQL Editor — the service-role JWT cannot
-- execute DDL through PostgREST.
--
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pbp_benefits (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id      text NOT NULL,
  benefit_type text NOT NULL,
  tier_id      text,
  copay        numeric,
  coinsurance  numeric,
  description  text,
  source       text NOT NULL DEFAULT 'pbp_federal'
               CHECK (source IN ('medicare_gov', 'sb_ocr', 'manual', 'pbp_federal')),
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

-- The UNIQUE constraint is what makes the scraper's upsert idempotent.
-- tier_id is nullable (most benefit_types don't tier) so we coalesce
-- to an empty string in the index to dedup correctly.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pbp_benefits_plan_type_tier
  ON pbp_benefits (plan_id, benefit_type, COALESCE(tier_id, ''));

CREATE INDEX IF NOT EXISTS idx_pbp_benefits_plan
  ON pbp_benefits (plan_id);

CREATE INDEX IF NOT EXISTS idx_pbp_benefits_source
  ON pbp_benefits (source);

-- Keep updated_at fresh on every row update. Cheap to add now, useful
-- later for "refresh rows older than N days" scraper heuristics.
CREATE OR REPLACE FUNCTION pbp_benefits_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pbp_benefits_updated_at ON pbp_benefits;
CREATE TRIGGER trg_pbp_benefits_updated_at
  BEFORE UPDATE ON pbp_benefits
  FOR EACH ROW EXECUTE FUNCTION pbp_benefits_touch_updated_at();

-- ═══ VERIFICATION ═══════════════════════════════════════════════════
-- Run these after the CREATEs to confirm the table is healthy.

-- 1) Schema shape
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'pbp_benefits'
ORDER BY ordinal_position;

-- 2) Constraints + indexes
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'pbp_benefits'
ORDER BY indexname;

-- 3) Source counts (empty until scraper runs)
SELECT source, COUNT(*) AS rows
FROM pbp_benefits
GROUP BY source
ORDER BY source;
