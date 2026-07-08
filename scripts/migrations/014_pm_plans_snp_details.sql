-- 014_pm_plans_snp_details.sql
--
-- Adds three CMS Landscape-sourced SNP detail columns to pm_plans so
-- the bench-filter UI can partition D-SNPs by state-integration status
-- and C-SNPs by chronic-condition type. Landscape ships these per
-- (contract, plan) triple but pm_plans has never carried them — the
-- broker's Compare bench currently collapses every D-SNP into a single
-- "D-SNP" bucket, which hides the FIDE / HIDE / coordination-only
-- distinction that changes what care-management workflow the client
-- gets. Populated by scripts/populate-landscape-snp-details.ts against
-- the CY2026_Landscape_202603 extract; migrations/*.ts CMS syncs and
-- scripts/cms-pbp/promote.ts also refresh these columns going forward.
--
-- Value spaces (verified against the Landscape CY2026 ReadMe):
--   dsnp_integration_status  ← col 23 "Dual Eligible SNP (D-SNP)
--                              Integration Status"
--     'FIDE'              Fully Integrated Dual Eligible
--     'HIDE'              Highly Integrated Dual Eligible
--     'Coordination Only' Coordination-only D-SNP
--     'AIP'               Applicable Integrated Plan (2027 target)
--     NULL                non-D-SNP plan
--
--   zero_cost_sharing        ← col 26 "Medicare Zero-Dollar Cost
--                              Sharing D-SNP Plan"
--     true   QMB+ / full-benefit dual pays nothing (D-SNP only)
--     false  everyone else (default)
--
--   csnp_condition_type      ← col 25 "Chronic or Disabling Condition
--                              SNP (C-SNP) Condition Type"
--     'Diabetes' | 'Cardiovascular Disorders' | 'Chronic Lung
--     Disorders' | 'ESRD' | ... free text — Landscape files whatever
--     the carrier declares. NULL on non-C-SNPs.
--
-- Idempotent. Run in the Supabase SQL editor against the plan-match-
-- prod project (rpcbrkmvalvdmroqzpaq); service-role JWT can't do DDL
-- via PostgREST.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE pm_plans
  ADD COLUMN IF NOT EXISTS dsnp_integration_status text;

ALTER TABLE pm_plans
  ADD COLUMN IF NOT EXISTS zero_cost_sharing boolean NOT NULL DEFAULT false;

ALTER TABLE pm_plans
  ADD COLUMN IF NOT EXISTS csnp_condition_type text;

-- Partial indexes so filter queries ("all D-SNPs with FIDE integration")
-- don't full-scan pm_plans. Both are cheap — the D-SNP + C-SNP subset
-- across NC/TX/GA is a few hundred rows.
CREATE INDEX IF NOT EXISTS pm_plans_dsnp_integration_idx
  ON pm_plans (dsnp_integration_status)
  WHERE dsnp_integration_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS pm_plans_csnp_condition_idx
  ON pm_plans (csnp_condition_type)
  WHERE csnp_condition_type IS NOT NULL;

-- Mirror the same three columns on pbp_plan_facts_v2 so scripts/cms-pbp/promote.ts
-- can persist zero_cost_sharing directly from pbp_a_dsnp_zerodollar (the
-- only one of the three that PBP Section A actually carries) and keep
-- placeholders for the two Landscape-only columns. The pm_plans rows
-- remain the source of truth for app reads — pbp_plan_facts_v2 stores
-- them here so downstream consumers doing a straight JOIN off the PBP
-- facts table don't have to also fetch pm_plans just for these facets.
ALTER TABLE pbp_plan_facts_v2
  ADD COLUMN IF NOT EXISTS zero_cost_sharing boolean;

ALTER TABLE pbp_plan_facts_v2
  ADD COLUMN IF NOT EXISTS dsnp_integration_status text;

ALTER TABLE pbp_plan_facts_v2
  ADD COLUMN IF NOT EXISTS csnp_condition_type text;
