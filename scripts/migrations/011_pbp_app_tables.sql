-- 011_pbp_app_tables.sql
--
-- App-facing tables derived from the PBP landing layer. One row set
-- per active release per plan year — the importer swaps these in a
-- single transaction at promotion time, mirroring the SPUF
-- pm_*_v2 swap in migration 005's promote() flow.
--
-- Three new tables:
--
--   pbp_plan_facts_v2    one row per plan: premium, MOOP variants,
--                        deductibles, plan-type, SNP-type, carrier.
--                        Wide schema. Replaces the per-plan financial
--                        fields the consumer's hooks currently fan out
--                        across pm_plans + Medicare.gov scrape.
--
--   pbp_benefits_v2      one row per (plan, benefit_type, tier_id):
--                        cost-share for every per-service benefit the
--                        consumer surfaces (PCP, specialist, emergency,
--                        urgent care, lab, diagnostic, telehealth, MH,
--                        PT, dental, vision, hearing, ambulance, etc.).
--                        Long schema. Replaces the carrier-specific
--                        per-benefit rows the legacy pbp_benefits table
--                        was getting from Medicare.gov scraping +
--                        SB-OCR + manual entry + the now-defunct
--                        import-pbp-extras.mjs script.
--
--   pbp_planarea_v2      county × plan service area. Replaces the
--                        ZIP→plan availability lookup that pm_zip_county
--                        currently joins through pm_plans.
--
-- The legacy pbp_benefits table is renamed pbp_benefits_legacy and
-- replaced by a VIEW that UNIONs pbp_benefits_v2 with carrier-side
-- legacy rows (medicare_gov, sb_ocr, manual). pbp_federal rows from
-- the retired import-pbp-extras path stay in the legacy table for
-- audit but are filtered OUT of the view — once cms_pbp lands, those
-- become superseded.
--
-- Compatibility view exposes the legacy column shape (combined plan_id
-- "H1234-005" string, no segment_id/plan_year visible) so api/
-- plans-with-extras.ts and api/plan-benefits.ts keep working without
-- code changes during cutover.
--
-- Source priority chain that the merge API enforces:
--   medicare_gov > cms_pbp > sb_ocr > manual > pbp_federal
-- Add 'cms_pbp' between 'medicare_gov' and 'sb_ocr' in the consumer's
-- PRIORITY array (api/plans-with-extras.ts) — one-line follow-up
-- commit after this migration applies.
--
-- Run in the Supabase SQL editor — service-role JWT can't do DDL via
-- PostgREST. Order matters: depends on migration 010.
-- ═══════════════════════════════════════════════════════════════════

-- ─── pbp_plan_facts_v2 ────────────────────────────────────────────────
--
-- Wide. One row per (contract, plan, segment, plan_year). Built from
-- pbp_section_a (carrier/plan name) + pbp_section_d (financials).

CREATE TABLE IF NOT EXISTS pbp_plan_facts_v2 (
  contract_id        text NOT NULL,
  plan_id            text NOT NULL,
  segment_id         text NOT NULL,
  plan_year          smallint NOT NULL,

  -- Premiums
  premium_part_c        numeric(10,2),                -- pbp_d_mplusc_premium
  premium_b_only        numeric(10,2),                -- pbp_d_mplusc_bonly_premium
  part_b_giveback       numeric(10,2),                -- pbp_d_mco_pay_reduct_amt

  -- MOOP variants — CMS allows four cost-sharing structures.
  -- Most plans set one of these and leave the others null.
  moop_in_network       numeric(12,2),                -- pbp_d_out_pocket_amt
  moop_combined         numeric(12,2),                -- pbp_d_comb_max_enr_amt (PPO in+out combined)
  moop_oon              numeric(12,2),                -- pbp_d_oon_max_enr_oopc_amt (PPO oon-only)
  moop_non_network      numeric(12,2),                -- pbp_d_maxenr_oopc_amt (PFFS)

  -- Deductibles
  annual_deductible     numeric(10,2),                -- pbp_d_ann_deduct_amt
  rx_deductible         numeric(10,2),                -- service-category-specific Rx deductible

  -- Plan attributes (Section A)
  plan_type             text,                         -- HMO/PPO/HMO-POS/PFFS/MSA/etc.
  snp_type              text,                         -- 'C-SNP' / 'D-SNP' / 'I-SNP' / NULL
  ben_cov               text,                         -- '1' = A+B, '2' = B-only
  contract_name         text,
  plan_name             text,

  release_id            bigint NOT NULL REFERENCES pbp_releases(release_id),
  PRIMARY KEY (contract_id, plan_id, segment_id, plan_year)
);

CREATE INDEX IF NOT EXISTS idx_pbp_plan_facts_v2_release
  ON pbp_plan_facts_v2 (release_id);
CREATE INDEX IF NOT EXISTS idx_pbp_plan_facts_v2_plan
  ON pbp_plan_facts_v2 (contract_id, plan_id);

-- ─── pbp_benefits_v2 ──────────────────────────────────────────────────
--
-- Long. One row per (plan, benefit_type, tier_id). The benefit_type
-- vocabulary matches what api/plans-with-extras.ts and the consumer's
-- brain rely on today (primary_care, specialist, emergency, lab,
-- diagnostic_radiology, telehealth, mental_health_individual, etc.).
--
-- tier_id captures dimensions specific to certain benefits:
--   inpatient: 'int1_t1' / 'int2_t1' / 'lrd' / 'ad' (interval × tier)
--   ambulance: 'ground' / 'air'
--   dental:    'preventive' / 'comprehensive'
--   vision:    'exam' / 'eyewear'
--   hearing:   'exam' / 'aid' / 'aid_otc'
--   rx_tier:   '1'..'6' (Part D tier — fed from MRX file in v2.x)
--   most others: NULL (single-row benefit per plan)
--
-- Synthetic id PK + UNIQUE INDEX with COALESCE(tier_id, '') so the
-- importer can use ON CONFLICT (...) DO UPDATE for idempotent writes.

CREATE TABLE IF NOT EXISTS pbp_benefits_v2 (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contract_id              text NOT NULL,
  plan_id                  text NOT NULL,
  segment_id               text NOT NULL,
  plan_year                smallint NOT NULL,
  benefit_type             text NOT NULL,
  tier_id                  text,                       -- nullable (see above)

  -- Standard cost-share. coinsurance is percent (25.0 = 25%) to match
  -- pm_plan_benefits convention. The legacy pbp_benefits table stored
  -- it the same way.
  copay                    numeric(10,2),
  copay_max                numeric(10,2),
  coinsurance              numeric(6,3),
  coinsurance_max          numeric(6,3),

  -- Channel variants — preserved from legacy schema.
  copay_mail_order         numeric(10,2),
  coinsurance_mail_order   numeric(6,3),
  copay_preferred          numeric(10,2),
  coinsurance_preferred    numeric(6,3),

  -- Allowance / cap fields. coverage_amount = annual allowance
  -- (dental annual max, hearing aid allowance, eyewear allowance, OTC
  -- quarterly allowance, food card monthly allowance). max_coverage
  -- = service-level cap when distinct from coverage_amount.
  coverage_amount          numeric(12,2),
  max_coverage             numeric(12,2),

  -- Auth / referral flags from PBP. Most plans require neither for
  -- standard benefits; specialty (e.g. PT, MH) often require both.
  prior_auth               boolean,
  referral_required        boolean,

  -- Free-form description. Importer fills with a human-readable
  -- summary derived from CMS code values + raw amounts.
  description              text,

  -- Provenance. v1 only inserts cms_pbp; the column accepts the full
  -- chain so future writers (carrier overrides, etc.) can use v2 too.
  source                   text NOT NULL DEFAULT 'cms_pbp'
                            CHECK (source IN ('cms_pbp','medicare_gov','sb_ocr','manual','pbp_federal')),
  release_id               bigint REFERENCES pbp_releases(release_id),

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Natural-key uniqueness with nullable tier_id via COALESCE.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pbp_benefits_v2_natural
  ON pbp_benefits_v2 (
    contract_id, plan_id, segment_id, plan_year, benefit_type,
    COALESCE(tier_id, '')
  );

CREATE INDEX IF NOT EXISTS idx_pbp_benefits_v2_plan
  ON pbp_benefits_v2 (contract_id, plan_id);
CREATE INDEX IF NOT EXISTS idx_pbp_benefits_v2_benefit_type
  ON pbp_benefits_v2 (benefit_type);
CREATE INDEX IF NOT EXISTS idx_pbp_benefits_v2_release
  ON pbp_benefits_v2 (release_id);
CREATE INDEX IF NOT EXISTS idx_pbp_benefits_v2_source
  ON pbp_benefits_v2 (source);

-- Touch-trigger to keep updated_at fresh on UPSERTs.
CREATE OR REPLACE FUNCTION pbp_benefits_v2_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pbp_benefits_v2_updated_at ON pbp_benefits_v2;
CREATE TRIGGER trg_pbp_benefits_v2_updated_at
  BEFORE UPDATE ON pbp_benefits_v2
  FOR EACH ROW EXECUTE FUNCTION pbp_benefits_v2_touch_updated_at();

-- ─── pbp_planarea_v2 ──────────────────────────────────────────────────
--
-- County × plan service area. The PlanArea.txt file in the PBP ZIP
-- is the authoritative source for "is plan X available in county Y"
-- — joined through pm_zip_county.county_fips → SSA county_code, this
-- replaces the consumer's current pm_plans-only county filtering.

CREATE TABLE IF NOT EXISTS pbp_planarea_v2 (
  contract_id        text NOT NULL,
  plan_id            text NOT NULL,
  segment_id         text NOT NULL,
  plan_year          smallint NOT NULL,
  county_code        text NOT NULL,                   -- 5-char SSA, NOT FIPS — join through pm_zip_county
  county_name        text,
  state              text NOT NULL,                   -- 2-char USPS
  ben_cov            text,                            -- A+B vs B-only flag from PlanArea
  release_id         bigint NOT NULL REFERENCES pbp_releases(release_id),
  PRIMARY KEY (contract_id, plan_id, segment_id, plan_year, county_code)
);

CREATE INDEX IF NOT EXISTS idx_pbp_planarea_v2_county
  ON pbp_planarea_v2 (state, county_name);
CREATE INDEX IF NOT EXISTS idx_pbp_planarea_v2_release
  ON pbp_planarea_v2 (release_id);

-- ─── Legacy table rename + compatibility view ─────────────────────────
--
-- The existing pbp_benefits table (133,683 rows from medicare_gov
-- scrape + sb_ocr + manual + pbp_federal) is renamed so a view can
-- take its place. The view exposes the legacy column shape:
--   plan_id  → "H1234-005" combined string (NOT split contract_id +
--              plan_id, since api/plans-with-extras.ts reads it that
--              way)
--   no segment_id, no plan_year   (legacy table doesn't carry them)
--   source   → original source value
--
-- v2 rows project: contract_id || '-' || plan_id AS plan_id; legacy
-- rows pass through unchanged. UNION ALL — the merge API at the
-- application layer enforces the priority chain (medicare_gov >
-- cms_pbp > sb_ocr > manual > pbp_federal) per (plan_id,
-- benefit_type, tier_id) tuple.
--
-- pbp_federal rows (the retired import-pbp-extras source) stay in
-- the legacy table for audit but are filtered OUT of the view — once
-- cms_pbp coverage lands, they're superseded. The merge API's
-- PRIORITY array can be left as-is; the view simply hides them.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'pbp_benefits'
      AND table_type = 'BASE TABLE'
  ) THEN
    EXECUTE 'ALTER TABLE pbp_benefits RENAME TO pbp_benefits_legacy';
  END IF;
END $$;

CREATE OR REPLACE VIEW pbp_benefits AS
-- v2 rows (cms_pbp source) projected to legacy column shape
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
FROM pbp_benefits_v2
UNION ALL
-- Carrier-side legacy rows; pbp_federal filtered out
SELECT
  plan_id,
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
FROM pbp_benefits_legacy
WHERE source IN ('medicare_gov','sb_ocr','manual');

COMMENT ON VIEW pbp_benefits IS
  'Compatibility view over pbp_benefits_v2 (cms_pbp source) UNION pbp_benefits_legacy (carrier-side rows). pbp_federal source is filtered out — superseded by cms_pbp. Drop pbp_benefits_legacy after parity confirmed across all consumers (api/plans-with-extras.ts, api/plans.ts, api/plan-benefits.ts).';

-- ═══ VERIFICATION ═══════════════════════════════════════════════════

-- 1) All v2 tables present
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'pbp_plan_facts_v2',
    'pbp_benefits_v2',
    'pbp_planarea_v2'
  )
ORDER BY table_name;

-- 2) pbp_benefits is now a view, pbp_benefits_legacy is the renamed table
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name LIKE 'pbp_benefits%'
ORDER BY table_name;

-- 3) View column shape — should match legacy column set
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pbp_benefits'
ORDER BY ordinal_position;

-- 4) Legacy row counts by source
SELECT source, COUNT(*) AS n
FROM pbp_benefits_legacy
GROUP BY source
ORDER BY source;

-- 5) Initial state — v2 tables empty until first PBP import promotes
SELECT
  (SELECT COUNT(*) FROM pbp_plan_facts_v2)        AS plan_facts_v2,
  (SELECT COUNT(*) FROM pbp_benefits_v2)          AS benefits_v2,
  (SELECT COUNT(*) FROM pbp_planarea_v2)          AS planarea_v2,
  (SELECT COUNT(*) FROM pbp_benefits_legacy)      AS legacy_rows,
  (SELECT COUNT(*) FROM pbp_benefits)             AS view_rows;
