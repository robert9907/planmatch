-- 018_pm_formulary_tier_label.sql
--
-- Adds tier_label to pm_formulary_v2 + re-exposes it through the
-- pm_formulary compatibility view.
--
-- CMS-published per-plan tier name — "Preferred Generic",
-- "Non-Preferred Brand", "Specialty", etc. Populated by the SPUF
-- promote path from cms_spuf_beneficiary_cost.tier_level_description
-- (or equivalent per-tier label column) at import time. NULL is
-- allowed so pre-backfill rows and rows on plans that haven't been
-- re-promoted since this migration keep working.
--
-- Why this exists: api/_lib/formulary-core.ts was shipped with
-- tier_label in FORMULARY_COLS ahead of any schema change; every
-- POST /api/formulary returned PostgREST 42703 (column doesn't exist),
-- blanking the entire meds screen. Commit 2bd54fa dropped the column
-- from the SELECT to unblock prod; this migration lands the schema so
-- the follow-up can put it back.
--
-- Idempotent: IF NOT EXISTS on the ADD COLUMN, CREATE OR REPLACE on
-- the view. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE pm_formulary_v2
  ADD COLUMN IF NOT EXISTS tier_label text;

-- Compatibility view — CREATE OR REPLACE VIEW cannot reorder or rename
-- existing columns, so tier_label is appended AFTER imported_at (the
-- current last column from migration 017). Preserves the leading
-- column order for SELECT * callers.
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
  f.imported_at,
  f.tier_label
FROM pm_formulary_v2 f
LEFT JOIN pm_rxcui_meta m USING (rxcui);

-- ═══ VERIFICATION ═══════════════════════════════════════════════════

-- 1) tier_label present on the base table
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'pm_formulary_v2'
  AND column_name = 'tier_label';

-- 2) tier_label present on the view
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'pm_formulary'
  AND column_name = 'tier_label';

-- 3) Selectable end-to-end (should return 5 rows, tier_label NULL
--    until the SPUF promote path backfills it).
SELECT contract_id, plan_id, rxcui, tier, tier_label
FROM pm_formulary
LIMIT 5;
