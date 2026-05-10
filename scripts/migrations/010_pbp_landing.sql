-- 010_pbp_landing.sql
--
-- CMS Plan Benefit Package (PBP) Benefits — landing layer.
--
-- Companion to the SPUF importer (migrations 004–009). PBP is the MA
-- medical-benefit bid filing — premium, MOOP, deductibles, plus the
-- per-service cost-share that drives the consumer's brain scoring.
--
-- This migration ships ONLY the release ledger. Landing tables for
-- the 17 PBP source files (Section A, Section D, PlanArea, and 14
-- Section B sub-tables) are created by the importer at runtime —
-- their column lists come from PBP_Benefits_2026_dictionary.xlsx and
-- evolve YoY as CMS adds/removes fields. The importer issues
-- CREATE TABLE IF NOT EXISTS with the dictionary-derived column set
-- and ALTERs the table when new columns appear in a future release.
--
-- Once landing rows are loaded, migration 011's app tables are
-- rebuilt from this release in a single transaction.
--
-- Run in the Supabase SQL editor — service-role JWT can't do DDL via
-- PostgREST. Safe to re-run (IF NOT EXISTS everywhere).
-- ═══════════════════════════════════════════════════════════════════

-- ─── Release ledger ───────────────────────────────────────────────────
--
-- One row per imported PBP ZIP. zip_sha256 is the idempotency key —
-- the importer aborts if the SHA already exists unless --force is
-- passed. CMS publishes pbp-benefits-2026.zip at a stable URL and
-- updates it in place each quarter, so the SHA-keyed approach is what
-- distinguishes "already imported" from "fresh quarterly refresh."

CREATE TABLE IF NOT EXISTS pbp_releases (
  release_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_year      smallint NOT NULL,
  release_date   date NOT NULL,                      -- ZIP Last-Modified header
  source_url     text NOT NULL,
  zip_sha256     char(64) NOT NULL UNIQUE,
  zip_bytes      bigint NOT NULL,
  downloaded_at  timestamptz NOT NULL DEFAULT now(),
  imported_at    timestamptz,                        -- set when all landing rows loaded
  promoted_at    timestamptz,                        -- set when app tables swapped to this release
  status         text NOT NULL DEFAULT 'downloaded'
                  CHECK (status IN ('downloaded','loading','loaded','active','superseded','failed')),
  row_counts     jsonb,                              -- {pbp_section_a: 8082, pbp_b1a_inpat_hosp: 7420, …}
  error          text,
  notes          text
);

-- Exactly one active release per plan year — partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pbp_releases_one_active
  ON pbp_releases (plan_year)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_pbp_releases_year_status
  ON pbp_releases (plan_year, status);

-- Naming convention for landing tables created at runtime by
-- scripts/cms-pbp/loader.ts (mirrors scripts/cms-spuf/loader.ts):
--
--   pbp_section_a, pbp_section_d, pbp_planarea
--   pbp_b1a_inpat_hosp, pbp_b1b_inpat_hosp, pbp_b2_snf,
--   pbp_b4_emerg_urgent, pbp_b6_home_health, pbp_b7_health_prof,
--   pbp_b8_clin_diag_ther, pbp_b9_outpat_hosp, pbp_b10_amb_trans,
--   pbp_b13_other_services, pbp_b14_preventive, pbp_b15_partb_rx_drugs,
--   pbp_b16_dental, pbp_b17_eye_exams_wear, pbp_b18_hearing_exams_aids
--
-- Every landing table carries a release_id bigint NOT NULL REFERENCES
-- pbp_releases(release_id) ON DELETE CASCADE as its first column,
-- followed by the verbatim CMS columns. PK on
-- (release_id, pbp_a_hnumber, pbp_a_plan_identifier, segment_id) for
-- B/C/D files; PlanArea adds county_code as a 5th PK column.

-- ═══ VERIFICATION ═══════════════════════════════════════════════════

SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_name = 'pbp_releases'
ORDER BY ordinal_position;

SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'pbp_releases'
ORDER BY indexname;

SELECT COUNT(*) AS releases FROM pbp_releases;
