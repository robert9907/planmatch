-- 017_pm_formulary_v2_drug_type.sql
--
-- Adds drug_type classification + imported_at freshness column to
-- pm_formulary_v2, and re-exposes both through the pm_formulary
-- compatibility view.
--
-- drug_type is a 3-value enum ('generic' | 'brand' | 'specialty') the
-- Compare view and LIS-cap math need to distinguish which per-drug LIS
-- copay cap applies (2026: generic $1.60/$5.10, brand $4.90/$12.65,
-- specialty tracks Part D OOP). NULL is allowed so promote / backfill
-- can leave rows unclassified when RxNorm TTY isn't yet cached in
-- pm_rxcui_meta.
--
-- Source of truth for populating drug_type at promote time:
--   specialty  ← cms_spuf_beneficiary_cost.tier_specialty_yn = 'Y'
--                (already fed into pm_beneficiary_cost_v2.tier_specialty)
--   generic    ← pm_rxcui_meta.tty IN (SCD/SCDC/SCDG/SCDF/GPCK)
--   brand      ← pm_rxcui_meta.tty IN (SBD/SBDC/SBDG/SBDF/BPCK/BN)
--   NULL       ← rxcui not yet enriched by RxNav (backfill later)
--
-- CMS SPUF has no tier-name column — the earlier "read
-- tier_level_description" plan was wrong. Preferred-vs-non-preferred
-- brand distinction requires a separate Medicare.gov Plan Compare
-- scrape and lands in a follow-on migration.
--
-- imported_at is fast-defaulted at ALTER time (all existing rows share
-- the migration-application timestamp — before this we didn't track
-- per-row freshness). Promote / INSERT paths get their own now() per
-- row going forward.
--
-- Idempotent: IF NOT EXISTS on the ADD COLUMNs, named CHECK constraint,
-- CREATE OR REPLACE for the view.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE pm_formulary_v2
  ADD COLUMN IF NOT EXISTS drug_type text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pm_formulary_v2_drug_type_chk'
  ) THEN
    ALTER TABLE pm_formulary_v2
      ADD CONSTRAINT pm_formulary_v2_drug_type_chk
      CHECK (drug_type IS NULL OR drug_type IN ('generic','brand','specialty'));
  END IF;
END $$;

ALTER TABLE pm_formulary_v2
  ADD COLUMN IF NOT EXISTS imported_at timestamptz NOT NULL DEFAULT now();

-- Compatibility view — append drug_type and imported_at at the end so
-- existing SELECT * callers still see the same leading columns. Keeps
-- the migration-005 view definition byte-for-byte and just tacks on the
-- two new fields.

CREATE OR REPLACE VIEW pm_formulary AS
SELECT
  f.contract_id,
  f.plan_id,
  f.rxcui,
  m.drug_name,
  f.tier,
  f.copay_default       AS copay,
  f.coinsurance_default AS coinsurance,
  f.prior_auth,
  f.step_therapy,
  f.quantity_limit,
  f.quantity_limit_amount,
  f.quantity_limit_days,
  f.segment_id,
  f.plan_year,
  f.formulary_id,
  f.excluded_drug_supplemental,
  f.indication_restricted,
  f.drug_type,
  f.imported_at
FROM pm_formulary_v2 f
LEFT JOIN pm_rxcui_meta m USING (rxcui);

-- ═══ VERIFICATION ═══════════════════════════════════════════════════

-- 1) New columns present with correct types
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'pm_formulary_v2'
  AND column_name IN ('drug_type','imported_at')
ORDER BY column_name;

-- 2) CHECK constraint attached
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conname = 'pm_formulary_v2_drug_type_chk';

-- 3) View exposes the new columns
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pm_formulary'
  AND column_name IN ('drug_type','imported_at')
ORDER BY column_name;

-- 4) Pre-populate distribution (all NULL right after migration, non-NULL
--    after the next promote or backfill run)
SELECT COALESCE(drug_type, '(null)') AS drug_type, COUNT(*) AS rows
FROM pm_formulary_v2
GROUP BY drug_type
ORDER BY rows DESC;
