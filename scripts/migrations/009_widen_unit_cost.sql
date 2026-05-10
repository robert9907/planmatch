-- 009_widen_unit_cost.sql
--
-- pricing.unit_cost was declared numeric(8,4) (max 9999.9999) based on
-- the 2024 CMS record layout. Real 2026 data exceeds that for specialty
-- drugs — some unit costs run into the tens of thousands per dose.
-- Widening to numeric(12,4) (max 99,999,999.9999) leaves headroom while
-- keeping 4 decimal places for sub-cent precision.
--
-- Same change for the dispensing-fee columns on pharmacy_network in
-- case those are similarly capped — defensive widening since pharmacy
-- import is opt-in and untested.
--
-- Run in the Supabase SQL editor — service-role JWT can't do DDL via
-- PostgREST. Idempotent.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE cms_spuf_pricing
  ALTER COLUMN unit_cost TYPE numeric(12,4);

ALTER TABLE pm_pricing_v2
  ALTER COLUMN unit_cost TYPE numeric(12,4);

-- Pharmacy network dispensing fees (defensive — pharmacy_networks is
-- skipped by default but if a future run loads it, don't repeat this.)
ALTER TABLE cms_spuf_pharmacy_network
  ALTER COLUMN brand_dispensing_fee_30   TYPE numeric(12,4),
  ALTER COLUMN brand_dispensing_fee_60   TYPE numeric(12,4),
  ALTER COLUMN brand_dispensing_fee_90   TYPE numeric(12,4),
  ALTER COLUMN generic_dispensing_fee_30 TYPE numeric(12,4),
  ALTER COLUMN generic_dispensing_fee_60 TYPE numeric(12,4),
  ALTER COLUMN generic_dispensing_fee_90 TYPE numeric(12,4);

-- ═══ VERIFICATION ═══════════════════════════════════════════════════

SELECT table_name, column_name, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE (table_name = 'cms_spuf_pricing' AND column_name = 'unit_cost')
   OR (table_name = 'pm_pricing_v2' AND column_name = 'unit_cost')
   OR (table_name = 'cms_spuf_pharmacy_network' AND column_name LIKE '%_dispensing_fee_%')
ORDER BY table_name, column_name;
