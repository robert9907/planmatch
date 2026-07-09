-- 015_pm_plans_dsnp_populations.sql
--
-- Adds D-SNP accepted-Medicaid-populations tagging to pm_plans, sourced
-- from the CMS SNP Comprehensive Report (a monthly XLSX at
-- cms.gov/data-research/.../special-needs-plan-snp-data/). That report
-- is the authoritative CMS filing of which dual populations each D-SNP
-- contract will accept — carrier-site scraping is unnecessary.
--
-- The report's SNP_REPORT_PART_17 sheet has a "Partial Dual" column
-- (Yes/No) which is the single-signal source for the population set:
--
--   Partial Dual = No  → plan only accepts full-benefit duals
--                        {FBDE, QMB+, SLMB+}
--   Partial Dual = Yes → plan accepts every subgroup
--                        {FBDE, QMB+, QMB, SLMB+, SLMB, QI}
--
-- The report also carries "DSNP Only Contract" (whether the entire
-- contract is D-SNP-only vs mixed MA/D-SNP), which the bench filter
-- can surface to help brokers steer members to plans engineered from
-- the ground up for dual populations.
--
-- Idempotent. Run in the Supabase SQL editor against plan-match-prod
-- (rpcbrkmvalvdmroqzpaq).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE pm_plans
  ADD COLUMN IF NOT EXISTS dsnp_accepted_populations text[];

-- Denormalized "does this plan accept any partial dual?" flag. Same
-- source as dsnp_accepted_populations (Partial Dual column), kept as
-- a separate boolean so filter queries can index it directly instead
-- of unnesting the array on every row.
ALTER TABLE pm_plans
  ADD COLUMN IF NOT EXISTS dsnp_partial_duals boolean;

-- True when the entire CMS contract is D-SNP-only (no mixed MA/D-SNP
-- plans under the same contract number). Signals a carrier who's
-- built its network + care model exclusively around dual populations.
ALTER TABLE pm_plans
  ADD COLUMN IF NOT EXISTS dsnp_only_contract boolean;

-- Partial index on the population array — most bench queries filter
-- to "accepts QMB" or "accepts partial duals," never fetch by
-- accepted-population set. GIN keeps `dsnp_accepted_populations && ARRAY[...]`
-- overlap checks fast without scanning every non-D-SNP row.
CREATE INDEX IF NOT EXISTS pm_plans_dsnp_populations_gin
  ON pm_plans USING GIN (dsnp_accepted_populations)
  WHERE dsnp_accepted_populations IS NOT NULL;
