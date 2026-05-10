-- 008_relax_not_null_post_ira.sql
--
-- Relax NOT NULL on columns that CMS removed from 2025+ files following
-- the IRA (Inflation Reduction Act) elimination of the Part D coverage
-- gap. The columns stay in the landing tables for historical-release
-- compatibility but receive NULL for every row from 2025+ releases.
--
-- Affected columns:
--   cms_spuf_excluded_drugs.gap_cov  (was NOT NULL in migration 004)
--
-- The other post-IRA-removed columns (cms_spuf_plan_information.icl,
-- cms_spuf_beneficiary_cost.gap_cov_tier) were already nullable.
--
-- Run in the Supabase SQL editor — service-role JWT can't do DDL via
-- PostgREST. Safe to re-run (idempotent: DROP NOT NULL on an already-
-- nullable column is a no-op).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE cms_spuf_excluded_drugs
  ALTER COLUMN gap_cov DROP NOT NULL;

-- ═══ VERIFICATION ═══════════════════════════════════════════════════

SELECT column_name, is_nullable
FROM information_schema.columns
WHERE table_name = 'cms_spuf_excluded_drugs'
  AND column_name = 'gap_cov';
