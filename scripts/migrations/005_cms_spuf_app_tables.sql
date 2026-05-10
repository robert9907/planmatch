-- 005_cms_spuf_app_tables.sql
--
-- App-facing tables derived from the CMS SPUF landing tables (migration
-- 004). One row set per active release per plan year — the importer
-- swaps these in a single transaction at promotion time.
--
-- Naming convention: pm_*_v2 (clean schema, plan_year + segment_id +
-- formulary_id present). The legacy pm_formulary table (~2.3M rows,
-- imported out-of-band on 2026-04-21, missing segment_id/formulary_id/
-- plan_year) is renamed to pm_formulary_legacy and replaced by a VIEW
-- of the same name backed by pm_formulary_v2 ⨝ pm_rxcui_meta. The view
-- preserves the column shape api/formulary.ts, api/plan-brain-data.ts,
-- and api/rxnorm-search.ts read against, so no API code changes during
-- cutover. Drop pm_formulary_legacy after one production cycle confirms
-- parity.
--
-- Run in the Supabase SQL Editor — service-role JWT can't do DDL via
-- PostgREST. Order matters: this depends on migration 004.
-- ═══════════════════════════════════════════════════════════════════

-- ─── pm_formulary_v2 ──────────────────────────────────────────────────
--
-- Per (contract, plan, segment, plan_year, rxcui). tier is min-tier
-- across NDC proxies for that rxcui within the formulary.
-- copay_default / coinsurance_default are denormalized to:
--    coverage_level = 1 (initial coverage)
--    days_supply    = 1 (30-day)
--    pharmacy_type  = pref (preferred retail)
-- Callers needing other cuts (mail-order, 90-day, deductible phase, etc.)
-- must join pm_beneficiary_cost_v2.

CREATE TABLE IF NOT EXISTS pm_formulary_v2 (
  contract_id                text NOT NULL,
  plan_id                    text NOT NULL,
  segment_id                 text NOT NULL,
  plan_year                  smallint NOT NULL,
  formulary_id               text NOT NULL,
  rxcui                      text NOT NULL,
  tier                       smallint NOT NULL,
  prior_auth                 boolean NOT NULL,
  step_therapy               boolean NOT NULL,
  quantity_limit             boolean NOT NULL,
  quantity_limit_amount      numeric(10,2),
  quantity_limit_days        smallint,
  -- Default cost-share denormalization (initial / 30-day / pref retail).
  -- copay_default is dollars; coinsurance_default is fraction (0.25 = 25%).
  -- Exactly one of the two is non-null per row (matches CMS cost_type).
  copay_default              numeric(12,2),
  coinsurance_default        numeric(6,4),
  -- Supplemental flags joined from excluded_drugs / indication_based_coverage.
  excluded_drug_supplemental boolean NOT NULL DEFAULT false,
  indication_restricted      boolean NOT NULL DEFAULT false,
  release_id                 bigint NOT NULL REFERENCES cms_spuf_releases(release_id),
  PRIMARY KEY (contract_id, plan_id, segment_id, plan_year, rxcui)
);

CREATE INDEX IF NOT EXISTS idx_pm_formulary_v2_rxcui
  ON pm_formulary_v2 (rxcui);
CREATE INDEX IF NOT EXISTS idx_pm_formulary_v2_contract_plan
  ON pm_formulary_v2 (contract_id, plan_id);
CREATE INDEX IF NOT EXISTS idx_pm_formulary_v2_formulary_id
  ON pm_formulary_v2 (formulary_id, rxcui);
CREATE INDEX IF NOT EXISTS idx_pm_formulary_v2_release
  ON pm_formulary_v2 (release_id);

-- ─── pm_beneficiary_cost_v2 ───────────────────────────────────────────
--
-- Pivoted long: 4 rows per (plan, tier, coverage_level, days_supply) —
-- one per pharmacy_type. Easier to query than the wide CMS shape and
-- keeps cost_amount as a single value column. Strings parsed:
-- cost_min was char(12) text in CMS landing; cast to numeric here.

CREATE TABLE IF NOT EXISTS pm_beneficiary_cost_v2 (
  contract_id        text NOT NULL,
  plan_id            text NOT NULL,
  segment_id         text NOT NULL,
  plan_year          smallint NOT NULL,
  coverage_level     smallint NOT NULL,                -- 0=ded, 1=initial, 3=catastrophic
  tier               smallint NOT NULL,
  days_supply_code   smallint NOT NULL,                -- 1=30, 2=90, 3=other, 4=60
  pharmacy_type      text NOT NULL CHECK (pharmacy_type IN ('pref','nonpref','mail_pref','mail_nonpref')),
  cost_type          smallint NOT NULL,                -- 0=n/a, 1=copay, 2=coinsurance
  cost_amount        numeric(12,2),
  cost_min           numeric(12,2),
  cost_max           numeric(12,2),
  tier_specialty     boolean NOT NULL,
  deductible_applies boolean NOT NULL,
  gap_cov_tier       text,
  release_id         bigint NOT NULL REFERENCES cms_spuf_releases(release_id),
  PRIMARY KEY (contract_id, plan_id, segment_id, plan_year, coverage_level, tier, days_supply_code, pharmacy_type)
);

CREATE INDEX IF NOT EXISTS idx_pm_beneficiary_cost_v2_release
  ON pm_beneficiary_cost_v2 (release_id);

-- ─── pm_pharmacy_network_v2 ───────────────────────────────────────────
--
-- npi is the bare 10-digit NPI (right 10 chars of pharmacy_number).

CREATE TABLE IF NOT EXISTS pm_pharmacy_network_v2 (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contract_id      text NOT NULL,
  plan_id          text NOT NULL,
  segment_id       text NOT NULL,
  plan_year        smallint NOT NULL,
  npi              text NOT NULL,                       -- bare 10-digit NPI
  pharmacy_zipcode text,
  preferred_retail boolean NOT NULL,
  preferred_mail   boolean NOT NULL,
  retail           boolean NOT NULL,
  mail             boolean NOT NULL,
  in_area          boolean NOT NULL,
  release_id       bigint NOT NULL REFERENCES cms_spuf_releases(release_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_pharmacy_network_v2_natural
  ON pm_pharmacy_network_v2 (contract_id, plan_id, segment_id, plan_year, npi, COALESCE(pharmacy_zipcode, ''));
CREATE INDEX IF NOT EXISTS idx_pm_pharmacy_network_v2_npi
  ON pm_pharmacy_network_v2 (npi);
CREATE INDEX IF NOT EXISTS idx_pm_pharmacy_network_v2_plan
  ON pm_pharmacy_network_v2 (contract_id, plan_id, segment_id, plan_year);
CREATE INDEX IF NOT EXISTS idx_pm_pharmacy_network_v2_release
  ON pm_pharmacy_network_v2 (release_id);

-- ─── pm_pricing_v2 ────────────────────────────────────────────────────
-- days_supply is LITERAL 30/60/90 (matches CMS pricing.txt, not
-- beneficiary_cost's coded enum).

CREATE TABLE IF NOT EXISTS pm_pricing_v2 (
  contract_id  text NOT NULL,
  plan_id      text NOT NULL,
  segment_id   text NOT NULL,
  plan_year    smallint NOT NULL,
  ndc          text NOT NULL,
  days_supply  smallint NOT NULL,                      -- literal 30/60/90
  unit_cost    numeric(8,4) NOT NULL,
  release_id   bigint NOT NULL REFERENCES cms_spuf_releases(release_id),
  PRIMARY KEY (contract_id, plan_id, segment_id, plan_year, ndc, days_supply)
);

CREATE INDEX IF NOT EXISTS idx_pm_pricing_v2_ndc ON pm_pricing_v2 (ndc);
CREATE INDEX IF NOT EXISTS idx_pm_pricing_v2_release ON pm_pricing_v2 (release_id);

-- ─── pm_insulin_cost_v2 ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pm_insulin_cost_v2 (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contract_id      text NOT NULL,
  plan_id          text NOT NULL,
  segment_id       text NOT NULL,
  plan_year        smallint NOT NULL,
  tier             smallint,                            -- NULL for defined-standard plans
  days_supply_code smallint NOT NULL,                   -- 1=30, 2=90, 3=other, 4=60
  pharmacy_type    text NOT NULL CHECK (pharmacy_type IN ('pref','nonpref','mail_pref','mail_nonpref')),
  copay_amount     numeric(12,2),
  release_id       bigint NOT NULL REFERENCES cms_spuf_releases(release_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_insulin_cost_v2_natural
  ON pm_insulin_cost_v2 (
    contract_id, plan_id, segment_id, plan_year,
    COALESCE(tier, -1), days_supply_code, pharmacy_type
  );
CREATE INDEX IF NOT EXISTS idx_pm_insulin_cost_v2_release
  ON pm_insulin_cost_v2 (release_id);

-- ─── pm_indication_coverage_v2 ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pm_indication_coverage_v2 (
  contract_id text NOT NULL,
  plan_id     text NOT NULL,
  plan_year   smallint NOT NULL,
  rxcui       text NOT NULL,
  disease     text NOT NULL,
  release_id  bigint NOT NULL REFERENCES cms_spuf_releases(release_id),
  PRIMARY KEY (contract_id, plan_id, plan_year, rxcui, disease)
);

CREATE INDEX IF NOT EXISTS idx_pm_indication_coverage_v2_rxcui
  ON pm_indication_coverage_v2 (rxcui);
CREATE INDEX IF NOT EXISTS idx_pm_indication_coverage_v2_release
  ON pm_indication_coverage_v2 (release_id);

-- ─── pm_geographic_locator_v2 ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pm_geographic_locator_v2 (
  county_code     text NOT NULL,                       -- SSA, not FIPS
  plan_year       smallint NOT NULL,
  statename       text NOT NULL,
  county          text NOT NULL,
  ma_region_code  text,
  ma_region       text,
  pdp_region_code text,
  pdp_region      text,
  release_id      bigint NOT NULL REFERENCES cms_spuf_releases(release_id),
  PRIMARY KEY (county_code, plan_year)
);

CREATE INDEX IF NOT EXISTS idx_pm_geographic_locator_v2_state
  ON pm_geographic_locator_v2 (statename);
CREATE INDEX IF NOT EXISTS idx_pm_geographic_locator_v2_release
  ON pm_geographic_locator_v2 (release_id);

-- ─── pm_rxcui_meta ────────────────────────────────────────────────────
-- RxNav enrichment cache. Populated lazily by the existing API code
-- (api/formulary.ts, api/rxnorm-search.ts) — separate concern from CMS
-- imports. Replaces the always-NULL drug_name column on legacy
-- pm_formulary. is_combo memoizes the /property.json combo-detection
-- the formulary endpoint already does in-process today.

CREATE TABLE IF NOT EXISTS pm_rxcui_meta (
  rxcui      text PRIMARY KEY,
  drug_name  text,
  tty        text,                                     -- SCD/SBD/IN/etc.
  is_combo   boolean,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pm_rxcui_meta_fetched
  ON pm_rxcui_meta (fetched_at);

-- ─── Legacy table rename + compatibility view ─────────────────────────
--
-- The existing pm_formulary table (2.3M rows from a one-shot import on
-- 2026-04-21 with no segment_id / formulary_id / plan_year) is renamed
-- so a view can take its place. The view exposes the SAME columns the
-- existing API code reads, so api/formulary.ts, plan-brain-data.ts, and
-- rxnorm-search.ts keep working without changes during cutover.
--
-- After one production cycle confirms parity, drop pm_formulary_legacy:
--   DROP TABLE pm_formulary_legacy;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'pm_formulary' AND table_type = 'BASE TABLE'
  ) THEN
    EXECUTE 'ALTER TABLE pm_formulary RENAME TO pm_formulary_legacy';
  END IF;
END $$;

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
  -- New columns exposed for callers that want them, harmless for callers
  -- that select only the legacy column set.
  f.segment_id,
  f.plan_year,
  f.formulary_id,
  f.excluded_drug_supplemental,
  f.indication_restricted
FROM pm_formulary_v2 f
LEFT JOIN pm_rxcui_meta m USING (rxcui);

COMMENT ON VIEW pm_formulary IS
  'Compatibility view over pm_formulary_v2 + pm_rxcui_meta. Replaces the legacy pm_formulary table (renamed pm_formulary_legacy). Drop the legacy table after parity confirmed.';

-- ═══ VERIFICATION ═══════════════════════════════════════════════════

-- 1) All v2 tables present
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'pm_formulary_v2',
    'pm_beneficiary_cost_v2',
    'pm_pharmacy_network_v2',
    'pm_pricing_v2',
    'pm_insulin_cost_v2',
    'pm_indication_coverage_v2',
    'pm_geographic_locator_v2',
    'pm_rxcui_meta'
  )
ORDER BY table_name;

-- 2) pm_formulary is now a view, pm_formulary_legacy is the renamed table
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE 'pm_formulary%'
ORDER BY table_name;

-- 3) View column shape — confirm legacy column names still present
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pm_formulary'
ORDER BY ordinal_position;

-- 4) Initial state: app tables empty until first SPUF import promotes
SELECT
  (SELECT COUNT(*) FROM pm_formulary_v2)         AS formulary_v2,
  (SELECT COUNT(*) FROM pm_beneficiary_cost_v2)  AS beneficiary_cost_v2,
  (SELECT COUNT(*) FROM pm_pharmacy_network_v2)  AS pharmacy_network_v2,
  (SELECT COUNT(*) FROM pm_pricing_v2)           AS pricing_v2,
  (SELECT COUNT(*) FROM pm_rxcui_meta)           AS rxcui_meta,
  (SELECT COUNT(*) FROM pm_formulary_legacy)     AS legacy_rows;
