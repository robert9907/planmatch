-- 019_cms_spuf_pharmacy_network_drift.sql
--
-- Pharmacy-network column drift fix — the one file the 006 drift audit
-- missed because it was in DEFAULT_SKIP and its header was never
-- validated against a real CMS file.
--
-- Audited the actual CMS pharmacy-network headers:
--   • 2027 monthly  (2027_20261008.zip):   19 columns
--   • 2026 quarterly (SPUF .../PPUF_2026Q1): 20 columns
--
-- Migration 004 defined cms_spuf_pharmacy_network with 16 data columns
-- (through generic_dispensing_fee_90). Both real files carry three more
-- trailing columns the landing table lacks:
--   SELECTED_DISPENSING_FEE_30 / _60 / _90
-- (the dispensing fee for the "Selected" pharmacy tier, parallel to the
-- brand/generic fees; added by CMS in 2025+).
--
-- The 2026 quarterly file ALSO carries a FLOOR_PRICE column between
-- IN_AREA_FLAG and BRAND_DISPENSING_FEE_30. The TS spec is currently
-- pinned to the 2027 monthly layout (no FLOOR_PRICE), which is what we
-- are loading (release 16). floor_price is added here too so a future
-- 2026-style quarterly load only needs the TS spec change, not another
-- migration. It stays NULL for 2027 rows.
--
-- Only ADDs columns — no DROP — safe to re-run (IF NOT EXISTS).
-- Run in the Supabase SQL editor — the service-role JWT can't do DDL
-- via PostgREST.
-- ═══════════════════════════════════════════════════════════════════

-- numeric(12,4) matches the brand/generic dispensing-fee columns after
-- migration 009's defensive widening.
ALTER TABLE cms_spuf_pharmacy_network
  ADD COLUMN IF NOT EXISTS selected_dispensing_fee_30 numeric(12,4),
  ADD COLUMN IF NOT EXISTS selected_dispensing_fee_60 numeric(12,4),
  ADD COLUMN IF NOT EXISTS selected_dispensing_fee_90 numeric(12,4),
  -- Present only in 2026-style quarterly files (20-col layout); NULL for
  -- the 2027 monthly layout the TS spec is currently pinned to.
  ADD COLUMN IF NOT EXISTS floor_price numeric(12,4);

-- ═══ VERIFICATION ═══════════════════════════════════════════════════
-- Expect brand/generic/selected dispensing fee columns + floor_price.
SELECT column_name, data_type, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_name = 'cms_spuf_pharmacy_network'
  AND column_name LIKE '%dispensing_fee%' OR column_name = 'floor_price'
ORDER BY ordinal_position;
