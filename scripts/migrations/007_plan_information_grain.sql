-- 007_plan_information_grain.sql
--
-- The CMS plan_information.txt file is denormalized at (plan × county)
-- grain — every row is a unique (contract, plan, segment, county_code)
-- tuple, with plan-level attributes (premium, deductible, formulary_id,
-- etc.) repeated for every county the plan serves. The 2026 Q1 release
-- has 112,638 rows but only 5,529 unique (contract, plan, segment)
-- triples (~20× repetition for H-contract plans across counties).
--
-- The original PK in migration 004 was on (release_id, contract_id,
-- plan_id, segment_id) — wrong; collides on every county-duplicate.
-- Switch to a synthetic id PK and add secondary indexes for the joins
-- the promote SQL does. The promote step itself uses DISTINCT to
-- collapse county-duplicates before joining (see promote.ts).
--
-- Run in the Supabase SQL editor — service-role JWT can't do DDL via
-- PostgREST. Safe to re-run (IF NOT EXISTS / IF EXISTS guards).
-- ═══════════════════════════════════════════════════════════════════

-- Drop the old PK if it's still on the natural key.
ALTER TABLE cms_spuf_plan_information
  DROP CONSTRAINT IF EXISTS cms_spuf_plan_information_pkey;

-- Add the synthetic id (matches the pattern used by pharmacy_network
-- and insulin_beneficiary_cost which already have nullable natural-key
-- columns).
ALTER TABLE cms_spuf_plan_information
  ADD COLUMN IF NOT EXISTS id bigint GENERATED ALWAYS AS IDENTITY;

-- Re-add the PK on id.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cms_spuf_plan_information_pkey'
  ) THEN
    ALTER TABLE cms_spuf_plan_information
      ADD CONSTRAINT cms_spuf_plan_information_pkey PRIMARY KEY (id);
  END IF;
END $$;

-- Plan-level lookup index — used by the promote SQL JOIN to
-- beneficiary_cost / pharmacy_network etc. on (contract, plan, segment).
CREATE INDEX IF NOT EXISTS idx_cms_spuf_plan_information_plan
  ON cms_spuf_plan_information (release_id, contract_id, plan_id, segment_id);

-- (idx_cms_spuf_plan_information_formulary on (release_id, formulary_id)
-- already exists from migration 004; keep it.)

-- ═══ VERIFICATION ═══════════════════════════════════════════════════

SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'cms_spuf_plan_information'::regclass
ORDER BY conname;

SELECT indexname, indexdef FROM pg_indexes
WHERE tablename = 'cms_spuf_plan_information'
ORDER BY indexname;
