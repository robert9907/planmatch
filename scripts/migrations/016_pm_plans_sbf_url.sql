-- 016_pm_plans_sbf_url.sql
--
-- Adds a per-plan Summary-of-Benefits URL cache to pm_plans so the
-- Compare bench card can link a broker directly to a rich plan-detail
-- page (medicareadvantage.com/plans/{lowercase-triple}) when one
-- exists, falling back to the Google search URL builder in
-- api/plans.ts:planFinderUrl() for plans whose carriers don't have
-- coverage there.
--
-- Populated by scripts/probe-sbf-urls.ts: for every distinct
-- (contract_id, plan_id, segment_id) in pm_plans it HEADs
-- medicareadvantage.com/plans/{triple} and checks the returned page
-- title contains the plan's contract-plan triple. When it does, the
-- carrier page is stored; when it doesn't, sbf_url stays NULL and
-- api/plans.ts falls through to the Google-search URL.
--
-- One row per pm_plans row (denormalized). pm_plans is per-
-- (contract, plan, segment, state, county); sbf_url is invariant per
-- (contract, plan, segment), so every row for the same triple carries
-- the same URL — the probe writes them together.
--
-- Idempotent. Run in the Supabase SQL editor (or via
-- scripts/probe-sbf-urls.ts which applies the ADD COLUMN IF NOT EXISTS
-- itself) against plan-match-prod (rpcbrkmvalvdmroqzpaq).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE pm_plans
  ADD COLUMN IF NOT EXISTS sbf_url text;
