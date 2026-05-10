-- 006_cms_spuf_drift_fixes.sql
--
-- Drift fixes after auditing the actual CMS SPUF 2026 Q1 release headers
-- against migration 004 specs. The CMS files differ from the 2024 record
-- layout the importer was originally written against:
--
--   • plan_information:        ICL removed (post-IRA — coverage gap eliminated)
--   • basic_drugs:             SELECTED_DRUG_YN added at end
--   • beneficiary_cost:        GAP_COV_TIER removed (post-IRA)
--   • excluded_drugs:          GAP_COV removed (post-IRA)
--   • insulin_beneficiary_cost: 4 coinsurance fields added alongside copay
--
-- The TS spec is updated to MATCH the actual file layout. Columns no
-- longer in CMS files (icl, gap_cov_tier, gap_cov) stay in the landing
-- tables but receive NULL on every row going forward — they're left in
-- place for historical-data compatibility (older years still have ICL).
--
-- This migration only ADDs columns — no DROP — so it's safe to re-run
-- and easy to roll back.
--
-- Run in the Supabase SQL editor — service-role JWT can't do DDL via
-- PostgREST. Safe to re-run (IF NOT EXISTS).
-- ═══════════════════════════════════════════════════════════════════

-- basic_drugs: SELECTED_DRUG_YN flag (CMS doesn't document; preserve verbatim)
ALTER TABLE cms_spuf_basic_drugs
  ADD COLUMN IF NOT EXISTS selected_drug_yn text;

-- insulin_beneficiary_cost: coinsurance amounts alongside copay amounts.
-- Per-pharmacy-type, parallels the existing copay_amt_*_insln columns.
ALTER TABLE cms_spuf_insulin_beneficiary_cost
  ADD COLUMN IF NOT EXISTS coin_amt_pref_insln          numeric(12,4),
  ADD COLUMN IF NOT EXISTS coin_amt_nonpref_insln       numeric(12,4),
  ADD COLUMN IF NOT EXISTS coin_amt_mail_pref_insln     numeric(12,4),
  ADD COLUMN IF NOT EXISTS coin_amt_mail_nonpref_insln  numeric(12,4);

-- ═══ VERIFICATION ═══════════════════════════════════════════════════

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'cms_spuf_basic_drugs'
  AND column_name = 'selected_drug_yn';

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'cms_spuf_insulin_beneficiary_cost'
  AND column_name LIKE 'coin_amt_%'
ORDER BY ordinal_position;
