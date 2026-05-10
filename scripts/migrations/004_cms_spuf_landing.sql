-- 004_cms_spuf_landing.sql
--
-- CMS Quarterly Prescription Drug Plan Formulary, Pharmacy Network &
-- Pricing Public Use File (SPUF) — landing tables.
--
-- These tables mirror CMS source files faithfully — column names, order,
-- and types follow the SPUF Record Layout (CMS, 2024 ed., reused for
-- 2025+ releases). Every row carries a release_id pointing to
-- cms_spuf_releases; multiple releases coexist so we can diff, roll
-- back, and re-derive the app-facing pm_*_v2 tables (migration 005)
-- without re-downloading the 2.5 GB ZIP.
--
-- Source layer flow:
--   1. importer downloads ZIP, computes sha256, INSERTs cms_spuf_releases
--   2. parses each .txt and bulk-loads the matching landing table here
--   3. once all 9 files are loaded, migration 005's app tables are
--      rebuilt from this release's landing rows in a single transaction
--
-- Run in the Supabase SQL Editor — service-role JWT can't do DDL via
-- PostgREST. Safe to re-run (IF NOT EXISTS everywhere).
-- ═══════════════════════════════════════════════════════════════════

-- ─── Release ledger ───────────────────────────────────────────────────
--
-- One row per imported ZIP. zip_sha256 is the idempotency key — the
-- importer aborts if the SHA already exists unless --force is passed.
-- The partial unique index "one active per plan year" makes the
-- exactly-one-promoted-release invariant database-enforced; readers can
-- safely query pm_*_v2 without filtering on release_id because the swap
-- in migration 005 leaves only one active release per year.

CREATE TABLE IF NOT EXISTS cms_spuf_releases (
  release_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_year      smallint NOT NULL,
  release_kind   text NOT NULL CHECK (release_kind IN ('quarterly','monthly')),
  release_date   date NOT NULL,                       -- e.g. 2026-04-08 from filename
  source_url     text NOT NULL,
  zip_sha256     char(64) NOT NULL UNIQUE,
  zip_bytes      bigint NOT NULL,
  downloaded_at  timestamptz NOT NULL DEFAULT now(),
  imported_at    timestamptz,                         -- set when all landing rows loaded
  promoted_at    timestamptz,                         -- set when app tables swapped to this release
  status         text NOT NULL DEFAULT 'downloaded'
                  CHECK (status IN ('downloaded','loading','loaded','active','superseded','failed')),
  row_counts     jsonb,                               -- {plan_information: 7234, basic_drugs: 14M, …}
  error          text,
  notes          text
);

-- Exactly one active release per plan year — enforced by partial index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cms_spuf_releases_one_active
  ON cms_spuf_releases (plan_year)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_cms_spuf_releases_year_status
  ON cms_spuf_releases (plan_year, status);

-- ─── A. plan_information ──────────────────────────────────────────────
-- Plan → formulary mapping. ~5k–8k rows per release.
-- Suppressed plans (plan_suppressed_yn='Y') have no rows in any other file.

CREATE TABLE IF NOT EXISTS cms_spuf_plan_information (
  release_id          bigint NOT NULL REFERENCES cms_spuf_releases(release_id) ON DELETE CASCADE,
  contract_id         text NOT NULL,                  -- char(5)
  plan_id             text NOT NULL,                  -- char(3)
  segment_id          text NOT NULL,                  -- char(3); '000' for R/S contracts
  contract_name       text,
  plan_name           text,
  formulary_id        text NOT NULL,                  -- char(8); FK into basic_drugs
  premium             numeric(12,2),
  deductible          numeric(12,2),
  icl                 numeric(12,2),                  -- annual initial coverage limit
  ma_region_code      text,                           -- populated only for R contracts
  pdp_region_code     text,                           -- populated only for S contracts
  state               text,                           -- USPS; populated only for H contracts
  county_code         text,                           -- char(5) SSA code, NOT FIPS
  snp                 text NOT NULL,                  -- 0=not SNP, 1=C-SNP, 2=D-SNP, 3=I-SNP
  plan_suppressed_yn  text NOT NULL,
  PRIMARY KEY (release_id, contract_id, plan_id, segment_id)
);

CREATE INDEX IF NOT EXISTS idx_cms_spuf_plan_information_formulary
  ON cms_spuf_plan_information (release_id, formulary_id);

-- ─── B. basic_drugs_formulary_file ────────────────────────────────────
-- The big formulary table. ~10–20M rows per release.

CREATE TABLE IF NOT EXISTS cms_spuf_basic_drugs (
  release_id              bigint NOT NULL REFERENCES cms_spuf_releases(release_id) ON DELETE CASCADE,
  formulary_id            text NOT NULL,
  formulary_version       text NOT NULL,
  contract_year           text NOT NULL,
  rxcui                   text NOT NULL,
  ndc                     text NOT NULL,              -- char(11) proxy NDC
  tier_level_value        smallint NOT NULL,          -- 1–6 typically
  quantity_limit_yn       text NOT NULL,              -- Y/N in this file (0/1 in excluded_drugs)
  quantity_limit_amount   text,                       -- CMS ships as text — preserve verbatim
  quantity_limit_days     text,                       -- CMS ships as text
  prior_authorization_yn  text NOT NULL,              -- full word here; abbreviated in excluded_drugs
  step_therapy_yn         text NOT NULL,
  PRIMARY KEY (release_id, formulary_id, formulary_version, contract_year, rxcui, ndc)
);

CREATE INDEX IF NOT EXISTS idx_cms_spuf_basic_drugs_rxcui
  ON cms_spuf_basic_drugs (release_id, rxcui);
CREATE INDEX IF NOT EXISTS idx_cms_spuf_basic_drugs_formulary_rxcui
  ON cms_spuf_basic_drugs (release_id, formulary_id, rxcui);

-- ─── C. beneficiary_cost ──────────────────────────────────────────────
-- Cost-sharing matrix. Wide CMS shape: one row carries all four pharmacy
-- types via column suffixes (_PREF, _NONPREF, _MAIL_PREF, _MAIL_NONPREF).
-- COST_MIN_AMT_* are CHAR(12) text in CMS — preserved as text here, cast
-- on the way into pm_beneficiary_cost_v2. ~150k–500k rows per release.

CREATE TABLE IF NOT EXISTS cms_spuf_beneficiary_cost (
  release_id                  bigint NOT NULL REFERENCES cms_spuf_releases(release_id) ON DELETE CASCADE,
  contract_id                 text NOT NULL,
  plan_id                     text NOT NULL,
  segment_id                  text NOT NULL,
  coverage_level              smallint NOT NULL,      -- 0=ded, 1=initial, 2=gap (pre-2025), 3=catastrophic
  tier                        smallint NOT NULL,
  days_supply                 smallint NOT NULL,      -- 1=30, 2=90, 3=other, 4=60
  cost_type_pref              smallint NOT NULL,      -- 0=n/a, 1=copay, 2=coinsurance
  cost_amt_pref               numeric(12,2),          -- $ if copay; fraction (0.25=25%) if coinsurance
  cost_min_amt_pref           text,                   -- CMS ships as char(12) text
  cost_max_amt_pref           numeric(12,2),
  cost_type_nonpref           smallint NOT NULL,
  cost_amt_nonpref            numeric(12,2),
  cost_min_amt_nonpref        text,
  cost_max_amt_nonpref        numeric(12,2),
  cost_type_mail_pref         smallint NOT NULL,
  cost_amt_mail_pref          numeric(12,2),
  cost_min_amt_mail_pref      text,
  cost_max_amt_mail_pref      numeric(12,2),
  cost_type_mail_nonpref      smallint NOT NULL,
  cost_amt_mail_nonpref       numeric(12,2),
  cost_min_amt_mail_nonpref   text,
  cost_max_amt_mail_nonpref   numeric(12,2),
  tier_specialty_yn           text NOT NULL,
  ded_applies_yn              text NOT NULL,
  gap_cov_tier                text,                   -- 1=full / 2=partial / 3=none; meaningless 2025+
  PRIMARY KEY (release_id, contract_id, plan_id, segment_id, coverage_level, tier, days_supply)
);

-- ─── D. pharmacy_network ──────────────────────────────────────────────
-- NPI-level pharmacy roster. ~30–80M rows per release (typically the
-- largest file after basic_drugs).
--
-- pharmacy_zipcode is nullable per CMS spec, so the natural key includes
-- it via COALESCE in a unique index rather than the PK. The synthetic id
-- is the actual PK to keep delete-on-release simple.

CREATE TABLE IF NOT EXISTS cms_spuf_pharmacy_network (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  release_id                bigint NOT NULL REFERENCES cms_spuf_releases(release_id) ON DELETE CASCADE,
  contract_id               text NOT NULL,
  plan_id                   text NOT NULL,
  segment_id                text NOT NULL,
  pharmacy_number           text NOT NULL,            -- char(12); bare NPI = right(pharmacy_number,10)
  pharmacy_zipcode          text,                     -- char(5); nullable per CMS
  preferred_status_retail   text NOT NULL,
  preferred_status_mail     text NOT NULL,
  pharmacy_retail           text NOT NULL,
  pharmacy_mail             text NOT NULL,
  in_area_flag              smallint NOT NULL,
  brand_dispensing_fee_30   numeric(8,4),
  brand_dispensing_fee_60   numeric(8,4),
  brand_dispensing_fee_90   numeric(8,4),
  generic_dispensing_fee_30 numeric(8,4),
  generic_dispensing_fee_60 numeric(8,4),
  generic_dispensing_fee_90 numeric(8,4)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cms_spuf_pharmacy_network_natural
  ON cms_spuf_pharmacy_network (
    release_id, contract_id, plan_id, segment_id,
    pharmacy_number, COALESCE(pharmacy_zipcode, '')
  );
CREATE INDEX IF NOT EXISTS idx_cms_spuf_pharmacy_network_release_plan
  ON cms_spuf_pharmacy_network (release_id, contract_id, plan_id, segment_id);
CREATE INDEX IF NOT EXISTS idx_cms_spuf_pharmacy_network_npi
  ON cms_spuf_pharmacy_network (release_id, (right(pharmacy_number, 10)));

-- ─── E. excluded_drugs_formulary_file ─────────────────────────────────
-- Drugs excluded from Part D that an enhanced-alternative plan covers as
-- supplemental benefit. Grain: (contract_id, plan_id) — NO segment_id,
-- NO formulary_id. Field name PRIOR_AUTH_YN (abbreviated, unlike the
-- basic file).

CREATE TABLE IF NOT EXISTS cms_spuf_excluded_drugs (
  release_id              bigint NOT NULL REFERENCES cms_spuf_releases(release_id) ON DELETE CASCADE,
  contract_id             text NOT NULL,
  plan_id                 text NOT NULL,
  rxcui                   text NOT NULL,
  tier                    smallint NOT NULL,
  quantity_limit_yn       text NOT NULL,              -- '0'/'1' per spec (vs Y/N in basic)
  quantity_limit_amount   text,                       -- char(8) here vs char(7) in basic
  quantity_limit_days     text,
  prior_auth_yn           text NOT NULL,              -- abbreviated name vs basic
  step_therapy_yn         text NOT NULL,
  capped_benefit_yn       text NOT NULL,
  gap_cov                 text NOT NULL,              -- meaningless 2025+
  PRIMARY KEY (release_id, contract_id, plan_id, rxcui)
);

-- ─── F. indication_based_coverage_formulary_file ──────────────────────

CREATE TABLE IF NOT EXISTS cms_spuf_indication_based_coverage (
  release_id   bigint NOT NULL REFERENCES cms_spuf_releases(release_id) ON DELETE CASCADE,
  contract_id  text NOT NULL,
  plan_id      text NOT NULL,
  rxcui        text NOT NULL,
  disease      text NOT NULL,                          -- char(100); FDA-approved indication
  PRIMARY KEY (release_id, contract_id, plan_id, rxcui, disease)
);

-- ─── G. insulin_beneficiary_cost ──────────────────────────────────────
-- Insulin cost-sharing (capped under IRA). tier is NULL for defined-
-- standard plans, so natural key uses COALESCE in a unique index.

CREATE TABLE IF NOT EXISTS cms_spuf_insulin_beneficiary_cost (
  id                            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  release_id                    bigint NOT NULL REFERENCES cms_spuf_releases(release_id) ON DELETE CASCADE,
  contract_id                   text NOT NULL,
  plan_id                       text NOT NULL,
  segment_id                    text NOT NULL,
  tier                          smallint,             -- NULL for defined-standard plans
  days_supply                   smallint NOT NULL,    -- 1=30, 2=90, 3=other, 4=60
  copay_amt_pref_insln          numeric(12,2),
  copay_amt_nonpref_insln       numeric(12,2),
  copay_amt_mail_pref_insln     numeric(12,2),
  copay_amt_mail_nonpref_insln  numeric(12,2)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cms_spuf_insulin_natural
  ON cms_spuf_insulin_beneficiary_cost (
    release_id, contract_id, plan_id, segment_id,
    COALESCE(tier, -1), days_supply
  );
CREATE INDEX IF NOT EXISTS idx_cms_spuf_insulin_release_plan
  ON cms_spuf_insulin_beneficiary_cost (release_id, contract_id, plan_id, segment_id);

-- ─── H. pricing (quarterly only — absent from monthly PUF) ────────────
-- ~20–50M rows per release. days_supply here is LITERAL 30/60/90 — not
-- the coded enum (1/2/3/4) used in beneficiary_cost.

CREATE TABLE IF NOT EXISTS cms_spuf_pricing (
  release_id   bigint NOT NULL REFERENCES cms_spuf_releases(release_id) ON DELETE CASCADE,
  contract_id  text NOT NULL,
  plan_id      text NOT NULL,
  segment_id   text NOT NULL,
  ndc          text NOT NULL,                          -- char(11)
  days_supply  smallint NOT NULL,                      -- literal 30/60/90
  unit_cost    numeric(8,4) NOT NULL,
  PRIMARY KEY (release_id, contract_id, plan_id, segment_id, ndc, days_supply)
);

CREATE INDEX IF NOT EXISTS idx_cms_spuf_pricing_ndc
  ON cms_spuf_pricing (release_id, ndc);

-- ─── I. geographic_locator ────────────────────────────────────────────
-- County-to-region crosswalk. ~3,200 rows. county_code is SSA, not FIPS.

CREATE TABLE IF NOT EXISTS cms_spuf_geographic_locator (
  release_id        bigint NOT NULL REFERENCES cms_spuf_releases(release_id) ON DELETE CASCADE,
  county_code       text NOT NULL,                     -- char(5) SSA
  statename         text NOT NULL,
  county            text NOT NULL,
  ma_region_code    text,
  ma_region         text,
  pdp_region_code   text,
  pdp_region        text,
  PRIMARY KEY (release_id, county_code)
);

-- ═══ VERIFICATION ═══════════════════════════════════════════════════
-- Run after the CREATEs to confirm all 10 tables landed.

SELECT table_name, COUNT(*) AS column_count
FROM information_schema.columns
WHERE table_name IN (
  'cms_spuf_releases',
  'cms_spuf_plan_information',
  'cms_spuf_basic_drugs',
  'cms_spuf_beneficiary_cost',
  'cms_spuf_pharmacy_network',
  'cms_spuf_excluded_drugs',
  'cms_spuf_indication_based_coverage',
  'cms_spuf_insulin_beneficiary_cost',
  'cms_spuf_pricing',
  'cms_spuf_geographic_locator'
)
GROUP BY table_name
ORDER BY table_name;

-- Index inventory
SELECT tablename, indexname
FROM pg_indexes
WHERE tablename LIKE 'cms_spuf_%'
ORDER BY tablename, indexname;

-- Release ledger should start empty
SELECT COUNT(*) AS releases FROM cms_spuf_releases;
